import { tz } from '@date-fns/tz'
import { AxisBottom, AxisLeft } from '@visx/axis'
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
import {
  formatOneDecimal,
  formatOre,
  formatOrePrecise,
  formatShortWeekday,
  formatTime,
  mergeRuns,
} from './format'

type Detail = RouterOutputs['evCharging']['session']
type Stretch = Detail['intervals'][number]
type Slot = Detail['prices'][number]
/** A stretch of the time axis: a price slot, or charged time no price slot covers. */
type Row = Slot
type StepPoint = { t: number; ore: number | null }

// Two panels on one time axis: the spot price on top (≈ 40 % of the plot), the
// energy below (≈ 60 %), each on its own y-axis — never two scales on one plot.
const HEIGHT = 300
const MARGIN_TOP = 20
const MARGIN_BOTTOM = 28
const PANEL_GAP = 12
const PRICE_SHARE = 0.4
const NARROW_PX = 480
const TICK_STEPS_H = [1, 2, 3, 4, 6, 12, 24]
// Side margins fit the widest tick label. Measured at 10 px, "−1 000" is 28 px
// in Times, 31 px in Arial and 37 px in Verdana (4.7–6.2 px a character), so
// 6.5 px a character covers a wide sans like Switzer. Labels start 10.5 px out
// (the 8 px tick + 0.25 em), plus a spare.
const CHAR_PX = 6.5
const TICK_GAP = 14
const MIN_SIDE = 28
// The right margin only has to hold half of the last time label.
const MIN_RIGHT = 12

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
//   band     the same runs in the price panel, behind the line:
//            --chart-2 dashed edges (the outline's stroke) vs card 3.7 / 7.0,
//            around a --chart-2 fill at 25 %. A fill never clears 3:1 against
//            the card: 1.35 / 1.55 composited in gamma sRGB as browsers do
//            (1.22 / 2.51 blended in linear light), so the edges mark the
//            stretch and the fill only tints it.
//   spot     --foreground line                   vs card 19.8 / 15.9
//            vs the band 14.6 / 10.2 (no bars in its panel, so no halo)
//            its crosshair dot: the same, ringed in --card
//   window   --muted-foreground dashed rules     vs card 4.7 / 6.7
//   crosshair --muted-foreground hairline        vs card 4.7 / 6.7, band 3.5 / 4.3
//            over a --card halo (the line alone is 1.9 / 1.2 against --chart-3)
//   zero öre --muted-foreground dotted rule      vs card 4.7 / 6.7
//   units    --muted-foreground text on a --card backing, so a rule or the
//            crosshair passing under it never cuts it: 4.7 / 6.7
// --chart-1 and --chart-4 fail one theme each (see EconomyMonthlyChart).
const ACTUAL = 'var(--chart-3)'
const OPTIMAL = 'var(--chart-2)'
const OPTIMAL_FILL_OPACITY = 0.15
const BAND_FILL_OPACITY = 0.25
const OPTIMAL_DASH = '4 2'
const OPTIMAL_STROKE_PX = 1.5
const SPOT = 'var(--foreground)'
const RULE = 'var(--muted-foreground)'
const HALO = 'var(--card)'
// As SVG attributes, not a class: the size is then the same in tests (which
// load no app CSS) and in the app, so the margin estimate holds in both.
const LABEL_PX = 10
// Given as functions, visx skips its per-axis defaults (and their Arial), so
// each mirrors its axis's default placement (@visx/axis left/bottom
// TickLabelProps) and keeps the app font.
const LABEL = { className: 'fill-muted-foreground', fontSize: LABEL_PX }
const LEFT_LABEL = () => ({ ...LABEL, dx: '-0.25em', dy: '0.25em', textAnchor: 'end' as const })
const BOTTOM_LABEL = () => ({ ...LABEL, dy: '0.25em', textAnchor: 'middle' as const })
const BAR_RADIUS = 2
// A bar shorter than this draws nothing: under 2 px it has no body and reads
// as a second baseline. Zaptec logs an idle night as one long interval with a
// little standby energy (1.25 kWh over 14 h: 0.09 kW, 1.2 px on a 10 kW
// domain), which drew a hairline along the axis through the whole night. On
// the 144 px panel this hides an average under domain / 72 (0.06–0.35 kW on a
// 4–25 kW domain); a charged stretch is at least ~1.4 kW, so only an hour
// that charged for a few minutes or less goes unseen. The energy stays in the
// session's total, the table and the popover.
const MIN_BAR_PX = 2
const DOT_R = 4
// A unit over its panel's top-left: the backing's padding and height, and the
// text baseline above the panel (it sits in the top margin or the panel gap).
const UNIT_PAD = 2
const UNIT_BOX_H = 10
const UNIT_BASELINE = 3
const GHOST_HALO_PX = 4
const byStart = bisector((r: Row) => r.startMs)

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
const oreLabel = (ore: number | null) => (ore === null ? '—' : formatOrePrecise(ore))

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
// 02:00; the repeat gets no second tick. Keyed on the Stockholm day as well,
// so a window over 24 h keeps the next day's tick at the same time of day.
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
    const key = `${stockholmDayOf(ms)} ${label(ms)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const sideMargin = (labels: string[]) =>
  Math.max(MIN_SIDE, Math.ceil((max(labels, (l) => l.length) ?? 0) * CHAR_PX) + TICK_GAP)

// A session in two panels on one time axis: the 15-min spot price (a step
// line) on top, the energy below (bars at their true times: Zaptec's hourly
// intervals), with the cheapest schedule as dashed ghost bars below and a
// shaded band behind the price above. Each panel has its own y-axis: two
// measures never share a plot. Mixed resolution needs a real time axis, hence
// visx + d3-scale rather than Recharts' category axis. Dashed rules mark the
// plug-in window across both panels. An estimated session has no intervals:
// no bars, still the price.
export function SessionPriceChart({ detail }: { detail: Detail }) {
  const headingId = useId()
  const toggleId = useId()
  const hintId = useId()
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
  const hasPrice = prices.some((p) => p.spotOre !== null)

  // The row under the pointer, so moving within it doesn't re-open the popover.
  const shownRef = useRef<Row | null>(null)
  useEffect(() => {
    if (!popover.open) shownRef.current = null
  }, [popover.open])

  // The SVG depends only on layout + data, so hovering doesn't redraw it: the
  // crosshair is drawn apart, between `marks` and `overlay`. `place` is where
  // a row's popover goes and `crossX` its crosshair, for keyboard and pointer.
  const plot = useMemo(() => {
    if (width <= 0) return null
    // Both panels and the gap between them; without any price the energy
    // panel takes it all rather than leave an empty price panel.
    const plotH = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM
    const priceH = hasPrice ? Math.round((plotH - PANEL_GAP) * PRICE_SHARE) : 0
    const energyTop = hasPrice ? priceH + PANEL_GAP : 0
    const energyH = plotH - energyTop
    const charged = intervals.filter((s) => s.kwh > 0 && s.endMs > s.startMs)
    const optimal = (optimalSchedule ?? []).filter((s) => s.endMs > s.startMs)
    // The kW scale includes the schedule even while it's hidden, so the toggle never rescales.
    const yKw = scaleLinear()
      .domain([0, Math.max(1, max([...charged, ...optimal], avgKw) ?? 0)])
      .nice()
      .range([energyH, 0])
    const ores = prices.flatMap((p) => (p.spotOre === null ? [] : [p.spotOre]))
    const hasNegative = ores.some((o) => o < 0)
    // Negative spot prices happen: the price axis reaches below 0 to keep them.
    // At least 10 öre tall, so whole-öre ticks never repeat.
    const yOre = scaleLinear()
      .domain([Math.min(0, min(ores) ?? 0), Math.max(10, max(ores) ?? 0)])
      .nice()
      .range([priceH, 0])
    const timeTicks = hourTicks(startMs, endMs, width < NARROW_PX ? 4 : 8, (ms) =>
      tickLabel(ms, multiDay),
    )
    // The first and last time labels are centred on the plot's edges at most.
    const halfTime = Math.ceil(
      ((max(timeTicks, (ms) => tickLabel(ms, multiDay).length) ?? 0) * CHAR_PX) / 2,
    )
    // One left margin for both panels, so they align to the pixel.
    const left = Math.max(
      sideMargin(yKw.ticks(4).map((v) => formatOneDecimal(v))),
      hasPrice ? sideMargin(yOre.ticks(4).map((v) => formatOre(v))) : 0,
      halfTime,
    )
    const right = Math.max(MIN_RIGHT, halfTime)
    const innerW = Math.max(0, width - left - right)
    const x = scaleTime().domain([startMs, endMs]).range([0, innerW])
    const bar = (s: Stretch) => {
      const x0 = x(s.startMs)
      const y0 = yKw(avgKw(s))
      return { x: x0, y: y0, width: Math.max(1, x(s.endMs) - x0 - 1), height: energyH - y0 }
    }
    const bars = charged.map((s) => ({ s, b: bar(s) })).filter(({ b }) => b.height >= MIN_BAR_PX)
    // Each run of the cheapest schedule: its stepped top edge from baseline to
    // baseline (the outline, open at the bottom) and the same shape closed.
    const ghosts = showOptimal
      ? mergeRuns(optimal).map((run) => {
          const tops = run
            .map((p) => {
              const y = yKw(avgKw(p))
              return `L${x(p.startMs)},${y}L${x(p.endMs)},${y}`
            })
            .join('')
          const x0 = x(run[0]?.startMs ?? 0)
          const x1 = x(run.at(-1)?.endMs ?? 0)
          const outline = `M${x0},${energyH}${tops}L${x1},${energyH}`
          // The top edge alone, one horizontal segment per piece, for the halo.
          const topEdge = run
            .map((p) => {
              const y = yKw(avgKw(p))
              return `M${x(p.startMs)},${y}L${x(p.endMs)},${y}`
            })
            .join('')
          return { key: run[0]?.startMs ?? 0, x0, x1, outline, topEdge, shape: `${outline}Z` }
        })
      : []
    const crossX = (r: Row) => (x(r.startMs) + x(r.endMs)) / 2
    // The price step's y at a row, for the crosshair's dot on the line.
    const dotY = (r: Row) => (r.spotOre === null ? null : yOre(r.spotOre))
    // A priced row's popover points at the price; an unpriced one at its
    // energy (the bar top), or the energy panel's middle without any.
    const anchorY = (r: Row) => {
      const y = dotY(r)
      if (y !== null) return y
      const kwh = kwhWithin(intervals, r)
      const kw = kwh === null ? null : (kwh / (r.endMs - r.startMs)) * millisecondsInHour
      return energyTop + (kw === null ? energyH / 2 : yKw(kw))
    }
    const place = (r: Row) => ({ left: left + crossX(r), top: MARGIN_TOP + anchorY(r) })
    // One overlay over both panels picks the row nearest the pointer, so a
    // fingertip can hit a 15-min slot a few pixels wide. pointerdown covers a
    // tap (ChartPopover keeps it open until a tap outside or Escape).
    const pick = (e: React.PointerEvent<SVGRectElement>) => {
      const t = x.invert(e.clientX - e.currentTarget.getBoundingClientRect().left).getTime()
      const i = byStart.right(rows, t) - 1
      const candidates = [rows[i], rows[i + 1]].filter((r) => r !== undefined)
      const dist = (r: Row) => (t < r.startMs ? r.startMs - t : t >= r.endMs ? t - r.endMs : 0)
      const row = candidates.sort((a, b) => dist(a) - dist(b))[0]
      if (!row || row === shownRef.current) return
      shownRef.current = row
      const at = place(row)
      show(row, at.left, at.top)
    }
    // Through both panels and the gap between them.
    const rule = (ms: number, key: string) => (
      <line
        key={key}
        data-window={key}
        x1={x(ms)}
        x2={x(ms)}
        y1={0}
        y2={plotH}
        style={{ stroke: RULE, strokeWidth: 1, strokeDasharray: '4 3' }}
      />
    )
    const axisProps = { stroke: 'var(--border)', tickStroke: 'var(--border)' }
    // A unit just over its panel's top-left corner (in the top margin, or the
    // gap between the panels), clear of the tick labels in the margin. Its
    // --card backing is painted over the rules and the crosshair, so neither
    // cuts through it; it is sized from the same 6.5 px a character as the
    // margins, so it errs wide.
    const unit = (name: string, text: string, panelTop: number) => {
      const baseline = panelTop - UNIT_BASELINE
      return (
        <g data-unit={name}>
          <rect
            data-unit-backing
            x={-UNIT_PAD}
            y={baseline + UNIT_PAD - UNIT_BOX_H}
            width={Math.ceil(text.length * CHAR_PX) + 2 * UNIT_PAD}
            height={UNIT_BOX_H}
            style={{ fill: HALO }}
          />
          <text x={0} y={baseline} fontSize={LABEL_PX} className="fill-muted-foreground">
            {text}
          </text>
        </g>
      )
    }
    const units = (
      <>
        {hasPrice ? unit('ore', 'öre/kWh', 0) : null}
        {unit('kw', 'kW', energyTop)}
      </>
    )
    const line = {
      data: stepPoints(prices),
      x: (d: StepPoint) => x(d.t),
      y: (d: StepPoint) => yOre(d.ore ?? 0),
      defined: (d: StepPoint) => d.ore !== null,
      curve: curveStepAfter,
    }

    const marks = (
      <>
        {rule(win.startMs, 'start')}
        {rule(win.endMs, 'end')}
        {hasPrice ? (
          <Group data-panel="price">
            {ghosts.map((g) => (
              <rect
                key={`b${g.key}`}
                data-band="optimal"
                x={g.x0}
                y={0}
                width={g.x1 - g.x0}
                height={priceH}
                style={{ fill: OPTIMAL, fillOpacity: BAND_FILL_OPACITY }}
              />
            ))}
            {ghosts.length > 0 ? (
              <path
                data-band-edge
                d={ghosts.map((g) => `M${g.x0},0V${priceH}M${g.x1},0V${priceH}`).join('')}
                style={{
                  fill: 'none',
                  stroke: OPTIMAL,
                  strokeWidth: OPTIMAL_STROKE_PX,
                  strokeDasharray: OPTIMAL_DASH,
                }}
              />
            ) : null}
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
            <LinePath
              {...line}
              data-series="spot"
              style={{ fill: 'none', stroke: SPOT, strokeWidth: 2, strokeLinejoin: 'round' }}
            />
            <g data-axis="ore">
              <AxisLeft
                scale={yOre}
                numTicks={4}
                tickFormat={(v) => formatOre(Number(v))}
                tickLabelProps={LEFT_LABEL}
                {...axisProps}
              />
            </g>
          </Group>
        ) : null}
        <Group top={energyTop} data-panel="energy">
          {ghosts.map((g) => (
            <path
              key={`f${g.key}`}
              data-ghost="fill"
              d={g.shape}
              style={{ fill: OPTIMAL, fillOpacity: OPTIMAL_FILL_OPACITY }}
            />
          ))}
          {bars.map(({ s, b }) =>
            // BarRounded clamps its radius to >= 1 px and would poke a sliver
            // below the baseline; a bar too short to round is a plain rect.
            b.height >= 2 * BAR_RADIUS ? (
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
            ),
          )}
          {ghosts.length > 0 ? (
            <>
              <mask id={maskId} maskUnits="userSpaceOnUse">
                <rect
                  x={-GHOST_HALO_PX}
                  y={-GHOST_HALO_PX}
                  width={innerW + 2 * GHOST_HALO_PX}
                  height={energyH + 2 * GHOST_HALO_PX}
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
                    strokeWidth: OPTIMAL_STROKE_PX,
                    strokeDasharray: OPTIMAL_DASH,
                  }}
                />
              ))}
            </>
          ) : null}
          <g data-axis="kw">
            <AxisLeft
              scale={yKw}
              numTicks={4}
              tickFormat={(v) => formatOneDecimal(Number(v))}
              tickLabelProps={LEFT_LABEL}
              {...axisProps}
            />
          </g>
          <g data-axis="time">
            <AxisBottom
              top={energyH}
              scale={x}
              tickValues={timeTicks}
              tickFormat={(d) => tickLabel(Number(d), multiDay)}
              tickLabelProps={BOTTOM_LABEL}
              {...axisProps}
            />
          </g>
        </Group>
      </>
    )
    const overlay = (
      <rect
        data-hover-overlay
        x={0}
        y={0}
        width={innerW}
        height={plotH}
        style={{ fill: 'transparent' }}
        onPointerMove={pick}
        onPointerDown={pick}
      />
    )
    return { left, plotH, marks, units, overlay, place, crossX, dotY }
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
    hasPrice,
    maskId,
  ])

  const table = useMemo(
    () => (
      <div className="sr-only">
        <table>
          <caption>{m.charging_session_chart_table_caption()}</caption>
          <thead>
            <tr>
              <th scope="col">{m.charging_session_chart_col_time()}</th>
              <th scope="col">{m.charging_session_chart_col_kwh()}</th>
              <th scope="col">{m.charging_session_chart_col_ore()}</th>
              {optimalSchedule ? (
                <th scope="col">{m.charging_session_chart_col_optimal()}</th>
              ) : null}
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
      </div>
    ),
    [rows, intervals, optimalSchedule, multiDay],
  )

  const active = popover.data
  const crossX = plot && popover.open && active ? plot.crossX(active) : null
  const dotY = plot && popover.open && active ? plot.dotY(active) : null
  const optimalShown = optimalSchedule !== null && showOptimal
  // An estimated session has no intervals: no bars, so no "Laddat" entry, but a note.
  const hasIntervals = intervals.length > 0
  const tooltipText = (r: Row) =>
    m.charging_session_chart_tooltip({
      from: timeLabel(r.startMs, multiDay),
      to: formatTime(new Date(r.endMs)),
      kwh: kwhLabel(kwhWithin(intervals, r)),
      ore: oreLabel(r.spotOre),
    })

  // Keyboard path to the same popover the pointer opens: the plot is one tab
  // stop, and the arrows / Home / End step through `rows` (the pointer's rows).
  // Screen readers keep the sr-only table as their way through the numbers;
  // the portalled popover is not a live region, so it is never read out on its
  // own. A keyboard step is announced once, through the polite live region
  // below (pointer moves are not, or hovering would chatter).
  const [announced, setAnnounced] = useState('')
  const close = () => {
    popover.hide()
    setAnnounced('')
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return close()
    if (!plot || rows.length === 0) return
    const last = rows.length - 1
    const current = popover.open && active ? rows.indexOf(active) : -1
    const next =
      e.key === 'ArrowRight'
        ? current < 0
          ? 0
          : Math.min(current + 1, last)
        : e.key === 'ArrowLeft'
          ? current < 0
            ? last
            : Math.max(current - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    const row = next === null ? undefined : rows[next]
    if (!row) return
    e.preventDefault()
    shownRef.current = row
    const at = plot.place(row)
    show(row, at.left, at.top)
    setAnnounced(tooltipText(row))
  }

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
            {/* A named group that takes focus and keys; the svg inside stays aria-hidden. */}
            {/* biome-ignore lint/a11y/useSemanticElements: a chart, not a form's fieldset */}
            <div
              ref={parentRef}
              role="group"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard path to the chart's popover (see onKeyDown)
              tabIndex={0}
              aria-label={m.charging_session_chart_title()}
              aria-describedby={hintId}
              onKeyDown={onKeyDown}
              onBlur={close}
              data-chart-focus
              className="peer w-full rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              style={{ height: HEIGHT }}
            >
              {plot ? (
                // biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the sr-only table carries the numbers
                <svg
                  width={width}
                  height={HEIGHT}
                  aria-hidden
                  className="block"
                  data-chart="session-price"
                >
                  <Group left={plot.left} top={MARGIN_TOP}>
                    {plot.marks}
                    {crossX === null ? null : (
                      // One hairline through both panels at the active row,
                      // over a card halo so it reads across the bars too.
                      <g data-crosshair style={{ pointerEvents: 'none' }}>
                        <line
                          x1={crossX}
                          x2={crossX}
                          y1={0}
                          y2={plot.plotH}
                          style={{ stroke: HALO, strokeWidth: 3 }}
                        />
                        <line
                          x1={crossX}
                          x2={crossX}
                          y1={0}
                          y2={plot.plotH}
                          style={{ stroke: RULE, strokeWidth: 1 }}
                        />
                        {/* The active slot on the price line, tying the panels together. */}
                        {dotY === null ? null : (
                          <circle
                            data-crosshair-dot
                            cx={crossX}
                            cy={dotY}
                            r={DOT_R}
                            style={{ fill: SPOT, stroke: HALO, strokeWidth: 1.5 }}
                          />
                        )}
                      </g>
                    )}
                    {plot.units}
                    {plot.overlay}
                  </Group>
                </svg>
              ) : null}
            </div>
            {/* Shown while the plot has keyboard focus; always its description. */}
            <p
              id={hintId}
              className="sr-only text-muted-foreground text-xs peer-focus-visible:not-sr-only peer-focus-visible:pt-1"
            >
              {m.charging_session_chart_keyboard_hint()}
            </p>
            <div className="sr-only" aria-live="polite" data-chart-announce>
              {announced}
            </div>
            <ChartPopover state={popover} dataKey={active ? String(active.startMs) : undefined}>
              {active ? tooltipText(active) : null}
            </ChartPopover>
          </div>
          {hasIntervals ? null : (
            <p className="text-muted-foreground text-xs" data-note="no-hourly">
              {m.charging_session_chart_no_hourly()}
            </p>
          )}
          {/* One legend for both panels, in their order: the price, then the energy. */}
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
            {hasPrice ? (
              <li className="flex items-center gap-1.5" data-legend="spot">
                <span className="h-0.5 w-3" style={{ background: SPOT }} />
                {m.charging_session_chart_spot()}
              </li>
            ) : null}
            {hasIntervals ? (
              <li className="flex items-center gap-1.5" data-legend="actual">
                <span className="size-2.5 rounded-t-sm" style={{ background: ACTUAL }} />
                {m.charging_session_chart_actual()}
              </li>
            ) : null}
            {optimalShown ? (
              <li className="flex items-center gap-1.5" data-legend="optimal">
                {/* Both of its marks: the band over the price, the ghost bars under it. */}
                <span
                  data-swatch="band"
                  className="h-2.5 w-3 border-x-[1.5px] border-dashed"
                  style={{
                    borderColor: OPTIMAL,
                    background: `color-mix(in oklab, ${OPTIMAL} ${BAND_FILL_OPACITY * 100}%, transparent)`,
                  }}
                />
                <span
                  data-swatch="ghost"
                  className="size-2.5 border-[1.5px] border-dashed"
                  style={{
                    borderColor: OPTIMAL,
                    background: `color-mix(in oklab, ${OPTIMAL} ${OPTIMAL_FILL_OPACITY * 100}%, transparent)`,
                  }}
                />
                {m.charging_session_chart_optimal()}
              </li>
            ) : null}
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
