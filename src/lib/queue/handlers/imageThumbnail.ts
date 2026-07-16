import { realtime, storage } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { SHARP_DECODABLE_MIME_SET } from '~/lib/image/blurhash'
import { generateImageThumbnail } from '~/lib/image/thumbnail'
import { logger } from '~/lib/logger/server'
import * as documentService from '~/lib/services/document'

const READ_URL_TTL_SECONDS = 60

// Empty-string sentinel: a render that fails on the bytes themselves (sharp
// can't decode) writes this so the document isn't re-enqueued on every list
// query. Distinct from `null` (never attempted) and a real pathname (done).
const RENDER_FAILED_SENTINEL = ''

const thumbnailPathname = (documentId: string) => `thumbnails/${documentId}.webp`

export type ImageThumbnailJobMetadata = {
  messageId: string
  deliveryCount: number
}

/**
 * Shared handler for the `image_thumbnail` job. Invoked by both the Nitro
 * `vercel:queue` plugin (production) and the local BullMQ worker
 * (`scripts/devQueueWorker.ts`) — one source of truth for both runtimes,
 * mirroring `handlers/blurhash.ts`.
 *
 * Reads the original byte from the private store, renders a WebP, and writes
 * a *separate* asset to the public store at `thumbnails/{documentId}.webp`.
 * The original at `file.pathname` is never touched. Best-effort: a decode
 * failure writes the sentinel and acks (no retry churn); a transport failure
 * throws so the queue retries with backoff.
 */
export async function handleImageThumbnailMessage(
  msg: QueuePayloadMap['image_thumbnail'],
  metadata: ImageThumbnailJobMetadata,
): Promise<void> {
  const { documentId } = msg
  const log = logger.child({
    topic: 'image_thumbnail',
    documentId,
    messageId: metadata.messageId,
    deliveryCount: metadata.deliveryCount,
  })

  const row = await documentService.findActiveById(documentId)
  if (!row) {
    log.warn('image_thumbnail: document gone, skipping')
    return
  }
  if (row.document.thumbnailPathname !== null) {
    // Real pathname → already rendered; sentinel → render previously failed.
    // Either way the job is done; don't re-render.
    log.info('image_thumbnail: already processed, skipping')
    return
  }
  if (!SHARP_DECODABLE_MIME_SET.has(row.file.mime)) {
    // Producer gates on the same set; landing here means an undecodable mime
    // slipped through (e.g. HEIC). Skip without throwing so the queue acks.
    log.info('image_thumbnail: unsupported mime, skipping', { mime: row.file.mime })
    return
  }

  const url = await storage.getReadUrl(row.file.access, row.file.pathname, READ_URL_TTL_SECONDS)
  const res = await fetch(url)
  if (!res.ok) {
    // Transport failure — let the queue retry with backoff.
    throw new Error(`image_thumbnail: download failed ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  let webp: Buffer
  try {
    webp = await generateImageThumbnail(buf)
  } catch (error) {
    // The bytes themselves can't be rendered (corrupt, or a format the
    // prebuilt sharp binary rejects). Mark done with the sentinel so we stop
    // re-enqueuing, and ack rather than retry.
    await documentService.setThumbnailPathname({ documentId, pathname: RENDER_FAILED_SENTINEL })
    log.warn('image_thumbnail: render failed, sentinel written', { error })
    return
  }

  const pathname = thumbnailPathname(documentId)
  await storage.put('public', pathname, webp, 'image/webp')
  await documentService.setThumbnailPathname({ documentId, pathname })
  log.info('image_thumbnail: stored', { pathname, bytes: webp.byteLength })

  await realtime.publish({ kind: 'document.changed', ids: [documentId] })
}
