import { logger } from '~/lib/logger/server'
import { evaluateReading } from '~/lib/services/sensorAlert'
import { publishAlertTransitions } from './publishAlertTransitions'

/**
 * Judges the device's alert rules after a stored reading and emails each transition. Never
 * rejects: an alerting problem must not fail the webhook, which has already stored the reading.
 * The emails are published after the evaluation's transaction has committed.
 */
export async function evaluateAfterReading(deviceId: string, now = new Date()): Promise<void> {
  try {
    await publishAlertTransitions(deviceId, await evaluateReading(deviceId, now))
  } catch (error) {
    logger.error('sensor alert evaluation failed', { deviceId, error })
  }
}
