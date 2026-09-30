import { AxisTop } from '@visx/axis'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar } from '@visx/shape'
import { bisectLeft, bisectRight, range } from 'd3-array'
import { scaleLinear } from 'd3-scale'
import { CalendarXIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '~/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import type { TimelineSession } from '~/lib/evCharging/patterns'
import { stockholmNightInWindow, stockholmNoonOnOrBefore } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { formatOneDecimal, formatTime, formatWeekdayDay, monthName } from './format'
import { valueLabel } from './WeekdayHourHeatmap'

const NARROW_PX = 640
const LABEL_W = 200
const GAP = 12
const AXIS_H = 18
const ROW_H = 22
// Track + label + padding, for reserving height before the width is measured.
const ROW_BLOCK = 40
const HOUR_MS = 3_600_000
const IDLE_FILL = 'color-mix(in oklch, var(--brand) 25%, transparent)'
const IDLE_STROKE = 'color-mix(in oklch, var(--brand) 60%, transparent)'
const NIGHT_FILL = 'var(--muted-foreground)'
const NIGHT_OPACITY = 0.1
const MIN_CHARGING_PX = 2
const MARK_W = 6
// A foreground triangle with a card-coloured halo: readable over bar or background.
const MARK_STYLE = {
  fill: 'var(--foreground)',
  stroke: 'var(--card)',
  strokeWidth: 2,
  paintOrder: 'stroke',
} as const

type Row = {
  session: TimelineSession
  bars: { key: string; x: number; width: number; kind: 'charging' | 'idle' }[]
  night: { x: number; width: number }
  clippedLeft: boolean
  clippedRight: boolean
}

function buildRow(session: TimelineSession, trackW: number): Row {
  const { startMs, endMs } = stockholmNoonOnOrBefore(session.startAt.getTime())
  const x = scaleLinear().domain([startMs, endMs]).range([0, trackW]).clamp(true)
  const bars = session.segments.map((seg, i) => {
    const x0 = x(seg.startAt.getTime())
    const x1 = x(seg.endAt.getTime())
    const min = seg.kind === 'charging' ? MIN_CHARGING_PX : 0
    return { key: `${i}-${seg.kind}`, x: x0, width: Math.max(min, x1 - x0), kind: seg.kind }
  })
  const night = stockholmNightInWindow(startMs)
  const nx0 = x(night.startMs)
  const nx1 = x(night.endMs)
  return {
    session,
    bars,
    night: { x: nx0, width: Math.max(0, nx1 - nx0) },
    clippedLeft: session.startAt.getTime() < startMs,
    clippedRight: session.endAt.getTime() > endMs,
  }
}

function MonthStepper({
  year,
  month,
  months,
  onMonth,
}: {
  year: number
  month: number
  months: number[]
  onMonth: (month: number) => void
}) {
  // `months` ascends; `month` may not be in it (a ?month= without sessions).
  const prev = months[bisectLeft(months, month) - 1]
  const next = months[bisectRight(months, month)]
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={m.charging_patterns_timeline_prev()}
        disabled={prev === undefined}
        onClick={() => prev !== undefined && onMonth(prev)}
      >
        <ChevronLeft />
      </Button>
      <span aria-live="polite" className="min-w-32 text-center font-medium text-sm capitalize">
        {monthName(month)} {year}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={m.charging_patterns_timeline_next()}
        disabled={next === undefined}
        onClick={() => next !== undefined && onMonth(next)}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}

export function SessionTimeline({
  sessions,
  year,
  month,
  months,
  onMonth,
}: {
  sessions: TimelineSession[]
  year: number
  month: number
  months: number[]
  onMonth: (month: number) => void
}) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const narrow = width > 0 && width < NARROW_PX
  const trackW = Math.max(0, narrow ? width : width - LABEL_W - GAP)

  const rows = useMemo(
    () => (trackW > 0 ? sessions.map((s) => buildRow(s, trackW)) : []),
    [sessions, trackW],
  )

  const axisScale = useMemo(() => scaleLinear().domain([0, 1]).range([0, trackW]), [trackW])
  const ticks = useMemo(() => range(9).map((i) => i / 8), [])

  const axis =
    trackW > 0 ? (
      // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the row labels carry the information
      <svg width={trackW} height={AXIS_H} aria-hidden className="block overflow-visible">
        <AxisTop
          scale={axisScale}
          top={AXIS_H - 1}
          tickValues={ticks}
          tickFormat={(v) => String((12 + Number(v) * 24) % 24).padStart(2, '0')}
          hideAxisLine
          tickLength={4}
          stroke="var(--border)"
          tickStroke="var(--border)"
          tickLabelProps={(_v, i, all) => ({
            className: 'fill-muted-foreground text-[10px]',
            // End labels stay inside the track instead of overhanging it.
            textAnchor: i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle',
            dy: '-0.25em',
          })}
        />
      </svg>
    ) : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonthStepper year={year} month={month} months={months} onMonth={onMonth} />
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: 'var(--brand)' }} />
            {m.charging_patterns_timeline_charging()}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: IDLE_FILL, border: `1px solid ${IDLE_STROKE}` }}
            />
            {m.charging_patterns_timeline_idle()}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: NIGHT_FILL, opacity: NIGHT_OPACITY * 2 }}
            />
            {m.charging_patterns_timeline_night()}
          </span>
        </div>
      </div>

      {sessions.length === 0 ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarXIcon />
            </EmptyMedia>
            <EmptyTitle>
              {m.charging_patterns_timeline_empty({ month: monthName(month) })}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          ref={parentRef}
          className="w-full"
          style={{ minHeight: AXIS_H + sessions.length * ROW_BLOCK }}
        >
          {trackW > 0 && (
            <>
              <div
                className="flex"
                style={{ paddingLeft: narrow ? 0 : LABEL_W + GAP, height: AXIS_H }}
              >
                {axis}
              </div>
              {/* biome-ignore lint/a11y/noRedundantRoles: list-style none makes Safari drop the list semantics */}
              <ul role="list" className="flex flex-col">
                {rows.map((row) => (
                  <TimelineRow key={row.session.id} row={row} trackW={trackW} narrow={narrow} />
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground text-xs">
                {m.charging_patterns_timeline_clipped()}
                {' · '}
                {m.charging_patterns_timeline_estimate()}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TimelineRow({ row, trackW, narrow }: { row: Row; trackW: number; narrow: boolean }) {
  const { session } = row
  const pluggedHours = (session.endAt.getTime() - session.startAt.getTime()) / HOUR_MS
  return (
    <li
      className="flex border-border/50 border-t py-1"
      style={{
        flexDirection: narrow ? 'column' : 'row',
        alignItems: narrow ? 'stretch' : 'center',
        gap: narrow ? 2 : GAP,
      }}
    >
      <div className="text-xs" style={{ width: narrow ? undefined : LABEL_W, flexShrink: 0 }}>
        <div className="font-medium">
          {formatWeekdayDay(session.startAt)} · {formatTime(session.startAt)}–
          {formatTime(session.endAt)} · {valueLabel(session.energyKwh, 'kwh')}
        </div>
        <div className="text-muted-foreground">
          {session.hourly
            ? m.charging_patterns_timeline_summary({
                charging: formatOneDecimal(session.chargingHours),
                plugged: formatOneDecimal(pluggedHours),
              })
            : m.charging_patterns_timeline_no_hourly()}
          {row.clippedRight && ` · ${m.charging_patterns_timeline_continues()}`}
        </div>
      </div>
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the row label carries the information */}
      <svg width={trackW} height={ROW_H} aria-hidden className="block shrink-0">
        <Group>
          <rect
            data-night
            x={row.night.x}
            y={0}
            width={row.night.width}
            height={ROW_H}
            style={{ fill: NIGHT_FILL, fillOpacity: NIGHT_OPACITY }}
          />
          {[
            ...row.bars.filter((b) => b.kind === 'idle'),
            ...row.bars.filter((b) => b.kind === 'charging'),
          ].map((b) => (
            <Bar
              key={b.key}
              data-segment={b.kind}
              x={b.x}
              y={4}
              width={b.width}
              height={ROW_H - 8}
              rx={2}
              style={
                b.kind === 'charging'
                  ? { fill: 'var(--brand)' }
                  : { fill: IDLE_FILL, stroke: IDLE_STROKE, strokeWidth: 1 }
              }
            />
          ))}
          {row.clippedLeft && (
            <path
              data-clipped="left"
              d={`M ${MARK_W + 1} ${ROW_H / 2 - 5} L 1 ${ROW_H / 2} L ${MARK_W + 1} ${ROW_H / 2 + 5} Z`}
              style={MARK_STYLE}
            />
          )}
          {row.clippedRight && (
            <path
              data-clipped="right"
              d={`M ${trackW - MARK_W - 1} ${ROW_H / 2 - 5} L ${trackW - 1} ${ROW_H / 2} L ${trackW - MARK_W - 1} ${ROW_H / 2 + 5} Z`}
              style={MARK_STYLE}
            />
          )}
        </Group>
      </svg>
    </li>
  )
}
