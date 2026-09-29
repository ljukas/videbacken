import { describe, expect, test } from 'vitest'
import { daySlots } from '../../spotPrice/testing/daySlots'
import {
  avgOre,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  priceIntervals,
  SlotIndex,
  type TariffPeriod,
  tariffAt,
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
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
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

describe('mergeTotals', () => {
  test('sums every field', () => {
    const a = { ...emptyTotals(), kwh: 1, gridKwh: 1, fullKwh: 1, spotSek: 2, totalSek: 3 }
    const b = { ...emptyTotals(), kwh: 2, gridKwh: 2, noPriceKwh: 2, feesSek: 1, totalSek: 1 }
    expect(mergeTotals(a, b)).toEqual({
      kwh: 3,
      gridKwh: 3,
      fullKwh: 1,
      noPriceKwh: 2,
      noTariffKwh: 0,
      spotSek: 2,
      feesSek: 1,
      totalSek: 4,
    })
  })
})
