// Client-safe, pure (ADR-0024). The single home of the house-energy page
// definitions: what a period's sums mean as solar use, grid use,
// self-sufficiency, car vs house and battery in / out / loss. The service
// fills `PeriodSums` from SQL sums; the pages call `energyFigures` on them.
import { BATTERY_CAPACITY_KWH } from './mix/pool'

/** Below this many kWh into the battery, efficiency and grid share mean nothing. */
export const MIN_BATTERY_IN_KWH = 1
/** At or above this share of expected buckets a period counts as complete. */
export const COVERAGE_COMPLETE = 0.99
const BUCKET_HOURS = 5 / 60

/** One period's (a month, a year, all time) raw sums over the house readings, kWh. */
export type PeriodSums = {
  gridImportKwh: number
  gridExportKwh: number
  solarKwh: number
  loadKwh: number
  batteryDischargeKwh: number
  batteryChargeSolarKwh: number
  /** Emaldo `charge_grid` + `charge_ac` (ac counts as grid, as in the derive). */
  batteryChargeGridKwh: number
  /** Counted charging of every vehicle (the /charging overview's kWh rule). */
  carKwh: number
  /** SoC % of the period's first / last bucket that has one. */
  firstSocPct: number | null
  lastSocPct: number | null
  /** Readings in the period, and how many there would be without gaps. */
  buckets: number
  expectedBuckets: number
}

export type EnergyFigures = {
  solarToBattery: number
  solarExported: number
  solarDirect: number
  importToBattery: number
  importDirect: number
  /** 0–1, or null without load. */
  selfSufficiency: number | null
  car: number
  restOfHouse: number
  batteryIn: number
  batteryOut: number
  /** Change in stored energy over the period, kWh (negative when it emptied). */
  deltaStored: number
  /** in − out − Δstored; may be slightly negative over a short period (meter noise). */
  loss: number
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  efficiency: number | null
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  gridChargedShare: number | null
  /** 0–1, or null when no bucket was expected. */
  coverage: number | null
  missingHours: number
}

/** Two adjacent periods as one; `earlier` must precede `later`. */
export function addPeriodSums(earlier: PeriodSums, later: PeriodSums): PeriodSums {
  return {
    gridImportKwh: earlier.gridImportKwh + later.gridImportKwh,
    gridExportKwh: earlier.gridExportKwh + later.gridExportKwh,
    solarKwh: earlier.solarKwh + later.solarKwh,
    loadKwh: earlier.loadKwh + later.loadKwh,
    batteryDischargeKwh: earlier.batteryDischargeKwh + later.batteryDischargeKwh,
    batteryChargeSolarKwh: earlier.batteryChargeSolarKwh + later.batteryChargeSolarKwh,
    batteryChargeGridKwh: earlier.batteryChargeGridKwh + later.batteryChargeGridKwh,
    carKwh: earlier.carKwh + later.carKwh,
    firstSocPct: earlier.firstSocPct ?? later.firstSocPct,
    lastSocPct: later.lastSocPct ?? earlier.lastSocPct,
    buckets: earlier.buckets + later.buckets,
    expectedBuckets: earlier.expectedBuckets + later.expectedBuckets,
  }
}

export function energyFigures(p: PeriodSums, capacityKwh = BATTERY_CAPACITY_KWH): EnergyFigures {
  const solarToBattery = p.batteryChargeSolarKwh
  const solarExported = Math.min(p.gridExportKwh, Math.max(0, p.solarKwh - solarToBattery))
  const solarDirect = Math.max(0, p.solarKwh - solarToBattery - solarExported)
  const importToBattery = Math.min(p.gridImportKwh, p.batteryChargeGridKwh)
  const batteryIn = solarToBattery + p.batteryChargeGridKwh
  const deltaStored =
    p.firstSocPct !== null && p.lastSocPct !== null
      ? ((p.lastSocPct - p.firstSocPct) / 100) * capacityKwh
      : 0
  const netIn = batteryIn - deltaStored
  const enough = batteryIn >= MIN_BATTERY_IN_KWH && netIn >= MIN_BATTERY_IN_KWH
  return {
    solarToBattery,
    solarExported,
    solarDirect,
    importToBattery,
    importDirect: p.gridImportKwh - importToBattery,
    selfSufficiency: p.loadKwh > 0 ? Math.max(0, 1 - p.gridImportKwh / p.loadKwh) : null,
    car: p.carKwh,
    restOfHouse: Math.max(0, p.loadKwh - p.carKwh),
    batteryIn,
    batteryOut: p.batteryDischargeKwh,
    deltaStored,
    loss: batteryIn - p.batteryDischargeKwh - deltaStored,
    efficiency: enough ? Math.min(1, p.batteryDischargeKwh / netIn) : null,
    gridChargedShare: batteryIn >= MIN_BATTERY_IN_KWH ? p.batteryChargeGridKwh / batteryIn : null,
    coverage: p.expectedBuckets > 0 ? p.buckets / p.expectedBuckets : null,
    missingHours: Math.max(0, p.expectedBuckets - p.buckets) * BUCKET_HOURS,
  }
}

/** Hours to name in "Data saknas för N h" (rounded, at least 1), or null when the period is complete. */
export function gapHours(f: EnergyFigures): number | null {
  if (f.coverage === null || f.coverage >= COVERAGE_COMPLETE) return null
  return Math.max(1, Math.round(f.missingHours))
}
