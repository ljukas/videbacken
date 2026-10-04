// Client-safe, pure (ADR-0023 decision 5 and its 2026-10-04 amendment, spec
// "Derivation" 3). The battery as an average-cost pool, run forward bucket by
// bucket: inflows enter at their full kWh carrying their slot's spot (grid:
// what was paid; solar: what export would have paid), an outflow takes every
// part in proportion, and after the bucket the pool is capped at what the
// battery's measured state of charge says it holds.
import type { HouseReading } from '~/lib/services/houseEnergy'
import { BUCKET_MS } from './shape'

/**
 * C: the kWh the battery delivers per 100 % SoC (spec "Derivation" 3).
 * Measured 2026-10-04 over 2026-01-20 → 2026-10-04: Σ discharge ÷ Σ SoC drop
 * / 100 over adjacent pairs of discharge-only buckets (≈ 6.2 in Jan–Feb,
 * 7.5–8.1 from March). Every checkpoint stores the C it was computed with, so
 * changing this re-derives history at the next derive.
 */
export const BATTERY_CAPACITY_KWH = 7.58

/** Below this the pool counts as empty (float dust after many proportional removals). */
const EMPTY_KWH = 1e-9

/**
 * What's in the battery: grid energy with Σ kWh × the spot it was bought at,
 * solar energy with Σ kWh × the spot it would have sold for, and energy stored
 * in a slot without a price. `storedKwh` is always their sum.
 */
export type PoolState = {
  storedKwh: number
  gridKwh: number
  gridSpotSekSum: number
  solarKwh: number
  solarSpotSekSum: number
  unpricedKwh: number
}

/** The composition of what left the battery in one bucket (its parts sum to the discharge). */
export type BatteryOut = {
  gridKwh: number
  gridSpotSekSum: number
  solarKwh: number
  solarSpotSekSum: number
  unpricedKwh: number
}

export const emptyPool = (): PoolState => ({
  storedKwh: 0,
  gridKwh: 0,
  gridSpotSekSum: 0,
  solarKwh: 0,
  solarSpotSekSum: 0,
  unpricedKwh: 0,
})

/**
 * The battery's SoC (%) at the end of bucket `r`. Emaldo's SoC describes the
 * middle of its bucket (measured 2026-10-04: the change from one row to the
 * next splits evenly between the two buckets' flows), so the end is the mean
 * of this row's and the next one's. Null, so no cap, without both values or
 * when `next` isn't the very next bucket (a gap).
 */
export function endOfBucketSocPct(r: HouseReading, next: HouseReading | undefined): number | null {
  if (!next || next.bucketStart.getTime() - r.bucketStart.getTime() !== BUCKET_MS) return null
  if (r.batterySocPct === null || next.batterySocPct === null) return null
  return (r.batterySocPct + next.batterySocPct) / 2
}

/**
 * One 5-minute bucket. The inflow joins before the outflow leaves (a bucket
 * that both charges and discharges sends some of its own inflow on). An
 * outflow beyond the pool empties it and counts the excess as grid energy at
 * this bucket's spot: conservative, and it absorbs measurement drift. Then,
 * with a `capKwh` (end-of-bucket SoC × C), a pool above it shrinks every part
 * by one factor and keeps its spot sums: charging, standby and heating losses
 * raise the average cost (and solar value) of what is left. Below the cap
 * nothing changes. `charge_ac` is grid-origin (spec "Sync").
 */
export function stepPool(
  s: PoolState,
  r: HouseReading,
  spotSekPerKwh: number | null,
  capKwh: number | null,
): { next: PoolState; out: BatteryOut } {
  const gridIn = r.batteryChargeGridKwh + r.batteryChargeAcKwh
  const solarIn = r.batteryChargeSolarKwh
  let { gridKwh, gridSpotSekSum, solarKwh, solarSpotSekSum, unpricedKwh } = s
  if (spotSekPerKwh === null) {
    unpricedKwh += gridIn + solarIn
  } else {
    gridKwh += gridIn
    gridSpotSekSum += gridIn * spotSekPerKwh
    solarKwh += solarIn
    solarSpotSekSum += solarIn * spotSekPerKwh
  }

  const out: BatteryOut = {
    gridKwh: 0,
    gridSpotSekSum: 0,
    solarKwh: 0,
    solarSpotSekSum: 0,
    unpricedKwh: 0,
  }
  const discharge = r.batteryDischargeKwh
  if (discharge > 0) {
    const stored = gridKwh + solarKwh + unpricedKwh
    const f = stored > 0 ? Math.min(1, discharge / stored) : 0
    out.gridKwh = gridKwh * f
    out.gridSpotSekSum = gridSpotSekSum * f
    out.solarKwh = solarKwh * f
    out.solarSpotSekSum = solarSpotSekSum * f
    out.unpricedKwh = unpricedKwh * f
    gridKwh *= 1 - f
    gridSpotSekSum *= 1 - f
    solarKwh *= 1 - f
    solarSpotSekSum *= 1 - f
    unpricedKwh *= 1 - f
    const excess = discharge - stored
    if (excess > 0) {
      if (spotSekPerKwh === null) out.unpricedKwh += excess
      else {
        out.gridKwh += excess
        out.gridSpotSekSum += excess * spotSekPerKwh
      }
    }
  }

  const stored = gridKwh + solarKwh + unpricedKwh
  if (capKwh !== null && stored > capKwh) {
    const k = Math.max(0, capKwh) / stored
    gridKwh *= k
    solarKwh *= k
    unpricedKwh *= k
  }
  const storedKwh = gridKwh + solarKwh + unpricedKwh
  if (storedKwh < EMPTY_KWH) return { next: emptyPool(), out }
  return {
    next: { storedKwh, gridKwh, gridSpotSekSum, solarKwh, solarSpotSekSum, unpricedKwh },
    out,
  }
}
