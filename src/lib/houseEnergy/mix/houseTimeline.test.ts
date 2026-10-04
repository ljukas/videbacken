import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { reading, syntheticDay } from '~test/fixtures/houseEnergy'
import { runHouseTimeline } from './houseTimeline'
import { BATTERY_CAPACITY_KWH, emptyPool } from './pool'

// No SoC in these readings unless a test sets one, so the pool isn't capped.
const charging = () => ({ batteryChargeGridKwh: 0.01, gridImportKwh: 0.01 })
const C = BATTERY_CAPACITY_KWH

test('a spring-forward day steps 276 buckets into one checkpoint', () => {
  const readings = syntheticDay('2026-03-29', charging)
  expect(readings).toHaveLength(276)
  const { days, house } = runHouseTimeline({
    readings,
    fromDay: '2026-03-29',
    throughDay: '2026-03-29',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days.map((d) => d.day)).toEqual(['2026-03-29'])
  expect(days[0].state.gridKwh).toBeCloseTo(276 * 0.01, 9)
  expect(house.size).toBe(276)
})

test('a fall-back day steps 300 buckets into one checkpoint', () => {
  const readings = syntheticDay('2026-10-25', charging)
  expect(readings).toHaveLength(300)
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-10-25',
    throughDay: '2026-10-25',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days).toHaveLength(1)
  expect(days[0].state.gridKwh).toBeCloseTo(300 * 0.01, 9)
})

test('days without readings carry the state forward, through throughDay', () => {
  const readings = [
    ...syntheticDay('2026-06-08', charging),
    ...syntheticDay('2026-06-10', charging),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-08',
    throughDay: '2026-06-12',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days.map((d) => d.day)).toEqual([
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
    '2026-06-12',
  ])
  expect(days[1].state).toEqual(days[0].state)
  expect(days[4].state).toEqual(days[2].state)
  expect(days[2].state.gridKwh).toBeCloseTo(2 * 288 * 0.01, 9)
})

test('readings before fromDay are not stepped (they only feed the shaping baseline)', () => {
  const readings = [...syntheticDay('2026-06-09', charging), ...syntheticDay('2026-06-10')]
  const { days, house } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days[0].state).toEqual(emptyPool())
  expect(house.has(stockholmDayBounds('2026-06-09').startMs)).toBe(false)
})

test("each bucket's inflow carries its own slot's spot", () => {
  const t0 = Date.UTC(2026, 5, 10, 10)
  const t1 = t0 + 300_000
  const readings = [
    reading(t0, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
    reading(t1, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: (ms) => (ms === t0 ? 1 : 3),
    capacityKwh: C,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(2, 12)
  expect(days[0].state.gridSpotSekSum).toBeCloseTo(4, 12)
})

test('after each bucket the pool is capped at its end-of-bucket SoC × capacity, keeping its cost', () => {
  // Capacity 10 kWh; SoC 10 → 12 → 14 %: the end-of-bucket caps are 1.1 and
  // 1.3 kWh; the last bucket has no next reading, so it isn't capped.
  const t0 = Date.UTC(2026, 5, 10, 10)
  const readings = [10, 12, 14].map((soc, i) =>
    reading(t0 + i * 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: soc }),
  )
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  // 1 (under 1.1) → 2 capped to 1.3 → 2.3 uncapped; all 3 SEK paid stay.
  expect(days[0].state.gridKwh).toBeCloseTo(2.3, 12)
  expect(days[0].state.gridSpotSekSum).toBeCloseTo(3, 12)
})

test('the bucket before a gap is not capped', () => {
  const t0 = Date.UTC(2026, 5, 10, 10)
  const readings = [
    reading(t0, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 10 }),
    reading(t0 + 600_000, { batterySocPct: 10 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 1,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(1, 12)
})

test("the cap of a day's last bucket uses the next day's first reading", () => {
  const day = '2026-06-10'
  const next = stockholmDayBounds(day).endMs
  const readings = [
    reading(next - 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 4 }),
    reading(next, { batterySocPct: 6 }),
  ]
  const { days } = runHouseTimeline({
    readings,
    fromDay: day,
    throughDay: '2026-06-11',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(0.5, 12)
})

test("records each bucket's house supply and what left the battery", () => {
  const t = Date.UTC(2026, 5, 10, 19)
  const { house } = runHouseTimeline({
    readings: [reading(t, { gridImportKwh: 0.3, batteryDischargeKwh: 0.3, loadKwh: 0.6 })],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 2,
    capacityKwh: C,
  })
  const bucket = house.get(t)
  expect(bucket?.supply?.grid).toBeCloseTo(0.5, 12)
  expect(bucket?.supply?.battery).toBeCloseTo(0.5, 12)
  // Empty pool: the whole discharge is drift, grid-origin at the current spot.
  expect(bucket?.batteryOut.gridKwh).toBeCloseTo(0.3, 12)
  expect(bucket?.batteryOut.gridSpotSekSum).toBeCloseTo(0.6, 12)
})

test('fromDay after throughDay and no readings: no checkpoints', () => {
  const r = runHouseTimeline({
    readings: [],
    fromDay: '2026-06-11',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(r.days).toEqual([])
  expect(r.house.size).toBe(0)
})

const startPool = {
  storedKwh: 1,
  gridKwh: 1,
  gridSpotSekSum: 0.5,
  solarKwh: 0,
  solarSpotSekSum: 0,
  unpricedKwh: 0,
}

test('readings after throughDay extend the run to their day', () => {
  const t = Date.UTC(2026, 5, 11, 10)
  const { days, house } = runHouseTimeline({
    readings: [reading(t, { batteryChargeGridKwh: 1, gridImportKwh: 1 })],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(days.map((d) => d.day)).toEqual(['2026-06-10', '2026-06-11'])
  expect(house.has(t)).toBe(true)
})

test('the run starts from the given pool', () => {
  const t = Date.UTC(2026, 5, 10, 19)
  const empty = runHouseTimeline({
    readings: [],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: startPool,
    spotAt: () => 1,
    capacityKwh: C,
  })
  expect(empty.days[0].state).toEqual(startPool)
  const { house } = runHouseTimeline({
    readings: [reading(t, { batteryDischargeKwh: 0.4, loadKwh: 0.4 })],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: startPool,
    spotAt: () => 9,
    capacityKwh: C,
  })
  expect(house.get(t)?.batteryOut.gridKwh).toBeCloseTo(0.4, 12)
  expect(house.get(t)?.batteryOut.gridSpotSekSum).toBeCloseTo(0.2, 12)
})

test('readings out of order are stepped in time order', () => {
  const t0 = Date.UTC(2026, 5, 10, 10)
  const readings = [10, 12, 14]
    .map((soc, i) =>
      reading(t0 + i * 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: soc }),
    )
    .reverse()
  const { days } = runHouseTimeline({
    readings,
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(2.3, 12)
})

test("the next day's first bucket belongs to the next day's checkpoint", () => {
  const next = stockholmDayBounds('2026-06-10').endMs
  const { days } = runHouseTimeline({
    readings: [
      reading(next - 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 4 }),
      reading(next, { batteryChargeGridKwh: 1, gridImportKwh: 1, batterySocPct: 6 }),
    ],
    fromDay: '2026-06-10',
    throughDay: '2026-06-11',
    start: emptyPool(),
    spotAt: () => 1,
    capacityKwh: 10,
  })
  expect(days[0].state.gridKwh).toBeCloseTo(0.5, 12)
  expect(days[1].state.gridKwh).toBeCloseTo(1.5, 12)
})

test('without a spot price, inflow is unpriced and drift is recorded as unpriced', () => {
  const t = Date.UTC(2026, 5, 10, 10)
  const { days, house } = runHouseTimeline({
    readings: [
      reading(t, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
      reading(t + 300_000, { batteryDischargeKwh: 1.5, loadKwh: 1.5 }),
    ],
    fromDay: '2026-06-10',
    throughDay: '2026-06-10',
    start: emptyPool(),
    spotAt: () => null,
    capacityKwh: C,
  })
  expect(house.get(t + 300_000)?.batteryOut.unpricedKwh).toBeCloseTo(1.5, 12)
  expect(days[0].state).toEqual(emptyPool())
})
