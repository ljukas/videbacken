import { and, asc, gte, inArray } from 'drizzle-orm'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { typicalGapMinutes } from '~/lib/sensor/alertGroups'

const WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * Each device's typical gap between merged readings over the 7 days before `now`, in minutes
 * (the form's "about N minutes per reading" hint). A device with under two readings is null.
 */
export async function typicalGapsByDevice(now: Date): Promise<Record<string, number | null>> {
  const devices = await db.select({ id: sensorDevice.id }).from(sensorDevice)
  if (devices.length === 0) return {}
  // Filter by device id first so the (device_id, recorded_at) index serves the range scan.
  const readings = await db
    .select({ deviceId: sensorReading.deviceId, recordedAt: sensorReading.recordedAt })
    .from(sensorReading)
    .where(
      and(
        inArray(
          sensorReading.deviceId,
          devices.map((d) => d.id),
        ),
        gte(sensorReading.recordedAt, new Date(now.getTime() - WINDOW_MS)),
      ),
    )
    .orderBy(asc(sensorReading.deviceId), asc(sensorReading.recordedAt))
  const byDevice = new Map<string, { recordedAt: Date }[]>()
  for (const r of readings) {
    const list = byDevice.get(r.deviceId)
    if (list) list.push(r)
    else byDevice.set(r.deviceId, [r])
  }
  return Object.fromEntries(devices.map((d) => [d.id, typicalGapMinutes(byDevice.get(d.id) ?? [])]))
}
