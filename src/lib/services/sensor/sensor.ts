import { and, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { SERIES_RANGES, type SeriesRange } from '~/lib/sensor/range'
import { SensorDomainError } from './errors'

// Re-exported so server-side consumers (procedures, tests) still get the range
// enum from the service barrel. The client route imports it from
// `~/lib/sensor/range` directly to avoid pulling this (db-importing) module.
export { SERIES_RANGES, type SeriesRange }

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

export type SeriesBucket = {
  t: number
  perDevice: Record<string, { tempAvg: number | null; humAvg: number | null }>
}

type SeriesWindow = { since: Date; bucketSec: number }

type BucketRow = {
  deviceId: string
  bucket: Date
  tempAvg: number | null
  humAvg: number | null
}

const DAY_SEC = 86_400

// Fixed ranges → lookback window + bucket width, chosen so each range yields a
// bounded number of points (~100-400). `all` is resolved from the data instead.
const FIXED_RANGES: Record<
  Exclude<SeriesRange, 'all'>,
  { windowSec: number; bucketSec: number }
> = {
  '24h': { windowSec: DAY_SEC, bucketSec: 600 }, // 10 min → ~144 pts
  '1m': { windowSec: 30 * DAY_SEC, bucketSec: 3 * 3600 }, // 3 h → ~240 pts
  '3m': { windowSec: 90 * DAY_SEC, bucketSec: 12 * 3600 }, // 12 h → ~180 pts
  '6m': { windowSec: 180 * DAY_SEC, bucketSec: DAY_SEC }, // 1 day → ~180 pts
  '1y': { windowSec: 365 * DAY_SEC, bucketSec: DAY_SEC }, // 1 day → ~365 pts
}

// Restrict to the requested devices; `undefined`/empty means no restriction.
function deviceFilter(deviceIds: string[] | undefined): SQL | undefined {
  return deviceIds && deviceIds.length > 0 ? inArray(sensorReading.deviceId, deviceIds) : undefined
}

// Earliest reading at-or-before `now`, restricted to the SAME device filter as
// the main query. Threading the filter through is load-bearing: for the `all`
// range this timestamp fixes the span that picks daily-vs-weekly bucketing, so
// an unrequested device's older data must not be allowed to coarsen this
// device's series. null = no matching readings.
async function earliestReadingAt(now: Date, filter: SQL | undefined): Promise<Date | null> {
  const [{ first }] = await db
    .select({ first: sql<string | null>`min(${sensorReading.recordedAt})` })
    .from(sensorReading)
    .where(and(lte(sensorReading.recordedAt, now), filter))
  return first ? new Date(first) : null
}

// The [since, bucketSec] window for a range. `now` (and the earliest reading for
// `all`) is floored to whole seconds before the window math, so `since` always
// lands on a second boundary regardless of `now`'s sub-second component. `all`
// spans from the first matching reading and widens to weekly buckets past ~400
// days to keep the point count bounded; null when there's nothing to show.
async function resolveWindow(
  range: SeriesRange,
  now: Date,
  filter: SQL | undefined,
): Promise<SeriesWindow | null> {
  const nowSec = Math.floor(now.getTime() / 1000)
  if (range !== 'all') {
    const { windowSec, bucketSec } = FIXED_RANGES[range]
    return { since: new Date((nowSec - windowSec) * 1000), bucketSec }
  }
  const first = await earliestReadingAt(now, filter)
  if (!first) return null
  const sinceSec = Math.floor(first.getTime() / 1000)
  const spanSec = nowSec - sinceSec
  return {
    since: new Date(sinceSec * 1000),
    bucketSec: spanSec > 400 * DAY_SEC ? 7 * DAY_SEC : DAY_SEC,
  }
}

// One row per (device, bucket) with the bucket's average temperature/humidity.
// Bounded on both sides: `now` is injectable for point-in-time correctness, so a
// reading stamped after it must not leak in.
function queryBucketAverages(win: SeriesWindow, now: Date, filter: SQL | undefined) {
  // epoch-floor bucketing — date_trunc can't do arbitrary 10-min / 3-h widths.
  const bucket = sql<Date>`to_timestamp(floor(extract(epoch from ${sensorReading.recordedAt}) / ${win.bucketSec}) * ${win.bucketSec})`
  return (
    db
      .select({
        deviceId: sensorReading.deviceId,
        bucket,
        tempAvg: sql<number | null>`avg(${sensorReading.temperatureC})`,
        humAvg: sql<number | null>`avg(${sensorReading.humidityPct})`,
      })
      .from(sensorReading)
      .where(
        and(gte(sensorReading.recordedAt, win.since), lte(sensorReading.recordedAt, now), filter),
      )
      // Group/order by the bucket via its SELECT ordinal (`2`): drizzle renders the
      // expression differently in SELECT vs GROUP BY, which Postgres rejects.
      .groupBy(sensorReading.deviceId, sql`2`)
      .orderBy(sql`2`)
  )
}

// postgres-js returns avg() as a numeric string; preserve null (never coerce to 0).
function toNumber(v: number | string | null): number | null {
  return v == null ? null : Number(v)
}

// Pivot (device, bucket) rows into one SeriesBucket per timestamp, ascending.
function toBuckets(rows: BucketRow[]): SeriesBucket[] {
  const byTime = new Map<number, SeriesBucket>()
  for (const row of rows) {
    const t = new Date(row.bucket).getTime()
    const bucket = byTime.get(t) ?? { t, perDevice: {} }
    bucket.perDevice[row.deviceId] = {
      tempAvg: toNumber(row.tempAvg),
      humAvg: toNumber(row.humAvg),
    }
    byTime.set(t, bucket)
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

// Server-side time-bucketed averages, one point per (device, bucket). `now` is
// injectable so tests are deterministic.
export async function getSeries(input: {
  range: SeriesRange
  deviceIds?: string[]
  now?: Date
}): Promise<{ buckets: SeriesBucket[] }> {
  const now = input.now ?? new Date()
  // Explicit empty selection = no devices → empty (distinct from undefined = all).
  if (input.deviceIds?.length === 0) return { buckets: [] }

  const filter = deviceFilter(input.deviceIds)
  const win = await resolveWindow(input.range, now, filter)
  if (!win) return { buckets: [] }

  return { buckets: toBuckets(await queryBucketAverages(win, now, filter)) }
}
