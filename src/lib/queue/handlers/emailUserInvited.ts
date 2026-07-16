import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { logger } from '~/lib/logger/server'

export type EmailUserInvitedJobMetadata = {
  messageId: string
  deliveryCount: number
}

/**
 * Shared handler for the `email_user_invited` job. Invoked by both the Nitro
 * `vercel:queue` plugin (production) and the local BullMQ worker
 * (`scripts/devQueueWorker.ts`), so one function backs both runtimes.
 *
 * The payload carries the already-generated verify-email link (built by Better
 * Auth's `sendVerificationEmail` hook in src/lib/auth.ts) plus the recipient
 * and locale, so the handler is a thin send — all auth/token work happened on
 * the producer side. A throw here lets the queue retry the SMTP/Resend send.
 * See ADR-0007 (queue) / ADR-0008 (email) / ADR-0017 (invitations).
 */
export async function handleEmailUserInvitedMessage(
  msg: QueuePayloadMap['email_user_invited'],
  metadata: EmailUserInvitedJobMetadata,
): Promise<void> {
  const log = logger.child({
    topic: 'email_user_invited',
    to: msg.to,
    messageId: metadata.messageId,
    deliveryCount: metadata.deliveryCount,
  })

  await email.sendUserInvited({ to: msg.to, inviteUrl: msg.inviteUrl, locale: msg.locale })
  log.info('invite email dispatched')
}
