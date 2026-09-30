import { tz } from '@date-fns/tz'
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis'
import { curveStepAfter } from '@visx/curve'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, BarRounded, LinePath } from '@visx/shape'
import { bisector, max, min, range, sum } from 'd3-array'
import { scaleLinear, scaleTime } from 'd3-scale'
import { getHours } from 'date-fns'
import { millisecondsInHour } from 'date-fns/constants'
import type * as React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import type { RouterOutputs } from '~/lib/orpc/client'
import { STOCKHOLM_TIME_ZONE, stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { ChartPopover, useChartPopover } from './ChartPopover'
import { formatOneDecimal, formatOre, formatShortWeekday, formatTime } from './format'

type Detail = RouterOutputs['evCharging']['session']
type Stretch = Detail['intervals'][number]
type Slot = Detail['prices'][number]
/** A stretch of the time axis: a price slot, or charged time no price slot covers. */
type Row = Slot
type StepPoint = { t: number; ore: number | null }

const HEIGHT = 260
const MARGIN_TOP = 20
const MARGIN_BOTTOM = 28
const NARROW_PX = 480
const TICK_STEPS_H = [1, 2, 3, 4, 6, 12, 24]
// Side margins fit the widest tick label. Measured at 10 px, "−1 000" is 28 px
// in Times, 31 px in Arial and 37 px in Verdana (4.7–6.2 px a character), so
// 6.5 px a character covers a wide sans like Switzer. Labels start 10.5 px out
// (the 8 px tick + 0.25 em), plus a spare.
const CHAR_PX = 6.5
const TICK_GAP = 14
const MIN_SIDE = 28

// Colours, as contrast ratios light / dark (WCAG, from the oklch tokens):
//   actual   --chart-3 fill                      vs card 9.1 / 8.1
//   optimal  --chart-2 dashed outline            vs card 3.7 / 7.0
//     One outline per run of consecutive schedule pieces, with a faint fill
//     drawn behind the actual bars. The outline sits over the bars. Along its
//     top edge a --card halo is painted only above the run (masked off
//     inside), so the top line has card on its outer side (3.7 / 7.0) even
//     over a taller actual bar: --chart-2 alone is only 2.5 / 1.15 against
//     --chart-3. The run's vertical edges get no halo — a halo there would cut
//     card columns through hourly bars, swallow narrow bars and gaps at phone
//     width, and trim the window rules — so they sit directly on bars or card;
//     the haloed top edge and the fill already identify the run.
//   spot     --foreground line                   vs card 19.8 / 15.9
//            over a --card halo (the line alone is 2.2 / 2.0 against --chart-3)
//   window   --muted-foreground dashed rules     vs card 4.7 / 6.7
//   zero öre --muted-foreground dotted rule      vs card 4.7 / 6.7
// --chart-1 and --chart-4 fail one theme each (see EconomyMonthlyChart).
const ACTUAL = 'var(--chart-3)'
const OPTIMAL = 'var(--chart-2)'
const SPOT = 'var(--foreground)'
const RULE = 'var(--muted-foreground)'
const HALO = 'var(--card)'
// As SVG attributes, not a class: the size is then the same in tests (which
// load no app CSS) and in the app, so the margin estimate holds in both.
const LABEL_PX = 10
// Given as functions, visx skips its per-axis defaults (and their Arial), so
// each mirrors its axis's default placement (@visx/axis left/right/bottom
// TickLabelProps) and keeps the app font.
const LABEL = { className: 'fill-muted-foreground', fontSize: LABEL_PX }
const LEFT_LABEL = () => ({ ...LABEL, dx: '-0.25em', dy: '0.25em', textAnchor: 'end' as const })
const RIGHT_LABEL = () => ({ ...LABEL, dx: '0.25em', dy: '0.25em', textAnchor: 'start' as const })
const BOTTOM_LABEL = () => ({ ...LABEL, dy: '0.25em', textAnchor: 'middle' as const })
const BAR_RADIUS = 2
const GHOST_HALO_PX = 4
const byStart = bisector((r: Row) => r.startMs)

// Consecutive schedule pieces, merged into runs drawn as one outline each.
function scheduleRuns(pieces: readonly Stretch[]): Stretch[][] {
  const runs: Stretch[][] = []
  for (const p of [...pieces].sort((a, b) => a.startMs - b.startMs)) {
    const run = runs.at(-1)
    if (run && run.at(-1)?.endMs === p.startMs) run.push(p)
    else runs.push([p])
  }
  return runs
}

const stockholmHour = (ms: number) => getHours(ms, { in: tz(STOCKHOLM_TIME_ZONE) })

// Average kW over the stretch, so an hour bar and a quarter bar compare fairly.
const avgKw = (s: Stretch) => (s.kwh / (s.endMs - s.startMs)) * millisecondsInHour

/**
 * The kWh of `stretches` that falls inside `row`, each stretch's energy spread
 * evenly over its span; null when no stretch overlaps it (no data, not 0 kWh).
 * The tooltip and the sr-only table both read this, so they always agree.
 */
function kwhWithin(stretches: readonly Stretch[], row: Row): number | null {
  const overlap = (s: Stretch) => Math.min(s.endMs, row.endMs) - Math.max(s.startMs, row.startMs)
  const overlapping = stretches.filter((s) => overlap(s) > 0)
  if (overlapping.length === 0) return null
  return sum(overlapping, (s) => (s.kwh * overlap(s)) / (s.endMs - s.startMs))
}

/**
 * The time axis in rows: every price slot, plus the charged time no slot
 * covers (a price day that never synced), priceless. So the table and the
 * tooltip never drop energy just because its hour has no price.
 */
function chartRows(prices: readonly Slot[], intervals: readonly Stretch[]): Row[] {
  const rows: Row[] = [...prices]
  for (const iv of intervals) {
    const covering = rows
      .filter((r) => r.endMs > iv.startMs && r.startMs < iv.endMs)
      .sort((a, b) => a.startMs - b.startMs)
    let cursor = iv.startMs
    const gaps: Row[] = []
    for (const r of covering) {
      if (r.startMs > cursor) gaps.push({ startMs: cursor, endMs: r.startMs, spotOre: null })
      cursor = Math.max(cursor, r.endMs)
    }
    if (cursor < iv.endMs) gaps.push({ startMs: cursor, endMs: iv.endMs, spotOre: null })
    rows.push(...gaps)
  }
  return rows.sort((a, b) => a.startMs - b.startMs)
}

// A time, with its weekday when the chart spans more than one Stockholm day.
const timeLabel = (ms: number, multiDay: boolean) =>
  multiDay ? `${formatShortWeekday(ms)} ${formatTime(new Date(ms))}` : formatTime(new Date(ms))
const rowLabel = (r: Row, multiDay: boolean) =>
  `${timeLabel(r.startMs, multiDay)}–${formatTime(new Date(r.endMs))}`
// Axis ticks name the weekday on midnight only.
const tickLabel = (ms: number, multiDay: boolean) =>
  timeLabel(ms, multiDay && stockholmHour(ms) === 0)

const kwhLabel = (kwh: number | null) => (kwh === null ? '—' : formatOneDecimal(kwh))
const oreLabel = (ore: number | null) => (ore === null ? '—' : formatOre(ore))

// Each slot's price held from its start to its end. A slot without a price (a
// day without a tariff) or a gap between slots (a day that never synced)
// breaks the line: missing is not a price.
function stepPoints(prices: readonly Slot[]): StepPoint[] {
  const points: StepPoint[] = []
  let prevEnd: number | undefined
  for (const p of prices) {
    if (p.spotOre === null || (prevEnd !== undefined && p.startMs !== prevEnd)) {
      points.push({ t: p.startMs, ore: null })
    }
    if (p.spotOre !== null) {
      points.push({ t: p.startMs, ore: p.spotOre }, { t: p.endMs, ore: p.spotOre })
    }
    prevEnd = p.endMs
  }
  return points
}

// Whole Stockholm hours, every 1, 2, 3 … h so at most `maxTicks` fit. d3's
// time ticks align to the browser's zone; the app shows Stockholm time, whose
// hours start on UTC hours (a whole-hour offset). The fall-back day repeats
// 02:00; the repeat gets no second tick.
function hourTicks(
  startMs: number,
  endMs: number,
  maxTicks: number,
  label: (ms: number) => string,
): number[] {
  const first = Math.ceil(startMs / millisecondsInHour) * millisecondsInHour
  const hours = range(first, endMs + 1, millisecondsInHour)
  const step = TICK_STEPS_H.find((s) => hours.length / s <= maxTicks) ?? 24
  const seen = new Set<string>()
  return hours.filter((ms) => {
    if (stockholmHour(ms) % step !== 0) return false
    const text = label(ms)
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
}

const sideMargin = (labels: string[]) =>
  Math.max(MIN_SIDE, Math.ceil((max(labels, (l) => l.length) ?? 0) * CHAR_PX) + TICK_GAP)

// A session's energy (bars at their true times: Zaptec's hourly intervals)
// against the 15-min spot price (a step line), with the cheapest schedule as
// dashed ghost bars. Mixed resolution needs a real time axis, hence visx +
// d3-scale rather than Recharts' category axis. Dashed rules mark the plug-in
// window. An estimated session has no intervals: no bars, still the price.
export function SessionPriceChart({ detail }: { detail: Detail }) {
  const headingId = useId()
  const toggleId = useId()
  const [showOptimal, setShowOptimal] = useState(true)
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  // A mask id valid in url(#…): useId's colons are not.
  const maskId = `ghost-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const popover = useChartPopover<Row>()
  const { show, containerProps } = popover
  const { window: win, intervals, prices, optimalSchedule } = detail

  const rows = useMemo(() => chartRows(prices, intervals), [prices, intervals])
  const startMs = Math.min(win.startMs - millisecondsInHour, rows[0]?.startMs ?? Infinity)
  const endMs = Math.max(win.endMs + millisecondsInHour, rows.at(-1)?.endMs ?? -Infinity)
  // Over more than one Stockholm day, times carry their weekday.
  const multiDay = stockholmDayOf(startMs) !== stockholmDayOf(endMs - 1)

  // The row under the pointer, so moving within it doesn't re-open the popover.
  const shownRef = useRef<Row | null>(null)
  useEffect(() => {
    if (!popover.open) shownRef.current = null
  }, [popover.open])

  // The SVG depends only on layout + data, so hovering doesn't redraw it.
  const svg = useMemo(() => {
    if (width <= 0) return null
    const innerH = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM
    const charged = intervals.filter((s) => s.kwh > 0 && s.endMs > s.startMs)
    const optimal = (optimalSchedule ?? []).filter((s) => s.endMs > s.startMs)
    // The kW scale includes the schedule even while it's hidden, so the toggle never rescales.
    const yKw = scaleLinear()
      .domain([0, Math.max(1, max([...charged, ...optimal], avgKw) ?? 0)])
      .nice()
      .range([innerH, 0])
    const ores = prices.flatMap((p) => (p.spotOre === null ? [] : [p.spotOre]))
    const hasPrice = ores.length > 0
    const hasNegative = ores.some((o) => o < 0)
    // Negative spot prices happen: the price axis reaches below 0 to keep them.
    // At least 10 öre tall, so whole-öre ticks never repeat.
    const yOre = scaleLinear()
      .domain([Math.min(0, min(ores) ?? 0), Math.max(10, max(ores) ?? 0)])
      .nice()
      .range([innerH, 0])
    const left = sideMargin(yKw.ticks(4).map((v) => formatOneDecimal(v)))
    const right = hasPrice ? sideMargin(yOre.ticks(4).map((v) => formatOre(v))) : MIN_SIDE
    const innerW = Math.max(0, width - left - right)
    const x = scaleTime().domain([startMs, endMs]).range([0, innerW])
    const bar = (s: Stretch) => {
      const x0 = x(s.startMs)
      const y0 = yKw(avgKw(s))
      return { x: x0, y: y0, width: Math.max(1, x(s.endMs) - x0 - 1), height: innerH - y0 }
    }
    // Each run of the cheapest schedule: its stepped top edge from baseline to
    // baseline (the outline, open at the bottom) and the same shape closed.
    const ghosts = showOptimal
      ? scheduleRuns(optimal).map((run) => {
          const tops = run
            .map((p) => {
              const y = yKw(avgKw(p))
              return `L${x(p.startMs)},${y}L${x(p.endMs)},${y}`
            })
            .join('')
          const x0 = x(run[0]?.startMs ?? 0)
          const x1 = x(run.at(-1)?.endMs ?? 0)
          const outline = `M${x0},${innerH}${tops}L${x1},${innerH}`
          // The top edge alone, one horizontal segment per piece, for the halo.
          const topEdge = run
            .map((p) => {
              const y = yKw(avgKw(p))
              return `M${x(p.startMs)},${y}L${x(p.endMs)},${y}`
            })
            .join('')
          return { key: run[0]?.startMs ?? 0, outline, topEdge, shape: `${outline}Z` }
        })
      : []
    const line = {
      data: stepPoints(prices),
      x: (d: StepPoint) => x(d.t),
      y: (d: StepPoint) => yOre(d.ore ?? 0),
      defined: (d: StepPoint) => d.ore !== null,
      curve: curveStepAfter,
    }
    const popoverTop = (r: Row) => MARGIN_TOP + (r.spotOre === null ? innerH / 2 : yOre(r.spotOre))
    // One overlay picks the row nearest the pointer, so a fingertip can hit a
    // 15-min slot a few pixels wide. pointerdown covers a tap (ChartPopover
    // keeps it open until a tap outside or Escape).
    const pick = (e: React.PointerEvent<SVGRectElement>) => {
      const t = x.invert(e.clientX - e.currentTarget.getBoundingClientRect().left).getTime()
      const i = byStart.right(rows, t) - 1
      const candidates = [rows[i], rows[i + 1]].filter((r) => r !== undefined)
      const dist = (r: Row) => (t < r.startMs ? r.startMs - t : t >= r.endMs ? t - r.endMs : 0)
      const row = candidates.sort((a, b) => dist(a) - dist(b))[0]
      if (!row || row === shownRef.current) return
      shownRef.current = row
      show(row, left + (x(row.startMs) + x(row.endMs)) / 2, popoverTop(row))
    }
    const rule = (ms: number, key: string) => (
      <line
        key={key}
        data-window={key}
        x1={x(ms)}
        x2={x(ms)}
        y1={0}
        y2={innerH}
        style={{ stroke: RULE, strokeWidth: 1, strokeDasharray: '4 3' }}
      />
    )
    const axisProps = { stroke: 'var(--border)', tickStroke: 'var(--border)' }

    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the sr-only table carries the numbers
      <svg width={width} height={HEIGHT} aria-hidden className="block" data-chart="session-price">
        <Group left={left} top={MARGIN_TOP}>
          {rule(win.startMs, 'start')}
          {rule(win.endMs, 'end')}
          {hasNegative ? (
            <line
              data-ref="zero-ore"
              x1={0}
              x2={innerW}
              y1={yOre(0)}
              y2={yOre(0)}
              style={{ stroke: RULE, strokeWidth: 1, strokeDasharray: '1 3' }}
            />
          ) : null}
          {ghosts.map((g) => (
            <path
              key={`f${g.key}`}
              data-ghost="fill"
              d={g.shape}
              style={{ fill: OPTIMAL, fillOpacity: 0.15 }}
            />
          ))}
          {charged.map((s) => {
            const b = bar(s)
            // BarRounded clamps its radius to >= 1 px and would poke a sliver
            // below the baseline; a bar too short to round is a plain rect.
            return b.height >= 2 * BAR_RADIUS ? (
              <BarRounded
                key={`a${s.startMs}`}
                data-series="actual"
                {...b}
                radius={BAR_RADIUS}
                top
                style={{ fill: ACTUAL }}
              />
            ) : (
              <Bar key={`a${s.startMs}`} data-series="actual" {...b} style={{ fill: ACTUAL }} />
            )
          })}
          {ghosts.length > 0 ? (
            <>
              <mask id={maskId} maskUnits="userSpaceOnUse">
                <rect
                  x={-GHOST_HALO_PX}
                  y={-GHOST_HALO_PX}
                  width={innerW + 2 * GHOST_HALO_PX}
                  height={innerH + 2 * GHOST_HALO_PX}
                  fill="white"
                />
                {ghosts.map((g) => (
                  <path key={`m${g.key}`} d={g.shape} fill="black" />
                ))}
              </mask>
              <path
                data-ghost="halo"
                d={ghosts.map((g) => g.topEdge).join('')}
                mask={`url(#${maskId})`}
                style={{ fill: 'none', stroke: HALO, strokeWidth: GHOST_HALO_PX }}
              />
              {ghosts.map((g) => (
                <path
                  key={`o${g.key}`}
                  data-ghost="outline"
                  data-series="optimal"
                  d={g.outline}
                  style={{
                    fill: 'none',
                    stroke: OPTIMAL,
                    strokeWidth: 1.5,
                    strokeDasharray: '4 2',
                  }}
                />
              ))}
            </>
          ) : null}
          <LinePath
            {...line}
            style={{ fill: 'none', stroke: HALO, strokeWidth: 4.5, strokeLinejoin: 'round' }}
          />
          <LinePath
            {...line}
            data-series="spot"
            style={{ fill: 'none', stroke: SPOT, strokeWidth: 2, strokeLinejoin: 'round' }}
          />
          <rect
            data-hover-overlay
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            style={{ fill: 'transparent' }}
            onPointerMove={pick}
            onPointerDown={pick}
          />
          <g data-axis="time">
            <AxisBottom
              top={innerH}
              scale={x}
              tickValues={hourTicks(startMs, endMs, width < NARROW_PX ? 4 : 8, (ms) =>
                tickLabel(ms, multiDay),
              )}
              tickFormat={(d) => tickLabel(Number(d), multiDay)}
              tickLabelProps={BOTTOM_LABEL}
              {...axisProps}
            />
          </g>
          <g data-axis="kw">
            <AxisLeft
              scale={yKw}
              numTicks={4}
              tickFormat={(v) => formatOneDecimal(Number(v))}
              tickLabelProps={LEFT_LABEL}
              {...axisProps}
            />
          </g>
          {hasPrice ? (
            <g data-axis="ore">
              <AxisRight
                left={innerW}
                scale={yOre}
                numTicks={4}
                tickFormat={(v) => formatOre(Number(v))}
                tickLabelProps={RIGHT_LABEL}
                {...axisProps}
              />
              <text x={innerW + 8} y={-8} fontSize={LABEL_PX} className="fill-muted-foreground">
                öre
              </text>
            </g>
          ) : null}
          <text
            x={-8}
            y={-8}
            textAnchor="end"
            fontSize={LABEL_PX}
            className="fill-muted-foreground"
          >
            kW
          </text>
        </Group>
      </svg>
    )
  }, [
    width,
    win,
    intervals,
    prices,
    optimalSchedule,
    rows,
    showOptimal,
    show,
    startMs,
    endMs,
    multiDay,
    maskId,
  ])

  const table = useMemo(
    () => (
      <table className="sr-only">
        <caption>{m.charging_session_chart_table_caption()}</caption>
        <thead>
          <tr>
            <th scope="col">{m.charging_session_chart_col_time()}</th>
            <th scope="col">{m.charging_session_chart_col_kwh()}</th>
            <th scope="col">{m.charging_session_chart_col_ore()}</th>
            {optimalSchedule ? <th scope="col">{m.charging_session_chart_col_optimal()}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.startMs}>
              <th scope="row">{rowLabel(r, multiDay)}</th>
              <td>{kwhLabel(kwhWithin(intervals, r))}</td>
              <td>{oreLabel(r.spotOre)}</td>
              {optimalSchedule ? <td>{kwhLabel(kwhWithin(optimalSchedule, r))}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [rows, intervals, optimalSchedule, multiDay],
  )

  const active = popover.data
  const optimalShown = optimalSchedule !== null && showOptimal

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id={headingId} className="font-medium text-sm">
              {m.charging_session_chart_title()}
            </h2>
            {optimalSchedule ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={toggleId}
                  checked={showOptimal}
                  onCheckedChange={(v) => setShowOptimal(v === true)}
                />
                <Label htmlFor={toggleId} className="font-normal text-sm">
                  {m.charging_session_chart_show_optimal()}
                </Label>
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div {...containerProps} className="relative w-full">
            <div ref={parentRef} className="w-full" style={{ height: HEIGHT }}>
              {svg}
            </div>
            <ChartPopover state={popover} dataKey={active ? String(active.startMs) : undefined}>
              {active
                ? m.charging_session_chart_tooltip({
                    from: timeLabel(active.startMs, multiDay),
                    to: formatTime(new Date(active.endMs)),
                    kwh: kwhLabel(kwhWithin(intervals, active)),
                    ore: oreLabel(active.spotOre),
                  })
                : null}
            </ChartPopover>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-t-sm" style={{ background: ACTUAL }} />
              {m.charging_session_chart_actual()}
            </li>
            {optimalShown ? (
              <li className="flex items-center gap-1.5" data-legend="optimal">
                <span
                  className="size-2.5 border-[1.5px] border-dashed"
                  style={{
                    borderColor: OPTIMAL,
                    background: `color-mix(in oklab, ${OPTIMAL} 15%, transparent)`,
                  }}
                />
                {m.charging_session_chart_optimal()}
              </li>
            ) : null}
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-3" style={{ background: SPOT }} />
              {m.charging_session_chart_spot()}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2.5 w-3 border-x border-dashed" style={{ borderColor: RULE }} />
              {m.charging_session_chart_window()}
            </li>
          </ul>
          {table}
        </CardContent>
      </Card>
    </section>
  )
}
