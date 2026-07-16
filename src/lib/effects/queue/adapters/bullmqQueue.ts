import { Queue } from 'bullmq'
import type { QueueEffects, QueueTopic } from '../queue'

/**
 * Local-dev producer adapter backed by BullMQ + Redis. Selected by
 * `pickAdapter()` when `REDIS_URL` is set. The matching consumer is the
 * standalone worker at `scripts/devQueueWorker.ts`, which calls the
 * same handler the Nitro `vercel:queue` plugin uses in production.
 *
 * One Queue instance per topic, lazily created at first publish, kept at
 * module scope so we don't reopen a Redis connection per call.
 */
const queues = new Map<QueueTopic, Queue>()

function getQueue(topic: QueueTopic): Queue {
  const existing = queues.get(topic)
  if (existing) return existing
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error('REDIS_URL is not set; cannot use the bullmqQueue adapter.')
  }
  const queue = new Queue(topic, { connection: { url } })
  queues.set(topic, queue)
  return queue
}

export const bullmqQueue: QueueEffects = {
  async publish(topic, payload) {
    await getQueue(topic).add(topic, payload, {
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
    })
  },
}
