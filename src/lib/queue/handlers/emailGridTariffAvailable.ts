import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

/**
 * Handler for the `email_grid_tariff_available` job, dispatched by `~/lib/queue`
 * in both the production consumer and the local BullMQ worker.
 *
 * The monthly Eltariff catalogue check publishes one message per admin when our
 * facility is covered, so this is a thin send, same shape as
 * `emailIntegrationSyncAlert.ts`. A throw lets the queue retry the send.
 */
export async function handleEmailGridTariffAvailableMessage(
  msg: QueuePayloadMap['email_grid_tariff_available'],
  { log }: QueueHandlerContext,
): Promise<void> {
  await email.sendGridTariffAvailable({
    to: msg.to,
    companyName: msg.companyName,
    locale: msg.locale,
  })
  log.info('grid tariff available email dispatched')
}

export const emailGridTariffAvailableHandler: QueueHandler<'email_grid_tariff_available'> = {
  handle: handleEmailGridTariffAvailableMessage,
  logFields: (msg) => ({ to: msg.to }),
}
