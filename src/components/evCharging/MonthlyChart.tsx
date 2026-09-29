import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal, formatSek, formatShare, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['overview']['months'][number]
type CostMonth = RouterOutputs['evCharging']['costOverview']['months'][number]
export type ChartMetric = 'kwh' | 'sek'

/** The kWh ↔ kr switch; the page puts it beside the year picker. */
export function ChartMetricToggle({
  value,
  onChange,
}: {
  value: ChartMetric
  onChange: (metric: ChartMetric) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix fires '' when the active item is re-pressed; keep one selected.
      onValueChange={(v) => {
        if (v) onChange(v as ChartMetric)
      }}
      variant="outline"
      size="sm"
      aria-label={m.charging_chart_metric_label()}
    >
      <ToggleGroupItem value="kwh">{m.charging_chart_metric_kwh()}</ToggleGroupItem>
      <ToggleGroupItem value="sek" aria-label={m.charging_chart_metric_sek_label()}>
        {m.charging_chart_metric_sek()}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

// kWh (or cost) per calendar month of the selected year — always 12 bars (the
// services zero-fill). The kr view is drawn from the cost data alone (its own
// 12 months), so it never pairs one year's kWh with another year's kronor. It
// stacks the spot price under markup + grid + tax, both incl VAT, with a
// legend (touch can't hover) and the month's total in the tooltip. A month
// whose energy has no price at all gets a muted stub labelled "Pris saknas" —
// never an empty bar that reads as 0 kr; a partly priced one says so. The page
// owns the metric (its <h2> names the chart and follows it); without cost
// data it's always kWh.
export function MonthlyChart({
  months,
  cost,
  metric = 'kwh',
}: {
  months: Month[]
  /** The cost months and their year (which may lag `months` while a year loads). */
  cost?: { year: number; months: CostMonth[] }
  metric?: ChartMetric
}) {
  const showing: ChartMetric = cost ? metric : 'kwh'
  return showing === 'sek' && cost ? (
    <CostChart months={cost.months} year={cost.year} />
  ) : (
    <EnergyChart months={months} />
  )
}

const kwhConfig = { kwh: { label: 'kWh', color: 'var(--chart-1)' } } satisfies ChartConfig

function EnergyChart({ months }: { months: Month[] }) {
  const data = months.map((mo) => ({ label: monthLabel(mo.month), kwh: mo.kwh }))
  return (
    <ChartFrame config={kwhConfig}>
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <CountAxis />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value) => (
                <span className="font-medium font-mono text-foreground tabular-nums">
                  {formatOneDecimal(Number(value))} kWh
                </span>
              )}
            />
          }
        />
        <Bar dataKey="kwh" fill="var(--color-kwh)" radius={4} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  )
}

const SERIES_ORDER = ['spot', 'fees', 'unpriced']

/** Series in stack order — for the legend and the tooltip (Recharts sorts by name by default). */
const seriesOrder = (item: { dataKey?: unknown }) => SERIES_ORDER.indexOf(String(item.dataKey))

function CostChart({ months, year }: { months: CostMonth[]; year: number }) {
  // Spot and fees in the two chart tokens that keep ≥3:1 against the page in
  // both themes; the unpriced stub is deliberately quiet (the same mixed
  // colour in the bar and its legend swatch).
  const config = {
    spot: { label: m.charging_chart_series_spot(), color: 'var(--chart-2)' },
    fees: { label: m.charging_chart_series_fees(), color: 'var(--chart-3)' },
    unpriced: {
      label: m.charging_chart_no_price(),
      color: 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)',
    },
  } satisfies ChartConfig
  const unpriced = (c: CostMonth) => c.kwh > 0 && c.fullKwh === 0
  // A year with nothing priced has no kronor scale to draw stubs against —
  // they'd be invisible under a 0–4 kr axis and read as 0 kr. Say so instead.
  if (!months.some((c) => c.fullKwh > 0)) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm">
        {m.charging_chart_cost_empty({ year })}
      </div>
    )
  }
  // The stub is a sliver of the axis span (negative spot prices can push a
  // month below 0), just enough to be seen.
  const stub = Math.max(...months.map((c) => Math.abs(c.totalSek))) * 0.03
  const data = months.map((c) => {
    const missingKwh = c.noPriceKwh + c.noTariffKwh
    return {
      label: monthLabel(c.month),
      // null (not 0) so the tooltip skips a series the month doesn't have.
      spot: unpriced(c) ? null : c.spotSek,
      fees: unpriced(c) ? null : c.feesSek,
      unpriced: unpriced(c) ? stub : null,
      totalSek: c.totalSek,
      // Partly priced, as the tiles say it: "minst …" plus the missing share.
      missingShare: c.fullKwh > 0 && !c.complete && missingKwh > 0 ? missingKwh / c.gridKwh : null,
    }
  })
  const hasUnpriced = months.some(unpriced)
  // Segments are separated by a hairline in the page colour, so the split
  // doesn't rely on the two hues alone.
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }

  return (
    <ChartFrame config={config}>
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <CountAxis />
        <ChartTooltip
          cursor={false}
          itemSorter={seriesOrder}
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => {
                if (name === 'unpriced') {
                  return <TooltipRow label={config.unpriced.label} color={config.unpriced.color} />
                }
                const series = config[name as 'spot' | 'fees']
                const { totalSek, missingShare } = item.payload
                const total = formatSek(totalSek)
                return (
                  <div className="flex w-full flex-col gap-0.5">
                    <TooltipRow label={series.label} color={series.color}>
                      {formatSek(Number(value))}
                    </TooltipRow>
                    {name === 'fees' ? (
                      <>
                        <TooltipRow label={m.charging_chart_total()} strong>
                          {missingShare === null ? total : m.charging_cost_min({ total })}
                        </TooltipRow>
                        {missingShare === null ? null : (
                          <span className="text-muted-foreground text-xs">
                            {m.charging_cost_partial_hint({ share: formatShare(missingShare) })}
                          </span>
                        )}
                      </>
                    ) : null}
                  </div>
                )
              }}
            />
          }
        />
        {/* Lists the rendered series, so "Pris saknas" appears only with a stub. */}
        <ChartLegend
          itemSorter={seriesOrder}
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />}
        />
        <Bar
          dataKey="spot"
          stackId="sek"
          fill="var(--color-spot)"
          {...seam}
          isAnimationActive={false}
        />
        <Bar
          dataKey="fees"
          stackId="sek"
          fill="var(--color-fees)"
          radius={[4, 4, 0, 0]}
          {...seam}
          isAnimationActive={false}
        />
        {hasUnpriced ? (
          <Bar
            dataKey="unpriced"
            stackId="sek"
            fill="var(--color-unpriced)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        ) : null}
      </BarChart>
    </ChartFrame>
  )
}

// A custom formatter replaces the tooltip's own colour dots, so each series
// row draws its dot here (a total row has none).
function TooltipRow({
  label,
  color,
  strong = false,
  children,
}: {
  label: string
  color?: string
  strong?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: color }}
          />
        ) : null}
        {label}
      </span>
      <span
        className={`font-mono text-foreground tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}
      >
        {children}
      </span>
    </div>
  )
}

function CountAxis() {
  return (
    <YAxis
      width="auto"
      tickLine={false}
      tickMargin={4}
      allowDecimals={false}
      tickFormatter={(v) => formatCount(Number(v))}
    />
  )
}

function ChartFrame({ config, children }: { config: ChartConfig; children: React.ReactElement }) {
  // Inline height (not a Tailwind class) so the chart has a measurable box
  // before CSS loads and in the Tailwind-less browser-test env (same as
  // ClimateChart); width stays responsive.
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 260 }}>
      {children}
    </ChartContainer>
  )
}
