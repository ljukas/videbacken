// Client-safe, pure (ADR-0024). The single home of the house-energy page
// definitions: what a period's sums mean as solar use, grid use,
// self-sufficiency, car vs heat pumps vs the rest of the house and battery in / out / loss. The service
// fills `PeriodSums` from SQL sums; the pages call `energyFigures` on them.
import { BATTERY_CAPACITY_KWH } from './mix/pool'

/** Below this many kWh into the battery, efficiency and grid share mean nothing. */
export const MIN_BATTERY_IN_KWH = 1
/** Above this share of what went in, a period's battery loss reads as winter heating (the tooltip's hint). */
export const WINTER_LOSS_SHARE = 0.25
/** At or above this share of expected buckets a period counts as complete. */
export const COVERAGE_COMPLETE = 0.99
const BUCKET_HOURS = 5 / 60

/** One heat pump's sums over a period (ADR-0027): its kWh, the hours with a reading and the hours expected. */
export type HeatPumpPeriod = {
  id: string
  name: string
  kwh: number
  hours: number
  expectedHours: number
}

/** The heat pumps' order everywhere (diagram, table, chart stack): Swedish name order, then id. */
export function byHeatPumpName(
  a: { id: string; name: string },
  b: { id: string; name: string },
): number {
  return a.name.localeCompare(b.name, 'sv') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

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
  /** Each heat pump with a reading in the period or expected to have one, in name order (heat pumps step 2). */
  heatPumps: HeatPumpPeriod[]
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
  /** Load minus laddning and the heat pumps, never negative (heat pumps step 2: excludes the heat pumps). */
  restOfHouse: number
  /**
   * Each heat pump's kWh and share of the load, in name order. Capped: laddning + heat pumps never exceed the load
   * (meter noise, or heat pump hours where house buckets are missing), so övrigt hus is never negative.
   */
  heatPumps: { id: string; name: string; kwh: number; share: number | null }[]
  /** The most hours any heat pump is missing in the period (whole hours; 0 when complete or without units). */
  heatPumpMissingHours: number
  batteryIn: number
  batteryOut: number
  /** Change in stored energy over the period, kWh (negative when it emptied). */
  deltaStored: number
  /** in − out − Δstored; may be slightly negative over a short period (meter noise). */
  loss: number
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  efficiency: number | null
  /** The loss as a share of what stayed in the battery (in − Δstored); null when `efficiency` is. */
  lossShare: number | null
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  gridChargedShare: number | null
  /** 0–1, or null when no bucket was expected. */
  coverage: number | null
  missingHours: number
  /** Export the solar surplus can't explain: it came out of the battery. */
  batteryToGrid: number
  /** What the battery delivered to the house: its discharge minus `batteryToGrid`. */
  batteryToHouse: number
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
    heatPumps: mergeHeatPumps(earlier.heatPumps, later.heatPumps),
  }
}

function mergeHeatPumps(earlier: HeatPumpPeriod[], later: HeatPumpPeriod[]): HeatPumpPeriod[] {
  const byId = new Map<string, HeatPumpPeriod>()
  for (const u of [...earlier, ...later]) {
    const seen = byId.get(u.id)
    byId.set(
      u.id,
      seen
        ? {
            id: u.id,
            name: u.name,
            kwh: seen.kwh + u.kwh,
            hours: seen.hours + u.hours,
            expectedHours: seen.expectedHours + u.expectedHours,
          }
        : { ...u },
    )
  }
  return [...byId.values()].sort(byHeatPumpName)
}

export function energyFigures(p: PeriodSums, capacityKwh = BATTERY_CAPACITY_KWH): EnergyFigures {
  const solarToBattery = p.batteryChargeSolarKwh
  const solarExported = Math.min(p.gridExportKwh, Math.max(0, p.solarKwh - solarToBattery))
  const solarDirect = Math.max(0, p.solarKwh - solarToBattery - solarExported)
  const importToBattery = Math.min(p.gridImportKwh, p.batteryChargeGridKwh)
  const batteryToGrid = Math.max(0, p.gridExportKwh - solarExported)
  const batteryIn = solarToBattery + p.batteryChargeGridKwh
  const deltaStored =
    p.firstSocPct !== null && p.lastSocPct !== null
      ? ((p.lastSocPct - p.firstSocPct) / 100) * capacityKwh
      : 0
  const netIn = batteryIn - deltaStored
  const enough = batteryIn >= MIN_BATTERY_IN_KWH && netIn >= MIN_BATTERY_IN_KWH
  const loss = batteryIn - p.batteryDischargeKwh - deltaStored
  // The car cannot have drawn more than the house measured as load.
  const car = Math.min(p.carKwh, p.loadKwh)
  // The heat pumps share what the car left of the load; scaled down together when they'd exceed it.
  const unitsKwh = p.heatPumps.reduce((sum, u) => sum + u.kwh, 0)
  const room = Math.max(0, p.loadKwh - car)
  const scale = unitsKwh > 0 ? Math.min(1, room / unitsKwh) : 1
  const heatPumps = p.heatPumps.map((u) => {
    const kwh = u.kwh * scale
    return { id: u.id, name: u.name, kwh, share: p.loadKwh > 0 ? kwh / p.loadKwh : null }
  })
  const heatPumpKwh = heatPumps.reduce((sum, u) => sum + u.kwh, 0)
  return {
    solarToBattery,
    solarExported,
    solarDirect,
    importToBattery,
    importDirect: p.gridImportKwh - importToBattery,
    selfSufficiency: p.loadKwh > 0 ? Math.max(0, 1 - p.gridImportKwh / p.loadKwh) : null,
    car,
    // Capped heat pumps fill the room exactly: 0, not a floating-point crumb.
    restOfHouse: scale < 1 ? 0 : Math.max(0, p.loadKwh - car - heatPumpKwh),
    heatPumps,
    heatPumpMissingHours: p.heatPumps.reduce(
      (most, u) => Math.max(most, u.expectedHours - u.hours),
      0,
    ),
    batteryIn,
    batteryOut: p.batteryDischargeKwh,
    deltaStored,
    loss,
    efficiency: enough ? Math.min(1, p.batteryDischargeKwh / netIn) : null,
    lossShare: enough ? loss / netIn : null,
    gridChargedShare: batteryIn >= MIN_BATTERY_IN_KWH ? p.batteryChargeGridKwh / batteryIn : null,
    coverage: p.expectedBuckets > 0 ? p.buckets / p.expectedBuckets : null,
    missingHours: Math.max(0, p.expectedBuckets - p.buckets) * BUCKET_HOURS,
    batteryToGrid,
    batteryToHouse: Math.max(0, p.batteryDischargeKwh - batteryToGrid),
  }
}

/** Hours to name in "Data saknas för N h" (rounded, at least 1), or null when the period is complete. */
export function gapHours(f: EnergyFigures): number | null {
  if (f.coverage === null || f.coverage >= COVERAGE_COMPLETE) return null
  return Math.max(1, Math.round(f.missingHours))
}
