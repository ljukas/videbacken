import { describe, expect, test } from 'vitest'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import {
  avgOre,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  ownSupplyShare,
  type PieceMix,
  priceIntervals,
  SlotIndex,
  supplySplit,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from './index'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const utc = (iso: string) => new Date(iso).getTime()

// Aug 2026 values from the owner's bills (ex VAT, öre/kWh): fees = 76,931 öre.
const TARIFF: TariffPeriod = {
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
const FEES_ORE = 5.331 + 35.6 + 36
const TARIFF_2025: TariffPeriod = { ...TARIFF, validFrom: '2025-01-01' }

function iv(startIso: string, endIso: string, kwh: number, gridShare = 1): EnergyInterval {
  return { startMs: utc(startIso), endMs: utc(endIso), kwh, gridShare }
}

describe('priceIntervals', () => {
  // 2026-09-28 is CEST: local 10:00 = 08:00Z. Slot i starts at local i×15 min.
  const day = new SlotIndex(daySlots('2026-09-28', 15, (i) => i / 10))

  test('an hour aligned to four 15-min slots takes each slot’s price for a quarter of the kWh', () => {
    // local 10:00–11:00 → slots 40..43, prices 4.0, 4.1, 4.2, 4.3 SEK/kWh.
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 4)], day, [TARIFF])

    expect(t.kwh).toBe(4)
    expect(t.fullKwh).toBeCloseTo(4)
    expect(t.spotSek).toBeCloseTo((4.0 + 4.1 + 4.2 + 4.3) * 1.25)
    expect(t.feesSek).toBeCloseTo(((4 * FEES_ORE) / 100) * 1.25)
    expect(t.totalSek).toBeCloseTo(t.spotSek + t.feesSek)
    expect(isComplete(t)).toBe(true)
    expect(avgOre(t)).toBeCloseTo((t.totalSek / 4) * 100)
  })

  test('an unaligned interval weights each slot by its overlap', () => {
    // local 10:10–11:10: 5 min of slot 40, 15 of 41..43, 10 of 44 → 60 min, 6 kWh.
    const t = priceIntervals([iv('2026-09-28T08:10Z', '2026-09-28T09:10Z', 6)], day, [TARIFF])
    const spotExVat = 6 * ((5 * 4.0 + 15 * 4.1 + 15 * 4.2 + 15 * 4.3 + 10 * 4.4) / 60)
    expect(t.spotSek).toBeCloseTo(spotExVat * 1.25)
    expect(t.fullKwh).toBeCloseTo(6)
  })

  test('the uncovered part of an interval is missing, never 0 kr', () => {
    const partial = new SlotIndex(daySlots('2026-09-28', 15).slice(0, 42)) // ends local 10:30
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 4)], partial, [TARIFF])
    expect(t.fullKwh).toBeCloseTo(2)
    expect(t.noPriceKwh).toBeCloseTo(2)
    expect(isComplete(t)).toBe(false)
    expect(t.spotSek).toBeCloseTo(2 * 1 * 1.25)
  })

  test('with no slots at all nothing is priced and the average is null', () => {
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 4)], new SlotIndex([]), [
      TARIFF,
    ])
    expect(t).toMatchObject({ kwh: 4, gridKwh: 4, fullKwh: 0, noPriceKwh: 4, totalSek: 0 })
    expect(avgOre(t)).toBeNull()
  })

  test('no tariff in force leaves priced-slot energy as no-tariff', () => {
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 4)], day, [
      { ...TARIFF, validFrom: '2026-10-01' },
    ])
    expect(t).toMatchObject({ fullKwh: 0, noTariffKwh: 4, noPriceKwh: 0, totalSek: 0 })
  })

  test('a negative spot price lowers the cost', () => {
    const negative = new SlotIndex(daySlots('2026-09-28', 15, () => -0.2))
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 10)], negative, [TARIFF])
    expect(t.spotSek).toBeCloseTo(10 * -0.2 * 1.25)
    expect(t.totalSek).toBeCloseTo(t.spotSek + ((10 * FEES_ORE) / 100) * 1.25)
  })

  test('only the grid share is priced', () => {
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 4, 0.25)], day, [TARIFF])
    expect(t.kwh).toBe(4)
    expect(t.gridKwh).toBe(1)
    expect(t.fullKwh).toBeCloseTo(1)
    expect(isComplete(t)).toBe(true)
  })

  test('a zero-length interval is unpriceable', () => {
    const t = priceIntervals([iv('2026-09-28T08:00Z', '2026-09-28T08:00Z', 1)], day, [TARIFF])
    expect(t).toMatchObject({ kwh: 1, noPriceKwh: 1, fullKwh: 0 })
  })

  test('the tariff switches at Stockholm midnight of valid_from, within one interval', () => {
    const newer: TariffPeriod = { ...TARIFF, validFrom: '2026-09-29', gridTransferOre: 135.6 }
    const slots = new SlotIndex([
      ...daySlots('2026-09-28', 15, () => 0),
      ...daySlots('2026-09-29', 15, () => 0),
    ])
    // local 23:30 → 00:30 (21:30Z → 22:30Z), 2 kWh: 1 kWh on each day.
    const t = priceIntervals([iv('2026-09-28T21:30Z', '2026-09-28T22:30Z', 2)], slots, [
      TARIFF,
      newer,
    ])
    expect(t.feesSek).toBeCloseTo(((FEES_ORE + (FEES_ORE + 100)) / 100) * 1.25)
  })

  test('prices across the hourly → 15-min switch on 2025-10-01', () => {
    const slots = new SlotIndex([
      ...daySlots('2025-09-30', 60, () => 2),
      ...daySlots('2025-10-01', 15, (i) => (i < 2 ? 4 : 99)),
    ])
    // local 23:30 → 00:30 (21:30Z → 22:30Z), 2 kWh: 1 at 2 SEK, 1 at 4 SEK.
    const t = priceIntervals([iv('2025-09-30T21:30Z', '2025-09-30T22:30Z', 2)], slots, [
      TARIFF_2025,
    ])
    expect(t.spotSek).toBeCloseTo((1 * 2 + 1 * 4) * 1.25)
    expect(isComplete(t)).toBe(true)
  })

  test('prices the repeated hour of a fall-back day (100 slots)', () => {
    const slots = new SlotIndex(daySlots('2025-10-26', 15, (i) => (i >= 8 && i < 16 ? 3 : 1)))
    // Slots 8..15 are local 02:00–03:00 CEST then 02:00–03:00 CET = 00:00Z–02:00Z.
    const t = priceIntervals([iv('2025-10-26T00:00Z', '2025-10-26T02:00Z', 8)], slots, [
      TARIFF_2025,
    ])
    expect(t.fullKwh).toBeCloseTo(8)
    expect(t.spotSek).toBeCloseTo(8 * 3 * 1.25)
  })

  test('conserves kWh: priced + missing always equals grid kWh', () => {
    // Deterministic pseudo-random intervals over two days with a hole in prices.
    // mulberry32: exact 32-bit integer steps, so the sequence is stable.
    let seed = 42
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32
    }
    const slots = new SlotIndex([
      ...daySlots('2026-09-28', 15, (i) => i / 20).filter((_, i) => i < 50 || i > 60),
      ...daySlots('2026-09-29', 15, () => 0.8),
    ])
    const base = utc('2026-09-27T22:00Z')
    const ivs: EnergyInterval[] = Array.from({ length: 200 }, () => {
      const start = base + Math.floor(rand() * 46 * HOUR)
      return {
        startMs: start,
        endMs: start + Math.floor(rand() * 3 * HOUR),
        kwh: rand() * 11,
        gridShare: rand(),
      }
    })
    const t = priceIntervals(ivs, slots, [{ ...TARIFF, validFrom: '2026-09-29' }])
    expect(t.fullKwh + t.noPriceKwh + t.noTariffKwh).toBeCloseTo(t.gridKwh, 9)
  })
})

describe('priceIntervals input and completeness guards', () => {
  const idx = new SlotIndex(daySlots('2026-09-28', 15))

  test.each([
    ['negative kWh', { kwh: -1 }],
    ['NaN kWh', { kwh: Number.NaN }],
    ['gridShare above 1', { gridShare: 2 }],
    ['negative gridShare', { gridShare: -0.1 }],
    ['NaN gridShare', { gridShare: Number.NaN }],
    ['NaN start', { startMs: Number.NaN }],
  ])('rejects %s', (_, override) => {
    const bad = { ...iv('2026-09-28T08:00Z', '2026-09-28T09:00Z', 1), ...override }
    expect(() => priceIntervals([bad], idx, [TARIFF])).toThrow(RangeError)
  })

  test('overlapping slots that double-count energy are not complete', () => {
    const dup = daySlots('2026-09-28', 60)
    const doubled = new SlotIndex([...dup, dup[8]])
    const t = priceIntervals([iv('2026-09-28T06:00Z', '2026-09-28T07:00Z', 10)], doubled, [TARIFF])
    expect(t.fullKwh).toBeGreaterThan(t.gridKwh)
    expect(isComplete(t)).toBe(false)
  })
})

describe('SlotIndex', () => {
  test('finds overlapping slots from unsorted input and excludes touching ones', () => {
    const idx = new SlotIndex([
      { startMs: 30, endMs: 45, sekPerKwh: 3 },
      { startMs: 0, endMs: 15, sekPerKwh: 1 },
      { startMs: 15, endMs: 30, sekPerKwh: 2 },
    ])
    expect(idx.between(15, 30).map((s) => s.sekPerKwh)).toEqual([2])
    expect(idx.between(10, 31).map((s) => s.sekPerKwh)).toEqual([1, 2, 3])
    expect(idx.between(45, 60)).toEqual([])
  })
})

describe('tariffAt', () => {
  const periods = [
    { ...TARIFF, validFrom: '2026-01-01' },
    { ...TARIFF, validFrom: '2026-08-01', retailMarkupOre: 1 },
  ]

  test('picks the latest period on or before the day', () => {
    expect(tariffAt(periods, '2025-12-31')).toBeNull()
    expect(tariffAt(periods, '2026-01-01')?.validFrom).toBe('2026-01-01')
    expect(tariffAt(periods, '2026-07-31')?.validFrom).toBe('2026-01-01')
    expect(tariffAt(periods, '2026-08-01')?.validFrom).toBe('2026-08-01')
  })
})

describe('unitPrice', () => {
  test('is the slot’s spot and the tariff’s fees per kWh, both incl VAT', () => {
    const u = unitPrice(0.8, TARIFF)
    expect(u.spotSek).toBeCloseTo(0.8 * 1.25)
    expect(u.feesSek).toBeCloseTo((FEES_ORE / 100) * 1.25)
  })

  test('keeps a negative spot price negative', () => {
    expect(unitPrice(-0.2, TARIFF).spotSek).toBeCloseTo(-0.25)
  })
})

const FEES_SEK = (FEES_ORE / 100) * 1.25 // per kWh incl VAT
const QUARTER = 15 * MIN
const NO_MIX: PieceMix = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

/** A 15-min piece with a mix; its kWh is the sum of the parts (synthetic, never real readings). */
function piece(startIso: string, parts: Partial<PieceMix>): EnergyInterval {
  const mix = { ...NO_MIX, ...parts }
  const kwh =
    mix.gridKwh +
    mix.solarKwh +
    mix.batteryGridKwh +
    mix.batterySolarKwh +
    mix.batteryUnpricedKwh +
    mix.noHouseDataKwh
  const startMs = utc(startIso)
  return { startMs, endMs: startMs + QUARTER, kwh, gridShare: 1, mix }
}

// mulberry32: exact 32-bit integer steps, so the sequence is stable.
function mulberry32(start: number) {
  let seed = start
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32
  }
}

describe('priceIntervals with an energy mix (ADR-0023)', () => {
  // 2026-09-28 CEST: 08:00Z = local 10:00 = slot 40, 4.0 SEK/kWh ex VAT.
  const day = new SlotIndex(daySlots('2026-09-28', 15, (i) => i / 10))
  const AT = '2026-09-28T08:00Z'

  test('grid and no-house-data energy are priced at the slot exactly like all-grid energy', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, noHouseDataKwh: 0.5 })], day, [TARIFF])
    const plain = priceIntervals([iv(AT, '2026-09-28T08:15Z', 1.5)], day, [TARIFF])
    expect(t).toMatchObject({
      kwh: 1.5,
      gridKwh: 1.5,
      noHouseDataKwh: 0.5,
      solarKwh: 0,
      batteryKwh: 0,
    })
    expect(t.spotSek).toBeCloseTo(1.5 * 4.0 * 1.25)
    expect(t.feesSek).toBeCloseTo(1.5 * FEES_SEK)
    expect(t.totalSek).toBeCloseTo(plain.totalSek, 9)
    expect(isComplete(t)).toBe(true)
  })

  test('own solar costs 0 kr and is valued at the slot spot, ex VAT and fees', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, solarKwh: 3 })], day, [TARIFF])
    expect(t).toMatchObject({
      kwh: 4,
      gridKwh: 1,
      solarKwh: 3,
      solarPricedKwh: 3,
      solarUnpricedKwh: 0,
    })
    expect(t.fullKwh).toBeCloseTo(1)
    expect(t.totalSek).toBeCloseTo(4.0 * 1.25 + FEES_SEK)
    expect(t.solarValueSek).toBeCloseTo(3 * 4.0)
    expect(isComplete(t)).toBe(true)
    // The average is the cash cost per charged kWh, own solar included at 0 kr.
    expect(avgOre(t)).toBeCloseTo((t.totalSek / 4) * 100)
  })

  test('battery energy from the grid is priced at its stored spot plus the fees of the day it is used', () => {
    const newer: TariffPeriod = { ...TARIFF, validFrom: '2026-09-28', gridTransferOre: 135.6 }
    const t = priceIntervals([piece(AT, { batteryGridKwh: 2, batteryGridSpotSek: 0.3 })], day, [
      TARIFF,
      newer,
    ])
    expect(t).toMatchObject({ kwh: 2, gridKwh: 2, batteryKwh: 2, solarKwh: 0 })
    expect(t.spotSek).toBeCloseTo(2 * 0.3 * 1.25) // the stored spot, not the slot's 4.0
    expect(t.feesSek).toBeCloseTo(2 * ((FEES_ORE + 100) / 100) * 1.25) // the use day's fees
    expect(isComplete(t)).toBe(true)
  })

  test('battery energy from solar costs 0 kr and is valued at its stored spot', () => {
    const t = priceIntervals([piece(AT, { batterySolarKwh: 1, batterySolarSpotSek: 0.7 })], day, [
      TARIFF,
    ])
    expect(t).toMatchObject({
      kwh: 1,
      gridKwh: 0,
      batteryKwh: 1,
      solarKwh: 0,
      totalSek: 0,
      solarPricedKwh: 1,
      solarUnpricedKwh: 0,
    })
    expect(t.solarValueSek).toBeCloseTo(0.7)
    expect(isComplete(t)).toBe(true)
    expect(avgOre(t)).toBeNull()
  })

  test('battery energy of unknown price is no-price energy, so the total is a minimum', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, batteryUnpricedKwh: 0.5 })], day, [TARIFF])
    expect(t).toMatchObject({ gridKwh: 1.5, batteryKwh: 0.5, noPriceKwh: 0.5 })
    expect(isComplete(t)).toBe(false)
  })

  test('a missing slot price leaves grid unpriced and solar unvalued; stored battery spots still apply', () => {
    const t = priceIntervals(
      [
        piece(AT, {
          gridKwh: 1,
          solarKwh: 1,
          batteryGridKwh: 1,
          batteryGridSpotSek: 0.5,
          batterySolarKwh: 1,
          batterySolarSpotSek: 0.2,
        }),
      ],
      new SlotIndex([]),
      [TARIFF],
    )
    expect(t.noPriceKwh).toBeCloseTo(1)
    expect(t.fullKwh).toBeCloseTo(1)
    expect(t.spotSek).toBeCloseTo(0.5 * 1.25)
    expect(t.solarUnpricedKwh).toBeCloseTo(1)
    expect(t.solarPricedKwh).toBeCloseTo(1)
    expect(t.solarValueSek).toBeCloseTo(0.2)
    expect(isComplete(t)).toBe(false)
  })

  test('a battery part with kWh but no stored spot is never priced or valued at 0', () => {
    const t = priceIntervals([piece(AT, { batteryGridKwh: 1, batterySolarKwh: 1 })], day, [TARIFF])
    expect(t).toMatchObject({ noPriceKwh: 1, solarUnpricedKwh: 1, solarPricedKwh: 0, totalSek: 0 })
    expect(isComplete(t)).toBe(false)
  })

  test('no tariff on the day of use leaves battery-from-grid as no-tariff', () => {
    const t = priceIntervals([piece(AT, { batteryGridKwh: 1, batteryGridSpotSek: 0.3 })], day, [
      { ...TARIFF, validFrom: '2026-10-01' },
    ])
    expect(t).toMatchObject({ noTariffKwh: 1, fullKwh: 0, totalSek: 0 })
  })

  test('a negative slot spot makes own solar worth less than nothing (export would have cost)', () => {
    const negative = new SlotIndex(daySlots('2026-09-28', 15, () => -0.2))
    const t = priceIntervals([piece(AT, { solarKwh: 2 })], negative, [TARIFF])
    expect(t.solarValueSek).toBeCloseTo(-0.4)
    expect(t.totalSek).toBe(0)
  })

  test('conserves kWh: priced + missing = bought, and bought + own solar = all', () => {
    const rand = mulberry32(7)
    const slots = new SlotIndex([
      ...daySlots('2026-09-28', 15, (i) => i / 20).filter((_, i) => i < 50 || i > 60),
      ...daySlots('2026-09-29', 15, () => 0.8),
    ])
    const base = utc('2026-09-27T22:00Z')
    let batterySolar = 0
    let solarOrigin = 0
    const pieces = Array.from({ length: 150 }, () => {
      const parts = {
        gridKwh: rand(),
        solarKwh: rand(),
        batteryGridKwh: rand(),
        batteryGridSpotSek: rand(),
        batterySolarKwh: rand(),
        batterySolarSpotSek: rand() < 0.1 ? null : rand(),
        batteryUnpricedKwh: rand() / 10,
        noHouseDataKwh: rand() / 5,
      }
      batterySolar += parts.batterySolarKwh
      solarOrigin += parts.solarKwh + parts.batterySolarKwh
      const p = piece(new Date(base).toISOString(), parts)
      const offset = Math.floor(rand() * 46 * 4) * QUARTER
      return { ...p, startMs: p.startMs + offset, endMs: p.endMs + offset }
    })
    const t = priceIntervals(pieces, slots, [{ ...TARIFF, validFrom: '2026-09-29' }])
    expect(t.fullKwh + t.noPriceKwh + t.noTariffKwh).toBeCloseTo(t.gridKwh, 9)
    expect(t.gridKwh + t.solarKwh + batterySolar).toBeCloseTo(t.kwh, 9)
    expect(t.solarPricedKwh + t.solarUnpricedKwh).toBeCloseTo(solarOrigin, 9)
  })

  test.each([
    ['a mix with gridShare below 1', { ...piece(AT, { gridKwh: 1 }), gridShare: 0.5 }],
    ['a negative mix part', piece(AT, { gridKwh: 2, solarKwh: -1 })],
    ['parts that do not sum to the kWh', { ...piece(AT, { gridKwh: 1 }), kwh: 1.1 }],
    ['a NaN stored spot', piece(AT, { batteryGridKwh: 1, batteryGridSpotSek: Number.NaN })],
    ['an infinite part', piece(AT, { solarKwh: Number.POSITIVE_INFINITY })],
  ])('rejects %s', (_, bad) => {
    expect(() => priceIntervals([bad], day, [TARIFF])).toThrow(RangeError)
  })
})

describe('priceIntervals with an energy mix: overlap, coverage and days', () => {
  // 2026-09-28 CEST: 08:00Z = slot 40 (4.0 SEK/kWh ex VAT), 08:15Z = slot 41 (4.1).
  const slots = daySlots('2026-09-28', 15, (i) => i / 10)
  const day = new SlotIndex(slots)
  const AT = '2026-09-28T08:00Z'
  const NEWER_FEES_SEK = ((FEES_ORE + 100) / 100) * 1.25
  const tomorrowsTariff: TariffPeriod = {
    ...TARIFF,
    validFrom: '2026-09-29',
    gridTransferOre: 135.6,
  }

  /** A mixed piece over [start, end), its kWh the sum of the parts. */
  function span(startIso: string, endIso: string, parts: Partial<PieceMix>): EnergyInterval {
    const p = piece(startIso, parts)
    return { ...p, endMs: utc(endIso) }
  }

  test('a piece over two slots values its solar by each slot’s overlap', () => {
    const t = priceIntervals([span(AT, '2026-09-28T08:30Z', { solarKwh: 4 })], day, [TARIFF])
    expect(t.solarValueSek).toBeCloseTo(2 * 4.0 + 2 * 4.1)
    expect(t.solarPricedKwh).toBeCloseTo(4)
    expect(t.solarUnpricedKwh).toBe(0)
  })

  test('half a piece without a slot: half its grid unpriced, half its solar unvalued, the battery still priced', () => {
    const firstQuarter = new SlotIndex(slots.filter((s) => s.startMs === utc(AT)))
    const t = priceIntervals(
      [
        span(AT, '2026-09-28T08:30Z', {
          gridKwh: 2,
          solarKwh: 2,
          batteryGridKwh: 1,
          batteryGridSpotSek: 0.3,
        }),
      ],
      firstQuarter,
      [TARIFF],
    )
    expect(t.noPriceKwh).toBeCloseTo(1)
    expect(t.fullKwh).toBeCloseTo(2) // 1 grid + 1 battery
    expect(t.spotSek).toBeCloseTo((1 * 4.0 + 1 * 0.3) * 1.25)
    expect(t.solarPricedKwh).toBeCloseTo(1)
    expect(t.solarUnpricedKwh).toBeCloseTo(1)
    expect(t.solarValueSek).toBeCloseTo(4.0)
  })

  test('battery-from-grid fees follow the Stockholm day the piece starts, without any slot', () => {
    const battery = { batteryGridKwh: 1, batteryGridSpotSek: 0.3 }
    const tariffs = [TARIFF, tomorrowsTariff]
    // Local 23:45–00:00 on the 28th: the 28th's fees, though it ends on the 29th.
    const late = priceIntervals(
      [span('2026-09-28T21:45Z', '2026-09-28T22:00Z', battery)],
      new SlotIndex([]),
      tariffs,
    )
    expect(late.feesSek).toBeCloseTo(FEES_SEK)
    // Local 00:15 on the 29th (still the 28th in UTC): the 29th's fees.
    const early = priceIntervals([piece('2026-09-28T22:15Z', battery)], new SlotIndex([]), tariffs)
    expect(early.feesSek).toBeCloseTo(NEWER_FEES_SEK)
    expect(early).toMatchObject({ fullKwh: 1, noPriceKwh: 0 })
  })

  test('the average divides cash by priced plus own solar energy, not by all of it', () => {
    const unpriced = priceIntervals(
      [piece(AT, { gridKwh: 1, solarKwh: 2, batteryUnpricedKwh: 1 })],
      day,
      [TARIFF],
    )
    expect(unpriced).toMatchObject({ kwh: 4, gridKwh: 2, noPriceKwh: 1 })
    expect(avgOre(unpriced)).toBeCloseTo((unpriced.totalSek / 3) * 100)
    const batterySolar = priceIntervals(
      [piece(AT, { gridKwh: 1, batterySolarKwh: 1, batterySolarSpotSek: 0.5 })],
      day,
      [TARIFF],
    )
    expect(avgOre(batterySolar)).toBeCloseTo((batterySolar.totalSek / 2) * 100)
  })

  test('a zero-length mixed piece leaves grid unpriced and solar unvalued; its battery is still priced', () => {
    const at = utc(AT)
    const t = priceIntervals(
      [
        {
          startMs: at,
          endMs: at,
          kwh: 3,
          gridShare: 1,
          mix: { ...NO_MIX, gridKwh: 1, solarKwh: 1, batteryGridKwh: 1, batteryGridSpotSek: 0.3 },
        },
      ],
      day,
      [TARIFF],
    )
    expect(t).toMatchObject({
      noPriceKwh: 1,
      solarUnpricedKwh: 1,
      solarPricedKwh: 0,
      solarValueSek: 0,
    })
    expect(t.fullKwh).toBeCloseTo(1)
  })

  test('without a tariff every bought part is no-tariff energy', () => {
    const t = priceIntervals(
      [piece(AT, { gridKwh: 1, noHouseDataKwh: 1, batteryGridKwh: 1, batteryGridSpotSek: 0.3 })],
      day,
      [],
    )
    expect(t).toMatchObject({ gridKwh: 3, noTariffKwh: 3, fullKwh: 0, noPriceKwh: 0, totalSek: 0 })
  })

  test('negative stored battery spots are real prices', () => {
    const t = priceIntervals(
      [
        piece(AT, {
          batteryGridKwh: 1,
          batteryGridSpotSek: -0.1,
          batterySolarKwh: 1,
          batterySolarSpotSek: -0.1,
        }),
      ],
      day,
      [TARIFF],
    )
    expect(t.spotSek).toBeCloseTo(-0.1 * 1.25)
    expect(t.solarValueSek).toBeCloseTo(-0.1)
  })

  test('parts within float rounding of the kWh are accepted; a real mismatch is not', () => {
    const p = piece(AT, { gridKwh: 1, solarKwh: 1 })
    expect(() => priceIntervals([{ ...p, kwh: p.kwh + 1e-9 }], day, [TARIFF])).not.toThrow()
    expect(() => priceIntervals([{ ...p, kwh: p.kwh + 1e-3 }], day, [TARIFF])).toThrow(RangeError)
  })

  test('the own-supply share never exceeds 1', () => {
    expect(ownSupplyShare({ kwh: 1, solarKwh: 0.7, batteryKwh: 0.3000000001 })).toBe(1)
    expect(ownSupplyShare({ kwh: 4, solarKwh: 0, batteryKwh: 1 })).toBeCloseTo(0.25)
  })
})

describe('emptyTotals and mergeTotals', () => {
  test('empty totals are all zero', () => {
    expect(emptyTotals()).toEqual({
      kwh: 0,
      gridKwh: 0,
      fullKwh: 0,
      noPriceKwh: 0,
      noTariffKwh: 0,
      spotSek: 0,
      feesSek: 0,
      totalSek: 0,
      solarKwh: 0,
      batteryKwh: 0,
      noHouseDataKwh: 0,
      solarValueSek: 0,
      solarPricedKwh: 0,
      solarUnpricedKwh: 0,
    })
  })

  test('sums every field', () => {
    const a = {
      ...emptyTotals(),
      kwh: 1,
      gridKwh: 1,
      fullKwh: 1,
      spotSek: 2,
      totalSek: 3,
      solarKwh: 1,
      solarValueSek: 0.5,
      solarPricedKwh: 1,
    }
    const b = {
      ...emptyTotals(),
      kwh: 2,
      gridKwh: 2,
      noPriceKwh: 2,
      feesSek: 1,
      totalSek: 1,
      batteryKwh: 2,
      noHouseDataKwh: 1,
      solarValueSek: 0.25,
      solarUnpricedKwh: 2,
    }
    expect(mergeTotals(a, b)).toEqual({
      kwh: 3,
      gridKwh: 3,
      fullKwh: 1,
      noPriceKwh: 2,
      noTariffKwh: 0,
      spotSek: 2,
      feesSek: 1,
      totalSek: 4,
      solarKwh: 1,
      batteryKwh: 2,
      noHouseDataKwh: 1,
      solarValueSek: 0.75,
      solarPricedKwh: 1,
      solarUnpricedKwh: 2,
    })
  })
})

describe('own supply', () => {
  test('the share from own solar and the battery, null without energy', () => {
    expect(ownSupplyShare({ kwh: 10, solarKwh: 3, batteryKwh: 1.4 })).toBeCloseTo(0.44)
    expect(ownSupplyShare({ kwh: 0, solarKwh: 0, batteryKwh: 0 })).toBeNull()
  })

  test('the bar split: grid is the rest (incl. energy without house data), never negative', () => {
    expect(supplySplit({ kwh: 10, solarKwh: 3, batteryKwh: 1 })).toEqual({
      gridKwh: 6,
      solarKwh: 3,
      batteryKwh: 1,
    })
    expect(supplySplit({ kwh: 1, solarKwh: 0.7, batteryKwh: 0.3000000001 }).gridKwh).toBe(0)
  })
})
