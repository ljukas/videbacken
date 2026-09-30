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
import { ChartFrame, NoData, TooltipRow } from './ChartFrame'
import { formatOre, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Series colours keep >=3:1 against the card in both themes (contrast light /
// dark): paid --chart-2 3.7 / 7.0; month average --foreground 19.8 / 15.9,
// dashed so it reads as a reference line rather than a second bar series.
const SERIES_ORDER = ['paid', 'avg']
const seriesOrder = (item: { dataKey?: unknown }) => SERIES_ORDER.indexOf(String(item.dataKey))

// Spot we paid (energy-weighted, comparable sessions) vs the month's
// time-weighted average spot, both öre/kWh incl VAT. A bar below the line
// means we charged in cheaper-than-average hours.
export function SpotComparisonChart({ months }: { months: Month[] }) {
  const config = {
    paid: { label: m.charging_economy_series_paid(), color: 'var(--chart-2)' },
    avg: { label: m.charging_economy_series_avg(), color: 'var(--foreground)' },
  } satisfies ChartConfig
  if (!months.some((mo) => mo.paidSpotOre !== null || mo.avgSpotOre !== null)) return <NoData />
  const hasPaid = months.some((mo) => mo.paidSpotOre !== null)
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
          itemSorter={seriesOrder}
          content={
            <ChartTooltipContent
              formatter={(value, name) => {
                const series = config[name as keyof typeof config]
                return (
                  <TooltipRow label={series.label} color={series.color}>
                    {m.charging_economy_ore({ value: formatOre(Number(value)) })}
                  </TooltipRow>
                )
              }}
            />
          }
        />
        <ChartLegend
          itemSorter={seriesOrder}
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />}
        />
        {/* Only with a paid price somewhere, so the legend never names a bar-less series. */}
        {hasPaid ? (
          <Bar dataKey="paid" fill="var(--color-paid)" radius={3} isAnimationActive={false} />
        ) : null}
        <Line
          dataKey="avg"
          type="linear"
          stroke="var(--color-avg)"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 3 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartFrame>
  )
}
