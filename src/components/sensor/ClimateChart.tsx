import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { ChartRow } from '~/lib/sensor/chartData'

export type ClimateChartDevice = {
  id: string
  displayName: string
  // Stable color assigned by the parent from the FULL device roster, so a
  // device keeps its color regardless of which siblings are toggled off.
  color: string
  hidden?: boolean
}

type Props = {
  rows: ChartRow[]
  // The full roster in stable order — hidden devices stay in the list (their
  // line is `hide`-d) so colors never shift when toggling visibility.
  devices: ClimateChartDevice[]
  unit: string // "°C" | "%"
  formatTick: (t: number) => string // range-aware x-axis time formatter
}

// Presentational multi-line chart (one colored line per device). Data fetching
// lives in the route; this component only renders whatever rows it is handed.
// The section's visible <h2> names the chart, so no SVG <title> is set (it would
// render a second, overlapping native tooltip on hover).
export function ClimateChart({ rows, devices, unit, formatTick }: Props) {
  const config: ChartConfig = Object.fromEntries(
    devices.map((d) => [d.id, { label: d.displayName, color: d.color }]),
  )
  return (
    // Height is inline (not a Tailwind class) so the chart has a measurable box
    // even before CSS loads / in the (Tailwind-less) browser-test env; width
    // stays responsive via the block-level container filling its parent.
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: 260 }}>
      <LineChart data={rows} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t) => formatTick(Number(t))}
          tickMargin={8}
          minTickGap={32}
        />
        <YAxis width={44} unit={unit} tickMargin={4} domain={['auto', 'auto']} />
        <ChartTooltip
          // No position transition — otherwise the box slides in from the
          // chart's top-left corner on first hover instead of appearing at the
          // point (Recharts animates the tooltip transform by default).
          isAnimationActive={false}
          content={
            <ChartTooltipContent
              // Entrance animation that plays AT the point (fade + slight zoom),
              // rather than the transform-slide from the corner that Recharts'
              // own tooltip animation produces.
              className="fade-in-0 zoom-in-95 animate-in duration-150"
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
            dataKey={d.id}
            name={d.displayName}
            hide={d.hidden}
            type="monotone"
            stroke={`var(--color-${d.id})`}
            dot={false}
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
