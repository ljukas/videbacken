import { definePlugin } from 'nitro'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { handleBlurhashMessage } from '~/lib/queue/handlers/blurhash'
import { handleEmailUserInvitedMessage } from '~/lib/queue/handlers/emailUserInvited'
import { handleHeicTranscodeMessage } from '~/lib/queue/handlers/heicTranscode'
import { handleImageThumbnailMessage } from '~/lib/queue/handlers/imageThumbnail'

/**
 * Vercel Queues consumer. Wired by Nitro's vercel preset via
 * `vercel.queues.triggers` in vite.config.ts (one trigger per topic). The
 * real work lives in `~/lib/queue/handlers/*` so the local BullMQ worker
 * (`scripts/devQueueWorker.ts`) can call the exact same functions.
 */
export default definePlugin((nitro) => {
  nitro.hooks.hook('vercel:queue', async ({ message, metadata }) => {
    const meta = { messageId: metadata.messageId, deliveryCount: metadata.deliveryCount }
    switch (metadata.topicName) {
      case 'blurhash':
        await handleBlurhashMessage(message as QueuePayloadMap['blurhash'], meta)
        return
      case 'image_thumbnail':
        await handleImageThumbnailMessage(message as QueuePayloadMap['image_thumbnail'], meta)
        return
      case 'email_user_invited':
        await handleEmailUserInvitedMessage(message as QueuePayloadMap['email_user_invited'], meta)
        return
      case 'heic_transcode':
        await handleHeicTranscodeMessage(message as QueuePayloadMap['heic_transcode'], meta)
        return
      default:
        return
    }
  })
})
