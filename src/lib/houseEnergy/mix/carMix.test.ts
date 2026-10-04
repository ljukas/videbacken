import { expect, test } from 'vitest'
import { type BucketHouse, deriveSessionMix, type MixSlot } from './carMix'
import type { BatteryOut } from './pool'
import { BUCKET_MS } from './shape'

const T0 = Date.UTC(2026, 5, 10, 10) // 10:00Z, a quarter-hour
const out = (o: Partial<BatteryOut> = {}): BatteryOut => ({
  gridKwh: 0,
  gridSpotSekSum: 0,
  solarKwh: 0,
  solarSpotSekSum: 0,
  unpricedKwh: 0,
  ...o,
})
const parts = (s: MixSlot) =>
  s.gridKwh +
  s.solarKwh +
  s.batteryGridKwh +
  s.batterySolarKwh +
  s.batteryUnpricedKwh +
  s.noHouseDataKwh

test('without house data every kWh is no-house-data', () => {
  const mix = deriveSessionMix(
    [0, 1, 2].map((i) => ({ bucketStart: T0 + i * BUCKET_MS, kwh: 1 })),
    new Map(),
  )
  expect(mix).toEqual([
    {
      slotStart: new Date(T0),
      kwh: 3,
      gridKwh: 0,
      solarKwh: 0,
      batteryGridKwh: 0,
      batteryGridSpotSek: null,
      batterySolarKwh: 0,
      batterySolarSpotSek: null,
      batteryUnpricedKwh: 0,
      noHouseDataKwh: 3,
    },
  ])
})

test('a bucket whose house supply is unknown (zero load) is no-house-data', () => {
  const house = new Map<number, BucketHouse>([[T0, { supply: null, batteryOut: out() }]])
  expect(deriveSessionMix([{ bucketStart: T0, kwh: 2 }], house)[0].noHouseDataKwh).toBe(2)
})

test("the car gets the house's proportional mix", () => {
  const house = new Map<number, BucketHouse>([
    [
      T0,
      {
        supply: { grid: 0.5, solar: 0.3, battery: 0.2 },
        batteryOut: out({ gridKwh: 1, gridSpotSekSum: 1.2 }),
      },
    ],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 2 }], house)
  expect(slot.gridKwh).toBeCloseTo(1, 12)
  expect(slot.solarKwh).toBeCloseTo(0.6, 12)
  expect(slot.batteryGridKwh).toBeCloseTo(0.4, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(1.2, 12)
  expect(slot.batterySolarKwh).toBe(0)
  expect(slot.batterySolarSpotSek).toBeNull()
})

test('the battery part splits by what left the battery, each with its average spot', () => {
  const house = new Map<number, BucketHouse>([
    [
      T0,
      {
        supply: { grid: 0, solar: 0, battery: 1 },
        batteryOut: out({ gridKwh: 1, gridSpotSekSum: 1, solarKwh: 3, solarSpotSekSum: 1.5 }),
      },
    ],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.4 }], house)
  expect(slot.batteryGridKwh).toBeCloseTo(0.1, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(1, 12)
  expect(slot.batterySolarKwh).toBeCloseTo(0.3, 12)
  expect(slot.batterySolarSpotSek).toBeCloseTo(0.5, 12)
})

test('battery energy of unpriced origin stays unpriced', () => {
  const house = new Map<number, BucketHouse>([
    [T0, { supply: { grid: 0, solar: 0, battery: 1 }, batteryOut: out({ unpricedKwh: 0.5 }) }],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.5 }], house)
  expect(slot.batteryUnpricedKwh).toBeCloseTo(0.5, 12)
  expect(slot.batteryGridSpotSek).toBeNull()
})

test('buckets aggregate into 15-min slots with kWh-weighted battery spots', () => {
  const battery = (spot: number): BucketHouse => ({
    supply: { grid: 0, solar: 0, battery: 1 },
    batteryOut: out({ gridKwh: 1, gridSpotSekSum: spot }),
  })
  const house = new Map<number, BucketHouse>([
    [T0, battery(1)],
    [T0 + BUCKET_MS, battery(2)],
    [T0 + 3 * BUCKET_MS, battery(3)],
  ])
  const mix = deriveSessionMix(
    [
      { bucketStart: T0, kwh: 1 },
      { bucketStart: T0 + BUCKET_MS, kwh: 3 },
      { bucketStart: T0 + 3 * BUCKET_MS, kwh: 2 },
    ],
    house,
  )
  expect(mix.map((s) => s.slotStart.getTime())).toEqual([T0, T0 + 3 * BUCKET_MS])
  expect(mix[0].kwh).toBeCloseTo(4, 12)
  expect(mix[0].batteryGridSpotSek).toBeCloseTo((1 * 1 + 3 * 2) / 4, 12)
  expect(mix[1].batteryGridSpotSek).toBeCloseTo(3, 12)
})

test('a session across midnight yields slots on both days, at UTC quarter-hours', () => {
  // 21:55Z = 23:55 local (CEST); 22:00Z = 00:00 local the next day.
  const mix = deriveSessionMix(
    [
      { bucketStart: Date.UTC(2026, 5, 10, 21, 55), kwh: 1 },
      { bucketStart: Date.UTC(2026, 5, 10, 22, 0), kwh: 1 },
    ],
    new Map(),
  )
  expect(mix.map((s) => s.slotStart.toISOString())).toEqual([
    '2026-06-10T21:45:00.000Z',
    '2026-06-10T22:00:00.000Z',
  ])
})

test('zero-kWh buckets add no slot', () => {
  expect(deriveSessionMix([{ bucketStart: T0, kwh: 0 }], new Map())).toEqual([])
})

test("the parts always sum to the slot's kWh", () => {
  let seed = 3
  const rand = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const buckets = Array.from({ length: 48 }, (_, i) => ({
    bucketStart: T0 + i * BUCKET_MS,
    kwh: rand() * 2,
  }))
  const house = new Map<number, BucketHouse>()
  for (const b of buckets) {
    if (rand() < 0.15) continue
    const g = rand()
    const s = rand()
    const bat = rand()
    const sum = g + s + bat
    house.set(b.bucketStart, {
      supply: rand() < 0.1 ? null : { grid: g / sum, solar: s / sum, battery: bat / sum },
      batteryOut: out({
        gridKwh: rand(),
        gridSpotSekSum: rand(),
        solarKwh: rand(),
        solarSpotSekSum: rand(),
        unpricedKwh: rand() < 0.5 ? rand() : 0,
      }),
    })
  }
  for (const slot of deriveSessionMix(buckets, house)) {
    expect(parts(slot)).toBeCloseTo(slot.kwh, 9)
    expect(slot.batteryGridSpotSek === null).toBe(!(slot.batteryGridKwh > 0))
    expect(slot.batterySolarSpotSek === null).toBe(!(slot.batterySolarKwh > 0))
  }
})

test('a battery share with nothing recorded leaving the battery is battery-unpriced', () => {
  const house = new Map<number, BucketHouse>([
    [T0, { supply: { grid: 0, solar: 0, battery: 1 }, batteryOut: out() }],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.5 }], house)
  expect(slot).toMatchObject({
    kwh: 0.5,
    gridKwh: 0,
    solarKwh: 0,
    batteryGridKwh: 0,
    batteryGridSpotSek: null,
    batterySolarKwh: 0,
    batterySolarSpotSek: null,
    batteryUnpricedKwh: 0.5,
  })
})

test('grid, solar and unpriced battery energy in one bucket split by what left', () => {
  const house = new Map<number, BucketHouse>([
    [
      T0,
      {
        supply: { grid: 0, solar: 0, battery: 1 },
        batteryOut: out({
          gridKwh: 1,
          gridSpotSekSum: 1,
          solarKwh: 2,
          solarSpotSekSum: 1,
          unpricedKwh: 1,
        }),
      },
    ],
  ])
  const [slot] = deriveSessionMix([{ bucketStart: T0, kwh: 0.8 }], house)
  expect(slot.batteryGridKwh).toBeCloseTo(0.2, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(1, 12)
  expect(slot.batterySolarKwh).toBeCloseTo(0.4, 12)
  expect(slot.batterySolarSpotSek).toBeCloseTo(0.5, 12)
  expect(slot.batteryUnpricedKwh).toBeCloseTo(0.2, 12)
})

test('battery solar spots are kWh-weighted across a slot too', () => {
  const solar = (spot: number): BucketHouse => ({
    supply: { grid: 0, solar: 0, battery: 1 },
    batteryOut: out({ solarKwh: 1, solarSpotSekSum: spot }),
  })
  const house = new Map<number, BucketHouse>([
    [T0, solar(0.2)],
    [T0 + BUCKET_MS, solar(0.6)],
  ])
  const [slot] = deriveSessionMix(
    [
      { bucketStart: T0, kwh: 1 },
      { bucketStart: T0 + BUCKET_MS, kwh: 3 },
    ],
    house,
  )
  expect(slot.batterySolarSpotSek).toBeCloseTo((0.2 + 3 * 0.6) / 4, 12)
})

test('a slot mixes buckets with and without house data', () => {
  const house = new Map<number, BucketHouse>([
    [T0, { supply: { grid: 1, solar: 0, battery: 0 }, batteryOut: out() }],
  ])
  const [slot] = deriveSessionMix(
    [
      { bucketStart: T0, kwh: 1 },
      { bucketStart: T0 + BUCKET_MS, kwh: 2 },
    ],
    house,
  )
  expect(slot).toMatchObject({ kwh: 3, gridKwh: 1, noHouseDataKwh: 2 })
})

test('buckets out of order still give ascending slots; negative kWh adds none', () => {
  const mix = deriveSessionMix(
    [
      { bucketStart: T0 + 3 * BUCKET_MS, kwh: 1 },
      { bucketStart: T0 + 6 * BUCKET_MS, kwh: -1 },
      { bucketStart: T0, kwh: 1 },
    ],
    new Map(),
  )
  expect(mix.map((s) => s.slotStart.getTime())).toEqual([T0, T0 + 3 * BUCKET_MS])
})
