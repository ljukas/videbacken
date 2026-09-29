import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal, formatSek, monthLabel } from './format'

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
      <ToggleGroupItem value="sek">{m.charging_chart_metric_sek()}</ToggleGroupItem>
    </ToggleGroup>
  )
}

// kWh (or cost) per calendar month of the selected year — always 12 bars (the
// services zero-fill). The kr view stacks the spot price under markup + grid +
// tax, both incl VAT, so the split is visible at a glance; a month missing
// some prices is flagged in its tooltip. The page owns the metric (its <h2>
// names the chart and follows it); without cost data it's always kWh.
export function MonthlyChart({
  months,
  costMonths,
  metric = 'kwh',
}: {
  months: Month[]
  costMonths?: CostMonth[]
  metric?: ChartMetric
}) {
  const showing: ChartMetric = costMonths ? metric : 'kwh'
  const costByMonth = new Map(costMonths?.map((c) => [c.month, c]))
  const data = months.map((mo) => {
    const cost = costByMonth.get(mo.month)
    return {
      label: monthLabel(mo.month),
      kwh: mo.kwh,
      spot: cost?.spotSek ?? 0,
      fees: cost?.feesSek ?? 0,
      partial: cost ? cost.kwh > 0 && !cost.complete : false,
    }
  })
  const config: ChartConfig =
    showing === 'kwh'
      ? { kwh: { label: 'kWh', color: 'var(--chart-1)' } }
      : {
          spot: { label: m.charging_chart_series_spot(), color: 'var(--chart-1)' },
          fees: { label: m.charging_chart_series_fees(), color: 'var(--chart-2)' },
        }
  const format = (v: number) => (showing === 'kwh' ? `${formatOneDecimal(v)} kWh` : formatSek(v))

  return (
    <div className="flex flex-col gap-2">
      {/* Inline height (not a Tailwind class) so the chart has a measurable box
          before CSS loads and in the Tailwind-less browser-test env (same as
          ClimateChart); width stays responsive. */}
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 260 }}>
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
          <YAxis
            width="auto"
            tickLine={false}
            tickMargin={4}
            allowDecimals={false}
            tickFormatter={(v) => formatCount(Number(v))}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(value, name, item) => (
                  <div className="flex w-full flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-3">
                      {showing === 'sek' ? (
                        <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                      ) : null}
                      <span className="font-medium font-mono text-foreground tabular-nums">
                        {format(Number(value))}
                      </span>
                    </div>
                    {showing === 'sek' && name === 'fees' && item.payload.partial ? (
                      <span className="text-muted-foreground text-xs">
                        {m.charging_chart_partial()}
                      </span>
                    ) : null}
                  </div>
                )}
              />
            }
          />
          {showing === 'kwh' ? (
            <Bar dataKey="kwh" fill="var(--color-kwh)" radius={4} isAnimationActive={false} />
          ) : (
            <>
              <Bar
                dataKey="spot"
                stackId="sek"
                fill="var(--color-spot)"
                isAnimationActive={false}
              />
              <Bar
                dataKey="fees"
                stackId="sek"
                fill="var(--color-fees)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </>
          )}
        </BarChart>
      </ChartContainer>
    </div>
  )
}
