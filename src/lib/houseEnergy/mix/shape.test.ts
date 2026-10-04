import { expect, test } from 'vitest'
import type { HouseReading } from '~/lib/services/houseEnergy'
import { reading } from '~test/fixtures/houseEnergy'
import { BUCKET_MS, type CarBucket, shapeSession } from './shape'

const at = (iso: string) => Date.parse(iso)
const total = (b: CarBucket[]) => b.reduce((s, x) => s + x.kwh, 0)
const kwhAt = (b: CarBucket[], iso: string) => b.find((x) => x.bucketStart === at(iso))?.kwh ?? 0

/** One reading per bucket over [fromIso, toIso) with `load(ms)` (all from the grid). */
function loads(fromIso: string, toIso: string, load: (ms: number) => number): HouseReading[] {
  const out: HouseReading[] = []
  for (let t = at(fromIso); t < at(toIso); t += BUCKET_MS) {
    out.push(reading(t, { loadKwh: load(t), gridImportKwh: load(t) }))
  }
  return out
}

const LONG = { startMs: at('2026-06-10T07:00:00Z'), endMs: at('2026-06-10T10:00:00Z'), kwh: 24 }

test('without readings an interval spreads uniformly over its buckets', () => {
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T11:00:00Z'), kwh: 6 }],
    readings: [],
  })
  expect(out).toHaveLength(12)
  expect(out[0].bucketStart).toBe(at('2026-06-10T10:00:00Z'))
  for (const b of out) expect(b.kwh).toBeCloseTo(0.5, 12)
})

test('an unaligned interval splits its edge buckets by overlap', () => {
  const out = shapeSession({
    startMs: at('2026-06-10T10:02:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:02:00Z'), endMs: at('2026-06-10T10:12:00Z'), kwh: 1 }],
    readings: [],
  })
  expect(kwhAt(out, '2026-06-10T10:00:00Z')).toBeCloseTo(0.3, 12)
  expect(kwhAt(out, '2026-06-10T10:05:00Z')).toBeCloseTo(0.5, 12)
  expect(kwhAt(out, '2026-06-10T10:10:00Z')).toBeCloseTo(0.2, 12)
})

test('the load rise above the pre-session baseline shapes a long interval', () => {
  // Zaptec's interval starts 07:00 but the car draws from 08:00: the load
  // jumps from 0.1 to 1.1 kWh per bucket there.
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', (t) =>
    t < at('2026-06-10T08:00:00Z') ? 0.1 : 1.1,
  )
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(24)
  expect(out[0].bucketStart).toBe(at('2026-06-10T08:00:00Z'))
  for (const b of out) expect(b.kwh).toBeCloseTo(1, 12)
  expect(kwhAt(out, '2026-06-10T07:30:00Z')).toBe(0)
})

test('a gap inside the interval falls back to a uniform spread', () => {
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', (t) =>
    t < at('2026-06-10T08:00:00Z') ? 0.1 : 1.1,
  ).filter((r) => r.bucketStart.getTime() !== at('2026-06-10T09:00:00Z'))
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('fewer than three pre-session buckets means no baseline: uniform spread', () => {
  const readings = loads('2026-06-10T06:50:00Z', '2026-06-10T10:00:00Z', () => 1.1)
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('a load that never rises above the baseline spreads uniformly', () => {
  const readings = loads('2026-06-10T06:30:00Z', '2026-06-10T10:00:00Z', () => 1)
  const out = shapeSession({ startMs: LONG.startMs, stretches: [LONG], readings })
  expect(out).toHaveLength(36)
  for (const b of out) expect(b.kwh).toBeCloseTo(24 / 36, 12)
})

test('a bucket is capped at the house load and the excess moves to buckets with headroom', () => {
  // No pre-session readings → uniform 1 kWh each; the first two buckets only
  // had 0.5 kWh of load in total.
  const readings = [0.5, 0.5, 2, 2].map((load, i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: load, gridImportKwh: load }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:20:00Z'), kwh: 4 }],
    readings,
  })
  expect(out.map((b) => b.kwh)).toEqual([0.5, 0.5, 1.5, 1.5].map((x) => expect.closeTo(x, 12)))
})

test('with no headroom anywhere the excess spreads by overlap (load is exceeded, kWh kept)', () => {
  const readings = [0, 1, 2, 3].map((i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: 0.5, gridImportKwh: 0.5 }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [{ startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:20:00Z'), kwh: 4 }],
    readings,
  })
  expect(out.map((b) => b.kwh)).toEqual([1, 1, 1, 1].map((x) => expect.closeTo(x, 12)))
})

test("an earlier interval's energy in a shared bucket counts against its load", () => {
  const readings = [1.0, 0.6, 2.0].map((load, i) =>
    reading(at('2026-06-10T10:00:00Z') + i * BUCKET_MS, { loadKwh: load, gridImportKwh: load }),
  )
  const out = shapeSession({
    startMs: at('2026-06-10T10:00:00Z'),
    stretches: [
      { startMs: at('2026-06-10T10:00:00Z'), endMs: at('2026-06-10T10:07:30Z'), kwh: 1.5 },
      { startMs: at('2026-06-10T10:07:30Z'), endMs: at('2026-06-10T10:15:00Z'), kwh: 1 },
    ],
    readings,
  })
  // A: 1.0 + 0.5. B: 1/3 into 10:05 capped at 0.6 − 0.5 = 0.1, the rest to 10:10.
  expect(kwhAt(out, '2026-06-10T10:00:00Z')).toBeCloseTo(1, 12)
  expect(kwhAt(out, '2026-06-10T10:05:00Z')).toBeCloseTo(0.6, 12)
  expect(kwhAt(out, '2026-06-10T10:10:00Z')).toBeCloseTo(0.9, 12)
})

test("every interval's kWh stays exact through shaping and clamping", () => {
  let seed = 7
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const readings = loads('2026-06-10T06:00:00Z', '2026-06-10T14:00:00Z', () => rand() * 1.5)
  const stretches = [
    { startMs: at('2026-06-10T07:03:00Z'), endMs: at('2026-06-10T08:41:00Z'), kwh: 9.7 },
    { startMs: at('2026-06-10T08:41:00Z'), endMs: at('2026-06-10T11:17:00Z'), kwh: 13.1 },
    { startMs: at('2026-06-10T11:17:00Z'), endMs: at('2026-06-10T13:59:00Z'), kwh: 2.25 },
  ]
  const out = shapeSession({ startMs: stretches[0].startMs, stretches, readings })
  expect(total(out)).toBeCloseTo(9.7 + 13.1 + 2.25, 9)
  for (const b of out) expect(b.kwh).toBeGreaterThanOrEqual(0)
})

test('a zero-length (estimated) stretch lands in its start bucket', () => {
  const t = at('2026-06-10T10:02:00Z')
  expect(
    shapeSession({ startMs: t, stretches: [{ startMs: t, endMs: t, kwh: 3 }], readings: [] }),
  ).toEqual([{ bucketStart: at('2026-06-10T10:00:00Z'), kwh: 3 }])
})

test('zero-kWh intervals produce no buckets', () => {
  expect(
    shapeSession({ startMs: LONG.startMs, stretches: [{ ...LONG, kwh: 0 }], readings: [] }),
  ).toEqual([])
})

test('an hour across the spring-forward switch is twelve buckets (UTC, never local)', () => {
  // 2026-03-29 00:30Z–01:30Z = 01:30 CET → 03:30 CEST.
  const out = shapeSession({
    startMs: at('2026-03-29T00:30:00Z'),
    stretches: [{ startMs: at('2026-03-29T00:30:00Z'), endMs: at('2026-03-29T01:30:00Z'), kwh: 6 }],
    readings: [],
  })
  expect(out).toHaveLength(12)
  expect(total(out)).toBeCloseTo(6, 12)
})
