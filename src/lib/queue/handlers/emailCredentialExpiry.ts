import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

/** Thin send for `email_credential_expiry` (same shape as emailGridTariffAvailable.ts). */
export async function handleEmailCredentialExpiryMessage(
  msg: QueuePayloadMap['email_credential_expiry'],
  { log }: QueueHandlerContext,
): Promise<void> {
  await email.sendCredentialExpiry({
    to: msg.to,
    source: msg.source,
    expiresAt: msg.expiresAt,
    days: msg.days,
    locale: msg.locale,
  })
  log.info('credential expiry email dispatched')
}

export const emailCredentialExpiryHandler: QueueHandler<'email_credential_expiry'> = {
  handle: handleEmailCredentialExpiryMessage,
  logFields: (msg) => ({ to: msg.to, source: msg.source, days: msg.days }),
}
