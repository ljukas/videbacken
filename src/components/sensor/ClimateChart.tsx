import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from '~/components/ui/chart'
import {
  nearestReadings,
  niceYScale,
  type SeriesPoint,
  timeDomain,
  valueRange,
} from '~/lib/sensor/chartData'
import { CADENCE_SEC } from '~/lib/sensor/range'

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

// Nearest-neighbour tooltip: one row per visible device, each snapped to its
// reading closest to the hovered time (see nearestReadings). It replaces
// Recharts' default axis tooltip, which — because each line has its own
// unaligned timestamps on the 24h range (10-min bucket ≪ ~2h cadence) — lists
// only the single line that owns the hovered x tick, so a hover shows just one
// sensor. `hoverT` is the snapped tick's real reading time. Each row shows its
// own reading time only when it differs from `hoverT` (the header), so the
// small per-line time offset stays visible without repeating the anchor.
function ClimateTooltipContent({
  active,
  hoverT,
  devices,
  unit,
  formatTick,
}: {
  active: boolean
  hoverT: number
  devices: ClimateChartDevice[]
  unit: string
  formatTick: (t: number) => string
}) {
  if (!active || !Number.isFinite(hoverT)) return null
  const rows = nearestReadings(devices, hoverT, CADENCE_SEC * 1000)
  if (rows.length === 0) return null
  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatTick(hoverT)}</div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex w-full items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="inline-block size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
              {row.displayName}
            </span>
            <span className="flex items-baseline gap-2">
              {row.t !== hoverT ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatTick(row.t)}
                </span>
              ) : null}
              <span className="font-medium font-mono text-foreground tabular-nums">
                {row.value.toFixed(1)}
                <span className="ml-0.5 font-sans text-muted-foreground">{unit}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
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
  // Nice, round y-axis ticks. Recharts equal-divides a narrow auto-domain into
  // arbitrary fractional ticks (24.595, 24.49, …) that overflow the axis; a
  // computed nice scale keeps labels short, round, and consistent with the
  // tooltip. Falls back to Recharts' auto scale when nothing is visible.
  const range = valueRange(devices)
  const y = range ? niceYScale(range[0], range[1]) : undefined
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
        <YAxis
          // width="auto" sizes the axis to its labels (Recharts 3), so a negative
          // temperature or a wider tick never spills past the chart's left edge.
          width="auto"
          unit={unit}
          tickMargin={4}
          domain={y?.domain ?? ['auto', 'auto']}
          ticks={y?.ticks}
          tickFormatter={y ? (value) => Number(value).toFixed(y.decimals) : undefined}
        />
        <ChartTooltip
          content={(props) => {
            // Prefer the snapped tick's own reading time; fall back to the axis
            // label. Both resolve to the hovered moment for a numeric x-axis.
            const first = props.payload?.[0]?.payload as SeriesPoint | undefined
            const hoverT = Number(first?.t ?? props.label)
            return (
              <ClimateTooltipContent
                active={props.active ?? false}
                hoverT={hoverT}
                devices={devices}
                unit={unit}
                formatTick={formatTick}
              />
            )
          }}
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
