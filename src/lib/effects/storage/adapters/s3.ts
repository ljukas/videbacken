import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { devS3Endpoint } from '~/lib/devHost'
import { contentDispositionAttachment } from '~/utils/filename'
import type { StorageEffects } from '../storage'

// Same upload-window TTL the vercelBlob adapter uses for `clientToken`.
// Browser has this long after mint to start the PUT before the URL expires.
const PUT_TTL_SECONDS = 5 * 60

// Public-store objects (avatars, derived thumbnails) are content-addressed by
// UUID/file-id and never mutate in place — a replacement writes a new pathname
// and deletes the old blob. So they're safe to cache forever. We set this
// explicitly because RustFS/S3 stores no Cache-Control unless we PUT one, and
// without it browsers fall back to heuristic caching (revalidate-or-refetch
// behaviour that diverges across browsers, e.g. Arc re-fetching every visit).
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'

function envOrThrow(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set; cannot use the s3 adapter.`)
  return v
}

// `pnpm dev --host` points this at the LAN IP so both the presigned PUT URL and
// the public read URL are reachable from a phone (dev-only; see devHost.ts).
// Falls back to the configured S3_ENDPOINT for normal localhost dev.
const ENDPOINT = devS3Endpoint() ?? envOrThrow('S3_ENDPOINT')
const REGION = process.env.S3_REGION ?? 'eu-north-1'
const PUBLIC_BUCKET = envOrThrow('S3_BUCKET_PUBLIC')
const PRIVATE_BUCKET = envOrThrow('S3_BUCKET_PRIVATE')

const client = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  // Path-style addressing — required for self-hosted S3-compatible servers
  // (MinIO/RustFS/Garage/etc.) where there's no DNS for `bucket.localhost`.
  forcePathStyle: true,
  credentials: {
    accessKeyId: envOrThrow('S3_ACCESS_KEY_ID'),
    secretAccessKey: envOrThrow('S3_SECRET_ACCESS_KEY'),
  },
})

function bucketFor(access: 'public' | 'private'): string {
  return access === 'public' ? PUBLIC_BUCKET : PRIVATE_BUCKET
}

function publicReadUrl(bucket: string, pathname: string): string {
  return `${ENDPOINT.replace(/\/$/, '')}/${bucket}/${pathname}`
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true
  return e.$metadata?.httpStatusCode === 404
}

/**
 * S3-compatible adapter for local dev (RustFS in `compose.yaml`). Two
 * buckets, one client. Public bucket is configured for anonymous read at
 * compose-init time (`mc anonymous set download`) so avatar URLs stored on
 * `user.image` stay fetchable without re-signing. Private bucket is signed
 * on every read.
 */
export const s3: StorageEffects = {
  // `maxBytes` is accepted but unenforceable here: a presigned PUT cannot cap
  // the object size (unlike Vercel Blob's `maximumSizeInBytes`). Dev-only
  // gap — size limits are still validated at the mint/confirm boundaries.
  async mintUploadToken({ access, pathname, contentType }) {
    // Bake an immutable Cache-Control into public uploads. A presigned PUT signs
    // whatever headers the command carries, so the browser MUST echo the exact
    // same `Cache-Control` value back on the PUT (clientUpload.ts forwards
    // `upload.headers`) or S3/RustFS rejects the request with 403.
    const cacheControl = access === 'public' ? PUBLIC_CACHE_CONTROL : undefined
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucketFor(access),
        Key: pathname,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      }),
      { expiresIn: PUT_TTL_SECONDS },
    )
    return {
      pathname,
      upload: {
        kind: 'presigned-put',
        url,
        headers: {
          'Content-Type': contentType,
          ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
        },
      },
    }
  },

  async head(access, pathname) {
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucketFor(access), Key: pathname }),
      )
      const url =
        access === 'public'
          ? publicReadUrl(bucketFor(access), pathname)
          : await getSignedUrl(
              client,
              new GetObjectCommand({ Bucket: bucketFor(access), Key: pathname }),
              { expiresIn: 60 },
            )
      return {
        url,
        contentType: result.ContentType ?? 'application/octet-stream',
        size: result.ContentLength ?? 0,
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  },

  async delete(access, pathname) {
    await client.send(new DeleteObjectCommand({ Bucket: bucketFor(access), Key: pathname }))
  },

  async put(access, pathname, bytes, contentType) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketFor(access),
        Key: pathname,
        Body: bytes,
        ContentType: contentType,
        ...(access === 'public' ? { CacheControl: PUBLIC_CACHE_CONTROL } : {}),
      }),
    )
  },

  async copy(access, fromPathname, toPathname, contentType) {
    const bucket = bucketFor(access)
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        // CopySource is `{bucket}/{key}`; encode so keys with spaces or other
        // URL-reserved characters resolve to the right object.
        CopySource: encodeURI(`${bucket}/${fromPathname}`),
        Key: toPathname,
        // MetadataDirective REPLACE so the re-passed content type is applied to
        // the destination instead of being copied from the source object.
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    )
  },

  async getReadUrl(access, pathname, ttlSeconds, opts) {
    if (access === 'public') {
      return publicReadUrl(bucketFor(access), pathname)
    }
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucketFor(access),
        Key: pathname,
        // S3 echoes this back as the response's Content-Disposition, so the
        // browser saves the file under the document's current display name.
        ...(opts?.downloadFilename
          ? { ResponseContentDisposition: contentDispositionAttachment(opts.downloadFilename) }
          : {}),
      }),
      { expiresIn: ttlSeconds },
    )
  },
}
