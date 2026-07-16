import { storage } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { generateBlurhash, SHARP_DECODABLE_MIME_SET } from '~/lib/image/blurhash'
import { logger } from '~/lib/logger/server'
import * as fileService from '~/lib/services/file'
import * as userService from '~/lib/services/user'

const READ_URL_TTL_SECONDS = 60

export type BlurhashJobMetadata = {
  messageId: string
  deliveryCount: number
}

/**
 * Shared handler for the `blurhash` job. Invoked by both the Nitro
 * `vercel:queue` plugin (production) and the local BullMQ worker
 * (`scripts/devQueueWorker.ts`) so a single source of truth backs both
 * runtimes.
 *
 * The producer carries the `kind` of the file in the payload so downstream
 * side-effects (mirroring onto `user.image_blurhash`, etc.) are explicit at
 * publish time rather than inferred from the file row. We re-fetch the row
 * inside the handler to mint a fresh signed URL — so an expired URL is
 * never trusted and a soft-delete that races the job is a clean no-op.
 *
 * `generateBlurhash` dynamic-imports `sharp` + `blurhash` itself, so the
 * heavy native modules only load on the first message — importing the
 * wrapper statically here doesn't drag them into the bundle.
 */
export async function handleBlurhashMessage(
  msg: QueuePayloadMap['blurhash'],
  metadata: BlurhashJobMetadata,
): Promise<void> {
  const { fileId } = msg
  const log = logger.child({
    topic: 'blurhash',
    kind: msg.kind,
    fileId,
    messageId: metadata.messageId,
    deliveryCount: metadata.deliveryCount,
  })

  const row = await fileService.findActiveById(fileId)
  if (!row) {
    log.warn('blurhash: file gone, skipping')
    return
  }
  if (row.blurhash) {
    log.info('blurhash: already set, skipping')
    return
  }
  if (!SHARP_DECODABLE_MIME_SET.has(row.mime)) {
    // Skip without throwing so the queue acks the message instead of
    // retrying. Producers gate on the same set; landing here means a mime
    // arrived that the prebuilt sharp binary can't decode (e.g. raw HEIC,
    // which the `heic_transcode` worker handles instead).
    log.info('blurhash: unsupported mime, skipping', { mime: row.mime })
    return
  }

  const url = await storage.getReadUrl(row.access, row.pathname, READ_URL_TTL_SECONDS)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`blurhash: download failed ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  const hash = await generateBlurhash(buf)

  await fileService.setBlurhash({ fileId, blurhash: hash })
  log.info('blurhash: stored', { length: hash.length })

  if (msg.kind === 'avatar') {
    const denormalized = await userService.setImageBlurhash(msg.userId, hash)
    if (denormalized) {
      log.info('blurhash: denormalized to user.imageBlurhash', { userId: msg.userId })
    } else {
      log.warn('blurhash: target user gone, skipped denormalization', { userId: msg.userId })
    }
  }
}
