import { put } from '@vercel/blob/client'
import type { MintUploadResult } from './storage'

export type UploadProgress = { loaded: number; total: number; percentage: number }

export type UploadOptions = {
  access: 'public' | 'private'
  contentType: string
  onProgress?: (progress: UploadProgress) => void
}

/**
 * Browser-side dispatcher matching the server `mintUploadToken` discriminated
 * union. The procedure layer returns `{ pathname, upload }`; this function
 * walks `upload.kind` and uses the right transport so components don't need
 * to know which storage backend is wired up.
 *
 *   - `vercel-blob-client`: routes through `@vercel/blob/client.put()` so
 *     we still get progress events + retry behaviour in production.
 *   - `presigned-put`: plain HTTPS PUT to the S3-compatible endpoint. No
 *     progress events (would require `XMLHttpRequest` instead of `fetch`);
 *     callers can show an indeterminate spinner for the dev path.
 */
export async function uploadFileToStorage(
  file: File,
  mint: MintUploadResult,
  opts: UploadOptions,
): Promise<void> {
  switch (mint.upload.kind) {
    case 'vercel-blob-client':
      await put(mint.pathname, file, {
        access: opts.access,
        token: mint.upload.clientToken,
        contentType: opts.contentType,
        onUploadProgress: opts.onProgress,
      })
      return
    case 'presigned-put': {
      const response = await fetch(mint.upload.url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': opts.contentType,
          ...(mint.upload.headers ?? {}),
        },
      })
      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`)
      }
      return
    }
  }
}

/**
 * The full three-step upload sequence shared by every direct-to-storage upload:
 * mint a token, PUT the bytes (with progress), then confirm server-side. Callers
 * supply `mint`/`confirm` callbacks so they can close over feature-specific
 * fields (e.g. a document's `folderId`, an avatar's narrowed mime) and pick
 * their own oRPC entrypoint (mutation vs. plain client call). `mint` is a thunk
 * — each call site owns its exact (often literal-typed) request shape. Pure — no
 * React state — so it's reusable by both the single-file (avatar) and multi-file
 * (document) flows and unit-testable.
 */
export async function runUploadFlow<M extends MintUploadResult>(
  file: File,
  opts: {
    access: 'public' | 'private'
    contentType: string
    mint: () => Promise<M>
    confirm: (minted: M) => Promise<unknown>
    onProgress?: (progress: UploadProgress) => void
  },
): Promise<void> {
  const minted = await opts.mint()
  await uploadFileToStorage(file, minted, {
    access: opts.access,
    contentType: opts.contentType,
    onProgress: opts.onProgress,
  })
  await opts.confirm(minted)
}
