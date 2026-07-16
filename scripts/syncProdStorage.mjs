#!/usr/bin/env node
// Mirrors production file bytes into the local RustFS S3 store so prod-origin
// documents open in dev.
//
// Why this exists: dev branches the prod Neon DB (compose.yaml), so the dev
// database carries prod `file`/`document` rows — but their bytes live in the
// production Vercel Blob store, not in local RustFS. Opening such a file in dev
// 404s. This script walks the prod-prefixed pathnames in the dev DB, reads each
// byte from Vercel Blob (read-only), and PUTs it into RustFS under the *same*
// key. The s3 adapter doesn't strip env prefixes, so a later
// `getReadUrl('private', 'prod/…')` resolves to the object written here.
//
// Idempotent: objects already in RustFS are skipped, so it's cheap to re-run on
// every `pnpm dev:up`. Safe re: the `vercel env pull` guard — the running app
// still uses the s3 adapter (S3_ENDPOINT wins in the adapter selector); only
// this script consumes the BLOB_* tokens, and only to read.
//
// Run via `pnpm storage:sync` (also chained into `pnpm dev:up`). Skips cleanly
// when not in local dev or when the prod blob read tokens aren't configured.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { BlobNotFoundError, head, issueSignedToken, presignUrl } from '@vercel/blob'
import postgres from 'postgres'

const TAG = '[storage:sync]'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Match the app's env resolution (.env, then .env.local override) so the script
// reads the same DB and storage config the running dev server does.
process.loadEnvFile(resolve(root, '.env'))
try {
  process.loadEnvFile(resolve(root, '.env.local'))
} catch {
  // .env.local is optional
}

const { S3_ENDPOINT, DATABASE_URL, BLOB_PUBLIC_READ_WRITE_TOKEN, BLOB_PRIVATE_READ_WRITE_TOKEN } =
  process.env

// Guard: only meaningful in local dev (s3 adapter active) with prod read tokens.
// Each missing piece is a clean exit 0 so `dev:up` never breaks for someone
// without prod tokens — they just get the in-app "PROD" marker instead.
if (!S3_ENDPOINT) {
  console.log(`${TAG} S3_ENDPOINT unset (not local dev) — skipping.`)
  process.exit(0)
}
if (!DATABASE_URL) {
  console.log(`${TAG} DATABASE_URL unset — skipping.`)
  process.exit(0)
}
if (!BLOB_PUBLIC_READ_WRITE_TOKEN || !BLOB_PRIVATE_READ_WRITE_TOKEN) {
  console.log(
    `${TAG} BLOB_* read tokens unset — skipping prod file sync.\n` +
      `${TAG} Add BLOB_PUBLIC_READ_WRITE_TOKEN + BLOB_PRIVATE_READ_WRITE_TOKEN to .env to pull prod files into local storage.`,
  )
  process.exit(0)
}

const REGION = process.env.S3_REGION ?? 'eu-north-1'
const PUBLIC_BUCKET = process.env.S3_BUCKET_PUBLIC
const PRIVATE_BUCKET = process.env.S3_BUCKET_PRIVATE
if (!PUBLIC_BUCKET || !PRIVATE_BUCKET) {
  console.error(`${TAG} S3_BUCKET_PUBLIC and S3_BUCKET_PRIVATE must be set.`)
  process.exit(1)
}

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: REGION,
  // Path-style addressing — required for self-hosted S3 (RustFS), mirrors the
  // s3 storage adapter.
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
})

const tokenFor = (access) =>
  access === 'public' ? BLOB_PUBLIC_READ_WRITE_TOKEN : BLOB_PRIVATE_READ_WRITE_TOKEN
const bucketFor = (access) => (access === 'public' ? PUBLIC_BUCKET : PRIVATE_BUCKET)

function isS3NotFound(err) {
  if (!err || typeof err !== 'object') return false
  if (err.name === 'NotFound' || err.name === 'NoSuchKey') return true
  return err.$metadata?.httpStatusCode === 404
}

async function existsInRustFs(access, pathname) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketFor(access), Key: pathname }))
    return true
  } catch (err) {
    if (isS3NotFound(err)) return false
    throw err
  }
}

// Resolve a fetchable URL for the prod blob. Pathnames are stored already
// env-prefixed (`prod/…`), so call the SDK directly — NOT through the storage
// adapter, which would re-prefix with the script's `dev/` env prefix.
async function blobReadUrl(access, pathname) {
  const meta = await head(pathname, { token: tokenFor(access) })
  if (access === 'public') return { url: meta.url, contentType: meta.contentType }
  const validUntil = Date.now() + 60_000
  const signed = await issueSignedToken({
    token: tokenFor('private'),
    pathname,
    operations: ['get'],
    validUntil,
  })
  const { presignedUrl } = await presignUrl(signed, {
    operation: 'get',
    pathname,
    access: 'private',
    validUntil,
  })
  return { url: presignedUrl, contentType: meta.contentType }
}

// → 'synced' | 'skipped' | 'missing'
async function syncOne({ access, pathname, mime }) {
  if (await existsInRustFs(access, pathname)) return 'skipped'
  let src
  try {
    src = await blobReadUrl(access, pathname)
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      console.warn(`${TAG} source missing in prod blob: ${access}/${pathname}`)
      return 'missing'
    }
    throw err
  }
  const res = await fetch(src.url)
  if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketFor(access),
      Key: pathname,
      Body: bytes,
      ContentType: mime ?? src.contentType ?? 'application/octet-stream',
    }),
  )
  return 'synced'
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 })
try {
  // Both stores in one pass: `file` rows carry their own `access` (private
  // documents + public avatars); thumbnails are separate public-store WebP
  // assets tracked on `document.thumbnail_pathname`.
  const files = await sql`
    SELECT pathname, mime, access
    FROM file
    WHERE deleted_at IS NULL AND pathname ~ '^(prod|preview)/'`
  const thumbs = await sql`
    SELECT thumbnail_pathname AS pathname
    FROM document
    WHERE thumbnail_pathname IS NOT NULL
      AND thumbnail_pathname <> ''
      AND thumbnail_pathname ~ '^(prod|preview)/'`

  const targets = [
    ...files.map((r) => ({ access: r.access, pathname: r.pathname, mime: r.mime })),
    ...thumbs.map((r) => ({ access: 'public', pathname: r.pathname, mime: 'image/webp' })),
  ]

  if (targets.length === 0) {
    console.log(`${TAG} no prod-origin files in the dev DB — nothing to sync.`)
  }

  let synced = 0
  let skipped = 0
  let failed = 0
  for (const target of targets) {
    try {
      const outcome = await syncOne(target)
      if (outcome === 'synced') {
        synced += 1
        console.log(`${TAG} synced ${target.access}/${target.pathname}`)
      } else if (outcome === 'skipped') {
        skipped += 1
      } else {
        failed += 1
      }
    } catch (err) {
      failed += 1
      console.warn(`${TAG} failed ${target.pathname}: ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(
    `${TAG} done — synced ${synced}, skipped ${skipped} (already present), failed ${failed} of ${targets.length}.`,
  )
} finally {
  await sql.end()
}
