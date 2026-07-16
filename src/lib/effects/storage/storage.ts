import { lazy } from '../lazy'

/**
 * Storage interface backed by one of three adapters:
 *   - `vercelBlob` — Vercel Blob in production.
 *   - `s3` — a local S3-compatible container (RustFS in `compose.yaml`) for
 *     offline dev. Selected when `S3_ENDPOINT` is set.
 *   - `devLog` — no-op stub for tests + offline dev without docker.
 *
 * Avatars live in the public store/bucket; documents in the private one.
 * Pathnames flow through this interface as logical paths
 * (`avatars/{userId}/{slug}`, `documents/{folder}/{name}`); each adapter
 * decides whether to env-prefix (Vercel Blob does; S3 doesn't — the dev
 * bucket is the env boundary).
 *
 * `mintUploadToken` returns a discriminated `upload` payload so the browser
 * can pick the right transport: Vercel Blob uses the SDK's client-token
 * flow (with progress events), S3 uses a presigned PUT URL the browser
 * PUTs to directly. The browser dispatcher lives in `clientUpload.ts`.
 */
export interface HeadResult {
  url: string
  contentType: string
  size: number
}

/**
 * Environment prefix the vercelBlob adapter prepends to every pathname
 * (`prod/` / `preview/` / `dev/`); the s3 and devLog adapters don't prefix.
 * Lives here so adapter prefixing and `stripEnvPrefix` can't drift apart.
 */
export function envPrefix(): string {
  switch (process.env.VERCEL_ENV) {
    case 'production':
      return 'prod/'
    case 'preview':
      return 'preview/'
    default:
      return 'dev/'
  }
}

/** Matches any env prefix (`prod/`, `preview/`, `dev/`) at the start of a pathname. */
const ENV_PREFIX_RE = /^(?:prod|preview|dev)\//

/**
 * Reduce an adapter-final pathname back to its logical form for validation.
 * `mintUploadToken` returns the final (possibly env-prefixed) pathname and the
 * browser round-trips it to the confirm procedure, so ownership/shape checks
 * (`startsWith('avatars/<id>/')`, `startsWith('documents/')`) must strip the
 * prefix first or they reject every production upload.
 */
export function stripEnvPrefix(pathname: string): string {
  return pathname.replace(ENV_PREFIX_RE, '')
}

/**
 * Prepend the current env prefix UNLESS the pathname already carries ANY env
 * prefix. The vercelBlob adapter uses this to turn a logical path
 * (`documents/x.pdf`) into the env-namespaced key it stores under.
 *
 * Recognizing all three prefixes — not just the current env's — matters because
 * dev/preview Neon DBs branch prod, so a prod `file` row read from preview keeps
 * its `prod/` pathname. That byte lives at `prod/…` in the shared Blob store, so
 * it must be looked up verbatim; re-prefixing it to `preview/prod/…` 404s
 * ("Blob not found"). Mirrors `stripEnvPrefix` so prefixing and stripping can't
 * drift. Logical paths never start with an env prefix, so new uploads still get
 * the current env's prefix.
 */
export function applyEnvPrefix(pathname: string): string {
  return ENV_PREFIX_RE.test(pathname) ? pathname : `${envPrefix()}${pathname}`
}

/**
 * True for a stored pathname whose env prefix differs from the *current*
 * environment's — a "foreign-origin" byte surfaced through a branched DB. Dev
 * and preview both branch the prod Neon DB, so their databases carry prod `file`
 * rows whose `pathname` keeps its `prod/` prefix. Two consequences hang off it:
 *
 *   - **Dev** (s3/RustFS adapter — never prefixes its own uploads): the bytes
 *     were never written locally, so the file routes return a friendly "run
 *     `pnpm storage:sync`" page when `head` misses, and the UI shows a PROD badge.
 *   - **Preview** (vercelBlob adapter — *shared* stores with prod): the bytes are
 *     readable (resolved verbatim by `applyEnvPrefix`), so the file renders — but
 *     prod *owns* the byte, so the adapter refuses to delete/overwrite it and the
 *     UI still shows a PROD badge so an editor knows mutations here can't touch
 *     the real file.
 *
 * False for a file in its own env (prefix == current env, e.g. every prod file
 * in production) and for dev's own unprefixed uploads.
 */
export function isRemoteOriginPathname(pathname: string): boolean {
  if (!ENV_PREFIX_RE.test(pathname)) return false
  return !pathname.startsWith(envPrefix())
}

export type MintUploadResult = {
  pathname: string
  upload:
    | { kind: 'vercel-blob-client'; clientToken: string }
    | { kind: 'presigned-put'; url: string; headers?: Record<string, string> }
}

export interface StorageEffects {
  /**
   * Mint the credential the browser needs to upload bytes directly.
   * `pathname` in the input is the logical path; the adapter may prefix it
   * and returns the final pathname the browser MUST round-trip back when
   * confirming the upload (server-side validation pins identity to it).
   */
  mintUploadToken(input: {
    access: 'public' | 'private'
    pathname: string
    contentType: string
    maxBytes: number
  }): Promise<MintUploadResult>

  /** Existence + metadata check for a pathname. Returns null when the blob does not exist. */
  head(access: 'public' | 'private', pathname: string): Promise<HeadResult | null>

  delete(access: 'public' | 'private', pathname: string): Promise<void>

  /**
   * Write bytes directly from a server-side context (background workers, not
   * the oRPC upload path — browsers still upload via `mintUploadToken`). Used
   * by the thumbnail worker to store a derived WebP in the public store.
   * `pathname` is the logical path; the adapter env-prefixes it the same way
   * `mintUploadToken` does, so a later `getReadUrl(access, pathname)` resolves.
   */
  put(
    access: 'public' | 'private',
    pathname: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void>

  /**
   * Server-side copy of a stored object to a new logical pathname within the
   * same access store. Used to "rename" a document's byte when its display name
   * changes — the prod (Vercel Blob) download filename is the pathname basename,
   * so the byte must physically move for a renamed document to download under
   * its new name. Storage-to-storage: the bytes never transit a Function.
   *
   * `contentType` is REQUIRED because Vercel Blob's `copy` does not carry the
   * source content type over (it would otherwise re-derive it from the
   * destination extension). Pass the file row's stored mime. No-op backends
   * (devLog) just resolve.
   */
  copy(
    access: 'public' | 'private',
    fromPathname: string,
    toPathname: string,
    contentType: string,
  ): Promise<void>

  /**
   * Download URL for a stored object. For `private`, returns a signed,
   * time-limited URL. For `public`, returns either the canonical public URL
   * (Vercel Blob) or a longer-lived presigned URL (S3 dev) — `ttlSeconds`
   * may be ignored for public on adapters whose public URLs don't expire.
   *
   * `opts.downloadFilename` forces a `Content-Disposition: attachment` with
   * that filename on the response, so a renamed document downloads under its
   * current display name. Honored on the S3 (dev) signed-URL path; Vercel Blob
   * (prod) ignores it and serves the pathname basename, which `renameDocument`
   * keeps in sync with the display name. See each adapter for support details.
   */
  getReadUrl(
    access: 'public' | 'private',
    pathname: string,
    ttlSeconds: number,
    opts?: { downloadFilename?: string },
  ): Promise<string>
}

const getAdapter = lazy(async (): Promise<StorageEffects> => {
  // Tests must never reach live storage; `test/setup.ts` loads `.env` via
  // dotenv, so without this short-circuit a test touching storage would pick
  // the s3 adapter and write to RustFS. Mirrors the email/queue selectors.
  if (process.env.VITEST === 'true') {
    return (await import('./adapters/devLog')).devLog
  }
  if (process.env.STORAGE_ADAPTER === 'devLog') {
    return (await import('./adapters/devLog')).devLog
  }
  // Local dev S3-compatible storage (RustFS in `compose.yaml`). Takes
  // precedence over BLOB_* so `vercel env pull` doesn't accidentally route
  // dev uploads at the real Vercel Blob CDN.
  if (process.env.S3_ENDPOINT) {
    return (await import('./adapters/s3')).s3
  }
  if (!process.env.BLOB_PUBLIC_READ_WRITE_TOKEN || !process.env.BLOB_PRIVATE_READ_WRITE_TOKEN) {
    return (await import('./adapters/devLog')).devLog
  }
  return (await import('./adapters/vercelBlob')).vercelBlob
})

export const storage: StorageEffects = {
  async mintUploadToken(input) {
    const adapter = await getAdapter()
    return adapter.mintUploadToken(input)
  },
  async head(access, pathname) {
    const adapter = await getAdapter()
    return adapter.head(access, pathname)
  },
  async delete(access, pathname) {
    const adapter = await getAdapter()
    return adapter.delete(access, pathname)
  },
  async put(access, pathname, bytes, contentType) {
    const adapter = await getAdapter()
    return adapter.put(access, pathname, bytes, contentType)
  },
  async copy(access, fromPathname, toPathname, contentType) {
    const adapter = await getAdapter()
    return adapter.copy(access, fromPathname, toPathname, contentType)
  },
  async getReadUrl(access, pathname, ttlSeconds, opts) {
    const adapter = await getAdapter()
    return adapter.getReadUrl(access, pathname, ttlSeconds, opts)
  },
}
