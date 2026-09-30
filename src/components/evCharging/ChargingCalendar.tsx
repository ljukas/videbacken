import { Group } from '@visx/group'
import { HeatmapRect } from '@visx/heatmap'
import { useParentSize } from '@visx/responsive'
import { max, range } from 'd3-array'
import { memo, useId, useMemo } from 'react'
import {
  type CalendarDay,
  type DayTotal,
  type MonthTotal,
  monthGrid,
} from '~/lib/evCharging/patterns'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { ChartPopover, useChartPopover } from './ChartPopover'
import { formatDay, formatWeekdayDay, monthName, weekdayLabel } from './format'
import { intensity, valueLabel } from './patternChart'

// Weekday-initials row height as a share of one cell, so the SVG aspect ratio is known up front.
const LABEL_ROWS = 0.75
const GAP = 2
type Cell = CalendarDay & { kwh: number; sessions: number; future: boolean; fill: string }

type Props = {
  year: number
  daily: DayTotal[]
  months: MonthTotal[]
  today: string
  onPickMonth: (month: number) => void
}

export function ChargingCalendar({ year, daily, months, today, onPickMonth }: Props) {
  const byDay = useMemo(() => new Map(daily.map((d) => [d.day, d])), [daily])
  const fill = useMemo(() => intensity(max(daily, (d) => d.kwh) ?? 0), [daily])
  const byMonth = useMemo(() => new Map(months.map((t) => [t.month, t])), [months])

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-4">
      {range(1, 13).map((month) => (
        <MonthCard
          key={month}
          year={year}
          month={month}
          total={byMonth.get(month)}
          byDay={byDay}
          fill={fill}
          today={today}
          onPickMonth={onPickMonth}
        />
      ))}
    </div>
  )
}

// Memoised: a metric toggle or timeline step re-renders the page, not 12 month SVGs.
const MonthCard = memo(MonthCardImpl)

function MonthCardImpl({
  year,
  month,
  total,
  byDay,
  fill,
  today,
  onPickMonth,
}: {
  year: number
  month: number
  total: MonthTotal | undefined
  byDay: Map<string, DayTotal>
  fill: (value: number) => string
  today: string
  onPickMonth: (month: number) => void
}) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const popover = useChartPopover<Cell>()
  const { markProps, containerProps } = popover
  const hatchId = useId()

  const { weeks, columns } = useMemo(() => {
    const cells = monthGrid(year, month).map((d): Cell => {
      const t = byDay.get(d.day)
      const kwh = t?.kwh ?? 0
      return { ...d, kwh, sessions: t?.sessions ?? 0, future: d.day > today, fill: fill(kwh) }
    })
    const weekCount = (cells.at(-1)?.week ?? 0) + 1
    // HeatmapRect: each datum is a column (weekday); its bins are the week rows.
    const cols = range(7).map((weekday) => cells.filter((c) => c.weekday === weekday))
    return { weeks: weekCount, columns: cols }
  }, [year, month, byDay, fill, today])

  const listed = useMemo(
    () =>
      columns
        .flat()
        .filter((c) => c.kwh > 0)
        .sort((a, b) => a.day.localeCompare(b.day)),
    [columns],
  )

  const svg = useMemo(() => {
    if (width <= 0) return null
    const step = width / 7
    const labelH = step * LABEL_ROWS
    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the sr-only table carries the numbers
      <svg width={width} height={labelH + step * weeks} aria-hidden>
        <defs>
          <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse">
            <path
              d="M0 6 L6 0"
              style={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.35, strokeWidth: 1 }}
            />
          </pattern>
        </defs>
        {range(7).map((i) => (
          <text
            key={i}
            x={i * step + step / 2}
            y={labelH - 3}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {weekdayLabel(i, 'short').charAt(0).toUpperCase()}
          </text>
        ))}
        <Group top={labelH}>
          <HeatmapRect<Cell[], Cell>
            data={columns}
            bins={(col) => col}
            count={(c) => c.kwh}
            xScale={(i) => i * step}
            yScale={(i) => i * step}
            binWidth={step}
            binHeight={step}
            gap={GAP}
          >
            {(heatmap) =>
              heatmap
                .flat()
                // HeatmapRect only supplies the bins: each day is placed from its own
                // weekday/week (a month's first/last rows are ragged), so its x/y/width
                // props are unused. A weekday with no day in a week row has no bin.
                .map((b) => {
                  const d = b.bin
                  const x = d.weekday * step + GAP / 2
                  const y = d.week * step + GAP / 2
                  const size = Math.max(0, step - GAP)
                  return (
                    <rect
                      key={d.day}
                      data-day={d.day}
                      data-future={d.future ? '' : undefined}
                      x={x}
                      y={y}
                      width={size}
                      height={size}
                      rx={2}
                      style={
                        d.future
                          ? { fill: `url(#${hatchId})`, stroke: 'var(--border)', strokeWidth: 1 }
                          : d.kwh > 0
                            ? { fill: d.fill }
                            : { fill: d.fill, stroke: 'var(--border)', strokeWidth: 1 }
                      }
                      {...(d.future ? {} : markProps(d, x + size / 2, labelH + y))}
                    />
                  )
                })
            }
          </HeatmapRect>
        </Group>
      </svg>
    )
  }, [width, weeks, columns, hatchId, markProps])

  const active = popover.data ? columns.flat().find((c) => c.day === popover.data?.day) : undefined
  const name = monthName(month)

  return (
    <div className="min-w-0 rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => onPickMonth(month)}
          aria-label={m.charging_patterns_calendar_pick({ month: name })}
          className="-mx-1 min-h-6 rounded-sm px-1 font-medium text-sm capitalize outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </button>
        {total && total.kwh > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {valueLabel(total.kwh, 'kwh')}
          </span>
        ) : null}
      </div>
      <div ref={parentRef} className="w-full" style={{ aspectRatio: `7 / ${weeks + LABEL_ROWS}` }}>
        <div {...containerProps} className="relative">
          {svg}
          <ChartPopover
            state={popover}
            dataKey={active ? `${active.day}-${active.kwh}-${active.sessions}` : undefined}
          >
            {active
              ? `${formatWeekdayDay(stockholmDayBounds(active.day).startMs)} · ${valueLabel(active.kwh, 'kwh')} · ${m.charging_patterns_day_sessions({ count: active.sessions })}`
              : null}
          </ChartPopover>
        </div>
      </div>
      {listed.length > 0 ? (
        <table className="sr-only">
          <caption>{m.charging_patterns_calendar_caption({ month: name, year })}</caption>
          <tbody>
            {listed.map((c) => (
              <tr key={c.day}>
                <th scope="row">{formatDay(c.day)}</th>
                <td>{valueLabel(c.kwh, 'kwh')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
