// Client-safe, pure (ADR-0023, spec "Derivation" 4). The car's energy per
// 15-minute slot, split like the house's supply in each 5-minute bucket; the
// battery part splits further by what left the battery in that bucket.
import type { BatteryOut } from './pool'
import type { CarBucket } from './shape'
import type { SupplyFractions } from './supply'

/** Mix rows are per UTC quarter-hour (the spot slot length since 2025-10-01). */
export const SLOT_MS = 15 * 60_000

export type MixSlot = {
  slotStart: Date
  kwh: number
  gridKwh: number
  solarKwh: number
  batteryGridKwh: number
  /** kWh-weighted average spot (SEK/kWh ex VAT); null when batteryGridKwh is 0. */
  batteryGridSpotSek: number | null
  batterySolarKwh: number
  /** kWh-weighted average spot (SEK/kWh ex VAT); null when batterySolarKwh is 0. */
  batterySolarSpotSek: number | null
  batteryUnpricedKwh: number
  noHouseDataKwh: number
}

/** What the house data says about one 5-minute bucket. */
export type BucketHouse = { supply: SupplyFractions | null; batteryOut: BatteryOut }

type Acc = {
  kwh: number
  gridKwh: number
  solarKwh: number
  batteryGridKwh: number
  batteryGridSpotSum: number
  batterySolarKwh: number
  batterySolarSpotSum: number
  batteryUnpricedKwh: number
  noHouseDataKwh: number
}

const emptyAcc = (): Acc => ({
  kwh: 0,
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSum: 0,
  batterySolarKwh: 0,
  batterySolarSpotSum: 0,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
})

/**
 * Per bucket: car kWh × the house fractions; a bucket missing from `house`, or
 * with unknown supply, is no-house-data. Slots ascending; a slot's parts sum
 * to its `kwh`, and a battery spot is set exactly when its kWh is > 0.
 */
export function deriveSessionMix(
  buckets: readonly CarBucket[],
  house: ReadonlyMap<number, BucketHouse>,
): MixSlot[] {
  const slots = new Map<number, Acc>()
  for (const b of buckets) {
    if (!(b.kwh > 0)) continue
    const slotStart = Math.floor(b.bucketStart / SLOT_MS) * SLOT_MS
    let acc = slots.get(slotStart)
    if (!acc) {
      acc = emptyAcc()
      slots.set(slotStart, acc)
    }
    acc.kwh += b.kwh
    const h = house.get(b.bucketStart)
    if (!h?.supply) {
      acc.noHouseDataKwh += b.kwh
      continue
    }
    acc.gridKwh += b.kwh * h.supply.grid
    acc.solarKwh += b.kwh * h.supply.solar
    const battery = b.kwh * h.supply.battery
    if (!(battery > 0)) continue
    const o = h.batteryOut
    const left = o.gridKwh + o.solarKwh + o.unpricedKwh
    if (!(left > 0)) {
      acc.batteryUnpricedKwh += battery
      continue
    }
    const fromGrid = battery * (o.gridKwh / left)
    const fromSolar = battery * (o.solarKwh / left)
    acc.batteryGridKwh += fromGrid
    acc.batterySolarKwh += fromSolar
    acc.batteryUnpricedKwh += battery * (o.unpricedKwh / left)
    if (o.gridKwh > 0) acc.batteryGridSpotSum += fromGrid * (o.gridSpotSekSum / o.gridKwh)
    if (o.solarKwh > 0) acc.batterySolarSpotSum += fromSolar * (o.solarSpotSekSum / o.solarKwh)
  }
  return [...slots]
    .sort(([a], [b]) => a - b)
    .map(([start, a]) => ({
      slotStart: new Date(start),
      kwh: a.kwh,
      gridKwh: a.gridKwh,
      solarKwh: a.solarKwh,
      batteryGridKwh: a.batteryGridKwh,
      batteryGridSpotSek: a.batteryGridKwh > 0 ? a.batteryGridSpotSum / a.batteryGridKwh : null,
      batterySolarKwh: a.batterySolarKwh,
      batterySolarSpotSek: a.batterySolarKwh > 0 ? a.batterySolarSpotSum / a.batterySolarKwh : null,
      batteryUnpricedKwh: a.batteryUnpricedKwh,
      noHouseDataKwh: a.noHouseDataKwh,
    }))
}
