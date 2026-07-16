import { transform } from 'unpic/providers/vercel'
import type { URLTransformer } from 'unpic/types'

const PUBLIC_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com'

// `/_vercel/image` is a Vercel platform endpoint — it only exists on deployments.
// In `pnpm dev` we return the source URL unchanged so the browser fetches the
// original bytes from Vercel Blob directly (unoptimized but functional). For
// non-Blob hosts (e.g. static passkey provider icons) we also skip routing
// because those hostnames are not on `remotePatterns`.
export const transformer: URLTransformer<'vercel'> = (src, operations, options) => {
  const srcStr = typeof src === 'string' ? src : src.toString()
  if (import.meta.env.DEV) return srcStr
  try {
    const host = new URL(srcStr).hostname
    if (!host.endsWith(PUBLIC_BLOB_HOST_SUFFIX)) return srcStr
  } catch {
    return srcStr
  }
  return transform(src, operations, options)
}
