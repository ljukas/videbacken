import './loadEnv'

import { Worker } from 'bullmq'
import type { QueueTopic } from '~/lib/effects/queue/queue'
import { logger } from '~/lib/logger/server'
import { dispatchQueueMessage, queueHandlers } from '~/lib/queue'

/**
 * Local-dev consumer for the background-job topics. Run via
 * `bun run dev:worker`. Connects to the Redis container declared in
 * `compose.yaml` (started by `bun run queue:up`) and hands each job to the
 * same dispatcher the Nitro `vercel:queue` plugin uses in production
 * (`server/plugins/queueConsumer.ts`), which logs one `queue message` line per
 * job and decides retry vs drop. BullMQ owns polling, ack, redelivery with
 * backoff (configured on the producer in `bullmqQueue.ts`), and graceful
 * shutdown.
 *
 * One BullMQ `Worker` per topic in the handler table — they share one Redis
 * connection url and one process, mirroring the single prod consumer.
 */
const log = logger.child({ component: 'devQueueWorker' })
const url = process.env.REDIS_URL ?? 'redis://localhost:14621'

const topics = Object.keys(queueHandlers) as QueueTopic[]

const workers = topics.map(
  (topic) =>
    new Worker(
      topic,
      (job) =>
        dispatchQueueMessage(topic, job.data, {
          messageId: job.id ?? 'local-unknown',
          deliveryCount: job.attemptsMade + 1,
        }),
      { connection: { url } },
    ),
)

for (const worker of workers) {
  // Job outcomes are logged by the dispatcher; this covers the worker's own
  // failures (e.g. lost Redis connection).
  worker.on('error', (error) => log.error('worker error', { topic: worker.name, error }))
}

log.info('worker ready', { topics, url })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info('worker shutting down', { signal: sig })
    await Promise.all(workers.map((w) => w.close()))
    process.exit(0)
  })
}
