import { eq, sql } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPump, heatPumpDay } from '~/lib/db/schema'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { upsertUnits } from './heatPump'
import { monthSums, refreshDaySums, splitRange } from './monthSums'

setupDatabase()

describe('splitRange', () => {
  const d = (iso: string) => new Date(iso)
  test('midnight to midnight: whole days only', () => {
    // Stockholm 2026-01-20 00:00 = 2026-01-19T23:00Z; 2026-02-01 00:00 = 2026-01-31T23:00Z.
    expect(splitRange(d('2026-01-19T23:00:00Z'), d('2026-01-31T23:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-20', to: '2026-02-01' },
      partials: [],
    })
  })
  test('midnight to mid-day (Översikt): whole days, then the last day up to `to`', () => {
    expect(splitRange(d('2026-01-19T23:00:00Z'), d('2026-10-15T06:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-20', to: '2026-10-15' },
      partials: [{ from: d('2026-10-14T22:00:00Z'), to: d('2026-10-15T06:00:00Z') }],
    })
  })
  test('mid-day to mid-day: a partial first day, whole days, a partial last day', () => {
    expect(splitRange(d('2026-01-15T05:00:00Z'), d('2026-01-18T05:00:00Z'))).toEqual({
      wholeDays: { from: '2026-01-16', to: '2026-01-18' },
      partials: [
        { from: d('2026-01-15T05:00:00Z'), to: d('2026-01-15T23:00:00Z') },
        { from: d('2026-01-17T23:00:00Z'), to: d('2026-01-18T05:00:00Z') },
      ],
    })
  })
  test('within one day, or across one midnight with no whole day: one partial', () => {
    expect(splitRange(d('2026-03-01T00:00:00Z'), d('2026-03-01T07:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [{ from: d('2026-03-01T00:00:00Z'), to: d('2026-03-01T07:00:00Z') }],
    })
    expect(splitRange(d('2026-03-01T10:00:00Z'), d('2026-03-02T07:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [{ from: d('2026-03-01T10:00:00Z'), to: d('2026-03-02T07:00:00Z') }],
    })
  })
  test('DST: the 23-hour and 25-hour days are split at local midnight', () => {
    // 2026-03-29 runs 2026-03-28T23:00Z → 2026-03-29T22:00Z; 2026-03-30 ends 2026-03-30T22:00Z.
    expect(splitRange(d('2026-03-29T10:00:00Z'), d('2026-03-30T22:00:00Z'))).toEqual({
      wholeDays: { from: '2026-03-30', to: '2026-03-31' },
      partials: [{ from: d('2026-03-29T10:00:00Z'), to: d('2026-03-29T22:00:00Z') }],
    })
    // 2025-10-26 runs 2025-10-25T22:00Z → 2025-10-26T23:00Z (25 h).
    expect(splitRange(d('2025-10-25T22:00:00Z'), d('2025-10-26T23:00:00Z'))).toEqual({
      wholeDays: { from: '2025-10-26', to: '2025-10-27' },
      partials: [],
    })
  })
  test('an empty or inverted range: nothing', () => {
    expect(splitRange(d('2026-03-01T00:00:00Z'), d('2026-03-01T00:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [],
    })
    expect(splitRange(d('2026-03-02T00:00:00Z'), d('2026-03-01T00:00:00Z'))).toEqual({
      wholeDays: null,
      partials: [],
    })
  })
})

const viewRows = async () =>
  (await db.select().from(heatPumpDay)).sort(
    (a, b) => a.heatPumpId.localeCompare(b.heatPumpId) || a.day.localeCompare(b.day),
  )

test('refreshDaySums over no readings leaves the view empty', async () => {
  await refreshDaySums()
  expect(await viewRows()).toEqual([])
})

test('the view sums each unit per Stockholm day: DST days have 25 and 23 hours, 22:00Z/23:00Z start a day', async () => {
  const id = await seedUnits('Matsal')
  // 2025-10-26 (CET from 03:00 local): 2025-10-25T22:00Z → 2025-10-26T23:00Z, 25 hours.
  // 2026-03-29 (CEST from 02:00 local): 2026-03-28T23:00Z → 2026-03-29T22:00Z, 23 hours.
  await storeHours(id.Matsal, '2025-10-25T21:00:00Z', '2025-10-27T00:00:00Z', undefined, {
    refresh: false,
  })
  await storeHours(id.Matsal, '2026-03-28T22:00:00Z', '2026-03-29T23:00:00Z', undefined, {
    refresh: false,
  })
  expect(await viewRows()).toEqual([]) // not refreshed yet
  await refreshDaySums()
  expect((await viewRows()).map((r) => [r.day, r.hours])).toEqual([
    ['2025-10-25', 1],
    ['2025-10-26', 25],
    ['2025-10-27', 1],
    ['2026-03-28', 1],
    ['2026-03-29', 23],
    ['2026-03-30', 1],
  ])
})

test('the view keeps temperature sums and hour counts, and a null share counts 0', async () => {
  const id = await seedUnits('Matsal')
  const hours = [
    { energyKwh: 0.2, heatShare: 1, coolShare: 0, insideC: 20, outsideC: -2, setpointC: null },
    {
      energyKwh: 0.4,
      heatShare: null,
      coolShare: null,
      insideC: null,
      outsideC: 4,
      setpointC: null,
    },
  ]
  await storeHours(id.Matsal, '2026-01-15T10:00:00Z', '2026-01-15T12:00:00Z', (_t, i) => hours[i])
  const [row] = await viewRows()
  expect(row).toMatchObject({
    day: '2026-01-15',
    hours: 2,
    insideCHours: 1,
    outsideCHours: 2,
    setpointCHours: 0,
    setpointCSum: null,
    firstHour: new Date('2026-01-15T10:00:00Z'),
    lastHour: new Date('2026-01-15T11:00:00Z'),
  })
  expect(row.kwh).toBeCloseTo(0.6, 9)
  expect(row.heatKwh).toBeCloseTo(0.2, 9)
  expect(row.coolKwh).toBeCloseTo(0, 9)
  expect(row.insideCSum).toBeCloseTo(20, 9)
  expect(row.outsideCSum).toBeCloseTo(2, 9)
})

test('a re-stored day that shrinks goes down after the refresh (recomputed, not added)', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T10:00:00Z')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T04:00:00Z') // replaces the UTC day
  const [row] = await viewRows()
  expect(row.hours).toBe(4)
  expect(row.kwh).toBeCloseTo(0.4, 9)
})

const all = { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2030-01-01T00:00:00Z') }

test('no readings: no rows', async () => {
  expect(await monthSums(all)).toEqual([])
})

test('sums each unit per Stockholm month across a month edge, in name order', async () => {
  // Inserted Övervåning first: the order comes from the name, not the insert.
  const id = await seedUnits('Övervåning', 'Matsal')
  // 31 March CEST: 20:00Z and 21:00Z are 22:00 and 23:00 in March, 22:00Z is 00:00 on 1 April.
  await storeHours(id.Matsal, '2026-03-31T20:00:00Z', '2026-03-31T23:00:00Z')
  await storeHours(id.Övervåning, '2026-03-31T21:00:00Z', '2026-03-31T22:00:00Z', () => ({
    energyKwh: 0.3,
  }))
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.name, r.year, r.month, r.hours])).toEqual([
    ['Matsal', 2026, 3, 2],
    ['Matsal', 2026, 4, 1],
    ['Övervåning', 2026, 3, 1],
  ])
  expect(rows[0].kwh).toBeCloseTo(0.2, 9)
  expect(rows[1].kwh).toBeCloseTo(0.1, 9)
  expect(rows[2].kwh).toBeCloseTo(0.3, 9)
  expect(rows[0].heatPumpId).toBe(id.Matsal)
  expect(rows[0].firstHour).toEqual(new Date('2026-03-31T20:00:00Z'))
  expect(rows[0].lastHour).toEqual(new Date('2026-03-31T21:00:00Z'))
})

test('two units with one name: ordered by id, each one’s months in order', async () => {
  const rows = await upsertUnits(
    [
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
      { guid: 'CS-HZ25ZKE+0000000002', name: 'Matsal', model: 'CS-HZ25ZKE' },
    ],
    new Date('2026-10-08T12:00:00Z'),
  )
  const [low, high] = rows.map((r) => r.id).sort()
  // Each across the March/April edge (31 March 22:00Z is 00:00 on 1 April); the higher id stored first.
  for (const id of [high, low]) await storeHours(id, '2026-03-31T21:00:00Z', '2026-03-31T23:00:00Z')
  expect((await monthSums(all)).map((r) => [r.heatPumpId, r.month])).toEqual([
    [low, 3],
    [low, 4],
    [high, 3],
    [high, 4],
  ])
})

test('both DST days: October 2025 has 745 hours, March 2026 743, none spill into a neighbour month', async () => {
  const id = await seedUnits('Matsal')
  // Stockholm October 2025: 2025-09-30T22:00Z (CEST) → 2025-10-31T23:00Z (CET), the 26th has 25 h.
  await storeHours(id.Matsal, '2025-09-30T22:00:00Z', '2025-10-31T23:00:00Z')
  // Stockholm March 2026: 2026-02-28T23:00Z (CET) → 2026-03-31T22:00:00Z (CEST), the 29th has 23 h.
  await storeHours(id.Matsal, '2026-02-28T23:00:00Z', '2026-03-31T22:00:00Z')
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.year, r.month, r.hours])).toEqual([
    [2025, 10, 745],
    [2026, 3, 743],
  ])
  expect(rows[0].kwh).toBeCloseTo(74.5, 9)
  expect(rows[1].kwh).toBeCloseTo(74.3, 9)
})

test('heating and cooling kWh weight each hour by its share; temperatures are hour means over hours with a value', async () => {
  const id = await seedUnits('Matsal')
  const hours = [
    { energyKwh: 0.2, heatShare: 1, coolShare: 0, insideC: 20, outsideC: -2, setpointC: null },
    {
      energyKwh: 0.4,
      heatShare: 0.5,
      coolShare: 0.5,
      insideC: 22,
      outsideC: null,
      setpointC: null,
    },
    {
      energyKwh: 0.1,
      heatShare: null,
      coolShare: null,
      insideC: null,
      outsideC: null,
      setpointC: null,
    },
    { energyKwh: 0.3, heatShare: 0, coolShare: 1, insideC: 21, outsideC: 4, setpointC: null },
  ]
  await storeHours(id.Matsal, '2026-01-15T10:00:00Z', '2026-01-15T14:00:00Z', (_t, i) => hours[i])
  const [row] = await monthSums(all)
  expect(row.kwh).toBeCloseTo(1, 9)
  expect(row.heatKwh).toBeCloseTo(0.4, 9) // 0,2 + 0,2; an hour without a share counts 0
  expect(row.coolKwh).toBeCloseTo(0.5, 9) // 0,2 + 0,3
  expect(row.insideC).toBeCloseTo(21, 9)
  expect(row.outsideC).toBeCloseTo(1, 9)
  expect(row.setpointC).toBeNull()
  expect(row.hours).toBe(4)
})

test('only hours in [from, to) are read', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T06:00:00Z')
  const [row] = await monthSums({
    from: new Date('2026-01-15T02:00:00Z'),
    to: new Date('2026-01-15T05:00:00Z'),
  })
  expect(row.hours).toBe(3)
  expect(row.firstHour).toEqual(new Date('2026-01-15T02:00:00Z'))
  expect(row.lastHour).toEqual(new Date('2026-01-15T04:00:00Z'))
})

test('a renamed unit reads under its current name, history kept', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T02:00:00Z')
  const renamedAt = new Date('2026-10-09T08:00:00Z')
  await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsalen', model: 'CS-HZ25ZKE' }],
    renamedAt,
  )
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.heatPumpId, r.name, r.hours])).toEqual([[id.Matsal, 'Matsalen', 2]])
  expect(rows[0].lastSeenAt).toEqual(renamedAt)
})

test('privacy: a row holds sums only, never an hour', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T03:00:00Z')
  const [row] = await monthSums(all)
  expect(Object.keys(row).sort()).toEqual([
    'coolKwh',
    'firstHour',
    'heatKwh',
    'heatPumpId',
    'hours',
    'insideC',
    'kwh',
    'lastHour',
    'lastSeenAt',
    'month',
    'name',
    'outsideC',
    'setpointC',
    'year',
  ])
})

/** The pre-step-2b read, straight over the readings: what `monthSums` must equal. */
async function reference(from: Date, to: Date) {
  const { rows } = await db.execute<{
    heat_pump_id: string
    y: number
    m: number
    kwh: number
    heat: number
    inside: number | null
    hours: number
  }>(sql`
    SELECT heat_pump_id,
      extract(year from date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm'))::int AS y,
      extract(month from date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm'))::int AS m,
      sum(energy_kwh)::float8 AS kwh, sum(energy_kwh * coalesce(heat_share, 0))::float8 AS heat,
      avg(inside_c)::float8 AS inside, count(*)::int AS hours
    FROM heat_pump_reading
    WHERE hour_start >= ${from.toISOString()}::timestamptz AND hour_start < ${to.toISOString()}::timestamptz
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
  return rows.map((r) => ({
    id: r.heat_pump_id,
    y: r.y,
    m: r.m,
    kwh: r.kwh,
    heat: r.heat,
    inside: r.inside,
    hours: r.hours,
  }))
}

test.each([
  ['midnight → mid-day (Översikt)', '2025-10-19T22:00:00Z', '2026-04-02T07:00:00Z'],
  ['mid-day → mid-day across both DST days', '2025-10-25T10:00:00Z', '2026-03-29T10:00:00Z'],
  ['a partial last day on the 23-hour day', '2026-03-01T00:00:00Z', '2026-03-29T05:00:00Z'],
  ['same day (lastYearSoFar on the 1st)', '2026-03-31T22:00:00Z', '2026-04-01T06:00:00Z'],
  ['across a month edge without a whole day', '2026-03-31T20:00:00Z', '2026-04-01T03:00:00Z'],
])('equals the raw read: %s', async (_name, fromIso, toIso) => {
  const id = await seedUnits('Matsal', 'Övervåning')
  // Varying values (synthetic) so a lost or doubled hour shows; Övervåning has gaps.
  const vary = (_t: number, i: number) => ({
    energyKwh: 0.01 + (i % 7) * 0.01,
    insideC: 18 + (i % 5),
    heatShare: (i % 3) / 2,
  })
  await storeHours(id.Matsal, '2025-10-01T00:00:00Z', '2026-04-03T00:00:00Z', vary)
  await storeHours(id.Övervåning, '2025-10-01T00:00:00Z', '2026-04-03T00:00:00Z', (t, i) =>
    i % 50 === 0 ? null : vary(t, i),
  )
  const from = new Date(fromIso)
  const to = new Date(toIso)
  const got = (await monthSums({ from, to })).map((r) => ({
    id: r.heatPumpId,
    y: r.year,
    m: r.month,
    kwh: r.kwh,
    heat: r.heatKwh,
    inside: r.insideC,
    hours: r.hours,
  }))
  const want = await reference(from, to)
  const key = (x: { id: string; y: number; m: number; hours: number }) =>
    `${x.id} ${x.y}-${x.m} ${x.hours}`
  expect(got.map(key).sort()).toEqual(want.map(key).sort())
  for (const w of want) {
    const g = got.find((x) => x.id === w.id && x.y === w.y && x.m === w.m)
    expect(g?.kwh).toBeCloseTo(w.kwh, 9)
    expect(g?.heat).toBeCloseTo(w.heat, 9)
    expect(g?.inside).toBeCloseTo(w.inside as number, 9) // every stored hour has an inside value
  }
})

test('hours stored after the refresh: a partial day counts them at once, a whole day only after the next refresh', async () => {
  const id = await seedUnits('Matsal')
  // Stockholm 2026-01-15 whole (24 h: 2026-01-14T23:00Z … 2026-01-15T22:00Z), refreshed.
  await storeHours(id.Matsal, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  // Without a refresh, re-store the UTC day 2026-01-15 as 00:00Z–09:00Z (10 h) plus 23:00Z, which is the
  // first hour of Stockholm 2026-01-16. Raw now: the 15th has 1 + 10 = 11 h, the 16th 1 h.
  const keep = (t: number) => {
    const h = new Date(t).getUTCHours()
    return h <= 9 || h === 23 ? {} : null
  }
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z', keep, {
    refresh: false,
  })
  // Whole day: the 15th (from the view); partial: [2026-01-15T23:00Z, 2026-01-16T05:00Z) (live).
  const range = { from: new Date('2026-01-14T23:00:00Z'), to: new Date('2026-01-16T05:00:00Z') }
  expect((await monthSums(range))[0].hours).toBe(24 + 1) // the stale 15th, the new 16th hour
  await refreshDaySums()
  expect((await monthSums(range))[0].hours).toBe(11 + 1)
})

test('a unit deleted before the refresh never shows', async () => {
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  await storeHours(id.Övervåning, '2026-01-14T23:00:00Z', '2026-01-15T23:00:00Z')
  await db.delete(heatPump).where(eq(heatPump.id, id.Övervåning)) // cascades its readings; the view is stale
  const rows = await monthSums({
    from: new Date('2026-01-14T23:00:00Z'),
    to: new Date('2026-01-15T23:00:00Z'),
  })
  expect(rows.map((r) => r.name)).toEqual(['Matsal'])
})
