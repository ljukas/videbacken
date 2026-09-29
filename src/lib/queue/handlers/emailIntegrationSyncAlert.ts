import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

/**
 * Handler for the `email_integration_sync_alert` job, dispatched by
 * `~/lib/queue` in both the production consumer and the local BullMQ worker.
 *
 * The sync run (`src/lib/evCharging/sync.ts`) publishes one message per admin
 * on the first failure of a streak and again on recovery — never on every
 * failed run — so this handler is a thin send, same shape as
 * `emailUserInvited.ts`. A throw here lets the queue retry the SMTP/Resend
 * send. See ADR-0007 (queue) / ADR-0008 (email) / ADR-0019 (integrations).
 */
export async function handleEmailIntegrationSyncAlertMessage(
  msg: QueuePayloadMap['email_integration_sync_alert'],
  { log }: QueueHandlerContext,
): Promise<void> {
  await email.sendIntegrationSyncAlert({
    to: msg.to,
    source: msg.source,
    transition: msg.transition,
    code: msg.code,
    failingSince: msg.failingSince,
    locale: msg.locale,
  })
  log.info('integration sync alert email dispatched')
}

export const emailIntegrationSyncAlertHandler: QueueHandler<'email_integration_sync_alert'> = {
  handle: handleEmailIntegrationSyncAlertMessage,
  logFields: (msg) => ({ to: msg.to, source: msg.source, transition: msg.transition }),
}
