import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

/**
 * Handler for the `email_user_invited` job, dispatched by `~/lib/queue` in both
 * the production consumer and the local BullMQ worker.
 *
 * The payload carries the already-built /login link (see ADR-0017 amendment —
 * invites are approved_email allowlist rows, not a minted token) plus the
 * recipient and locale, so the handler is a thin send. A throw here lets the
 * queue retry the SMTP/Resend send. See ADR-0007 (queue) / ADR-0008 (email) /
 * ADR-0017 (invitations).
 */
export async function handleEmailUserInvitedMessage(
  msg: QueuePayloadMap['email_user_invited'],
  { log }: QueueHandlerContext,
): Promise<void> {
  await email.sendUserInvited({ to: msg.to, inviteUrl: msg.inviteUrl, locale: msg.locale })
  log.info('invite email dispatched')
}

export const emailUserInvitedHandler: QueueHandler<'email_user_invited'> = {
  handle: handleEmailUserInvitedMessage,
  logFields: (msg) => ({ to: msg.to }),
}
