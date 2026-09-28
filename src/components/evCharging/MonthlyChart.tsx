import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { formatCount, formatOneDecimal, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['overview']['months'][number]

// kWh per calendar month of the selected year — always 12 bars (the service
// zero-fills). The section's visible <h2> names the chart.
export function MonthlyChart({ months }: { months: Month[] }) {
  const config: ChartConfig = { kwh: { label: 'kWh', color: 'var(--chart-1)' } }
  const data = months.map((mo) => ({ ...mo, label: monthLabel(mo.month) }))
  return (
    // Inline height (not a Tailwind class) so the chart has a measurable box
    // before CSS loads and in the Tailwind-less browser-test env (same as
    // ClimateChart); width stays responsive.
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
    </ChartContainer>
  )
}
