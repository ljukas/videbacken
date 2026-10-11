import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { energyMixDeriveRequest, evSessionCost, spotPrice, spotPriceDay } from '~/lib/db/schema'
import { requestDerive } from '~/lib/services/energyMix/deriveRequest'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import type { PriceZone } from '~/lib/spotPrice/zones'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { SpotPriceDomainError } from './errors'
import { dailyAverageSpot, daysStored, listSlotsOverlapping, replaceDay } from './spotPrice'

// The real requestDerive, wrapped so a test can make the last step of
// replaceDay's transaction fail.
vi.mock('~/lib/services/energyMix/deriveRequest', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/services/energyMix/deriveRequest')>()
  return { ...real, requestDerive: vi.fn(real.requestDerive) }
})

setupDatabase()

async function generationOf(sessionId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ generation: evSessionCost.generation })
    .from(evSessionCost)
    .where(eq(evSessionCost.sessionId, sessionId))
  return row?.generation
}

const utc = (iso: string) => new Date(iso).getTime()

async function storedCount() {
  return (await db.select().from(spotPrice)).length
}

async function storedDays() {
  return db.select().from(spotPriceDay).orderBy(spotPriceDay.day)
}

/** Writes a day's slots past `replaceDay` (no writer does this): no day row. */
async function insertSlotsOnly(day: string) {
  await db.insert(spotPrice).values(
    daySlots(day, 60).map((s) => ({
      zone: 'SE3',
      slotStart: new Date(s.startMs),
      slotEnd: new Date(s.endMs),
      sekPerKwh: s.sekPerKwh,
    })),
  )
}

test('replaceDay stores a validated day and reports what it wrote', async () => {
  const result = await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => i / 100),
  )
  expect(result).toEqual({ written: 96 })
  expect(await storedCount()).toBe(96)
})

test('re-storing a day at another granularity leaves no stale slots behind', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 60, () => 2),
  )

  const rows = await db.select().from(spotPrice)
  expect(rows).toHaveLength(24)
  expect(rows.every((r) => r.sekPerKwh === 2)).toBe(true)
  // Pricing an hour now sees exactly one slot, never the old quarters too.
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z') },
  ])
  expect(slots).toHaveLength(1)
})

test('replaceDay only touches its own Stockholm day', async () => {
  await replaceDay('SE3', '2026-09-27', daySlots('2026-09-27', 15))
  await replaceDay('SE3', '2026-09-29', daySlots('2026-09-29', 15))
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 60))
  expect(await storedCount()).toBe(96 + 96 + 24)
})

test('an invalid day is rejected before anything is written', async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  const holey = daySlots('2026-09-28', 15, () => 5).filter((_, i) => i !== 40)

  await expect(replaceDay('SE3', '2026-09-28', holey)).rejects.toMatchObject({
    name: 'SpotPriceDomainError',
    code: 'INVALID_DAY_SLOTS',
  })
  await expect(replaceDay('SE3', '2026-09-28', [])).rejects.toBeInstanceOf(SpotPriceDomainError)
  // The previous day is intact.
  const rows = await db.select().from(spotPrice)
  expect(rows).toHaveLength(96)
  expect(rows.every((r) => r.sekPerKwh === 1)).toBe(true)
})

test('stores DST days of 92 and 100 slots', async () => {
  await replaceDay('SE3', '2026-03-29', daySlots('2026-03-29', 15))
  await replaceDay('SE3', '2025-10-26', daySlots('2025-10-26', 15))
  expect(await storedCount()).toBe(192)
})

test("replaceDay stores the day's average beside its slots, on the Stockholm day", async () => {
  // 2026-09-28 starts at 2026-09-27T22:00Z: the row is the Stockholm day.
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => i / 100),
  )
  const rows = await storedDays()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ zone: 'SE3', day: '2026-09-28', coveredSeconds: 86_400 })
  expect(rows[0].avgSekPerKwh).toBeCloseTo(0.475) // mean of 0.00 … 0.95
})

test('re-storing a day replaces its average', async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 60, () => 2),
  )
  const rows = await storedDays()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ day: '2026-09-28', avgSekPerKwh: 2, coveredSeconds: 86_400 })
})

test("replacing a day leaves the neighbouring days' averages alone", async () => {
  await replaceDay(
    'SE3',
    '2026-09-27',
    daySlots('2026-09-27', 15, () => 1),
  )
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 2),
  )
  await replaceDay(
    'SE3',
    '2026-09-29',
    daySlots('2026-09-29', 15, () => 3),
  )
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 60, () => 4),
  )
  expect((await storedDays()).map((r) => [r.day, r.avgSekPerKwh])).toEqual([
    ['2026-09-27', 1],
    ['2026-09-28', 4],
    ['2026-09-29', 3],
  ])
})

test('a rejected day keeps its stored average, and a never-stored day gets none', async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  const holey = daySlots('2026-09-28', 15, () => 5).filter((_, i) => i !== 40)
  await expect(replaceDay('SE3', '2026-09-28', holey)).rejects.toThrow(SpotPriceDomainError)
  const holeyNew = daySlots('2026-09-29', 15, () => 5).filter((_, i) => i !== 40)
  await expect(replaceDay('SE3', '2026-09-29', holeyNew)).rejects.toThrow(SpotPriceDomainError)
  expect((await storedDays()).map((r) => [r.day, r.avgSekPerKwh])).toEqual([['2026-09-28', 1]])
})

test("a failure later in replaceDay's transaction keeps the old slots and average together", async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, () => 1),
  )
  vi.mocked(requestDerive).mockRejectedValueOnce(new Error('derive queue down'))
  await expect(
    replaceDay(
      'SE3',
      '2026-09-28',
      daySlots('2026-09-28', 60, () => 2),
    ),
  ).rejects.toThrow('derive queue down')
  const slots = await db.select().from(spotPrice)
  expect(slots).toHaveLength(96)
  expect(slots.every((r) => r.sekPerKwh === 1)).toBe(true)
  expect((await storedDays()).map((r) => [r.day, r.avgSekPerKwh])).toEqual([['2026-09-28', 1]])
})

test('the 0024 backfill writes exactly what replaceDay writes', async () => {
  // Two copies of one aggregate (the migration can't import the service):
  // awkward floats so a change in summation, weighting or rounding shows.
  await replaceDay(
    'SE3',
    '2026-03-29',
    daySlots('2026-03-29', 60, (i) => 0.1 * i + 1 / 3),
  )
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => Math.sin(i) * 1.7),
  )
  const written = await storedDays()
  await db.delete(spotPriceDay)
  const backfill = await readFile('drizzle/0024_backfill_spot_price_day.sql', 'utf8')
  await db.execute(sql.raw(backfill))
  expect(await storedDays()).toEqual(written)
})

test('DST days store 23 and 25 hours', async () => {
  await replaceDay('SE3', '2026-03-29', daySlots('2026-03-29', 60))
  await replaceDay('SE3', '2026-10-25', daySlots('2026-10-25', 15))
  expect((await storedDays()).map((r) => [r.day, r.coveredSeconds])).toEqual([
    ['2026-03-29', 82_800],
    ['2026-10-25', 90_000],
  ])
})

test('listSlotsOverlapping returns each overlapping slot once, including one starting before the range', async () => {
  await replaceDay(
    'SE3',
    '2025-09-30',
    daySlots('2025-09-30', 60, (i) => i),
  )

  // Two overlapping ranges inside local 10:00–12:00 (08:00Z–10:00Z CEST).
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2025-09-30T08:30Z'), endMs: utc('2025-09-30T09:15Z') },
    { startMs: utc('2025-09-30T09:00Z'), endMs: utc('2025-09-30T09:45Z') },
  ])

  expect(slots.map((s) => new Date(s.startMs).toISOString())).toEqual([
    '2025-09-30T08:00:00.000Z',
    '2025-09-30T09:00:00.000Z',
  ])
  expect(slots.map((s) => s.sekPerKwh)).toEqual([10, 11])
  expect(slots[0].endMs - slots[0].startMs).toBe(60 * 60 * 1000)
})

test('listSlotsOverlapping ignores touching slots and handles no ranges', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  expect(await listSlotsOverlapping('SE3', [])).toEqual([])
  const slots = await listSlotsOverlapping('SE3', [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z') },
  ])
  expect(slots).toHaveLength(1)
})

test('daysStored groups by Stockholm day across the UTC boundary', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15)) // starts 2026-09-27T22:00Z
  await replaceDay('SE3', '2026-09-30', daySlots('2026-09-30', 15))

  expect(await daysStored('SE3', '2026-09-27', '2026-10-01')).toEqual(
    new Set(['2026-09-28', '2026-09-30']),
  )
  expect(await daysStored('SE3', '2026-09-29', '2026-09-29')).toEqual(new Set())
  expect(await daysStored('SE3', '2026-09-28', '2026-09-28')).toEqual(new Set(['2026-09-28']))
})

test('daysStored sees a whole 25-hour fall-back day as one day', async () => {
  await replaceDay('SE3', '2025-10-26', daySlots('2025-10-26', 15))
  expect(await daysStored('SE3', '2025-10-25', '2025-10-27')).toEqual(new Set(['2025-10-26']))
})

test('daysStored counts a day without its stored average as missing, so the sync re-fetches it', async () => {
  // E.g. slots written by code from before spot_price_day (a rollback): the
  // next sync re-stores the day and replaceDay writes the average with it.
  await insertSlotsOnly('2026-09-28')
  expect(await daysStored('SE3', '2026-09-28', '2026-09-28')).toEqual(new Set())
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 60))
  expect(await daysStored('SE3', '2026-09-28', '2026-09-28')).toEqual(new Set(['2026-09-28']))
})

test('dailyAverageSpot averages each Stockholm day, weighting by slot length', async () => {
  await replaceDay(
    'SE3',
    '2026-09-28',
    daySlots('2026-09-28', 15, (i) => i / 100),
  )
  await replaceDay(
    'SE3',
    '2025-09-15',
    daySlots('2025-09-15', 60, () => 2),
  )
  await replaceDay(
    'SE3',
    '2026-09-29',
    daySlots('2026-09-29', 15, () => 7),
  ) // outside the range

  const days = await dailyAverageSpot('SE3', '2025-09-01', '2026-09-28')
  expect(days.map((d) => d.day)).toEqual(['2025-09-15', '2026-09-28'])
  expect(days[0]).toEqual({ day: '2025-09-15', avgSekPerKwh: 2, coveredMs: 24 * 3_600_000 })
  expect(days[1].avgSekPerKwh).toBeCloseTo(0.475) // mean of 0.00 … 0.95
  expect(days[1].coveredMs).toBe(24 * 3_600_000)
})

test('dailyAverageSpot counts a 25-hour DST day as 25 hours', async () => {
  await replaceDay(
    'SE3',
    '2026-10-25',
    daySlots('2026-10-25', 60, () => 1),
  )
  const [d] = await dailyAverageSpot('SE3', '2026-10-25', '2026-10-25')
  expect(d.coveredMs).toBe(25 * 3_600_000)
})

test('dailyAverageSpot is empty without stored slots', async () => {
  expect(await dailyAverageSpot('SE3', '2026-01-01', '2026-12-31')).toEqual([])
})

test('dailyAverageSpot only reads the requested zone', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  // The zone CHECK constrains writes only; reading another zone is just an empty result.
  expect(await dailyAverageSpot('SE4' as PriceZone, '2026-09-28', '2026-09-28')).toEqual([])
  expect(await dailyAverageSpot('SE3', '2026-09-28', '2026-09-28')).toHaveLength(1)
})

test('dailyAverageSpot bounds the range on both ends, inclusively', async () => {
  for (const day of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']) {
    await replaceDay('SE3', day, daySlots(day, 60))
  }
  const days = await dailyAverageSpot('SE3', '2026-09-27', '2026-09-28')
  expect(days.map((d) => d.day)).toEqual(['2026-09-27', '2026-09-28'])
})

test("dailyAverageSpot carries each day's covered time, whatever its slot length", async () => {
  // A 23-hour hourly day beside a 24-hour quarter-hour day: the covered time is
  // what weights days against each other (averageSpotOre).
  await replaceDay(
    'SE3',
    '2026-03-29',
    daySlots('2026-03-29', 60, () => 1),
  )
  await replaceDay(
    'SE3',
    '2026-03-30',
    daySlots('2026-03-30', 15, () => 3),
  )
  expect(await dailyAverageSpot('SE3', '2026-03-29', '2026-03-30')).toEqual([
    { day: '2026-03-29', avgSekPerKwh: 1, coveredMs: 23 * 3_600_000 },
    { day: '2026-03-30', avgSekPerKwh: 3, coveredMs: 24 * 3_600_000 },
  ])
})

test('dailyAverageSpot reads the stored day averages, not raw slots', async () => {
  await insertSlotsOnly('2026-09-28')
  expect(await dailyAverageSpot('SE3', '2026-09-28', '2026-09-28')).toEqual([])
})

test('dailyAverageSpot counts a 23-hour spring DST day as 23 hours', async () => {
  await replaceDay(
    'SE3',
    '2026-03-29',
    daySlots('2026-03-29', 60, (i) => i),
  )
  const [d] = await dailyAverageSpot('SE3', '2026-03-29', '2026-03-29')
  expect(d.coveredMs).toBe(23 * 3_600_000)
  expect(d.avgSekPerKwh).toBeCloseTo(11) // mean of 0 … 22
})

test("listSlotsOverlapping reads inside a caller's transaction", async () => {
  // The test pool has one connection: using `db` instead of `tx` here would hang.
  await db.transaction(async (tx) => {
    await tx.insert(spotPrice).values({
      zone: 'SE3',
      slotStart: new Date('2026-09-28T08:00:00Z'),
      slotEnd: new Date('2026-09-28T08:15:00Z'),
      sekPerKwh: 1.5,
    })
    const slots = await listSlotsOverlapping(
      'SE3',
      [{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z') }],
      tx,
    )
    expect(slots).toEqual([
      { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T08:15Z'), sekPerKwh: 1.5 },
    ])
  })
})

test('replacing a day queues an energy-mix derive from that day', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15))
  const queued = await db
    .select({ fromDay: energyMixDeriveRequest.fromDay })
    .from(energyMixDeriveRequest)
  expect(queued).toEqual([{ fromDay: '2026-09-28' }])
})

const chargeSession = (startIso: string, endIso: string) =>
  insertSession({ startAt: new Date(startIso), endAt: new Date(endIso) })

test('replaceDay bumps sessions charging that Stockholm day, and only those', async () => {
  const inDay = await chargeSession('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  const dayBefore = await chargeSession('2026-09-19T08:00:00Z', '2026-09-19T09:00:00Z')
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15))
  expect(await generationOf(inDay)).toBe(1)
  expect(await generationOf(dayBefore)).toBeUndefined()
})

test('replaceDay waits for an in-flight session import, then bumps its session', async () => {
  const { rows } = await db.execute<{ schema: string }>(sql`select current_schema() as schema`)
  const other = new Client({ connectionString: process.env.DATABASE_URL })
  await other.connect()
  try {
    await other.query(`set search_path to "${rows[0].schema}", public`)
    await other.query('begin')
    await other.query(
      `insert into ev_charger (id, name, installation_id) values ('charger-1', 'Charger', 'install-1')`,
    )
    const inserted = await other.query<{ id: string }>(
      `insert into ev_charge_session (zaptec_session_id, charger_id, start_at, end_at, energy_kwh)
       values ('zap-import', 'charger-1', '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z', 5)
       returning id`,
    )

    let resolved = false
    const pending = replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15)).then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(resolved).toBe(false)

    await other.query('commit')
    await pending
    expect(await generationOf(inserted.rows[0].id)).toBe(1)
  } finally {
    await other.end()
  }
})

test("a failure after replaceDay's bump rolls the bump back", async () => {
  const inDay = await chargeSession('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15))
  expect(await generationOf(inDay)).toBe(1)
  // requestDerive runs after bumpOverlapping in the same transaction.
  vi.mocked(requestDerive).mockRejectedValueOnce(new Error('derive queue down'))
  await expect(replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 60))).rejects.toThrow(
    'derive queue down',
  )
  expect(await generationOf(inDay)).toBe(1)
})

test('a rejected day bumps nothing', async () => {
  const inDay = await chargeSession('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  await expect(replaceDay('SE3', '2026-09-20', [])).rejects.toThrow()
  expect(await generationOf(inDay)).toBeUndefined()
})
