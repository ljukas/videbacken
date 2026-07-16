import { queue, realtime, storage } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { HEIC_MIME } from '~/lib/image/heicMime'
import { transcodeHeicToJpeg } from '~/lib/image/heicTranscode'
import { logger } from '~/lib/logger/server'
import * as fileService from '~/lib/services/file'
import * as userService from '~/lib/services/user'

const READ_URL_TTL_SECONDS = 60

export type HeicTranscodeJobMetadata = { messageId: string; deliveryCount: number }

/**
 * Shared handler for the `heic_transcode` job (Nitro `vercel:queue` plugin in
 * prod + the dev BullMQ worker — one source of truth for both runtimes, like
 * `handlers/blurhash.ts`).
 *
 * Decodes the uploaded HEIC and REPLACES the file with a JPEG (write the JPEG,
 * repoint the row, delete the original). Best-effort: a transport failure
 * (download) throws so the queue retries with backoff; an undecodable file
 * stamps `transcode_failed_at` and acks so we stop retrying.
 */
export async function handleHeicTranscodeMessage(
  msg: QueuePayloadMap['heic_transcode'],
  metadata: HeicTranscodeJobMetadata,
): Promise<void> {
  const { fileId, kind } = msg
  const log = logger.child({
    topic: 'heic_transcode',
    kind,
    fileId,
    messageId: metadata.messageId,
    deliveryCount: metadata.deliveryCount,
  })

  const row = await fileService.findActiveById(fileId)
  if (!row) {
    log.warn('heic_transcode: file gone, skipping')
    return
  }
  if (!HEIC_MIME.has(row.mime)) {
    // Already transcoded (idempotent re-delivery) or never HEIC — ack, don't retry.
    log.info('heic_transcode: already transcoded, skipping', { mime: row.mime })
    return
  }
  if (row.transcodeFailedAt) {
    log.info('heic_transcode: previously failed, skipping')
    return
  }

  const url = await storage.getReadUrl(row.access, row.pathname, READ_URL_TTL_SECONDS)
  const res = await fetch(url)
  if (!res.ok) {
    // Transport failure — let the queue retry with backoff.
    throw new Error(`heic_transcode: download failed ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  let jpeg: Buffer
  try {
    jpeg = await transcodeHeicToJpeg(buf)
  } catch (error) {
    // Undecodable bytes — mark permanently failed and ack (no retry churn). Still
    // notify subscribers so a failed/placeholder state can render.
    await fileService.setTranscodeFailed(fileId)
    log.warn('heic_transcode: decode failed, marked failed', { error })
    await realtime.publish({ kind: 'user.changed', ids: [msg.userId] })
    return
  }

  const jpegPath = toJpegPathname(row.pathname)
  await storage.put(row.access, jpegPath, jpeg, 'image/jpeg')
  await fileService.replaceTranscoded({
    fileId,
    pathname: jpegPath,
    mime: 'image/jpeg',
    sizeBytes: jpeg.byteLength,
  })
  // Defensive backstop for the `toJpegPathname` invariant: if the original
  // pathname lacked a `.heic`/`.heif` suffix the regex no-ops, so `jpegPath`
  // equals `row.pathname` and the JPEG we just wrote *is* the original key —
  // deleting it would erase the transcode. Not reachable today (producers
  // always mint the suffix); warn and skip the delete rather than throw (a
  // throw would re-enqueue and re-run the whole job). Always enqueue blurhash.
  const wouldEraseJpeg = jpegPath === row.pathname
  if (wouldEraseJpeg) {
    log.warn('heic_transcode: jpeg path equals original, skipping delete', {
      pathname: row.pathname,
    })
  }
  // Independent, both already non-throwing — delete the original HEIC (unless
  // doing so would erase the JPEG) and enqueue the blurhash backstop concurrently.
  await Promise.all([
    wouldEraseJpeg
      ? Promise.resolve()
      : storage
          .delete(row.access, row.pathname)
          .catch((error) => log.warn('heic_transcode: failed to delete original HEIC', { error })),
    queue
      .publish('blurhash', { fileId, kind: 'avatar', userId: msg.userId })
      .catch((error) => log.warn('heic_transcode: blurhash enqueue failed', { error })),
  ])

  const blob = await storage.head(row.access, jpegPath)
  if (blob) await userService.setImage(msg.userId, blob.url)
  await realtime.publish({ kind: 'user.changed', ids: [msg.userId] })
  log.info('heic_transcode: replaced with JPEG', { jpegPath })
}

// Swaps a `.heic`/`.heif` suffix for `.jpg`. INVARIANT: the upload producers
// always mint a `.heic`/`.heif` extension (see imageUpload), so the suffix is
// present and the result differs from the input. If it ever didn't, the regex
// no-ops and `jpegPath === row.pathname` — the replace branch guards against
// that before deleting the original (a delete would erase the just-written JPEG).
const toJpegPathname = (p: string) => p.replace(/\.(heic|heif)$/i, '.jpg')
