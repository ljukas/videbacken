import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import type { PriceSlot } from '~/lib/spotPrice/slots'
import { stockholmDayOf } from '~/lib/time/stockholm'
import type { SlotIndex } from './slotIndex'

/**
 * How one piece of charging energy was supplied (ADR-0023), in kWh that sum
 * to the piece's `kwh`: grid, own solar, battery energy that came from the
 * grid (with the average spot it was bought at, SEK/kWh ex VAT), from solar
 * (with its average spot when stored), of unknown price, and energy without
 * house data (counted as bought from the grid). A spot is null when its kWh is 0.
 */
export type PieceMix = Omit<MixSlot, 'slotStart' | 'kwh'>

/**
 * One stretch of charging energy. Power is assumed uniform within it (Zaptec
 * intervals are ~hourly, price slots 15 min), so its kWh splits across price
 * slots in proportion to overlap. Without `mix`, `gridShare` is the fraction
 * bought from the grid and only that share is priced (the economy
 * counterfactuals use 1: price timing as if all were bought). With `mix` (a
 * 15-min slot of the stored mix, or a session's labelled all-grid fallback)
 * the piece is priced per source and `gridShare` must be 1.
 */
export type EnergyInterval = {
  startMs: number
  endMs: number
  kwh: number
  gridShare: number
  mix?: PieceMix
}

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
 * grid transfer + energy tax, so `totalSek = spotSek + feesSek`. Only bought
 * kWh with both a price and a tariff (`fullKwh`) are priced — the rest is
 * counted as missing, never as 0 kr. Own solar (straight or via the battery)
 * costs 0 kr; what it would have earned exported is kept apart, ex VAT and
 * fees (ADR-0023).
 */
export type CostTotals = {
  /** All charged energy. */
  kwh: number
  /**
   * The bought share of `kwh` — what the money must cover: grid, energy
   * without house data, and battery energy from the grid or of unknown price.
   */
  gridKwh: number
  /** Bought kWh with a price and a tariff — what the money covers. */
  fullKwh: number
  /** Bought kWh with no spot price for its time, or battery energy of unknown price. */
  noPriceKwh: number
  /** Bought kWh with a price but no tariff in force on its day. */
  noTariffKwh: number
  spotSek: number
  feesSek: number
  totalSek: number
  /** Own solar straight to the car (not via the battery). */
  solarKwh: number
  /** From the home battery, whatever charged it (grid, solar or unknown). */
  batteryKwh: number
  /** Without house data for its time, so counted as bought from the grid (part of `gridKwh`). */
  noHouseDataKwh: number
  /** What the own solar used (straight and via the battery) would have earned exported: kWh × spot, ex VAT, no fees. */
  solarValueSek: number
  /** Solar-origin kWh (straight + via the battery) whose value is in `solarValueSek`. */
  solarPricedKwh: number
  /** Solar-origin kWh with no spot to value it — left out of `solarValueSek`, never valued at 0. */
  solarUnpricedKwh: number
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
    solarKwh: 0,
    batteryKwh: 0,
    noHouseDataKwh: 0,
    solarValueSek: 0,
    solarPricedKwh: 0,
    solarUnpricedKwh: 0,
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
    solarKwh: a.solarKwh + b.solarKwh,
    batteryKwh: a.batteryKwh + b.batteryKwh,
    noHouseDataKwh: a.noHouseDataKwh + b.noHouseDataKwh,
    solarValueSek: a.solarValueSek + b.solarValueSek,
    solarPricedKwh: a.solarPricedKwh + b.solarPricedKwh,
    solarUnpricedKwh: a.solarUnpricedKwh + b.solarUnpricedKwh,
  }
}

/** Float tolerance for "no bought kWh is missing a price or tariff". */
const COMPLETE_EPSILON_KWH = 1e-6

/** Float tolerance for a mix's parts summing to its piece's kWh (the DB CHECK is tighter). */
const MIX_SUM_EPSILON_KWH = 1e-6

/**
 * Every bought kWh is priced — exactly once. A priced total above the bought
 * total means overlapping slots double-counted energy, which is not complete either.
 */
export function isComplete(t: CostTotals): boolean {
  return Math.abs(t.gridKwh - t.fullKwh) <= COMPLETE_EPSILON_KWH
}

/**
 * Average cash öre/kWh incl VAT per charged kWh whose cost is known: the priced
 * energy plus the cash-free own solar (`kwh − gridKwh`). Null when nothing is priced.
 */
export function avgOre(t: CostTotals): number | null {
  return t.fullKwh > 0 ? (t.totalSek / (t.fullKwh + Math.max(0, t.kwh - t.gridKwh))) * 100 : null
}

type Supply = Pick<CostTotals, 'kwh' | 'solarKwh' | 'batteryKwh'>

/** The share of the charged energy from own solar or the home battery; null without energy. */
export function ownSupplyShare(t: Supply): number | null {
  return t.kwh > 0 ? Math.min(1, (t.solarKwh + t.batteryKwh) / t.kwh) : null
}

/** kWh per source for the grid / solar / battery bar; grid includes energy without house data. */
export function supplySplit(t: Supply): { gridKwh: number; solarKwh: number; batteryKwh: number } {
  return {
    gridKwh: Math.max(0, t.kwh - t.solarKwh - t.batteryKwh),
    solarKwh: t.solarKwh,
    batteryKwh: t.batteryKwh,
  }
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
 * Prices intervals against spot slots and tariffs. Each interval's bought kWh
 * is split into pieces by the slots it overlaps (kWh × overlap / duration); an
 * uncovered stretch is a no-price piece. A priced piece takes the tariff of its
 * slot's Stockholm day (slots never straddle local midnight). A mixed interval
 * is priced per source (ADR-0023): see `priceMixed`.
 */
export function priceIntervals(
  intervals: readonly EnergyInterval[],
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): CostTotals {
  const t = emptyTotals()
  for (const iv of intervals) {
    assertValidInterval(iv)
    t.kwh += iv.kwh
    if (iv.mix) priceMixed(t, iv, iv.mix, slots, tariffsAsc)
    else priceBought(t, iv, iv.kwh * iv.gridShare, slots, tariffsAsc)
  }
  return t
}

// `boughtKwh` spread evenly over `iv`, priced at each overlapping slot's spot
// + its day's fees; the share no slot covers is no-price.
function priceBought(
  t: CostTotals,
  iv: EnergyInterval,
  boughtKwh: number,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): void {
  t.gridKwh += boughtKwh
  const uncovered = eachSlotShare(iv, slots, (slot, share) =>
    addPriced(
      t,
      boughtKwh * share,
      slot.sekPerKwh,
      tariffAt(tariffsAsc, stockholmDayOf(slot.startMs)),
    ),
  )
  t.noPriceKwh += boughtKwh * uncovered
}

// A piece with a known mix (ADR-0023): grid and no-house-data energy at the
// slot's spot + fees; battery-from-grid at the spot it was bought at + the
// fees of the day it is used; own solar 0 kr, valued at its spot (ex VAT, no
// fees); battery energy of unknown price is no-price.
function priceMixed(
  t: CostTotals,
  iv: EnergyInterval,
  mix: PieceMix,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): void {
  priceBought(t, iv, mix.gridKwh + mix.noHouseDataKwh, slots, tariffsAsc)
  t.noHouseDataKwh += mix.noHouseDataKwh
  t.solarKwh += mix.solarKwh
  t.batteryKwh += mix.batteryGridKwh + mix.batterySolarKwh + mix.batteryUnpricedKwh

  if (mix.solarKwh > 0) {
    const unvalued = eachSlotShare(iv, slots, (slot, share) => {
      t.solarValueSek += mix.solarKwh * share * slot.sekPerKwh
      t.solarPricedKwh += mix.solarKwh * share
    })
    t.solarUnpricedKwh += mix.solarKwh * unvalued
  }

  t.gridKwh += mix.batteryGridKwh + mix.batteryUnpricedKwh
  t.noPriceKwh += mix.batteryUnpricedKwh
  if (mix.batteryGridKwh > 0) {
    if (mix.batteryGridSpotSek === null) t.noPriceKwh += mix.batteryGridKwh
    else {
      const useDay = tariffAt(tariffsAsc, stockholmDayOf(iv.startMs))
      addPriced(t, mix.batteryGridKwh, mix.batteryGridSpotSek, useDay)
    }
  }
  if (mix.batterySolarKwh > 0) {
    if (mix.batterySolarSpotSek === null) t.solarUnpricedKwh += mix.batterySolarKwh
    else {
      t.solarValueSek += mix.batterySolarKwh * mix.batterySolarSpotSek
      t.solarPricedKwh += mix.batterySolarKwh
    }
  }
}

// Calls `each` for every slot overlapping `iv` with the share of `iv` it
// covers (overlap ÷ duration); returns the share no slot covers — all of a
// zero-length interval, which has no duration to spread over.
function eachSlotShare(
  iv: EnergyInterval,
  slots: SlotIndex,
  each: (slot: PriceSlot, share: number) => void,
): number {
  const durationMs = iv.endMs - iv.startMs
  if (durationMs <= 0) return 1
  let coveredMs = 0
  for (const slot of slots.between(iv.startMs, iv.endMs)) {
    const overlapMs = Math.min(slot.endMs, iv.endMs) - Math.max(slot.startMs, iv.startMs)
    if (overlapMs <= 0) continue
    coveredMs += overlapMs
    each(slot, overlapMs / durationMs)
  }
  return (durationMs - Math.min(coveredMs, durationMs)) / durationMs
}

function addPriced(
  t: CostTotals,
  kwh: number,
  sekPerKwh: number,
  tariff: TariffPeriod | null,
): void {
  if (!tariff) {
    t.noTariffKwh += kwh
    return
  }
  const unit = unitPrice(sekPerKwh, tariff)
  const spotSek = kwh * unit.spotSek
  const feesSek = kwh * unit.feesSek
  t.fullKwh += kwh
  t.spotSek += spotSek
  t.feesSek += feesSek
  t.totalSek += spotSek + feesSek
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
  if (iv.mix) assertValidMix(iv.mix, iv.kwh, iv.gridShare)
}

function assertValidMix(mix: PieceMix, kwh: number, gridShare: number): void {
  const parts = [
    mix.gridKwh,
    mix.solarKwh,
    mix.batteryGridKwh,
    mix.batterySolarKwh,
    mix.batteryUnpricedKwh,
    mix.noHouseDataKwh,
  ]
  const spots = [mix.batteryGridSpotSek, mix.batterySolarSpotSek]
  if (
    gridShare !== 1 ||
    parts.some((p) => !Number.isFinite(p) || p < 0) ||
    spots.some((s) => s !== null && !Number.isFinite(s)) ||
    Math.abs(parts.reduce((a, b) => a + b, 0) - kwh) > MIX_SUM_EPSILON_KWH
  ) {
    throw new RangeError('Invalid energy mix')
  }
}
