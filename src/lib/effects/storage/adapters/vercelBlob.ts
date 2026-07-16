import {
  BlobNotFoundError,
  copy as blobCopy,
  del,
  head,
  issueSignedToken,
  presignUrl,
  put,
} from '@vercel/blob'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'
import { applyEnvPrefix, isRemoteOriginPathname, type StorageEffects } from '../storage'

const TOKEN_TTL_MS = 5 * 60 * 1000

// Public-store objects (avatars, thumbnails) are content-addressed and immutable,
// so cache them for a year. Prod reads route through `/_vercel/image`, which sets
// its own cache headers, so this mainly hardens the raw blob URL; the SDK exposes
// only `cacheControlMaxAge` (no literal `immutable` token). Mirrors the s3 adapter.
const PUBLIC_CACHE_MAX_AGE_SECONDS = 31_536_000

function tokenFor(access: 'public' | 'private'): string {
  const token =
    access === 'public'
      ? process.env.BLOB_PUBLIC_READ_WRITE_TOKEN
      : process.env.BLOB_PRIVATE_READ_WRITE_TOKEN
  if (!token) {
    throw new Error(
      `BLOB_${access.toUpperCase()}_READ_WRITE_TOKEN is not set; cannot use the vercelBlob adapter for ${access} storage.`,
    )
  }
  return token
}

/**
 * Two-store Vercel Blob adapter. The `access` parameter routes to the right
 * read-write token (BLOB_PUBLIC_READ_WRITE_TOKEN vs BLOB_PRIVATE_READ_WRITE_TOKEN).
 * Pathnames are env-prefixed inside the adapter (`applyEnvPrefix`) so callers
 * think in logical terms (`avatars/{userId}/{slug}`, `documents/{folder}/{name}`);
 * the prefixed form is what the browser SDK uses and what we store on metadata
 * rows. `applyEnvPrefix` leaves an already-prefixed pathname untouched, so a
 * cross-env (`prod/…`) row read from preview resolves in the shared store
 * instead of being double-prefixed to a non-existent key.
 */
export const vercelBlob: StorageEffects = {
  async mintUploadToken({ access, pathname, contentType, maxBytes }) {
    const prefixed = applyEnvPrefix(pathname)
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: tokenFor(access),
      pathname: prefixed,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: maxBytes,
      validUntil: Date.now() + TOKEN_TTL_MS,
      addRandomSuffix: false,
      allowOverwrite: false,
      ...(access === 'public' ? { cacheControlMaxAge: PUBLIC_CACHE_MAX_AGE_SECONDS } : {}),
    })
    return { pathname: prefixed, upload: { kind: 'vercel-blob-client', clientToken } }
  },

  async head(access, pathname) {
    try {
      const result = await head(applyEnvPrefix(pathname), { token: tokenFor(access) })
      return { url: result.url, contentType: result.contentType, size: result.size }
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null
      throw err
    }
  },

  async delete(access, pathname) {
    // The store is shared across environments. A foreign-origin byte (e.g. a
    // prod file surfaced through a branched preview DB) is owned by the env its
    // prefix names; deleting it here would destroy *that* env's object. No-op —
    // the metadata row is branch-local and already gone. In production this never
    // triggers (prod files carry the current prefix); it exists to stop a preview
    // hard-delete or rename from reaching into prod.
    if (isRemoteOriginPathname(pathname)) return
    await del(applyEnvPrefix(pathname), { token: tokenFor(access) })
  },

  async put(access, pathname, bytes, contentType) {
    // allowOverwrite so a re-run of the (idempotent) worker replaces the
    // existing derived asset rather than throwing on the same pathname.
    await put(applyEnvPrefix(pathname), bytes, {
      access,
      token: tokenFor(access),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(access === 'public' ? { cacheControlMaxAge: PUBLIC_CACHE_MAX_AGE_SECONDS } : {}),
    })
  },

  async copy(access, fromPathname, toPathname, contentType) {
    // Backstop against writing into another env's namespace from a branched DB.
    // `renameDocument` already skips the byte move for a foreign-origin source,
    // so this only fires defensively. (Reading/copying a prod byte into a new
    // prod key would still mutate the shared prod store.)
    if (isRemoteOriginPathname(fromPathname) || isRemoteOriginPathname(toPathname)) return
    // `copy` does not carry the source content type over, so we re-pass the
    // file's stored mime. `addRandomSuffix: false` keeps the destination
    // pathname exactly as computed (its basename is the prod download name).
    await blobCopy(applyEnvPrefix(fromPathname), applyEnvPrefix(toPathname), {
      access,
      token: tokenFor(access),
      contentType,
      addRandomSuffix: false,
    })
  },

  async getReadUrl(access, pathname, ttlSeconds, _opts) {
    const prefixed = applyEnvPrefix(pathname)
    if (access === 'public') {
      const result = await head(prefixed, { token: tokenFor('public') })
      return result.url
    }
    // `_opts.downloadFilename` is intentionally ignored here: the @vercel/blob
    // private presigned GET URL only honors `validUntil` (PresignGetUrlOptions
    // rejects per-read Content-Disposition at the type level). The browser
    // still saves the file under the immutable storage pathname, which keeps
    // the correct extension — only the renamed base name isn't reflected in
    // prod downloads. The S3 (dev) adapter honors it fully via
    // ResponseContentDisposition. Revisit if the SDK adds read-time disposition.
    const validUntil = Date.now() + ttlSeconds * 1000
    const signedToken = await issueSignedToken({
      token: tokenFor('private'),
      pathname: prefixed,
      operations: ['get'],
      validUntil,
    })
    const { presignedUrl } = await presignUrl(signedToken, {
      operation: 'get',
      pathname: prefixed,
      access: 'private',
      validUntil,
    })
    return presignedUrl
  },
}
