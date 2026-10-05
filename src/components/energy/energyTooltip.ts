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

/** A month's parts (positive kWh) and the metric's total, for the bars and the tooltip. */
export function energyTooltipRows(
  metric: EnergyMetric,
  p: PeriodSums,
): { parts: { key: SeriesKey; kwh: number }[]; totalKwh: number } {
  const f = energyFigures(p)
  const value: Record<SeriesKey, number> = {
    solarDirect: f.solarDirect,
    solarBattery: f.solarToBattery,
    solarExported: f.solarExported,
    importDirect: f.importDirect,
    importBattery: f.importToBattery,
    exported: p.gridExportKwh,
    car: f.car,
    house: f.restOfHouse,
  }
  const totalKwh = metric === 'solar' ? p.solarKwh : metric === 'grid' ? p.gridImportKwh : p.loadKwh
  return { parts: METRIC_SERIES[metric].map((key) => ({ key, kwh: value[key] })), totalKwh }
}
