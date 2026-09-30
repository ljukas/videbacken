// Client-safe: month / year sums of session counterfactuals.
import { sum } from 'd3-array'
import { type TariffPeriod, tariffAt, unitPrice } from '~/lib/evCharging/cost'
import type { DailySpot } from '~/lib/spotPrice/slots'
import { timingScore } from './sessionEconomy'
import type { Counterfactual, EconomyTotals, SessionEconomy } from './types'

export function sumEconomy(
  items: readonly SessionEconomy[],
  avgSpotOre: number | null,
): EconomyTotals {
  const included = items.flatMap((e) =>
    e.counterfactual ? [{ actual: e.actual, cf: e.counterfactual as Counterfactual }] : [],
  )
  const actualSek = sum(included, (e) => e.actual.totalSek)
  const immediateSek = sum(included, (e) => e.cf.immediate.totalSek)
  const optimalSek = sum(included, (e) => e.cf.optimal.totalSek)
  const dearestSek = sum(included, (e) => e.cf.dearest.totalSek)
  const fullKwh = sum(included, (e) => e.actual.fullKwh)
  return {
    sessions: items.length,
    included: included.length,
    excluded: {
      noHourly: items.filter((e) => e.excluded === 'no_hourly').length,
      noPrice: items.filter((e) => e.excluded === 'no_price').length,
    },
    kwh: sum(included, (e) => e.actual.kwh),
    actualSek,
    immediateSek,
    optimalSek,
    dearestSek,
    savedVsImmediateSek: immediateSek - actualSek,
    leftOnTableSek: Math.max(0, actualSek - optimalSek),
    score: included.length > 0 ? timingScore(actualSek, optimalSek, dearestSek) : null,
    paidSpotOre: fullKwh > 0 ? (sum(included, (e) => e.actual.spotSek) / fullKwh) * 100 : null,
    avgSpotOre,
  }
}

/** Time-weighted average spot over whole days, öre/kWh incl each day's VAT; days without a tariff are skipped. */
export function averageSpotOre(
  days: readonly DailySpot[],
  tariffsAsc: readonly TariffPeriod[],
): number | null {
  let weighted = 0
  let coveredMs = 0
  for (const d of days) {
    const tariff = tariffAt(tariffsAsc, d.day)
    if (!tariff || d.coveredMs <= 0) continue
    weighted += unitPrice(d.avgSekPerKwh, tariff).spotSek * d.coveredMs
    coveredMs += d.coveredMs
  }
  return coveredMs > 0 ? (weighted / coveredMs) * 100 : null
}
