import { sum } from 'd3-array'
import { describe, expect, test } from 'vitest'
import { SlotIndex, type TariffPeriod } from '~/lib/evCharging/cost'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { analyzeSession, timingScore, windowAvgSpotOre } from './sessionEconomy'
import type { EconomySession } from './types'

const HOUR = 3_600_000
const utc = (iso: string) => new Date(iso).getTime()
const TARIFF: TariffPeriod = {
  validFrom: '2025-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
// Local 10:00–12:00 on 2026-09-28 (08:00Z–10:00Z): 10:xx costs 3 SEK, 11:xx 1 SEK.
const slots = new SlotIndex(daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 1)))
const session = (over: Partial<EconomySession> = {}): EconomySession => ({
  startMs: utc('2026-09-28T08:00Z'),
  endMs: utc('2026-09-28T10:00Z'),
  // Charged the dear hour at 10 kW, idle through the cheap one.
  stretches: [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10 },
    { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 0 },
  ],
  estimated: false,
  ...over,
})
const unit = (spot: number) => (spot + 0.76931) * 1.25

describe('analyzeSession', () => {
  test('charging the dear hour: immediate = actual = dearest, optimal is the cheap hour', () => {
    const { economy, optimalSchedule } = analyzeSession(session(), slots, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    expect(economy.actual.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.immediate.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.dearest.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.optimal.totalSek).toBeCloseTo(10 * unit(1))
    expect(cf?.savedVsImmediateSek).toBeCloseTo(0)
    expect(cf?.leftOnTableSek).toBeCloseTo(10 * (unit(3) - unit(1)))
    expect(cf?.score).toBeCloseTo(0)
    expect(optimalSchedule?.map((iv) => iv.startMs)).toEqual([
      utc('2026-09-28T09:00Z'),
      utc('2026-09-28T09:15Z'),
      utc('2026-09-28T09:30Z'),
      utc('2026-09-28T09:45Z'),
    ])
  })

  test('waiting for the cheap hour scores 100 % and saves against charging at once', () => {
    const waited = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 },
      ],
    })
    const cf = analyzeSession(waited, slots, [TARIFF]).economy.counterfactual
    expect(cf?.score).toBeCloseTo(1)
    expect(cf?.savedVsImmediateSek).toBeCloseTo(10 * (unit(3) - unit(1)))
    expect(cf?.leftOnTableSek).toBeCloseTo(0)
  })

  test('a negative saving survives: charging at once would have been cheaper', () => {
    // Prices reversed: 10:xx cheap, 11:xx dear; we charged the dear hour.
    const reversed = new SlotIndex(daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 1 : 3)))
    const late = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 },
      ],
    })
    const cf = analyzeSession(late, reversed, [TARIFF]).economy.counterfactual
    expect(cf?.savedVsImmediateSek).toBeCloseTo(-10 * (unit(3) - unit(1)))
  })

  test('paid spot and window average spot are öre/kWh incl VAT', () => {
    const { economy } = analyzeSession(session(), slots, [TARIFF])
    expect(economy.paidSpotOre).toBeCloseTo(3 * 1.25 * 100)
    expect(economy.windowAvgSpotOre).toBeCloseTo(2 * 1.25 * 100)
  })

  test('a session without hourly data is excluded as no_hourly, its actual cost still shown', () => {
    const flat = session({
      stretches: [{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 }],
      estimated: true,
    })
    const { economy, optimalSchedule } = analyzeSession(flat, slots, [TARIFF])
    expect(economy.excluded).toBe('no_hourly')
    expect(economy.counterfactual).toBeNull()
    expect(economy.actual.totalSek).toBeGreaterThan(0)
    expect(optimalSchedule).toBeNull()
  })

  test('a window with an unpriced stretch is excluded as no_price — even where we did not charge', () => {
    const holey = new SlotIndex(daySlots('2026-09-28', 15).filter((_, i) => i !== 46))
    expect(analyzeSession(session(), holey, [TARIFF]).economy.excluded).toBe('no_price')
  })

  test('an excluded no_price session with a partly priced actual is flagged incomplete, without a paid spot', () => {
    // Slot 42 (10:30 local) is in the charged hour: some energy is priced, some is not.
    const holey = new SlotIndex(daySlots('2026-09-28', 15).filter((_, i) => i !== 42))
    const { economy } = analyzeSession(session(), holey, [TARIFF])
    expect(economy.excluded).toBe('no_price')
    expect(economy.actual.fullKwh).toBeGreaterThan(0)
    expect(economy.actualComplete).toBe(false)
    expect(economy.paidSpotOre).toBeNull()
  })

  test('an included session has a complete actual', () => {
    expect(analyzeSession(session(), slots, [TARIFF]).economy.actualComplete).toBe(true)
  })

  test('a no_hourly session with fully priced estimated energy has a complete actual', () => {
    const flat = session({
      stretches: [{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 }],
      estimated: true,
    })
    const { economy } = analyzeSession(flat, slots, [TARIFF])
    expect(economy.excluded).toBe('no_hourly')
    expect(economy.actualComplete).toBe(true)
  })

  test('a window without a tariff is excluded as no_price', () => {
    const later = [{ ...TARIFF, validFrom: '2026-10-01' }]
    const { economy } = analyzeSession(session(), slots, later)
    expect(economy.excluded).toBe('no_price')
    expect(economy.windowAvgSpotOre).toBeNull()
  })

  test('a fully priced window with an unpriceable stretch is excluded as no_price', () => {
    const zeroLength = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 1 },
      ],
    })
    const { economy, optimalSchedule } = analyzeSession(zeroLength, slots, [TARIFF])
    expect(economy.actual.noPriceKwh).toBeGreaterThan(0)
    expect(economy.excluded).toBe('no_price')
    expect(optimalSchedule).toBeNull()
  })

  test('a zero-energy session is included with null score and finite figures', () => {
    const idle = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 0 },
      ],
    })
    const { economy } = analyzeSession(idle, slots, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    expect(economy.paidSpotOre).toBeNull()
    expect(cf?.score).toBeNull()
    for (const v of [
      economy.actual.totalSek,
      cf?.immediate.totalSek,
      cf?.optimal.totalSek,
      cf?.dearest.totalSek,
      cf?.savedVsImmediateSek,
      cf?.leftOnTableSek,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  // Window widening: a stretch past plug-out (or before plug-in) must stay inside the
  // window the counterfactuals choose from, else optimal could exceed actual.
  const quirkSlots = new SlotIndex(daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 0)))
  const HOURLY_10 = { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10 }
  test.each([
    [
      'after plug-out',
      { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:05Z'), kwh: 0.5 },
    ],
    [
      'before plug-in',
      { startMs: utc('2026-09-28T07:55Z'), endMs: utc('2026-09-28T08:00Z'), kwh: 0.5 },
    ],
  ])('a clock-quirk stretch %s keeps optimal ≤ actual and the score in 0…1', (_, quirk) => {
    const s = session({
      startMs: utc('2026-09-28T08:00Z'),
      endMs: utc('2026-09-28T09:00Z'),
      stretches: [HOURLY_10, quirk],
    })
    const { economy } = analyzeSession(s, quirkSlots, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    expect(cf?.optimal.totalSek).toBeLessThanOrEqual(economy.actual.totalSek + 1e-9)
    expect(cf?.score ?? 0).toBeGreaterThanOrEqual(0)
    expect(cf?.score ?? 0).toBeLessThanOrEqual(1)
  })

  test('a window across local midnight prices each slot day under its own tariff', () => {
    const twoDays = new SlotIndex([
      ...daySlots('2026-09-30', 15, () => 2),
      ...daySlots('2026-10-01', 15, () => 4),
    ])
    const newTariff: TariffPeriod = {
      validFrom: '2026-10-01',
      retailMarkupOre: 0,
      gridTransferOre: 20,
      energyTaxOre: 30,
      vatPercent: 10,
    }
    const s = session({
      startMs: utc('2026-09-30T21:00Z'),
      endMs: utc('2026-09-30T23:00Z'),
      stretches: [
        { startMs: utc('2026-09-30T21:00Z'), endMs: utc('2026-09-30T22:00Z'), kwh: 5 },
        { startMs: utc('2026-09-30T22:00Z'), endMs: utc('2026-09-30T23:00Z'), kwh: 5 },
      ],
    })
    const { economy } = analyzeSession(s, twoDays, [TARIFF, newTariff])
    expect(economy.excluded).toBeNull()
    expect(economy.actual.totalSek).toBeCloseTo(5 * unit(2) + 5 * (4 + 0.5) * 1.1)
    expect(economy.windowAvgSpotOre).toBeCloseTo(((2 * 1.25 + 4 * 1.1) / 2) * 100)
  })
})

describe('windowAvgSpotOre', () => {
  test('weights each slot by its overlap with an unaligned window', () => {
    const priced = new SlotIndex(daySlots('2026-09-28', 15, (i) => i - 40 + 1))
    // 10:07–11:38 local: overlaps 8, 15, 15, 15, 15, 15, 8 min in slots priced 1…7.
    const mins = [8, 15, 15, 15, 15, 15, 8]
    const expected = (mins.reduce((a, m, k) => a + m * (k + 1), 0) / 91) * 1.25 * 100
    const window = { startMs: utc('2026-09-28T08:07Z'), endMs: utc('2026-09-28T09:38Z') }
    expect(windowAvgSpotOre(window, priced, [TARIFF])).toBeCloseTo(expected)
  })
  test('is null without slots', () => {
    const window = { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z') }
    expect(windowAvgSpotOre(window, new SlotIndex([]), [TARIFF])).toBeNull()
  })
})

describe('timingScore', () => {
  test('is where actual sits between dearest (0) and optimal (1)', () => {
    expect(timingScore(15, 10, 20)).toBeCloseTo(0.5)
  })
  test('is null when there was nothing to choose between', () => {
    expect(timingScore(10, 10, 10.005)).toBeNull()
  })
  test('is null below the absolute gap floor (0,4 kr)', () => {
    expect(timingScore(10.2, 10, 10.4)).toBeNull()
  })
  test('is null below the relative floor: 0,9 kr gap on a 20 kr session (5 % = 1,0 kr)', () => {
    expect(timingScore(20, 19.5, 20.4)).toBeNull()
  })
  test('scores a 1,2 kr gap on a 20 kr session', () => {
    expect(timingScore(20, 19, 20.2)).toBeCloseTo(0.2 / 1.2)
  })
  test('uses |actual| for the relative floor when actual is negative', () => {
    // 5 % of |-30| = 1,5 kr: a 1,2 kr gap is below it, a 1,6 kr gap is not.
    expect(timingScore(-30, -31, -29.8)).toBeNull()
    // (dearest − actual) ÷ gap = 0,6 ÷ 1,6
    expect(timingScore(-30, -31, -29.4)).toBeCloseTo(0.375)
  })
  test('at actual 0 the absolute floor governs', () => {
    expect(timingScore(0, -0.2, 0.2)).toBeNull()
    expect(timingScore(0, -0.2, 0.4)).toBeCloseTo(0.4 / 0.6)
  })
  test('the exact boundary scores (the rule is "<")', () => {
    // 0,5 kr is exact in binary, so gap === threshold holds without rounding.
    expect(timingScore(5, 5, 5.5)).toBe(1)
  })
  test('is clamped to 0…1 against float noise', () => {
    expect(timingScore(9.9999999, 10, 20)).toBe(1)
    expect(timingScore(20.0000001, 10, 20)).toBe(0)
  })
})

// Seeded PRNG (mulberry32) — test-only, so the invariant test is reproducible.
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('invariant: optimal ≤ actual ≤ dearest, optimal ≤ immediate ≤ dearest', () => {
  test.each(Array.from({ length: 200 }, (_, i) => i + 1))('seed %i', (seed) => {
    const r = rng(seed)
    const dayStart = utc('2026-09-27T22:00Z') // local midnight, 2026-09-28
    const prices = new SlotIndex(daySlots('2026-09-28', 15, () => r() * 4.5 - 0.5))
    const startMs =
      dayStart + Math.floor(r() * 12 * 4) * 15 * 60_000 + Math.floor(r() * 14) * 60_000
    const endMs = startMs + (1 + Math.floor(r() * 10)) * HOUR + Math.floor(r() * 50) * 60_000
    const stretches: EconomySession['stretches'] = []
    // Hour-aligned stretches like Zaptec's, plus sometimes a clock-quirk one outside the window.
    for (let a = startMs; a < endMs; ) {
      const b = Math.min(endMs, Math.floor(a / HOUR) * HOUR + HOUR)
      stretches.push({ startMs: a, endMs: b, kwh: r() * 11 * ((b - a) / HOUR) })
      a = b
    }
    if (r() < 0.2) stretches.push({ startMs: endMs, endMs: endMs + 5 * 60_000, kwh: r() * 0.5 })
    const s: EconomySession = { startMs, endMs, stretches, estimated: false }

    const { economy, optimalSchedule } = analyzeSession(s, prices, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    const eps = 1e-9
    expect(cf?.optimal.totalSek).toBeLessThanOrEqual(economy.actual.totalSek + eps)
    expect(economy.actual.totalSek).toBeLessThanOrEqual((cf?.dearest.totalSek ?? 0) + eps)
    expect(cf?.optimal.totalSek).toBeLessThanOrEqual((cf?.immediate.totalSek ?? 0) + eps)
    expect(cf?.immediate.totalSek).toBeLessThanOrEqual((cf?.dearest.totalSek ?? 0) + eps)
    if (cf?.score != null) {
      expect(cf.score).toBeGreaterThanOrEqual(0)
      expect(cf.score).toBeLessThanOrEqual(1)
    }
    expect(sum(optimalSchedule ?? [], (iv) => iv.kwh)).toBeCloseTo(
      sum(stretches, (x) => x.kwh),
      6,
    )
  })
})
