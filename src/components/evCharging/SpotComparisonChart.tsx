import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { NoData } from './EconomyMonthlyChart'
import { formatOre, monthLabel } from './format'
import { ChartFrame } from './MonthlyChart'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Spot we paid (energy-weighted, comparable sessions) vs the month's
// time-weighted average spot, both öre/kWh incl VAT. A bar below the line
// means we charged in cheaper-than-average hours.
export function SpotComparisonChart({ months }: { months: Month[] }) {
  const config = {
    paid: { label: m.charging_economy_series_paid(), color: 'var(--chart-1)' },
    avg: { label: m.charging_economy_series_avg(), color: 'var(--chart-4)' },
  } satisfies ChartConfig
  if (!months.some((mo) => mo.paidSpotOre !== null || mo.avgSpotOre !== null)) return <NoData />
  const data = months.map((mo) => ({
    label: monthLabel(mo.month),
    paid: mo.paidSpotOre,
    avg: mo.avgSpotOre,
  }))
  return (
    <ChartFrame config={config}>
      <ComposedChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          width="auto"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tickFormatter={(v) => formatOre(Number(v))}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name) =>
                `${config[name as keyof typeof config].label} ${m.charging_economy_ore({ value: formatOre(Number(value)) })}`
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar dataKey="paid" fill="var(--color-paid)" radius={3} isAnimationActive={false} />
        <Line
          dataKey="avg"
          type="monotone"
          stroke="var(--color-avg)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartFrame>
  )
}
