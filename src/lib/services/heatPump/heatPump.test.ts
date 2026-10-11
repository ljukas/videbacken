import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { HEAT_PUMP_HOUR_KWH_MAX, heatPump, heatPumpReading } from '~/lib/db/schema'
import { utcDayBounds } from '~/lib/time/utc'
import { setupDatabase } from '~test/setup'
import { HeatPumpDomainError } from './errors'
import {
  type HeatPumpHourInput,
  listUnits,
  markHistoryComplete,
  oldestDay,
  replaceDay,
  setRegisteredOn,
  upsertUnits,
} from './heatPump'

setupDatabase()

afterEach(() => {
  vi.restoreAllMocks()
})

const HOUR = 3_600_000
const NOW = new Date('2026-10-08T10:00:00Z')
const LATER = new Date('2026-10-08T16:20:00Z')
const MATSAL = { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }
const OVERVANING = { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' }
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

// Synthetic values only — never real readings (the repo is public).
const hour = (start: number | Date, kwh = 0.12): HeatPumpHourInput => ({
  hourStart: new Date(start),
  energyKwh: kwh,
  heatShare: 1,
  coolShare: 0,
  setpointC: 21,
  insideC: 20.5,
  outsideC: 3.25,
})
const fullDay = (day: string) => {
  const { startMs } = utcDayBounds(day)
  return Array.from({ length: 24 }, (_, i) => hour(startMs + i * HOUR, 0.1 + i / 1000))
}
const readingsOf = (heatPumpId: string) =>
  db
    .select()
    .from(heatPumpReading)
    .where(eq(heatPumpReading.heatPumpId, heatPumpId))
    .orderBy(heatPumpReading.hourStart)
async function twoUnits() {
  const [matsal, overvaning] = await upsertUnits([MATSAL, OVERVANING], NOW)
  return { matsal, overvaning }
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as Error,
  )

// ---- units ------------------------------------------------------------------

test('upsertUnits inserts new units, stamping both seen times', async () => {
  const { matsal } = await twoUnits()
  expect(matsal).toMatchObject({
    ...MATSAL,
    registeredOn: null,
    historyCompleteAt: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
})

test('a later upsert refreshes name, model and last_seen_at, keeping id and first_seen_at', async () => {
  const { matsal } = await twoUnits()
  await setRegisteredOn(matsal.id, '2024-10-31')
  const [renamed] = await upsertUnits(
    [{ ...MATSAL, name: 'Matsalen', model: 'CS-HZ25ZKE-2' }],
    LATER,
  )
  expect(renamed).toMatchObject({
    id: matsal.id,
    name: 'Matsalen',
    model: 'CS-HZ25ZKE-2',
    firstSeenAt: NOW,
    lastSeenAt: LATER,
    registeredOn: '2024-10-31',
  })
  expect(await listUnits()).toHaveLength(2)
})

test('upsertUnits returns input order, once per guid; nothing in, nothing out', async () => {
  const rows = await upsertUnits([OVERVANING, MATSAL, { ...OVERVANING, name: 'Övervåningen' }], NOW)
  expect(rows.map((r) => r.name)).toEqual(['Övervåningen', 'Matsal'])
  expect(await upsertUnits([], NOW)).toEqual([])
})

test('listUnits orders by name', async () => {
  await upsertUnits([OVERVANING, MATSAL], NOW)
  expect((await listUnits()).map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
})

// ---- replaceDay -------------------------------------------------------------

test('stores a whole UTC day, the DST day included, and reads it back', async () => {
  const { matsal } = await twoUnits()
  for (const day of ['2026-06-10', '2026-03-29']) {
    expect(await replaceDay(matsal.id, day, fullDay(day).reverse())).toEqual({ stored: 24 })
  }
  const rows = await readingsOf(matsal.id)
  expect(rows).toHaveLength(48)
  expect(rows[0]).toEqual({ heatPumpId: matsal.id, ...hour(Date.UTC(2026, 2, 29), 0.1) })
})

test('a re-fetched day replaces only that unit’s day: gaps stay gaps, neighbours untouched', async () => {
  const { matsal, overvaning } = await twoUnits()
  for (const day of ['2026-06-09', '2026-06-10', '2026-06-11'])
    await replaceDay(matsal.id, day, fullDay(day))
  await replaceDay(overvaning.id, '2026-06-10', fullDay('2026-06-10'))
  const { startMs } = utcDayBounds('2026-06-10')

  await replaceDay(matsal.id, '2026-06-10', [hour(startMs, 0.3), hour(startMs + 5 * HOUR, 0.4)])

  const matsalRows = await readingsOf(matsal.id)
  expect(matsalRows).toHaveLength(24 + 2 + 24)
  expect(
    matsalRows
      .filter(
        (r) => r.hourStart.getTime() >= startMs && r.hourStart.getTime() < startMs + 24 * HOUR,
      )
      .map((r) => r.energyKwh),
  ).toEqual([0.3, 0.4])
  expect(await readingsOf(overvaning.id)).toHaveLength(24)
})

test('an empty list clears the day', async () => {
  const { matsal } = await twoUnits()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  expect(await replaceDay(matsal.id, '2026-06-10', [])).toEqual({ stored: 0 })
  expect(await readingsOf(matsal.id)).toEqual([])
})

test('null shares and temperatures are stored as null; a standby hour of 0 kWh is a reading', async () => {
  const { matsal } = await twoUnits()
  const start = utcDayBounds('2026-06-10').startMs
  await replaceDay(matsal.id, '2026-06-10', [
    {
      hourStart: new Date(start),
      energyKwh: 0,
      heatShare: null,
      coolShare: null,
      setpointC: null,
      insideC: null,
      outsideC: null,
    },
  ])
  expect(await readingsOf(matsal.id)).toEqual([
    {
      heatPumpId: matsal.id,
      hourStart: new Date(start),
      energyKwh: 0,
      heatShare: null,
      coolShare: null,
      setpointC: null,
      insideC: null,
      outsideC: null,
    },
  ])
})

test('rejects hours outside the day, off the hour, repeated, or with a value out of range — keeping the stored day', async () => {
  const { matsal } = await twoUnits()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  const { startMs, endMs } = utcDayBounds('2026-06-10')
  const at = (overrides: Partial<HeatPumpHourInput>) => ({ ...hour(startMs), ...overrides })
  const bad: [string, HeatPumpHourInput[]][] = [
    ['before the day', [hour(startMs - HOUR)]],
    ['at the next midnight', [hour(endMs)]],
    ['off the hour', [hour(startMs + 30 * 60_000)]],
    ['a repeated hour', [hour(startMs), hour(startMs)]],
    ['an invalid date', [hour(new Date(Number.NaN))]],
    ['negative kWh', [at({ energyKwh: -0.001 })]],
    ['5 kWh', [at({ energyKwh: HEAT_PUMP_HOUR_KWH_MAX })]],
    ['NaN kWh', [at({ energyKwh: Number.NaN })]],
    ['a share above 1', [at({ heatShare: 1.01 })]],
    ['a negative share', [at({ coolShare: -0.1 })]],
    ['an infinite share', [at({ heatShare: Number.POSITIVE_INFINITY })]],
    ['a hot indoor', [at({ insideC: 60.25 })]],
    ['a frozen outdoor', [at({ outsideC: -60.25 })]],
    ['a NaN setpoint', [at({ setpointC: Number.NaN })]],
  ]
  for (const [label, hours] of bad) {
    await expect(replaceDay(matsal.id, '2026-06-10', hours), label).rejects.toMatchObject({
      name: 'HeatPumpDomainError',
      code: 'INVALID_READING',
    })
  }
  expect(await readingsOf(matsal.id)).toHaveLength(24)
})

test('an INVALID_READING message names the hour and field, never the value', async () => {
  const { matsal } = await twoUnits()
  const start = utcDayBounds('2026-06-10').startMs
  const err = await caught(
    replaceDay(matsal.id, '2026-06-10', [{ ...hour(start), outsideC: 61.123456 }]),
  )
  expect(err).toBeInstanceOf(HeatPumpDomainError)
  expect(err.message).toContain('hour 0')
  expect(err.message).toContain('outsideC')
  expect(err.message).not.toContain('61.123456')
})

test('replaceDay of an unknown unit is UNKNOWN_HEAT_PUMP, whatever the id looks like', async () => {
  for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
    await expect(replaceDay(id, '2026-06-10', fullDay('2026-06-10'))).rejects.toMatchObject({
      code: 'UNKNOWN_HEAT_PUMP',
    })
    await expect(replaceDay(id, '2026-06-10', [])).rejects.toMatchObject({
      code: 'UNKNOWN_HEAT_PUMP',
    })
  }
})

test('a day that is not a real YYYY-MM-DD is a RangeError (a caller bug)', async () => {
  const { matsal } = await twoUnits()
  await expect(replaceDay(matsal.id, '2026-02-30', [])).rejects.toThrow(RangeError)
})

// drizzle's query error carries every bound parameter in its message and `.params`, and pg's
// detail quotes the failing row.
test('a database failure is rethrown without any reading in it', async () => {
  const { matsal } = await twoUnits()
  const pg = Object.assign(new Error('duplicate key; Failing row contains (0.123456)'), {
    code: '23505',
    constraint: 'heat_pump_reading_pkey',
    detail: 'Failing row contains (0.123456)',
  })
  const drizzle = Object.assign(new Error('Failed query: insert …\nparams: 0.123456'), {
    params: [0.123456],
    cause: pg,
  })
  vi.spyOn(db, 'transaction').mockRejectedValueOnce(drizzle)
  const start = utcDayBounds('2026-06-10').startMs
  const err = await caught(replaceDay(matsal.id, '2026-06-10', [hour(start, 0.123456)]))
  expect(err.message).toBe(
    'Storing heat pump readings failed (Postgres 23505, heat_pump_reading_pkey)',
  )
  expect(err.cause).toBeUndefined()
  expect(`${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain('0.123456')
})

// ---- oldestDay, registered_on, history_complete_at --------------------------

test('oldestDay is the UTC day of the unit’s oldest hour; null with none or for an unknown unit', async () => {
  const { matsal, overvaning } = await twoUnits()
  expect(await oldestDay(matsal.id)).toBeNull()
  await replaceDay(matsal.id, '2026-06-10', fullDay('2026-06-10'))
  await replaceDay(matsal.id, '2026-06-08', [hour(Date.UTC(2026, 5, 8, 23))])
  await replaceDay(overvaning.id, '2026-01-01', fullDay('2026-01-01'))
  expect(await oldestDay(matsal.id)).toBe('2026-06-08')
  expect(await oldestDay(UNKNOWN_ID)).toBeNull()
  expect(await oldestDay('not-a-uuid')).toBeNull()
})

test('setRegisteredOn and markHistoryComplete set their column on that unit only', async () => {
  const { matsal, overvaning } = await twoUnits()
  await setRegisteredOn(matsal.id, '2024-10-31')
  await markHistoryComplete(matsal.id, LATER)
  const [m] = await db.select().from(heatPump).where(eq(heatPump.id, matsal.id))
  const [o] = await db.select().from(heatPump).where(eq(heatPump.id, overvaning.id))
  expect(m).toMatchObject({ registeredOn: '2024-10-31', historyCompleteAt: LATER })
  expect(o).toMatchObject({ registeredOn: null, historyCompleteAt: null })
  await setRegisteredOn(matsal.id, '2024-11-27')
  expect((await listUnits())[0]).toMatchObject({
    registeredOn: '2024-11-27',
    historyCompleteAt: LATER,
  })
})

test('an earlier registered_on reopens the backfill; the same or a later one keeps it complete', async () => {
  const { matsal, overvaning } = await twoUnits()
  const unitRow = async (id: string) =>
    (await db.select().from(heatPump).where(eq(heatPump.id, id)))[0]
  await setRegisteredOn(matsal.id, '2024-11-27')
  await markHistoryComplete(matsal.id, LATER)

  await setRegisteredOn(matsal.id, '2024-11-27')
  expect(await unitRow(matsal.id)).toMatchObject({
    registeredOn: '2024-11-27',
    historyCompleteAt: LATER,
  })
  await setRegisteredOn(matsal.id, '2024-12-01')
  expect(await unitRow(matsal.id)).toMatchObject({
    registeredOn: '2024-12-01',
    historyCompleteAt: LATER,
  })

  await setRegisteredOn(matsal.id, '2024-10-31')
  expect(await unitRow(matsal.id)).toMatchObject({
    registeredOn: '2024-10-31',
    historyCompleteAt: null,
  })

  // A first-time set on a unit already marked complete (no stored date to compare) keeps it.
  await markHistoryComplete(overvaning.id, LATER)
  await setRegisteredOn(overvaning.id, '2024-11-27')
  expect(await unitRow(overvaning.id)).toMatchObject({
    registeredOn: '2024-11-27',
    historyCompleteAt: LATER,
  })
})

test('setRegisteredOn and markHistoryComplete of an unknown unit are UNKNOWN_HEAT_PUMP', async () => {
  for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
    await expect(setRegisteredOn(id, '2024-10-31')).rejects.toMatchObject({
      code: 'UNKNOWN_HEAT_PUMP',
    })
    await expect(markHistoryComplete(id, NOW)).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP' })
  }
})

test('setRegisteredOn refuses a day that is not a real date', async () => {
  const { matsal } = await twoUnits()
  await expect(setRegisteredOn(matsal.id, '2024-13-01')).rejects.toThrow(RangeError)
})
