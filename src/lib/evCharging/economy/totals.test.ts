import { describe, expect, test } from 'vitest'
import { type CostTotals, emptyTotals, type TariffPeriod } from '~/lib/evCharging/cost'
import { averageSpotOre, sumEconomy } from './totals'
import type { SessionEconomy } from './types'

const TARIFF: TariffPeriod = {
  validFrom: '2026-01-01',
  retailMarkupOre: 0,
  gridTransferOre: 0,
  energyTaxOre: 0,
  vatPercent: 25,
}
const totals = (totalSek: number, extra: Partial<CostTotals> = {}): CostTotals => ({
  ...emptyTotals(),
  kwh: 10,
  gridKwh: 10,
  fullKwh: 10,
  spotSek: totalSek / 2,
  totalSek,
  ...extra,
})
const included = (
  actual: number,
  immediate: number,
  optimal: number,
  dearest: number,
  actualExtra: Partial<CostTotals> = {},
): SessionEconomy => ({
  actual: totals(actual, actualExtra),
  actualComplete: true,
  paidSpotOre: null,
  windowAvgSpotOre: null,
  excluded: null,
  counterfactual: {
    immediate: totals(immediate),
    optimal: totals(optimal),
    dearest: totals(dearest),
    score: null,
    savedVsImmediateSek: immediate - actual,
    leftOnTableSek: actual - optimal,
  },
})
const excluded = (reason: 'no_hourly' | 'no_price'): SessionEconomy => ({
  actual: totals(99),
  actualComplete: true,
  paidSpotOre: null,
  windowAvgSpotOre: null,
  excluded: reason,
  counterfactual: null,
})

describe('sumEconomy', () => {
  test('sums the included sessions and scores the sums', () => {
    const t = sumEconomy([included(15, 20, 10, 20), included(10, 10, 10, 20)], 120)
    expect(t).toMatchObject({
      sessions: 2,
      included: 2,
      excluded: { noHourly: 0, noPrice: 0 },
      kwh: 20,
      actualSek: 25,
      immediateSek: 30,
      optimalSek: 20,
      dearestSek: 40,
      savedVsImmediateSek: 5,
      leftOnTableSek: 5,
      avgSpotOre: 120,
    })
    expect(t.score).toBeCloseTo((40 - 25) / (40 - 20))
    expect(t.paidSpotOre).toBeCloseTo((12.5 / 20) * 100)
  })

  test('excluded sessions are counted by reason and left out of every kronor figure', () => {
    // fullKwh (5) differs from kwh (10): paid spot is over the priced energy.
    const t = sumEconomy(
      [
        included(15, 20, 10, 20, { fullKwh: 5, spotSek: 2 }),
        excluded('no_hourly'),
        excluded('no_price'),
      ],
      null,
    )
    expect(t).toMatchObject({
      sessions: 3,
      included: 1,
      excluded: { noHourly: 1, noPrice: 1 },
      kwh: 10,
      actualSek: 15,
      immediateSek: 20,
      optimalSek: 10,
      dearestSek: 20,
    })
    expect(t.paidSpotOre).toBeCloseTo((2 / 5) * 100)
  })

  test('left on the table is clamped at zero when actual beat optimal', () => {
    expect(sumEconomy([included(9, 12, 10, 20)], null).leftOnTableSek).toBe(0)
  })

  test('nothing included → zero sums, null score and null paid spot (the UI says "—")', () => {
    const t = sumEconomy([excluded('no_price')], null)
    expect(t).toMatchObject({ included: 0, actualSek: 0, score: null, paidSpotOre: null })
  })

  test('a negative month saving stays negative', () => {
    expect(sumEconomy([included(20, 15, 10, 20)], null).savedVsImmediateSek).toBe(-5)
  })
})

describe('averageSpotOre', () => {
  test('weights each day by the time it has prices, incl that day’s VAT', () => {
    const avg = averageSpotOre(
      [
        { day: '2026-09-01', avgSekPerKwh: 1, coveredMs: 24 * 3_600_000 },
        { day: '2026-09-02', avgSekPerKwh: 2, coveredMs: 12 * 3_600_000 },
      ],
      [TARIFF],
    )
    expect(avg).toBeCloseTo(((1 * 24 + 2 * 12) / 36) * 1.25 * 100)
  })

  test('applies each day’s own VAT', () => {
    const later: TariffPeriod = { ...TARIFF, validFrom: '2026-09-02', vatPercent: 0 }
    const avg = averageSpotOre(
      [
        { day: '2026-09-01', avgSekPerKwh: 1, coveredMs: 24 * 3_600_000 },
        { day: '2026-09-02', avgSekPerKwh: 2, coveredMs: 12 * 3_600_000 },
      ],
      [TARIFF, later],
    )
    expect(avg).toBeCloseTo(((1 * 1.25 * 24 + 2 * 1 * 12) / 36) * 100)
  })

  test('skips days without a tariff; none left → null', () => {
    const days = [{ day: '2025-12-31', avgSekPerKwh: 1, coveredMs: 3_600_000 }]
    expect(averageSpotOre(days, [TARIFF])).toBeNull()
    expect(averageSpotOre([], [TARIFF])).toBeNull()
  })
})
