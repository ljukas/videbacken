import { useMemo } from 'react'
import { BarChart, type BarSeries } from '~/components/chart/BarChart'
import { CHART_HEIGHT, TooltipRow } from '~/components/chart/ChartParts'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { m } from '~/paraglide/messages'
import {
  type ChartRow,
  chartRows,
  chartUnits,
  type EnergyMetric,
  energyTooltipRows,
  type HeatPumpSeriesKey,
  isBelowAxis,
  isHeatPumpSeries,
  metricSeries,
  type SeriesKey,
} from './energyTooltip'

export type { EnergyMetric } from './energyTooltip'

export function energyMetricOptions(): MetricOption<EnergyMetric>[] {
  return [
    { value: 'solar', label: m.energy_metric_solar() },
    { value: 'grid', label: m.energy_metric_grid() },
    { value: 'load', label: m.energy_metric_load() },
  ]
}

function fixedSeries(): Record<
  Exclude<SeriesKey, HeatPumpSeriesKey>,
  { label: string; color: string }
> {
  return {
    solarDirect: { label: m.energy_series_solar_direct(), color: 'var(--energy-solar)' },
    solarBattery: { label: m.energy_series_solar_battery(), color: 'var(--energy-battery)' },
    solarExported: { label: m.energy_series_solar_exported(), color: 'var(--energy-export)' },
    importDirect: { label: m.energy_series_import_direct(), color: 'var(--energy-grid)' },
    importBattery: { label: m.energy_series_import_battery(), color: 'var(--energy-battery)' },
    exported: { label: m.energy_series_export(), color: 'var(--energy-export)' },
    car: { label: m.energy_series_car(), color: 'var(--energy-car)' },
    house: { label: m.energy_series_house(), color: 'var(--energy-house)' },
  }
}

// A series' legend label and colour. A heat pump is named from the data; its colour is its all-time place
// (`colourUnits`), so it isn't repainted in a year where an earlier-named unit has no data.
function seriesStyle(
  key: SeriesKey,
  units: readonly { id: string; name: string }[],
  colourUnits: readonly { id: string }[],
): { label: string; color: string } {
  if (!isHeatPumpSeries(key)) return fixedSeries()[key]
  const id = key.slice('heatPump:'.length)
  const name = units.find((u) => u.id === id)?.name ?? ''
  return {
    label: m.energy_heat_pump_name({ name }),
    color: heatPumpColor(colourUnits.length > 0 ? colourUnits : units, id),
  }
}

// BarChart's accessors, at module level: they capture nothing, and a stable
// identity keeps the chart's geometry memo across page re-renders.
const monthCategory = (r: ChartRow) => monthLabel(r.month)
const monthInitial = (r: ChartRow) => monthLabel(r.month).charAt(0).toUpperCase()
const seriesValue = (r: ChartRow, key: string) => r[key as SeriesKey] ?? null

const TOTAL_LABEL: Record<EnergyMetric, () => string> = {
  solar: m.energy_chart_total_solar,
  grid: m.energy_chart_total_grid,
  load: m.energy_chart_total_load,
}

// The house's energy per month of `year` for one metric: stacked bars, export
// below the axis on Nät, a legend (touch can't hover), and a tooltip with the
// month's parts (kWh and share), its total and any gap. Months without data
// draw no bar (never a zero bar) and can't be selected. Clicking a month (or
// Enter / Space on the keyboard-focused one) selects it; the selected month is
// tinted with a bold label. The page owns the metric, the year and the selection.
// Drawn by the visx `BarChart`; the chart owns hover, keyboard and selection.
export function EnergyMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
  selectedMonth,
  onSelectMonth,
  heatPumpUnits,
}: {
  year: number
  months: (PeriodSums | null)[]
  metric: EnergyMetric
  /** The current Stockholm month when `year` is the current year (its tooltip says "hittills"), else null. */
  currentMonth: number | null
  /** The month (1–12) of `year` shown in the summary, else null. */
  selectedMonth: number | null
  onSelectMonth: (month: number) => void
  /** Every unit in its all-time order (overview.allTime.heatPumps): the heat pump colour order. */
  heatPumpUnits: readonly { id: string; name: string }[]
}) {
  // From the data: the year's units, memoised with the months so the chart's geometry survives re-renders.
  const units = useMemo(() => chartUnits(months), [months])
  const keys = useMemo(() => metricSeries(metric, units), [metric, units])
  // Memoised, like the rows (and with the module-level accessors), so the
  // chart's geometry survives page re-renders (polls, selection).
  const series = useMemo<BarSeries[]>(() => {
    // The stack's top is rounded; on Nät that's the purchase's top (export hangs below).
    const top = keys[keys.length - (metric === 'grid' ? 2 : 1)]
    return keys.map((key) => {
      const style = seriesStyle(key, units, heatPumpUnits)
      return {
        key,
        label: style.label,
        color: style.color,
        stack: 'kwh',
        ...(key === top || isBelowAxis(metric, key) ? { radius: 2, roundEndOnly: true } : {}),
        // A 2 px surface gap between stacked segments.
        stroke: 'var(--card)',
        strokeWidth: 2,
      }
    })
  }, [keys, metric, units, heatPumpUnits])
  const rows = useMemo(() => chartRows(metric, months), [metric, months])
  if (months.every((p) => p === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.energy_chart_no_data({ year: String(year) })}
        </div>
        {/* The hint's line, reserved: the card is as tall as with data (the
            legend sits inside CHART_HEIGHT). */}
        <p aria-hidden className="invisible mt-2 text-muted-foreground text-sm">
          {m.energy_chart_select_hint()}
        </p>
      </div>
    )
  }
  return (
    <div>
      <BarChart
        rows={rows}
        category={monthCategory}
        shortCategory={monthInitial}
        series={series}
        value={seriesValue}
        stackOffset={metric === 'grid' ? 'diverging' : 'none'}
        zeroLine={metric === 'grid'}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 border-border px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) =>
          r.sums ? (
            <EnergyTooltip
              row={r}
              sums={r.sums}
              metric={metric}
              currentMonth={currentMonth}
              units={units}
              heatPumpUnits={heatPumpUnits}
            />
          ) : null
        }
        label={m.energy_chart_title({ year: String(year) })}
        keyboardHint={m.energy_chart_keyboard_hint()}
        selection={{
          selected: selectedMonth === null ? null : selectedMonth - 1,
          onSelect: (i) => onSelectMonth(rows[i].month),
          canSelect: (r) => r.sums !== null,
        }}
      />
      <p className="mt-2 text-muted-foreground text-sm">{m.energy_chart_select_hint()}</p>
    </div>
  )
}

function EnergyTooltip({
  row,
  sums,
  metric,
  currentMonth,
  units,
  heatPumpUnits,
}: {
  row: ChartRow
  sums: PeriodSums
  metric: EnergyMetric
  currentMonth: number | null
  units: readonly { id: string; name: string }[]
  heatPumpUnits: readonly { id: string; name: string }[]
}) {
  const { parts, totalKwh } = energyTooltipRows(metric, sums)
  const figures = energyFigures(sums)
  const gap = gapHours(figures)
  const style = (key: SeriesKey) => seriesStyle(key, units, heatPumpUnits)
  // Nät's export is a separate flow: it follows the total instead of adding to it.
  const stacked = parts.filter((p) => !isBelowAxis(metric, p.key))
  const after = parts.filter((p) => isBelowAxis(metric, p.key))
  // Rows without a share keep the (empty) share column so the kWh figures line up.
  const rowFor = ({ key, kwh, share }: (typeof parts)[number]) => (
    <TooltipRow
      key={key}
      label={style(key).label}
      color={style(key).color}
      share={share === null ? '' : formatShare(share)}
    >
      {formatOneDecimal(kwh)} kWh
    </TooltipRow>
  )
  return (
    <>
      <div className="font-semibold text-sm">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {stacked.map(rowFor)}
      <TooltipRow label={TOTAL_LABEL[metric]()} strong share="">
        {formatOneDecimal(totalKwh)} kWh
      </TooltipRow>
      {after.map(rowFor)}
      {gap === null ? null : (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(gap) })}
        </span>
      )}
      {metric === 'load' && figures.heatPumpMissingHours >= 1 ? (
        <span className="text-muted-foreground">
          {m.energy_use_missing_hours({ hours: String(figures.heatPumpMissingHours) })}
        </span>
      ) : null}
    </>
  )
}
