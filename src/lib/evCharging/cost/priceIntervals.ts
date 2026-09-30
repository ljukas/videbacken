import { stockholmDayOf } from '~/lib/time/stockholm'
import type { SlotIndex } from './slotIndex'

/**
 * One stretch of charging energy. Power is assumed uniform within it (Zaptec
 * intervals are ~hourly, price slots 15 min), so its kWh splits across price
 * slots in proportion to overlap. `gridShare` is the fraction bought from the
 * grid — always 1 until a solar/battery source (Emaldo) can say otherwise;
 * only that share is priced.
 */
export type EnergyInterval = { startMs: number; endMs: number; kwh: number; gridShare: number }

/** A tariff period as the cost math needs it; amounts in öre/kWh ex VAT. */
export type TariffPeriod = {
  /** Stockholm calendar day ('YYYY-MM-DD') the period applies from. */
  validFrom: string
  retailMarkupOre: number
  gridTransferOre: number
  energyTaxOre: number
  vatPercent: number
}

/**
 * Cost of a set of intervals. Money is SEK incl VAT; `feesSek` is markup +
 * grid transfer + energy tax, so `totalSek = spotSek + feesSek`. Only grid
 * kWh with both a spot price and a tariff (`fullKwh`) are priced — the rest is
 * counted as missing, never as 0 kr.
 */
export type CostTotals = {
  /** All charged energy. */
  kwh: number
  /** The grid-bought share of `kwh`. */
  gridKwh: number
  /** Grid kWh with a price and a tariff — what the money covers. */
  fullKwh: number
  /** Grid kWh with no spot price for its time. */
  noPriceKwh: number
  /** Grid kWh with a spot price but no tariff in force that day. */
  noTariffKwh: number
  spotSek: number
  feesSek: number
  totalSek: number
}

export function emptyTotals(): CostTotals {
  return {
    kwh: 0,
    gridKwh: 0,
    fullKwh: 0,
    noPriceKwh: 0,
    noTariffKwh: 0,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
  }
}

export function mergeTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    kwh: a.kwh + b.kwh,
    gridKwh: a.gridKwh + b.gridKwh,
    fullKwh: a.fullKwh + b.fullKwh,
    noPriceKwh: a.noPriceKwh + b.noPriceKwh,
    noTariffKwh: a.noTariffKwh + b.noTariffKwh,
    spotSek: a.spotSek + b.spotSek,
    feesSek: a.feesSek + b.feesSek,
    totalSek: a.totalSek + b.totalSek,
  }
}

/** Float tolerance for "no grid kWh is missing a price or tariff". */
const COMPLETE_EPSILON_KWH = 1e-6

/**
 * Every grid kWh is priced — exactly once. A priced total above the grid total
 * means overlapping slots double-counted energy, which is not complete either.
 */
export function isComplete(t: CostTotals): boolean {
  return Math.abs(t.gridKwh - t.fullKwh) <= COMPLETE_EPSILON_KWH
}

/** Average öre/kWh incl VAT over the priced energy; null when nothing is priced. */
export function avgOre(t: CostTotals): number | null {
  return t.fullKwh > 0 ? (t.totalSek / t.fullKwh) * 100 : null
}

/**
 * The tariff in force on Stockholm `day`: the latest period whose `validFrom`
 * is on or before it. `tariffsAsc` must be sorted by `validFrom` ascending
 * ('YYYY-MM-DD' strings compare correctly as text).
 */
export function tariffAt(tariffsAsc: readonly TariffPeriod[], day: string): TariffPeriod | null {
  for (let i = tariffsAsc.length - 1; i >= 0; i--) {
    if (tariffsAsc[i].validFrom <= day) return tariffsAsc[i]
  }
  return null
}

/**
 * SEK per kWh incl VAT of a slot's spot price and of a tariff's per-kWh fees
 * (markup + grid transfer + energy tax). The one formula every kronor figure
 * uses — priced energy here, and slot ranking in the Phase 4 counterfactuals.
 */
export function unitPrice(
  sekPerKwh: number,
  tariff: TariffPeriod,
): { spotSek: number; feesSek: number } {
  const vat = 1 + tariff.vatPercent / 100
  const feesOre = tariff.retailMarkupOre + tariff.gridTransferOre + tariff.energyTaxOre
  return { spotSek: sekPerKwh * vat, feesSek: (feesOre / 100) * vat }
}

/**
 * Prices intervals against spot slots and tariffs. Each interval's grid kWh is
 * split into pieces by the slots it overlaps (kWh × overlap / duration); an
 * uncovered stretch is a no-price piece. A priced piece takes the tariff of its
 * slot's Stockholm day (slots never straddle local midnight).
 */
export function priceIntervals(
  intervals: readonly EnergyInterval[],
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): CostTotals {
  const t = emptyTotals()
  for (const iv of intervals) {
    assertValidInterval(iv)
    const durationMs = iv.endMs - iv.startMs
    const gridKwh = iv.kwh * iv.gridShare
    t.kwh += iv.kwh
    t.gridKwh += gridKwh
    if (durationMs <= 0) {
      // No duration to spread the energy over: it can't be priced.
      t.noPriceKwh += gridKwh
      continue
    }
    let coveredMs = 0
    for (const slot of slots.between(iv.startMs, iv.endMs)) {
      const overlapMs = Math.min(slot.endMs, iv.endMs) - Math.max(slot.startMs, iv.startMs)
      if (overlapMs <= 0) continue
      coveredMs += overlapMs
      const kwh = (gridKwh * overlapMs) / durationMs
      const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
      if (!tariff) {
        t.noTariffKwh += kwh
        continue
      }
      const unit = unitPrice(slot.sekPerKwh, tariff)
      const spotSek = kwh * unit.spotSek
      const feesSek = kwh * unit.feesSek
      t.fullKwh += kwh
      t.spotSek += spotSek
      t.feesSek += feesSek
      t.totalSek += spotSek + feesSek
    }
    t.noPriceKwh += (gridKwh * (durationMs - Math.min(coveredMs, durationMs))) / durationMs
  }
  return t
}

// Stored energy is CHECK-constrained non-negative and finite, so a bad value
// here is a caller bug: fail loudly rather than let one NaN poison every sum.
function assertValidInterval(iv: EnergyInterval): void {
  if (
    !Number.isFinite(iv.startMs) ||
    !Number.isFinite(iv.endMs) ||
    !Number.isFinite(iv.kwh) ||
    iv.kwh < 0 ||
    !(iv.gridShare >= 0 && iv.gridShare <= 1)
  ) {
    throw new RangeError('Invalid energy interval')
  }
}
