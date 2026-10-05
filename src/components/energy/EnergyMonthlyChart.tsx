import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'
import { CHART_HEIGHT, ChartFrame, TooltipRow } from '~/components/evCharging/ChartFrame'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from '~/components/ui/chart'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import {
  type ChartRow,
  chartRows,
  type EnergyMetric,
  energyTooltipRows,
  isBelowAxis,
  METRIC_SERIES,
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

function seriesConfig(): Record<SeriesKey, { label: string; color: string }> {
  return {
    solarDirect: { label: m.energy_series_solar_direct(), color: 'var(--energy-solar)' },
    solarBattery: { label: m.energy_series_solar_battery(), color: 'var(--energy-battery)' },
    solarExported: { label: m.energy_series_solar_exported(), color: 'var(--energy-export)' },
    importDirect: { label: m.energy_series_import_direct(), color: 'var(--energy-grid)' },
    importBattery: { label: m.energy_series_import_battery(), color: 'var(--energy-battery)' },
    exported: { label: m.energy_series_export(), color: 'var(--energy-export)' },
    car: { label: m.energy_series_car(), color: 'var(--brand)' },
    house: { label: m.energy_series_house(), color: 'var(--chart-2)' },
  }
}

const TOTAL_LABEL: Record<EnergyMetric, () => string> = {
  solar: m.energy_chart_total_solar,
  grid: m.energy_chart_total_grid,
  load: m.energy_chart_total_load,
}

type Row = ChartRow & { label: string }

// The house's energy per month of `year` for one metric: stacked bars, export
// below the axis on Nät, a legend (touch can't hover), and a tooltip with the
// month's parts, its total, self-sufficiency and any gap. Months without data
// draw no bar (never a zero bar). The page owns the metric and the year.
export function EnergyMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  metric: EnergyMetric
  /** The current Stockholm month when `year` is the current year (its tooltip says "hittills"), else null. */
  currentMonth: number | null
}) {
  if (months.every((p) => p === null)) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
        style={{ height: CHART_HEIGHT }}
      >
        {m.energy_chart_no_data({ year: String(year) })}
      </div>
    )
  }
  const series = METRIC_SERIES[metric]
  const all = seriesConfig()
  const config = Object.fromEntries(series.map((k) => [k, all[k]])) satisfies ChartConfig
  const data: Row[] = chartRows(metric, months).map((r) => ({ ...r, label: monthLabel(r.month) }))
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }
  const top = series[series.length - (metric === 'grid' ? 2 : 1)]

  return (
    <ChartFrame config={config}>
      <BarChart
        data={data}
        stackOffset={metric === 'grid' ? 'sign' : 'none'}
        margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          width="auto"
          tickLine={false}
          tickMargin={4}
          allowDecimals={false}
          tickFormatter={(v) => formatCount(Number(v))}
        />
        {metric === 'grid' ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => (
            <EnergyTooltip
              active={active}
              row={payload?.[0]?.payload as Row | undefined}
              metric={metric}
              currentMonth={currentMonth}
            />
          )}
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        {series.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="kwh"
            fill={`var(--color-${key})`}
            radius={isBelowAxis(metric, key) ? [0, 0, 4, 4] : key === top ? [4, 4, 0, 0] : 0}
            {...seam}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartFrame>
  )
}

function EnergyTooltip({
  active,
  row,
  metric,
  currentMonth,
}: {
  active?: boolean
  row: Row | undefined
  metric: EnergyMetric
  currentMonth: number | null
}) {
  if (!active || !row?.sums) return null
  const { parts, totalKwh } = energyTooltipRows(metric, row.sums)
  const f = energyFigures(row.sums)
  const gap = gapHours(f)
  const config = seriesConfig()
  // Nät's export is a separate flow: it follows the total instead of adding to it.
  const stacked = parts.filter((p) => !isBelowAxis(metric, p.key))
  const after = parts.filter((p) => isBelowAxis(metric, p.key))
  const rowFor = ({ key, kwh }: (typeof parts)[number]) => (
    <TooltipRow key={key} label={config[key].label} color={config[key].color}>
      {formatOneDecimal(kwh)} kWh
    </TooltipRow>
  )
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {stacked.map(rowFor)}
      <TooltipRow label={TOTAL_LABEL[metric]()} strong>
        {formatOneDecimal(totalKwh)} kWh
      </TooltipRow>
      {after.map(rowFor)}
      {f.selfSufficiency === null ? null : (
        <TooltipRow label={m.energy_tile_self_sufficiency()}>
          {formatShare(f.selfSufficiency)}
        </TooltipRow>
      )}
      {gap === null ? null : (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(gap) })}
        </span>
      )}
    </div>
  )
}
