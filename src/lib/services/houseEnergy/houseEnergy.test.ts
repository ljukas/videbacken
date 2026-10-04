import { afterEach, expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { energyMixDeriveRequest, HOUSE_BUCKET_KWH_MAX } from '~/lib/db/schema'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { HouseEnergyDomainError } from './errors'
import { firstReadingAt, type HouseReading, listReadings, replaceDay } from './houseEnergy'

setupDatabase()

afterEach(() => {
  vi.restoreAllMocks()
})

const FIVE_MIN = 300_000
const KWH_FIELDS = [
  'gridImportKwh',
  'gridExportKwh',
  'solarKwh',
  'loadKwh',
  'batteryDischargeKwh',
  'batteryChargeSolarKwh',
  'batteryChargeGridKwh',
  'batteryChargeAcKwh',
] as const

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}

// Synthetic values only — never real household readings (the repo is public).
const reading = (bucketStart: Date, kwh = 0.1): HouseReading => ({
  bucketStart,
  gridImportKwh: kwh,
  gridExportKwh: 0,
  solarKwh: 0.02,
  loadKwh: kwh,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
  batterySocPct: 50,
})

/** Every 5-minute bucket of the Stockholm day (276 / 288 / 300 of them). */
const fullDay = (day: string): HouseReading[] => {
  const { dayStart, dayEnd } = dayOf(day)
  const n = (dayEnd.getTime() - dayStart.getTime()) / FIVE_MIN
  return Array.from({ length: n }, (_, i) => reading(new Date(dayStart.getTime() + i * FIVE_MIN)))
}

const all = () =>
  listReadings({ from: new Date('2000-01-01T00:00:00Z'), to: new Date('2100-01-01T00:00:00Z') })

test('stores a whole spring-forward day (276 buckets) and reads it back ascending', async () => {
  const day = dayOf('2026-03-29')
  const buckets = fullDay('2026-03-29').reverse()
  expect(buckets).toHaveLength(276)

  expect(await replaceDay(day, buckets)).toBe(276)

  const stored = await listReadings({ from: day.dayStart, to: day.dayEnd })
  expect(stored).toHaveLength(276)
  expect(stored[0]).toEqual(reading(day.dayStart))
  expect(stored.at(-1)?.bucketStart).toEqual(new Date(day.dayEnd.getTime() - FIVE_MIN))
})

test('stores a whole fall-back day (300 buckets)', async () => {
  expect(await replaceDay(dayOf('2026-10-25'), fullDay('2026-10-25'))).toBe(300)
})

test('a re-fetched day replaces its rows and leaves the neighbouring days alone', async () => {
  await replaceDay(dayOf('2026-03-31'), fullDay('2026-03-31'))
  await replaceDay(dayOf('2026-04-01'), fullDay('2026-04-01'))
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const d = dayOf('2026-04-01')

  // Gaps stay gaps: the new answer has two buckets, so only those two remain.
  await replaceDay(d, [
    reading(d.dayStart, 0.3),
    reading(new Date(d.dayStart.getTime() + 2 * FIVE_MIN), 0.4),
  ])

  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.gridImportKwh)).toEqual([0.3, 0.4])
  expect(await all()).toHaveLength(288 + 2 + 288)
})

test('listReadings is [from, to): a bucket at `to` belongs to the next range', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, [reading(d.dayStart)])
  await replaceDay(dayOf('2026-04-02'), [reading(d.dayEnd)])
  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.bucketStart)).toEqual([d.dayStart])
})

test('an empty list clears the day and writes nothing', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  expect(await replaceDay(d, [])).toBe(0)
  expect(await all()).toHaveLength(0)
})

test('rejects readings outside the day, repeated, or with a bad kWh — and keeps the stored day', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  const bad: [string, HouseReading[]][] = [
    ['before the day', [reading(new Date(d.dayStart.getTime() - FIVE_MIN))]],
    ['at the next midnight', [reading(d.dayEnd)]],
    ['a repeated start', [reading(d.dayStart), reading(d.dayStart)]],
    ['off the 5-minute grid', [reading(new Date(d.dayStart.getTime() + 60_000))]],
    ['a negative value', [{ ...reading(d.dayStart), solarKwh: -0.01 }]],
    ['NaN', [{ ...reading(d.dayStart), loadKwh: Number.NaN }]],
    ['Infinity', [{ ...reading(d.dayStart), gridExportKwh: Number.POSITIVE_INFINITY }]],
    ['an absurd value', [{ ...reading(d.dayStart), gridImportKwh: 1000 }]],
    ['an invalid date', [reading(new Date(Number.NaN))]],
  ]
  for (const [label, buckets] of bad) {
    await expect(replaceDay(d, buckets), label).rejects.toMatchObject({
      name: 'HouseEnergyDomainError',
      code: 'INVALID_READINGS',
    })
  }
  expect(await all()).toHaveLength(288)
})

test('an error names the bucket and field, never the value', async () => {
  const d = dayOf('2026-04-01')
  const error = await replaceDay(d, [
    { ...reading(d.dayStart), batteryChargeAcKwh: -0.123456 },
  ]).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(HouseEnergyDomainError)
  expect((error as Error).message).toContain('bucket 0')
  expect((error as Error).message).toContain('batteryChargeAcKwh')
  expect((error as Error).message).not.toContain('0.123456')
})

test('rejects a day that is not 1 ms–25 h long', async () => {
  const start = new Date('2026-04-01T22:00:00Z')
  for (const dayEnd of [
    start,
    new Date(start.getTime() - 1),
    new Date(start.getTime() + 26 * 3_600_000),
    new Date(Number.NaN),
  ]) {
    await expect(replaceDay({ dayStart: start, dayEnd }, [])).rejects.toMatchObject({
      code: 'INVALID_DAY',
    })
  }
})

test('firstReadingAt is null before any reading, then the earliest bucket', async () => {
  expect(await firstReadingAt()).toBeNull()
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const early = new Date(dayOf('2026-03-30').dayStart.getTime() + 7 * FIVE_MIN)
  await replaceDay(dayOf('2026-03-30'), [reading(early)])
  expect(await firstReadingAt()).toEqual(early)
})

test.each(KWH_FIELDS)('a negative or at-the-bound %s is a domain error', async (field) => {
  const d = dayOf('2026-04-01')
  for (const value of [-0.001, HOUSE_BUCKET_KWH_MAX]) {
    await expect(replaceDay(d, [{ ...reading(d.dayStart), [field]: value }])).rejects.toMatchObject(
      {
        name: 'HouseEnergyDomainError',
        code: 'INVALID_READINGS',
        message: expect.stringContaining(field),
      },
    )
  }
  // Just under the bound is stored.
  expect(await replaceDay(d, [{ ...reading(d.dayStart), [field]: 9.999 }])).toBe(1)
})

test('an error quotes at most five problems and counts the rest', async () => {
  const d = dayOf('2026-04-01')
  const buckets = Array.from({ length: 7 }, (_, i) => ({
    ...reading(new Date(d.dayStart.getTime() + i * FIVE_MIN)),
    loadKwh: -1,
  }))
  const error = (await replaceDay(d, buckets).catch((e: unknown) => e)) as Error
  expect(error.message.split('; ')).toHaveLength(5)
  expect(error.message).toMatch(/ \(\+2 more\)$/)
})

test('a failing insert rolls the delete back: the stored day survives', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementationOnce(((run: (tx: unknown) => Promise<unknown>) =>
    transaction(async (tx) =>
      run(
        new Proxy(tx, {
          get(target, prop) {
            if (prop === 'insert') {
              return () => {
                throw new Error('insert failed')
              }
            }
            const value = Reflect.get(target, prop)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      ),
    )) as never)

  await expect(replaceDay(d, fullDay('2026-04-01'))).rejects.toThrow()
  expect(await listReadings({ from: d.dayStart, to: d.dayEnd })).toHaveLength(288)
})

// drizzle's query error carries every bound parameter (the day's readings) in
// its message and `.params`, and pg's detail quotes the failing row.
test('a database failure is rethrown without any reading in it', async () => {
  const pg = Object.assign(new Error('duplicate key; Failing row contains (0.123456)'), {
    code: '23505',
    constraint: 'house_energy_reading_pkey',
    detail: 'Failing row contains (0.123456)',
  })
  const drizzle = Object.assign(new Error('Failed query: insert …\nparams: 0.123456'), {
    params: [0.123456],
    cause: pg,
  })
  vi.spyOn(db, 'transaction').mockRejectedValueOnce(drizzle)
  const d = dayOf('2026-04-01')

  const error = (await replaceDay(d, [reading(d.dayStart, 0.123456)]).catch(
    (e: unknown) => e,
  )) as Error

  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('23505')
  expect(error.message).toContain('house_energy_reading_pkey')
  expect(error.cause).toBeUndefined()
  expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('0.123456')
})

test('SoC round-trips exactly, null included', async () => {
  const d = dayOf('2026-04-01')
  const at = (i: number) => new Date(d.dayStart.getTime() + i * FIVE_MIN)
  const rows = [null, 0, 37.5, 100].map((batterySocPct, i) => ({
    ...reading(at(i)),
    batterySocPct,
  }))
  await replaceDay(d, rows)
  const stored = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(stored.map((r) => r.batterySocPct)).toEqual([null, 0, 37.5, 100])
})

test('a bad SoC and a bad kWh in one bucket are both reported', async () => {
  const d = dayOf('2026-04-01')
  const err = (await replaceDay(d, [
    { ...reading(d.dayStart), loadKwh: -1, batterySocPct: 101 },
  ]).catch((e) => e)) as Error
  expect(err.message).toContain('bucket 0: loadKwh')
  expect(err.message).toContain('bucket 0: batterySocPct')
  expect(err.message.split('; ')).toHaveLength(2)
})

test.each([
  -0.001,
  100.001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
])('a SoC of %s is a domain error naming the bucket and field only, keeping the stored day', async (batterySocPct) => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, [reading(d.dayStart)])
  const err = await replaceDay(d, [{ ...reading(d.dayStart), batterySocPct }]).catch((e) => e)
  expect(err).toBeInstanceOf(HouseEnergyDomainError)
  expect(err).toMatchObject({ code: 'INVALID_READINGS' })
  expect(err.message).toContain('bucket 0: batterySocPct')
  expect(err.message).not.toContain(String(batterySocPct))
  expect((await all()).map((r) => r.batterySocPct)).toEqual([50])
})

test('replacing a day queues an energy-mix derive from that day, in the same transaction', async () => {
  const day = '2026-06-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, [])
  const queued = await db
    .select({ fromDay: energyMixDeriveRequest.fromDay })
    .from(energyMixDeriveRequest)
  expect(queued).toEqual([{ fromDay: day }])
})
