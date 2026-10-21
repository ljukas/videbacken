import { queue } from '~/lib/effects'
import { logger } from '~/lib/logger/server'
import { evaluateValueRules } from '~/lib/services/sensorAlert'
import { baseLocale } from '~/paraglide/runtime'

/**
 * Judges the device's value alert rules after a stored reading and emails each transition. Never
 * rejects: an alerting problem must not fail the webhook, which has already stored the reading.
 * The emails are published after the evaluation's transaction has committed, each with its own
 * catch so one failure doesn't stop the others.
 */
export async function evaluateAfterReading(deviceId: string, now = new Date()): Promise<void> {
  try {
    const transitions = await evaluateValueRules(deviceId, now)
    await Promise.all(
      transitions.map((t) => {
        logger.info('sensor alert transition', {
          ruleId: t.ruleId,
          eventId: t.eventId,
          deviceId,
          kind: t.kind,
          transition: t.transition,
        })
        return queue
          .publish('email_sensor_alert', {
            to: t.to,
            locale: baseLocale,
            transition: t.transition,
            sensorName: t.sensorName,
            kind: t.kind,
            direction: t.direction,
            threshold: t.threshold,
            count: t.count,
            value: t.value,
            since: t.since.toISOString(),
            endedAt: t.endedAt?.toISOString() ?? null,
          })
          .catch((error) =>
            logger.error('sensor alert email publish failed', {
              ruleId: t.ruleId,
              eventId: t.eventId,
              transition: t.transition,
              error,
            }),
          )
      }),
    )
  } catch (error) {
    logger.error('sensor alert evaluation failed', { deviceId, error })
  }
}
