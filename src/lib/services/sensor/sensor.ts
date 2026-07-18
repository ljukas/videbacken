import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { SensorDomainError } from './errors'

// Lowercase + keep hex only, so "AA:BB:CC...", "aa-bb-cc..." and "aabbcc..."
// all resolve to one device.
export function normalizeMac(raw: string): string {
  return raw.toLowerCase().replace(/[^a-f0-9]/g, '')
}

// A normalized MAC must be a full 12-hex identity (Shelly emits a bare
// `${config.sys.device.mac}` of exactly 12 hex chars). Rejecting anything else
// stops garbage input (which strips to "" or a stub) from silently colliding
// distinct callers onto one phantom device row on the unique `mac` column.
const MAC_RE = /^[0-9a-f]{12}$/
export function isValidMac(normalized: string): boolean {
  return MAC_RE.test(normalized)
}

function displayNameFor(name: string | null, mac: string): string {
  return name ?? `Sensor ${mac.slice(-4)}`
}

export type RecordReadingInput = {
  mac: string
  temperatureC?: number | null
  humidityPct?: number | null
  batteryPct?: number | null
}

// Auto-registers the device by MAC (unknown → new unnamed row), inserts one
// reading, and bumps last-seen (+ battery when present) — all in one tx. A
// webhook without a battery reading keeps the previously-stored battery.
export async function recordReading(input: RecordReadingInput): Promise<{ deviceId: string }> {
  const mac = normalizeMac(input.mac)
  if (!isValidMac(mac)) throw new SensorDomainError('INVALID_MAC')
  const now = new Date()
  return db.transaction(async (tx) => {
    const updateSet: { lastSeenAt: Date; batteryPct?: number } = { lastSeenAt: now }
    if (input.batteryPct != null) updateSet.batteryPct = input.batteryPct
    const [device] = await tx
      .insert(sensorDevice)
      .values({ mac, lastSeenAt: now, batteryPct: input.batteryPct ?? null })
      .onConflictDoUpdate({ target: sensorDevice.mac, set: updateSet })
      .returning({ id: sensorDevice.id })
    // recordedAt set explicitly to the same `now` as lastSeenAt so the device's
    // last-seen and its newest reading timestamp are identical for one event.
    await tx.insert(sensorReading).values({
      deviceId: device.id,
      temperatureC: input.temperatureC ?? null,
      humidityPct: input.humidityPct ?? null,
      batteryPct: input.batteryPct ?? null,
      recordedAt: now,
    })
    return { deviceId: device.id }
  })
}

export type SensorReadingSnapshot = {
  temperatureC: number | null
  humidityPct: number | null
  recordedAt: Date
}

export type SensorDeviceRow = {
  id: string
  mac: string
  name: string | null
  location: string | null
  displayName: string
  batteryPct: number | null
  lastSeenAt: Date | null
  latest: SensorReadingSnapshot | null
}

// Devices (creation order) + their single most-recent reading, for the
// current-value tiles. Two queries + an in-memory join — trivial at 4 devices,
// and avoids any lateral-join API surprises.
export async function listDevices(): Promise<SensorDeviceRow[]> {
  // `id` tiebreaks createdAt so ordering is deterministic even if two devices
  // auto-register in the same instant.
  const devices = await db
    .select()
    .from(sensorDevice)
    .orderBy(sensorDevice.createdAt, sensorDevice.id)

  // DISTINCT ON (device_id) + this ORDER BY takes the newest reading per device;
  // `desc(id)` tiebreaks an exact recorded_at collision so the pick is stable.
  const latestRows = await db
    .selectDistinctOn([sensorReading.deviceId], {
      deviceId: sensorReading.deviceId,
      temperatureC: sensorReading.temperatureC,
      humidityPct: sensorReading.humidityPct,
      recordedAt: sensorReading.recordedAt,
    })
    .from(sensorReading)
    .orderBy(sensorReading.deviceId, desc(sensorReading.recordedAt), desc(sensorReading.id))

  const latestByDevice = new Map(latestRows.map((r) => [r.deviceId, r]))

  return devices.map((d) => {
    const latest = latestByDevice.get(d.id)
    return {
      id: d.id,
      mac: d.mac,
      name: d.name,
      location: d.location,
      displayName: displayNameFor(d.name, d.mac),
      batteryPct: d.batteryPct,
      lastSeenAt: d.lastSeenAt,
      latest: latest
        ? {
            temperatureC: latest.temperatureC,
            humidityPct: latest.humidityPct,
            recordedAt: latest.recordedAt,
          }
        : null,
    }
  })
}

export async function renameDevice(
  id: string,
  patch: { name: string | null; location: string | null },
): Promise<void> {
  const updated = await db
    .update(sensorDevice)
    .set({ name: patch.name, location: patch.location })
    .where(eq(sensorDevice.id, id))
    .returning({ id: sensorDevice.id })
  if (updated.length === 0) throw new SensorDomainError('DEVICE_NOT_FOUND')
}

export async function deleteDevice(id: string): Promise<void> {
  const deleted = await db
    .delete(sensorDevice)
    .where(eq(sensorDevice.id, id))
    .returning({ id: sensorDevice.id })
  if (deleted.length === 0) throw new SensorDomainError('DEVICE_NOT_FOUND')
}

export const SERIES_RANGES = ['24h', '1m', '3m', '6m', '1y', 'all'] as const
export type SeriesRange = (typeof SERIES_RANGES)[number]

export type SeriesBucket = {
  t: number
  perDevice: Record<string, { tempAvg: number | null; humAvg: number | null }>
}

const DAY = 86_400
// window (seconds) + bucket (seconds) per range. `all` is resolved dynamically.
const RANGE_CONFIG: Record<
  Exclude<SeriesRange, 'all'>,
  { windowSec: number; bucketSec: number }
> = {
  '24h': { windowSec: DAY, bucketSec: 600 }, //          10 min → ~144 pts
  '1m': { windowSec: 30 * DAY, bucketSec: 3 * 3600 }, //  3 h   → ~240 pts
  '3m': { windowSec: 90 * DAY, bucketSec: 12 * 3600 }, // 12 h  → ~180 pts
  '6m': { windowSec: 180 * DAY, bucketSec: DAY }, //      1 day → ~180 pts
  '1y': { windowSec: 365 * DAY, bucketSec: DAY }, //     1 day → ~365 pts
}

// Server-side time-bucketed averages, one series point per (device, bucket).
// Bucketing keeps the payload ~100-400 points regardless of range. `now` is
// injectable purely so tests are deterministic.
export async function getSeries(input: {
  range: SeriesRange
  deviceIds?: string[]
  now?: Date
}): Promise<{ buckets: SeriesBucket[] }> {
  const now = input.now ?? new Date()

  // Contract: `undefined` deviceIds = all devices; an explicit empty array =
  // "no devices selected" → empty result (never silently "show everything").
  if (input.deviceIds && input.deviceIds.length === 0) return { buckets: [] }
  const deviceFilter =
    input.deviceIds && input.deviceIds.length > 0
      ? inArray(sensorReading.deviceId, input.deviceIds)
      : undefined

  let sinceSec: number
  let bucketSec: number
  if (input.range === 'all') {
    // The min() MUST honor the same device + point-in-time filters as the main
    // query — otherwise an unrequested device's old data would dictate this
    // device's bucket width (daily vs weekly) and silently coarsen its series.
    const minFilters = [lte(sensorReading.recordedAt, now)]
    if (deviceFilter) minFilters.push(deviceFilter)
    const [{ first }] = await db
      .select({ first: sql<string | null>`min(${sensorReading.recordedAt})` })
      .from(sensorReading)
      .where(and(...minFilters))
    if (!first) return { buckets: [] }
    sinceSec = Math.floor(new Date(first).getTime() / 1000)
    const spanSec = Math.floor(now.getTime() / 1000) - sinceSec
    bucketSec = spanSec > 400 * DAY ? 7 * DAY : DAY // weekly if very long, else daily
  } else {
    const cfg = RANGE_CONFIG[input.range]
    sinceSec = Math.floor(now.getTime() / 1000) - cfg.windowSec
    bucketSec = cfg.bucketSec
  }
  const since = new Date(sinceSec * 1000)

  // Bounded on both sides: `now` is injectable for point-in-time correctness, so
  // a reading stamped after it must not leak in.
  const filters = [gte(sensorReading.recordedAt, since), lte(sensorReading.recordedAt, now)]
  if (deviceFilter) filters.push(deviceFilter)

  // epoch-floor bucketing — date_trunc can't do arbitrary 10-min / 3-h widths.
  const bucketExpr = sql<Date>`to_timestamp(floor(extract(epoch from ${sensorReading.recordedAt}) / ${bucketSec}) * ${bucketSec})`

  const rows = await db
    .select({
      deviceId: sensorReading.deviceId,
      bucket: bucketExpr,
      tempAvg: sql<number | null>`avg(${sensorReading.temperatureC})`,
      humAvg: sql<number | null>`avg(${sensorReading.humidityPct})`,
    })
    .from(sensorReading)
    .where(and(...filters))
    // Group/order by the SELECT's 2nd column (the bucket) positionally: drizzle
    // renders the bucket expression with a qualified column in GROUP BY but an
    // unqualified one in SELECT, which Postgres rejects as a mismatch. Ordinals
    // reference the SELECT position, so the expression is written exactly once.
    .groupBy(sensorReading.deviceId, sql`2`)
    .orderBy(sql`2`)

  const byBucket = new Map<number, SeriesBucket>()
  for (const r of rows) {
    const t = new Date(r.bucket).getTime()
    let bucket = byBucket.get(t)
    if (!bucket) {
      bucket = { t, perDevice: {} }
      byBucket.set(t, bucket)
    }
    bucket.perDevice[r.deviceId] = {
      tempAvg: r.tempAvg == null ? null : Number(r.tempAvg),
      humAvg: r.humAvg == null ? null : Number(r.humAvg),
    }
  }
  return { buckets: [...byBucket.values()].sort((a, b) => a.t - b.t) }
}
