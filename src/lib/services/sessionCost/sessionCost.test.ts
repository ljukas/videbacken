import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession, evSessionCost, evSessionCostMonth } from '~/lib/db/schema'
import { type CostTotals, emptyTotals } from '~/lib/evCharging/cost'
import { insertInterval, insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import {
  bumpAll,
  bumpOverlapping,
  bumpSessions,
  listCurrentMonths,
  listStale,
  type PricedForStore,
  readMonthSums,
  readSessionSums,
  writePriced,
} from '.'

setupDatabase()

const V = 1

const session = (
  startIso: string,
  endIso: string,
  over: Partial<typeof evChargeSession.$inferInsert> = {},
) => insertSession({ startAt: new Date(startIso), endAt: new Date(endIso), ...over })

const totals = (kwh: number, totalSek: number): CostTotals => ({
  ...emptyTotals(),
  kwh,
  gridKwh: kwh,
  fullKwh: kwh,
  totalSek,
})

const priced = (
  sessionId: string,
  generation: number | null,
  months: [number, number, CostTotals][],
  estimated = false,
): PricedForStore => ({
  sessionId,
  generation,
  estimated,
  months: months.map(([year, month, t]) => ({ year, month, totals: t })),
})

async function state(sessionId: string) {
  const [row] = await db.select().from(evSessionCost).where(eq(evSessionCost.sessionId, sessionId))
  return row
}

test('a session with no row is stale; once written it is current and summed per month', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const b = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')

  const before = await readMonthSums({ pricingVersion: V })
  expect(before.months).toEqual([])
  expect(before.stale.map((s) => s.sessionId).sort()).toEqual([a, b].sort())
  expect(before.stale.every((s) => s.generation === null)).toBe(true)

  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [[2026, 9, totals(5, 10)]]),
      priced(b, null, [
        [2026, 9, totals(2, 4)],
        [2026, 10, totals(3, 6)],
      ]),
    ],
  })
  expect(written).toBe(2)

  const after = await readMonthSums({ pricingVersion: V })
  expect(after.stale).toEqual([])
  const byMonth = new Map(after.months.map((m) => [m.year * 100 + m.month, m.totals]))
  expect(byMonth.get(202609)).toMatchObject({ kwh: 7, totalSek: 14 })
  expect(byMonth.get(202610)).toMatchObject({ kwh: 3, totalSek: 6 })
  expect(await state(a)).toMatchObject({ generation: 0, pricedGeneration: 0, pricingVersion: V })
})

test('a bump makes a written session stale, with its generation', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpSessions([a, a])

  const read = await readMonthSums({ pricingVersion: V })
  expect(read.months).toEqual([])
  expect(read.stale).toEqual([{ sessionId: a, generation: 1 }])
})

test('another pricing version is stale', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  const read = await readMonthSums({ pricingVersion: V + 1 })
  expect(read.months).toEqual([])
  expect(read.stale).toEqual([{ sessionId: a, generation: 0 }])
  expect(await listStale({ pricingVersion: V + 1 })).toEqual([{ sessionId: a, generation: 0 }])
  expect(await listStale({ pricingVersion: V })).toEqual([])
})

test('the write-back loses to a bump that came after the generation read', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpSessions([a])
  const { stale } = await readSessionSums({ sessionIds: [a], pricingVersion: V })
  expect(stale).toEqual([{ sessionId: a, generation: 1 }])

  await bumpSessions([a]) // a writer commits while the repricer is pricing
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, 1, [[2026, 9, totals(99, 99)]])],
  })

  expect(written).toBe(0)
  expect(await state(a)).toMatchObject({ generation: 2, pricedGeneration: 0 })
  const again = await readSessionSums({ sessionIds: [a], pricingVersion: V })
  expect(again.current).toEqual([])
  expect(again.stale).toEqual([{ sessionId: a, generation: 2 }])
})

test('a first write-back loses to a writer that created the row meanwhile', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  // Read as "no row" (generation null), then a writer bumps before the write-back.
  await bumpSessions([a])
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
  expect(await state(a)).toMatchObject({ generation: 1, pricedGeneration: null })
})

test('a re-price replaces the month rows', async () => {
  const a = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [
        [2026, 9, totals(2, 4)],
        [2026, 10, totals(3, 6)],
      ]),
    ],
  })
  await bumpSessions([a])
  await writePriced({ pricingVersion: V, sessions: [priced(a, 1, [[2026, 9, totals(5, 10)]])] })

  const { months } = await readMonthSums({ pricingVersion: V })
  expect(months).toEqual([{ year: 2026, month: 9, totals: totals(5, 10) }])
})

test('readSessionSums: current sums over months, stale ids, uncounted ids dropped', async () => {
  const a = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')
  const b = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  const voided = await session('2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z', { voided: true })
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(
        a,
        null,
        [
          [2026, 9, totals(2, 4)],
          [2026, 10, totals(3, 6)],
        ],
        true,
      ),
      priced(voided, null, [[2026, 9, totals(1, 1)]]),
    ],
  })

  const read = await readSessionSums({ sessionIds: [a, b, voided], pricingVersion: V })
  expect(read.current).toEqual([{ sessionId: a, estimated: true, totals: totals(5, 10) }])
  expect(read.stale).toEqual([{ sessionId: b, generation: null }])
  expect(await readSessionSums({ sessionIds: [], pricingVersion: V })).toEqual({
    current: [],
    stale: [],
  })
})

test('readMonthSums follows the counted filter and the vehicle scope', async () => {
  const ours = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const other = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z', {
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const noise = await session('2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z', { energyKwh: 0.01 })
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(ours, null, [[2026, 9, totals(5, 10)]]),
      priced(other, null, [[2026, 9, totals(7, 14)]]),
      priced(noise, null, [[2026, 9, totals(0.01, 1)]]),
    ],
  })

  const all = await readMonthSums({ pricingVersion: V })
  expect(all.months).toEqual([{ year: 2026, month: 9, totals: totals(12, 24) }])
  const oursOnly = await readMonthSums({ vehicle: 'ours', pricingVersion: V })
  expect(oursOnly.months).toEqual([{ year: 2026, month: 9, totals: totals(5, 10) }])
  const others = await readMonthSums({ vehicle: 'other', pricingVersion: V })
  expect(others.months).toEqual([{ year: 2026, month: 9, totals: totals(7, 14) }])
  expect(all.stale).toEqual([])
})

test('bumpOverlapping bumps sessions with energy in the range, by interval or window', async () => {
  const dayStart = Date.parse('2026-09-19T22:00:00Z') // Stockholm 2026-09-20
  const dayEnd = Date.parse('2026-09-20T22:00:00Z')
  const byWindow = await session('2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z')
  const byInterval = await session('2026-09-19T20:00:00Z', '2026-09-19T21:00:00Z')
  await insertInterval(
    byInterval,
    new Date('2026-09-19T21:45:00Z'),
    new Date('2026-09-19T22:15:00Z'),
    1,
  )
  const before = await session('2026-09-19T20:00:00Z', '2026-09-19T22:00:00Z') // ends at the day's start
  const after = await session('2026-09-20T22:00:00Z', '2026-09-20T23:00:00Z') // starts at its end

  await bumpOverlapping({ startMs: dayStart, endMs: dayEnd })

  expect((await state(byWindow))?.generation).toBe(1)
  expect((await state(byInterval))?.generation).toBe(1)
  expect(await state(before)).toBeUndefined()
  expect(await state(after)).toBeUndefined()
})

test('bumpAll bumps every session, creating the missing rows', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const b = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await bumpAll()
  expect((await state(a))?.generation).toBe(1)
  expect(await state(b)).toMatchObject({ generation: 1, pricedGeneration: null })
})

test('a repricer that read a session without a row loses to a tariff edit', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  // Read as "no row" (generation null), priced with the old tariff, then a tariff edit commits.
  await bumpAll()
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
  expect((await readSessionSums({ sessionIds: [a], pricingVersion: V })).stale).toEqual([
    { sessionId: a, generation: 1 },
  ])
})

test('a second write-back of the same generation rewrites nothing', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  const again = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, 0, [[2026, 9, totals(5, 10)]])],
  })
  expect(again.written).toBe(0)
  expect((await readMonthSums({ pricingVersion: V })).months).toEqual([
    { year: 2026, month: 9, totals: totals(5, 10) },
  ])
})

test('deleting a session deletes its stored cost', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await writePriced({ pricingVersion: V, sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])] })
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  expect(await state(a)).toBeUndefined()
  expect((await readMonthSums({ pricingVersion: V })).months).toEqual([])
})

test('a write-back skips a session deleted meanwhile', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await db.delete(evChargeSession).where(eq(evChargeSession.id, a))
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [priced(a, null, [[2026, 9, totals(5, 10)]])],
  })
  expect(written).toBe(0)
})

test('listCurrentMonths: the month rows of current counted sessions only', async () => {
  const a = await session('2026-09-30T21:00:00Z', '2026-09-30T23:00:00Z')
  const stale = await session('2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')
  const voided = await session('2026-09-03T10:00:00Z', '2026-09-03T11:00:00Z', { voided: true })
  await session('2026-09-04T10:00:00Z', '2026-09-04T11:00:00Z') // no row: stale
  await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [
        [2026, 9, totals(2, 4)],
        [2026, 10, totals(3, 6)],
      ]),
      priced(stale, null, [[2026, 9, totals(1, 2)]]),
      priced(voided, null, [[2026, 9, totals(1, 1)]]),
    ],
  })
  await bumpSessions([stale])

  const read = await listCurrentMonths({ pricingVersion: V })
  expect(read).toEqual([
    {
      sessionId: a,
      months: [
        { year: 2026, month: 9, totals: totals(2, 4) },
        { year: 2026, month: 10, totals: totals(3, 6) },
      ],
    },
  ])
  expect(await listCurrentMonths({ pricingVersion: V + 1 })).toEqual([])
})

test('a duplicate session in one write-back is stored once', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  const { written } = await writePriced({
    pricingVersion: V,
    sessions: [
      priced(a, null, [[2026, 9, totals(5, 10)]]),
      priced(a, null, [[2026, 9, totals(5, 10)]]),
    ],
  })
  expect(written).toBe(1)
  expect((await readMonthSums({ pricingVersion: V })).months).toEqual([
    { year: 2026, month: 9, totals: totals(5, 10) },
  ])
})

test('a write-back gives up on a locked row after its lock timeout and writes nothing', async () => {
  const a = await session('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')
  await bumpSessions([a])
  const { rows } = await db.execute<{ schema: string }>(sql`select current_schema() as schema`)
  const other = new Client({ connectionString: process.env.DATABASE_URL })
  await other.connect()
  try {
    await other.query(`set search_path to "${rows[0].schema}", public`)
    await other.query('begin')
    await other.query('select 1 from ev_session_cost where session_id = $1 for update', [a])

    const started = performance.now()
    await expect(
      writePriced({
        pricingVersion: V,
        sessions: [priced(a, 1, [[2026, 9, totals(5, 10)]])],
        lockTimeoutMs: 200,
      }),
    ).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(800)
    await other.query('rollback')
  } finally {
    await other.end()
  }
  expect(
    await db.select().from(evSessionCostMonth).where(eq(evSessionCostMonth.sessionId, a)),
  ).toEqual([])
  expect(await state(a)).toMatchObject({ generation: 1, pricedGeneration: null })
})
