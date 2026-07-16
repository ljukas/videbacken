import type { Locale } from '~/paraglide/runtime'
import { lazy } from '../lazy'

/**
 * Background-job queue interface. Producers (oRPC procedures) call
 * `publish('<topic>', payload)` after the synchronous service call lands.
 * The Nitro Vercel preset routes inbound messages to the `vercel:queue`
 * hook (see `server/plugins/queueConsumer.ts`).
 *
 * `topic` is typed as a string union of currently-used topics — extend
 * the union when adding new background jobs. Adapter selection happens on
 * first publish via dynamic import so each runtime only ships the adapter
 * it actually uses (BullMQ stays out of the prod Nitro bundle, etc.).
 */
export type QueueTopic = 'blurhash' | 'email_user_invited' | 'heic_transcode'

/**
 * Per-topic payload shape. The blurhash payload carries a `kind` discriminant
 * so the consumer can dispatch downstream side effects (e.g. mirroring onto
 * `user.image_blurhash`) without introspecting the file row — job semantics
 * live in the message, not in storage layout. Today the only producer is the
 * avatar upload flow; the `kind` field is kept (rather than dropped) so a
 * future second producer (e.g. another image-bearing domain) can extend the
 * union without reshaping the handler's dispatch.
 */
export type QueuePayloadMap = {
  blurhash: { fileId: string; kind: 'avatar'; userId: string }
  // Invite email (tier-3): `inviteUrl` is just the app's /login link (see
  // ADR-0017 amendment — invites are approved_email allowlist rows, not a
  // minted token) — the oRPC `user.invite`/`resendInvite` procedures enqueue
  // this so the SMTP/Resend send happens off the admin's request with
  // retry/backoff.
  email_user_invited: { to: string; inviteUrl: string; locale: Locale }
  // HEIC→JPEG transcode: replaces the file with a JPEG (write, repoint the
  // row, delete the original). `userId` carries the avatar's user so the
  // worker can repoint user.image without a session.
  heic_transcode: { fileId: string; kind: 'avatar'; userId: string }
}

export interface QueueEffects {
  publish<T extends QueueTopic>(topic: T, payload: QueuePayloadMap[T]): Promise<void>
}

const getAdapter = lazy(async (): Promise<QueueEffects> => {
  if (process.env.VITEST === 'true') {
    return (await import('./adapters/devLog')).devLog
  }
  // Local dev: when REDIS_URL is set we route through BullMQ so a real
  // worker (`scripts/devQueueWorker.ts`) can consume the queue out of
  // band. Mirrors the prod topology in shape (durable broker, separate
  // consumer process, retries) without depending on a Vercel runtime.
  if (process.env.REDIS_URL) {
    return (await import('./adapters/bullmqQueue')).bullmqQueue
  }
  if (!process.env.VERCEL) {
    return (await import('./adapters/devLog')).devLog
  }
  return (await import('./adapters/vercelQueue')).vercelQueue
})

export const queue: QueueEffects = {
  async publish(topic, payload) {
    const adapter = await getAdapter()
    await adapter.publish(topic, payload)
  },
}
