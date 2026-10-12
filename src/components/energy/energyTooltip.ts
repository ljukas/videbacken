import { byHeatPumpName, energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'

export type EnergyMetric = 'solar' | 'grid' | 'load'
/** One series per heat pump on Förbrukning (heat pumps step 2): the unit's id after the prefix. */
export type HeatPumpSeriesKey = `heatPump:${string}`
export type SeriesKey =
  | 'solarDirect'
  | 'solarBattery'
  | 'solarExported'
  | 'importDirect'
  | 'importBattery'
  | 'exported'
  | 'car'
  | 'house'
  | HeatPumpSeriesKey

export const heatPumpSeriesKey = (id: string): HeatPumpSeriesKey => `heatPump:${id}`
export const isHeatPumpSeries = (key: SeriesKey): key is HeatPumpSeriesKey =>
  key.startsWith('heatPump:')

/**
 * Each metric's fixed series in stack order (bottom → top; `exported` on Nät draws below the axis). Förbrukning's
 * heat pumps go between laddning and övrigt hus: see `metricSeries`.
 */
export const METRIC_SERIES: Record<EnergyMetric, SeriesKey[]> = {
  solar: ['solarDirect', 'solarBattery', 'solarExported'],
  grid: ['importDirect', 'importBattery', 'exported'],
  load: ['car', 'house'],
}

/** A metric's series in stack order: on Förbrukning one per heat pump between laddning and övrigt hus. */
export function metricSeries(metric: EnergyMetric, units: readonly { id: string }[]): SeriesKey[] {
  if (metric !== 'load') return METRIC_SERIES[metric]
  return ['car', ...units.map((u) => heatPumpSeriesKey(u.id)), 'house']
}

/** The heat pumps with a figure in any of `months`, once each, in name order: Förbrukning's series (from the data). */
export function chartUnits(months: readonly (PeriodSums | null)[]): { id: string; name: string }[] {
  const byId = new Map<string, { id: string; name: string }>()
  for (const p of months)
    for (const u of p?.heatPumps ?? []) byId.set(u.id, { id: u.id, name: u.name })
  return [...byId.values()].sort(byHeatPumpName)
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
  // (figures.ts caps the car and the heat pumps at the load itself).
  const solarBattery = Math.min(f.solarToBattery, p.solarKwh)
  const fixed: Record<Exclude<SeriesKey, HeatPumpSeriesKey>, number> = {
    solarDirect: f.solarDirect,
    solarBattery,
    solarExported: f.solarExported,
    importDirect: f.importDirect,
    importBattery: f.importToBattery,
    exported: p.gridExportKwh,
    car: f.car,
    house: f.restOfHouse,
  }
  const units = new Map(f.heatPumps.map((u) => [heatPumpSeriesKey(u.id), u.kwh]))
  const totalKwh = metric === 'solar' ? p.solarKwh : metric === 'grid' ? p.gridImportKwh : p.loadKwh
  // This month's units only: a unit without a figure here has no part (and no tooltip row).
  const parts = metricSeries(metric, f.heatPumps).map((key) => {
    const kwh = isHeatPumpSeries(key) ? (units.get(key) ?? 0) : fixed[key]
    return { key, kwh, share: totalKwh > 0 && !isBelowAxis(metric, key) ? kwh / totalKwh : null }
  })
  return { parts, totalKwh }
}

export type ChartRow = { month: number; sums: PeriodSums | null } & Partial<
  Record<SeriesKey, number | null>
>

/** One row per month for the stacked bars: null (not 0) without data, or for a unit absent that month; Nät's export negated. */
export function chartRows(metric: EnergyMetric, months: (PeriodSums | null)[]): ChartRow[] {
  const keys = metricSeries(metric, chartUnits(months))
  return months.map((sums, i) => {
    const row: ChartRow = { month: i + 1, sums }
    const parts = sums ? energyTooltipRows(metric, sums).parts : []
    for (const key of keys) {
      const part = parts.find((r) => r.key === key)
      row[key] = part ? (isBelowAxis(metric, key) ? -part.kwh : part.kwh) : null
    }
    return row
  })
}
