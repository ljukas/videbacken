import './loadEnv'

import { Worker } from 'bullmq'
import type { QueuePayloadMap, QueueTopic } from '~/lib/effects/queue/queue'
import { logger } from '~/lib/logger/server'
import { handleBlurhashMessage } from '~/lib/queue/handlers/blurhash'
import { handleEmailUserInvitedMessage } from '~/lib/queue/handlers/emailUserInvited'
import { handleHeicTranscodeMessage } from '~/lib/queue/handlers/heicTranscode'
import { handleImageThumbnailMessage } from '~/lib/queue/handlers/imageThumbnail'

/**
 * Local-dev consumer for the background-job topics. Run via
 * `pnpm dev:worker`. Connects to the Redis container declared in
 * `compose.yaml` (started by `pnpm queue:up`) and dispatches each job
 * through the same handlers the Nitro `vercel:queue` plugin uses in
 * production (`server/plugins/queueConsumer.ts`). BullMQ owns polling, ack,
 * retry/backoff (configured on the producer in `bullmqQueue.ts`), and
 * graceful shutdown.
 *
 * One BullMQ `Worker` per topic — they share one Redis connection url and
 * one process, mirroring the single prod consumer that dispatches by topic.
 */
const log = logger.child({ component: 'devQueueWorker' })
const url = process.env.REDIS_URL ?? 'redis://localhost:14521'

const workers = [
  new Worker<QueuePayloadMap['blurhash']>(
    'blurhash',
    async (job) => {
      await handleBlurhashMessage(job.data, {
        messageId: job.id ?? 'local-unknown',
        deliveryCount: job.attemptsMade + 1,
      })
    },
    { connection: { url } },
  ),
  new Worker<QueuePayloadMap['image_thumbnail']>(
    'image_thumbnail',
    async (job) => {
      await handleImageThumbnailMessage(job.data, {
        messageId: job.id ?? 'local-unknown',
        deliveryCount: job.attemptsMade + 1,
      })
    },
    { connection: { url } },
  ),
  new Worker<QueuePayloadMap['email_user_invited']>(
    'email_user_invited',
    async (job) => {
      await handleEmailUserInvitedMessage(job.data, {
        messageId: job.id ?? 'local-unknown',
        deliveryCount: job.attemptsMade + 1,
      })
    },
    { connection: { url } },
  ),
  new Worker<QueuePayloadMap['heic_transcode']>(
    'heic_transcode',
    async (job) => {
      await handleHeicTranscodeMessage(job.data, {
        messageId: job.id ?? 'local-unknown',
        deliveryCount: job.attemptsMade + 1,
      })
    },
    { connection: { url } },
  ),
]

for (const worker of workers) {
  const topic = worker.name as QueueTopic
  worker.on('completed', (job) => log.info('job completed', { topic, jobId: job.id }))
  worker.on('failed', (job, err) =>
    log.error('job failed', { topic, jobId: job?.id, attempts: job?.attemptsMade, err }),
  )
  worker.on('error', (err) => log.error('worker error', { topic, err }))
}

log.info('worker ready', { topics: workers.map((w) => w.name), url })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info('worker shutting down', { signal: sig })
    await Promise.all(workers.map((w) => w.close()))
    process.exit(0)
  })
}
