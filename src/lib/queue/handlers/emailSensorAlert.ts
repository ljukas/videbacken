import { email } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import type { QueueHandler, QueueHandlerContext } from '~/lib/queue/dispatch'

/** Thin send for `email_sensor_alert` (same shape as emailCredentialExpiry.ts). */
export async function handleEmailSensorAlertMessage(
  msg: QueuePayloadMap['email_sensor_alert'],
  { log }: QueueHandlerContext,
): Promise<void> {
  await email.sendSensorAlert(msg)
  log.info('sensor alert email dispatched')
}

export const emailSensorAlertHandler: QueueHandler<'email_sensor_alert'> = {
  handle: handleEmailSensorAlertMessage,
  logFields: (msg) => ({ to: msg.to, transition: msg.transition, kind: msg.kind }),
}
