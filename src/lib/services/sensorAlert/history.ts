import { and, desc, eq, lt, or } from 'drizzle-orm'
import { db } from '~/lib/db'
import { sensorAlertEvent } from '~/lib/db/schema'
import type { SensorAlertEventDto } from '~/lib/sensor/alerts'

export const ALERT_HISTORY_PAGE = 10

type Cursor = { startedAt: Date; id: string }

/** The user's alert history on one sensor, newest first, keyset-paged on (started_at, id). */
export async function listOwnHistory(
  userId: string,
  deviceId: string,
  before?: Cursor,
): Promise<{ entries: SensorAlertEventDto[]; next: Cursor | null }> {
  const rows = await db
    .select({
      id: sensorAlertEvent.id,
      kind: sensorAlertEvent.kind,
      direction: sensorAlertEvent.direction,
      threshold: sensorAlertEvent.threshold,
      count: sensorAlertEvent.count,
      silenceHours: sensorAlertEvent.silenceHours,
      startedAt: sensorAlertEvent.startedAt,
      endedAt: sensorAlertEvent.endedAt,
      endReason: sensorAlertEvent.endReason,
    })
    .from(sensorAlertEvent)
    .where(
      and(
        eq(sensorAlertEvent.userId, userId),
        eq(sensorAlertEvent.deviceId, deviceId),
        before
          ? or(
              lt(sensorAlertEvent.startedAt, before.startedAt),
              and(
                eq(sensorAlertEvent.startedAt, before.startedAt),
                lt(sensorAlertEvent.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(sensorAlertEvent.startedAt), desc(sensorAlertEvent.id))
    .limit(ALERT_HISTORY_PAGE + 1)
  const entries = rows.slice(0, ALERT_HISTORY_PAGE)
  const last = entries.at(-1)
  return {
    entries,
    next:
      rows.length > ALERT_HISTORY_PAGE && last ? { startedAt: last.startedAt, id: last.id } : null,
  }
}
