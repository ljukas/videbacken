import { expect, test } from 'vitest'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { upsertUnits } from './heatPump'
import { monthSums } from './monthSums'

setupDatabase()

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
