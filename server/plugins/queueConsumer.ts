import { definePlugin } from 'nitro'
import { dispatchQueueMessage } from '~/lib/queue'

/**
 * Vercel Queues consumer. Wired by Nitro's vercel preset via
 * `vercel.queues.triggers` in vite.config.ts (one trigger per topic). The
 * dispatcher (`~/lib/queue`) owns handler lookup, the one-line outcome log,
 * and retry-vs-drop — the same module the local BullMQ worker
 * (`scripts/devQueueWorker.ts`) calls. A throw from here makes Vercel redeliver;
 * returning acks.
 */
export default definePlugin((nitro) => {
  nitro.hooks.hook('vercel:queue', async ({ message, metadata }) => {
    await dispatchQueueMessage(metadata.topicName, message, {
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
    })
  })
})
