import { queue } from '~/lib/effects'
import type { QueuePayloadMap } from '~/lib/effects/queue/queue'
import { logger } from '~/lib/logger/server'
import type { SensorAlertTransition } from '~/lib/services/sensorAlert'
import { baseLocale, type Locale } from '~/paraglide/runtime'

/**
 * Emails each alert transition of an evaluation (a reading's or the silence cron's). Never
 * rejects: the transitions are already committed, so a failed publish is logged and the others
 * still go out. The queue payload is built here, one shape per alert family.
 */
export async function publishAlertTransitions(
  deviceId: string,
  transitions: SensorAlertTransition[],
): Promise<void> {
  await Promise.all(
    transitions.map((t) => {
      logger.info('sensor alert transition', {
        ruleId: t.ruleId,
        eventId: t.eventId,
        deviceId,
        kind: t.kind,
        transition: t.transition,
      })
      const base = {
        to: t.to,
        locale: baseLocale as Locale,
        transition: t.transition,
        sensorName: t.sensorName,
        since: t.since.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
      }
      const payload: QueuePayloadMap['email_sensor_alert'] =
        t.kind === 'silence'
          ? { ...base, kind: t.kind, silenceHours: t.silenceHours }
          : {
              ...base,
              kind: t.kind,
              direction: t.direction,
              threshold: t.threshold,
              count: t.count,
              value: t.value,
            }
      return Promise.resolve()
        .then(() => queue.publish('email_sensor_alert', payload))
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
}
