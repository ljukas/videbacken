import { definePlugin } from 'nitro'

/**
 * Vercel Queues consumer. Wired by Nitro's vercel preset via
 * `vercel.queues.triggers` in vite.config.ts (one trigger per topic). The
 * dispatcher (`~/lib/queue`) owns handler lookup, the one-line outcome log,
 * and retry-vs-drop — the same module the local BullMQ worker
 * (`scripts/devQueueWorker.ts`) calls. A throw from here makes Vercel redeliver;
 * returning acks.
 *
 * The dispatcher is imported on the first message, not with the plugin: Nitro
 * bundles plugins apart from the app, so a static import would load a second
 * copy of ~/lib/db (and its pool) on every instance at init. Only an instance
 * that consumes a message loads that copy (server-latency roadmap row 9).
 */
export default definePlugin((nitro) => {
  nitro.hooks.hook('vercel:queue', async ({ message, metadata }) => {
    const { dispatchQueueMessage } = await import('~/lib/queue')
    await dispatchQueueMessage(metadata.topicName, message, {
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
    })
  })
})
