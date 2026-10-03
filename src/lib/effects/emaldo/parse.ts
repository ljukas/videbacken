import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { STOCKHOLM_TIME_ZONE, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import type { EmaldoDay, HouseBucket } from './emaldo'
import { EmaldoError, type EmaldoOp } from './errors'

export const SERIES_NAMES = ['grid', 'mppt', 'usage', 'battery'] as const
export type SeriesName = (typeof SERIES_NAMES)[number]

const BUCKET_MINUTES = 5
/** Average W over one 5-min bucket → kWh: W × 5 / 60 / 1000 = W / 12 000. */
const W_PER_KWH_BUCKET = (60 / BUCKET_MINUTES) * 1000
/** A 25-h day has 300 rows; anything far beyond is not a day series. */
const MAX_ROWS = 400
const MAX_HOMES = 100
/** 2100-01-01 UTC: a later start_time is not a plausible day and would overflow the date helpers. */
const MAX_START_TIME = 4_102_444_800

function unexpected(op: EmaldoOp, message: string): EmaldoError {
  return new EmaldoError('unexpected_response', op, undefined, { message })
}

function parse<T>(op: EmaldoOp, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const at = summarizeIssuePaths(parsed.error.issues.map((i) => issuePath(i.path)))
  throw unexpected(op, `Emaldo ${op} response has an unexpected shape at: ${at}`)
}

// ---- envelope, login, discovery -------------------------------------------

const envelopeSchema = z.object({ Status: z.int(), Result: z.unknown().optional() })
export type Envelope = z.infer<typeof envelopeSchema>

export function parseEnvelope(op: EmaldoOp, body: unknown): Envelope {
  return parse(op, envelopeSchema, body)
}

const loginSchema = z.object({ token: z.string().min(1).max(256) })

export function parseLogin(result: unknown): string {
  return parse('login', loginSchema, result).token
}

const id = z.string().min(1).max(128)
const homesSchema = z.object({
  list_homes: z
    .array(z.object({ home_id: id }))
    .max(MAX_HOMES)
    .nullish(),
})
const devicesSchema = z.object({
  bmts: z
    .array(z.object({ id, model: id }))
    .max(MAX_HOMES)
    .nullish(),
})

export function parseHomeIds(result: unknown): string[] {
  return (parse('discover', homesSchema, result).list_homes ?? []).map((h) => h.home_id)
}

export function parseDevices(result: unknown): { deviceId: string; model: string }[] {
  return (parse('discover', devicesSchema, result).bmts ?? []).map((d) => ({
    deviceId: d.id,
    model: d.model,
  }))
}

// ---- day series -----------------------------------------------------------

const minute = z.int().nonnegative().multipleOf(BUCKET_MINUTES)
const w = z.number() // finite; a negative reading drops its bucket in `buildDay`
const rest = z.unknown() // columns we don't use may be anything
const ROWS = {
  grid: z.tuple([minute, w, w, w], rest), // min, import, emergency import, export, …
  mppt: z.tuple([minute, w, w, w, w], rest), // min, string 1, 2, 3, third-party, …
  usage: z.tuple([minute, w, w], rest), // min, ?, load (charger included), …
  battery: z.tuple([minute, w, w, w, w], rest), // min, discharge, charge_mppt, charge_grid, charge_ac, …
}

const dayOf = <T extends z.ZodType>(row: T) =>
  z.object({
    start_time: z.int().positive().max(MAX_START_TIME),
    timezone: z.literal(STOCKHOLM_TIME_ZONE),
    interval: z.literal(BUCKET_MINUTES),
    data: z.array(row).max(MAX_ROWS),
  })

/** One series of one day: minute → the raw watt columns we use, in a fixed order. */
export type SeriesDay = { startTime: number; rows: Map<number, readonly number[]> }

function collect<R extends readonly [number, ...unknown[]]>(
  day: { start_time: number; data: R[] },
  used: (row: R) => number[],
): SeriesDay {
  const rows = new Map<number, readonly number[]>()
  for (const row of day.data) {
    if (rows.has(row[0])) throw unexpected('stats', 'Emaldo stats response repeats a minute')
    rows.set(row[0], used(row))
  }
  return { startTime: day.start_time, rows }
}

export function parseSeries(name: SeriesName, result: unknown): SeriesDay {
  switch (name) {
    case 'grid':
      return collect(parse('stats', dayOf(ROWS.grid), result), (r) => [r[1], r[2], r[3]])
    case 'mppt':
      return collect(parse('stats', dayOf(ROWS.mppt), result), (r) => [r[1], r[2], r[3], r[4]])
    case 'usage':
      return collect(parse('stats', dayOf(ROWS.usage), result), (r) => [r[2]])
    case 'battery':
      return collect(parse('stats', dayOf(ROWS.battery), result), (r) => [r[1], r[2], r[3], r[4]])
  }
}

const kwh = (watts: number) => watts / W_PER_KWH_BUCKET
const newest = (rows: Map<number, unknown>) => (rows.size > 0 ? Math.max(...rows.keys()) : -1)

/**
 * The four series of one day → the buckets present in all of them, inside
 * [start_time, next Stockholm midnight). Offset 0 (today) also drops the
 * still-filling newest bucket: everything from the earliest of the four
 * series' newest minutes on.
 */
export function buildDay(offset: number, series: Record<SeriesName, SeriesDay>): EmaldoDay {
  const startTime = series.grid.startTime
  if (SERIES_NAMES.some((n) => series[n].startTime !== startTime)) {
    throw unexpected('stats', 'Emaldo day series disagree on the day start')
  }
  const startMs = startTime * 1000
  const { startMs: midnight, endMs } = stockholmDayBounds(stockholmDayOf(startMs))
  if (midnight !== startMs)
    throw unexpected('stats', 'Emaldo day does not start at a Stockholm midnight')

  const cutoff =
    offset === 0 ? Math.min(...SERIES_NAMES.map((n) => newest(series[n].rows))) : Infinity
  const minutes = new Set(SERIES_NAMES.flatMap((n) => [...series[n].rows.keys()]))
  const buckets: HouseBucket[] = []
  for (const m of [...minutes].sort((a, b) => a - b)) {
    const at = startMs + m * 60_000
    const g = series.grid.rows.get(m)
    const p = series.mppt.rows.get(m)
    const u = series.usage.rows.get(m)
    const b = series.battery.rows.get(m)
    if (!g || !p || !u || !b || at >= endMs || m >= cutoff) continue
    if ([g, p, u, b].some((cols) => cols.some((watts) => watts < 0))) continue
    buckets.push({
      bucketStart: new Date(at),
      gridImportKwh: kwh(g[0] + g[1]),
      gridExportKwh: kwh(g[2]),
      solarKwh: kwh(p[0] + p[1] + p[2] + p[3]),
      loadKwh: kwh(u[0]),
      batteryDischargeKwh: kwh(b[0]),
      batteryChargeSolarKwh: kwh(b[1]),
      batteryChargeGridKwh: kwh(b[2]),
      batteryChargeAcKwh: kwh(b[3]),
    })
  }
  return {
    dayStart: new Date(startMs),
    dayEnd: new Date(endMs),
    buckets,
    droppedBuckets: minutes.size - buckets.length,
  }
}
