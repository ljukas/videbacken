import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import { type ChartRow, colorForIndex } from '~/lib/sensor/chartData'

export type ClimateChartDevice = { id: string; displayName: string }

type Props = {
  rows: ChartRow[]
  devices: ClimateChartDevice[] // visible devices, in stable order
  unit: string // "°C" | "%"
  formatTick: (t: number) => string // range-aware x-axis time formatter
}

// Presentational multi-line chart (one colored line per device). Data fetching
// lives in the route; this component only renders whatever rows it is handed.
export function ClimateChart({ rows, devices, unit, formatTick }: Props) {
  const config: ChartConfig = Object.fromEntries(
    devices.map((d, i) => [d.id, { label: d.displayName, color: colorForIndex(i) }]),
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
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => formatTick(Number(items?.[0]?.payload?.t))}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {devices.map((d) => (
          <Line
            key={d.id}
            dataKey={d.id}
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
