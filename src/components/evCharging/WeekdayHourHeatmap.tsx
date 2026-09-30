import { Group } from '@visx/group'
import { HeatmapRect } from '@visx/heatmap'
import { useParentSize } from '@visx/responsive'
import { range, transpose } from 'd3-array'
import { scaleBand } from 'd3-scale'
import { useMemo } from 'react'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { ChartPopover, useChartPopover } from './ChartPopover'
import { hourRangeLabel, weekdayLabel } from './format'
import { heatmapIntensity, type PatternMetric, slotValue, valueLabel } from './patternChart'

const NARROW_PX = 640
const LABEL_W = 34
const LABEL_H = 16
type Cell = { weekday: number; hour: number; value: number; fill: string }

export function WeekdayHourHeatmap({ grid, metric }: { grid: Slot[][]; metric: PatternMetric }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const popover = useChartPopover<Cell>()
  const { markProps, containerProps } = popover

  // Fills are computed once per grid/metric, not per cell per hover.
  const cells = useMemo(() => {
    const { fill } = heatmapIntensity(grid, metric)
    return grid.map((row, weekday) =>
      row.map((slot, hour): Cell => {
        const value = slotValue(slot, metric)
        return { weekday, hour, value, fill: fill(value) }
      }),
    )
  }, [grid, metric])

  const narrow = width > 0 && width < NARROW_PX

  // The SVG depends only on layout + data, so hovering (popover state) doesn't redraw 168 cells.
  const svg = useMemo(() => {
    if (width <= 0) return null
    // HeatmapRect: each datum is a column, its bins the rows.
    const columns: Cell[][] = narrow ? cells : transpose(cells)
    const nCols = narrow ? 7 : 24
    const nRows = narrow ? 24 : 7
    const plotW = Math.max(0, width - LABEL_W)
    const step = plotW / nCols
    const rowStep = narrow ? Math.min(Math.max(step / 2.2, 18), 24) : step
    const x = scaleBand<number>().domain(range(nCols)).range([0, plotW])
    const y = scaleBand<number>()
      .domain(range(nRows))
      .range([0, rowStep * nRows])
    const colLabel = (i: number) =>
      narrow ? weekdayLabel(i) : i % 3 === 0 ? String(i).padStart(2, '0') : ''
    const rowLabel = (i: number) => (narrow ? String(i).padStart(2, '0') : weekdayLabel(i))

    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the sr-only table carries the numbers
      <svg
        width={width}
        height={LABEL_H + rowStep * nRows}
        aria-hidden
        data-orientation={narrow ? 'weekdays-across' : 'hours-across'}
      >
        <Group left={LABEL_W}>
          {range(nCols).map((i) => (
            <text
              key={i}
              x={(x(i) ?? 0) + step / 2}
              y={11}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {colLabel(i)}
            </text>
          ))}
        </Group>
        <Group top={LABEL_H}>
          {range(nRows).map((i) => (
            <text
              key={i}
              x={0}
              y={(y(i) ?? 0) + rowStep / 2}
              dominantBaseline="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {rowLabel(i)}
            </text>
          ))}
        </Group>
        <Group left={LABEL_W} top={LABEL_H}>
          <HeatmapRect<Cell[], Cell>
            data={columns}
            bins={(col) => col}
            count={(c) => c.value}
            xScale={(i) => x(i) ?? 0}
            yScale={(i) => y(i) ?? 0}
            binWidth={step}
            binHeight={rowStep}
            gap={2}
          >
            {(heatmap) =>
              heatmap
                .flat()
                .map((b) => (
                  <rect
                    key={`${b.bin.weekday}-${b.bin.hour}`}
                    data-cell={`${b.bin.weekday}-${b.bin.hour}`}
                    x={b.x}
                    y={b.y}
                    width={b.width}
                    height={b.height}
                    rx={3}
                    style={
                      b.bin.value > 0
                        ? { fill: b.bin.fill }
                        : { fill: b.bin.fill, stroke: 'var(--border)', strokeWidth: 1 }
                    }
                    {...markProps(b.bin, LABEL_W + b.x + b.width / 2, LABEL_H + b.y)}
                  />
                ))
            }
          </HeatmapRect>
        </Group>
      </svg>
    )
  }, [width, narrow, cells, markProps])

  const table = useMemo(
    () => (
      <table className="sr-only">
        <caption>{m.charging_patterns_heatmap_caption()}</caption>
        <thead>
          <tr>
            <td />
            {range(24).map((h) => (
              <th key={h} scope="col">
                {hourRangeLabel(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((row) => (
            <tr key={row[0]?.weekday}>
              <th scope="row">{weekdayLabel(row[0]?.weekday ?? 0, 'long')}</th>
              {row.map((c) => (
                <td key={c.hour}>{valueLabel(c.value, metric)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [cells, metric],
  )

  const active = popover.data ? cells[popover.data.weekday]?.[popover.data.hour] : undefined

  return (
    <div {...containerProps} className="relative w-full">
      <div ref={parentRef} className="min-h-44 w-full">
        {svg}
      </div>
      <ChartPopover
        state={popover}
        dataKey={active ? `${active.weekday}-${active.hour}-${active.value}` : undefined}
      >
        {active
          ? `${weekdayLabel(active.weekday)} ${hourRangeLabel(active.hour)} · ${valueLabel(active.value, metric)}`
          : null}
      </ChartPopover>
      {table}
    </div>
  )
}
