import { useParentSize } from '@visx/responsive'
import { range } from 'd3-array'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { formatCount, hourRangeLabel } from './format'
import { type PatternMetric, slotValue } from './patternChart'
import { valueLabel } from './WeekdayHourHeatmap'

const NARROW_PX = 480
const config = { value: { label: 'kWh', color: 'var(--brand)' } } satisfies ChartConfig

// Charging per hour of day — always 24 bars. A tick every 3 h on desktop and
// every 6 h on a phone (24 two-digit labels don't fit 320 px). Recharts' own
// tooltip (hover/tap) names the hour; the SVG is visual, so the same numbers
// are also in an sr-only table, like the heatmap.
export function HourOfDayChart({ hours, metric }: { hours: Slot[]; metric: PatternMetric }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const narrow = width > 0 && width < NARROW_PX
  const data = hours.map((slot, hour) => ({
    hour,
    label: String(hour).padStart(2, '0'),
    value: slotValue(slot, metric),
  }))

  return (
    <div ref={parentRef} className="w-full">
      {/* Inline height (not a Tailwind class) as in MonthlyChart's ChartFrame. */}
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 220 }}>
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} tickMargin={8} interval={narrow ? 5 : 2} />
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
                hideLabel
                formatter={(value, _name, item) => (
                  <span className="font-medium font-mono text-foreground tabular-nums">
                    {hourRangeLabel(item.payload.hour)} · {valueLabel(Number(value), metric)}
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={4} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>{m.charging_patterns_hour_caption()}</caption>
        <tbody>
          {range(24).map((h) => (
            <tr key={h}>
              <th scope="row">{hourRangeLabel(h)}</th>
              <td>{valueLabel(data[h]?.value ?? 0, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
