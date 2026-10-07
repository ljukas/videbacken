import { useParentSize } from '@visx/responsive'
import { range } from 'd3-array'
import { useMemo } from 'react'
import { BarChart } from '~/components/chart/BarChart'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { formatCount, hourRangeLabel } from './format'
import { type PatternMetric, slotValue, valueLabel } from './patternChart'

const NARROW_PX = 480
type Row = { hour: number; label: string; value: number }
const series = [{ key: 'value', label: '', color: 'var(--brand)', radius: 4 }]

// Charging per hour of day — always 24 bars. A tick every 3 h on desktop and
// every 6 h on a phone (24 two-digit labels don't fit 320 px). The tooltip
// (hover/tap) names the hour; the SVG is visual, so the same numbers are also
// in an sr-only table, like the heatmap, and the chart takes no keyboard stop.
export function HourOfDayChart({ hours, metric }: { hours: Slot[]; metric: PatternMetric }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  // Unmeasured (0) counts as narrow so a phone never flashes the wide ticks.
  const narrow = width < NARROW_PX
  const data = useMemo(
    () =>
      hours.map(
        (slot, hour): Row => ({
          hour,
          label: String(hour).padStart(2, '0'),
          value: slotValue(slot, metric),
        }),
      ),
    [hours, metric],
  )
  const table = useMemo(
    () => (
      <div className="sr-only">
        <table>
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
    ),
    [data, metric],
  )

  return (
    <div ref={parentRef} className="w-full">
      <BarChart
        rows={data}
        category={(r) => r.label}
        series={series}
        value={(r) => r.value}
        yTickFormat={formatCount}
        yIntegers
        xTickEvery={narrow ? 6 : 3}
        height={220}
        tooltipTitle={false}
        tooltip={(r) => (
          <span className="font-medium font-mono text-foreground tabular-nums">
            {hourRangeLabel(r.hour)} · {valueLabel(r.value, metric)}
          </span>
        )}
      />
      {table}
    </div>
  )
}
