import type {
  CredentialReminderDays,
  ExpiringCredentialSource,
  IntegrationErrorCode,
  IntegrationSource,
} from '~/lib/integrationHealth'
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
export type QueueTopic =
  | 'blurhash'
  | 'email_user_invited'
  | 'heic_transcode'
  | 'email_integration_sync_alert'
  | 'email_grid_tariff_available'
  | 'email_credential_expiry'

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
  // Integration sync health alert (tier-3): published by the shared pulled-sync
  // lifecycle (`src/lib/integrations/runPulledSync.ts`) for every pulled
  // integration (Zaptec, elpris), one message per admin, on the first
  // failure of a streak and again on recovery — never on every failed run
  // (see `src/lib/integrationHealth.ts` and ADR-0019). `code`/`failingSince`
  // are null on `recovered` (health is back to `ok`, nothing to explain).
  email_integration_sync_alert: {
    to: string
    source: IntegrationSource
    transition: 'started_failing' | 'recovered'
    code: IntegrationErrorCode | null
    failingSince: string | null // ISO
    locale: Locale
  }
  // Grid-tariff watcher notice (tier-3): published by the monthly Eltariff
  // catalogue check (`src/lib/gridTariff/catalogueCheck.ts`), one message per
  // admin, on every run that finds our facility covered. Carries only the
  // company's name — never the facility ID.
  email_grid_tariff_available: {
    to: string
    companyName: string | null
    locale: Locale
  }
  // Expiring-credential reminder (tier-3): published by the Škoda sync at the
  // 30/7-day thresholds, one per admin; a redelivery can repeat a send —
  // acceptable for an admin reminder.
  email_credential_expiry: {
    to: string
    source: ExpiringCredentialSource
    expiresAt: string // ISO
    days: CredentialReminderDays
    locale: Locale
  }
}

/**
 * How many times a message is delivered before the dispatcher gives up and
 * drops it (`src/lib/queue/dispatch.ts`). Vercel Queues itself has no
 * max-delivery count — a throwing handler would be retried until the message
 * expires (24 h) — and the dev BullMQ producer uses the same number as its
 * `attempts`, so prod and dev give up at the same point.
 */
export const QUEUE_MAX_DELIVERIES = 5

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
