import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatSek, monthLabel } from './format'
import { ChartFrame } from './MonthlyChart'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Per month: what charging at once would have cost, what we paid and the
// cheapest schedule — side by side, over the month's comparable sessions only.
// A month with none gets no bars (its gap is the honest state, never 0 kr).
export function EconomyMonthlyChart({ months }: { months: Month[] }) {
  const config = {
    immediate: { label: m.charging_economy_series_immediate(), color: 'var(--chart-3)' },
    actual: { label: m.charging_economy_series_actual(), color: 'var(--chart-1)' },
    optimal: { label: m.charging_economy_series_optimal(), color: 'var(--chart-2)' },
  } satisfies ChartConfig
  if (!months.some((mo) => mo.included > 0)) return <NoData />
  const data = months.map((mo) => ({
    label: monthLabel(mo.month),
    // null (not 0): a month without comparable sessions has no bars, not 0 kr ones.
    immediate: mo.included > 0 ? mo.immediateSek : null,
    actual: mo.included > 0 ? mo.actualSek : null,
    optimal: mo.included > 0 ? mo.optimalSek : null,
  }))
  return (
    <ChartFrame config={config}>
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          width="auto"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tickFormatter={(v) => formatSek(Number(v))}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) =>
                `${config[name as keyof typeof config].label} ${formatSek(Number(value))}`
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar
          dataKey="immediate"
          fill="var(--color-immediate)"
          radius={3}
          isAnimationActive={false}
        />
        <Bar dataKey="actual" fill="var(--color-actual)" radius={3} isAnimationActive={false} />
        <Bar dataKey="optimal" fill="var(--color-optimal)" radius={3} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  )
}

/** The chart-sized "nothing to compare" state (shared with the spot chart). */
export function NoData() {
  return (
    <div
      className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
      style={{ height: 260 }}
    >
      {m.charging_economy_chart_no_data()}
    </div>
  )
}
