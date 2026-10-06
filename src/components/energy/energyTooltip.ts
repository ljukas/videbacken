import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'

export type EnergyMetric = 'solar' | 'grid' | 'load'
export type SeriesKey =
  | 'solarDirect'
  | 'solarBattery'
  | 'solarExported'
  | 'importDirect'
  | 'importBattery'
  | 'exported'
  | 'car'
  | 'house'

/** Each metric's series in stack order (bottom → top; `exported` on Nät draws below the axis). */
export const METRIC_SERIES: Record<EnergyMetric, SeriesKey[]> = {
  solar: ['solarDirect', 'solarBattery', 'solarExported'],
  grid: ['importDirect', 'importBattery', 'exported'],
  load: ['car', 'house'],
}

/** The one series that draws below the axis: Nät's export (a separate flow, not part of the purchase). */
export const isBelowAxis = (metric: EnergyMetric, key: SeriesKey) =>
  metric === 'grid' && key === 'exported'

export type TooltipPart = {
  key: SeriesKey
  kwh: number
  /** Share of `totalKwh` for a stacked part; null for Nät's export and when the total is 0. */
  share: number | null
}

/** A month's parts (positive kWh, each with its share of the total) and the metric's total, for the bars and the tooltip. */
export function energyTooltipRows(
  metric: EnergyMetric,
  p: PeriodSums,
): { parts: TooltipPart[]; totalKwh: number } {
  const f = energyFigures(p)
  // The parts must add up to the total the tooltip prints: battery charging
  // from solar can overshoot the month's solar (meter noise); cap it here
  // (figures.ts caps the car at load itself).
  const solarBattery = Math.min(f.solarToBattery, p.solarKwh)
  const value: Record<SeriesKey, number> = {
    solarDirect: f.solarDirect,
    solarBattery,
    solarExported: f.solarExported,
    importDirect: f.importDirect,
    importBattery: f.importToBattery,
    exported: p.gridExportKwh,
    car: f.car,
    house: f.restOfHouse,
  }
  const totalKwh = metric === 'solar' ? p.solarKwh : metric === 'grid' ? p.gridImportKwh : p.loadKwh
  const parts = METRIC_SERIES[metric].map((key) => ({
    key,
    kwh: value[key],
    share: totalKwh > 0 && !isBelowAxis(metric, key) ? value[key] / totalKwh : null,
  }))
  return { parts, totalKwh }
}

export type ChartRow = { month: number; sums: PeriodSums | null } & Partial<
  Record<SeriesKey, number | null>
>

/** One row per month for the stacked bars: null (not 0) without data; Nät's export negated (below the axis). */
export function chartRows(metric: EnergyMetric, months: (PeriodSums | null)[]): ChartRow[] {
  return months.map((sums, i) => {
    const row: ChartRow = { month: i + 1, sums }
    const parts = sums ? energyTooltipRows(metric, sums).parts : []
    for (const key of METRIC_SERIES[metric]) {
      const part = parts.find((r) => r.key === key)
      row[key] = part ? (isBelowAxis(metric, key) ? -part.kwh : part.kwh) : null
    }
    return row
  })
}
