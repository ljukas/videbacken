import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import { type SeriesPoint, timeDomain } from '~/lib/sensor/chartData'

export type ClimateChartDevice = {
  id: string
  displayName: string
  // Stable color assigned by the parent from the FULL device roster, so a device
  // keeps its color regardless of which siblings are toggled off.
  color: string
  hidden?: boolean
  // This device's own readings (ascending t) with outage break markers already
  // inserted by toDeviceSeries — `<id>: null` is a real gap, not structural noise.
  points: SeriesPoint[]
}

type Props = {
  devices: ClimateChartDevice[]
  unit: string // "°C" | "%"
  formatTick: (t: number) => string // range-aware x-axis time formatter
}

// A dot only for a reading with no connected neighbour (a lone reading, or a short
// resumption between two outages); otherwise the line already shows the point and
// dots would clutter a dense trace. Recharts clones this element per point,
// injecting cx/cy/payload; `color` is supplied per-<Line> so the dot matches.
function IsolatedDot(props: { cx?: number; cy?: number; color?: string; payload?: SeriesPoint }) {
  const { cx, cy, color, payload } = props
  if (!payload?.isolated || cx == null || cy == null) return null
  return <circle className="recharts-dot" cx={cx} cy={cy} r={3} fill={color} stroke={color} />
}

// Presentational multi-line chart (one colored line per device). Each line reads
// its own `data`, so nulls are only intentional outage breaks (connectNulls off).
// Data fetching + reshape live in the route. The section's visible <h2> names the
// chart, so no SVG <title> is set (it would render a second, overlapping tooltip).
export function ClimateChart({ devices, unit, formatTick }: Props) {
  const config: ChartConfig = Object.fromEntries(
    devices.map((d) => [d.id, { label: d.displayName, color: d.color }]),
  )
  // Explicit domain over ALL devices (incl. hidden) so toggling never rescales the
  // time axis — per-<Line> data otherwise derives the domain from visible lines.
  const domain: [number, number] | ['dataMin', 'dataMax'] = timeDomain(devices) ?? [
    'dataMin',
    'dataMax',
  ]
  return (
    // Height is inline (not a Tailwind class) so the chart has a measurable box
    // even before CSS loads / in the (Tailwind-less) browser-test env; width stays
    // responsive via the block-level container filling its parent.
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 260 }}>
      <LineChart margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={domain}
          tickFormatter={(t) => formatTick(Number(t))}
          tickMargin={8}
          minTickGap={32}
        />
        <YAxis width={44} unit={unit} tickMargin={4} domain={['auto', 'auto']} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => formatTick(Number(items?.[0]?.payload?.t))}
              // Custom row: device name on the left, value + unit on the right,
              // clearly spaced (the default cramps them and omits the unit).
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-6">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: item.color }}
                    />
                    {name}
                  </span>
                  <span className="font-medium font-mono text-foreground tabular-nums">
                    {typeof value === 'number' ? value.toFixed(1) : value}
                    <span className="ml-0.5 font-sans text-muted-foreground">{unit}</span>
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {devices.map((d) => (
          <Line
            key={d.id}
            data={d.points}
            dataKey={d.id}
            name={d.displayName}
            hide={d.hidden}
            type="monotone"
            stroke={`var(--color-${d.id})`}
            dot={<IsolatedDot color={`var(--color-${d.id})`} />}
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
