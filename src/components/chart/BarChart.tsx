import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, BarRounded, LinePath } from '@visx/shape'
import { range } from 'd3-array'
import { type ScaleLinear, scaleBand } from 'd3-scale'
import type * as React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import {
  AXIS_COLOR,
  CHART_MARGIN as MARGIN,
  measureAt,
  TICK_PX,
  TICK_SIZE,
  X_AXIS_H,
  X_TICK_MARGIN,
  Y_TICK_MARGIN,
  yAxisWidth,
} from './axis'
import {
  type BarSeries,
  labelsFit,
  layoutBars,
  MIN_BAR_PX,
  type StackOffset,
  stackExtent,
  thinTicks,
  yScaleFor,
} from './barLayout'
import { CHART_HEIGHT, ChartLegend } from './ChartParts'

export type { BarSeries } from './barLayout'
export type LineSeries = {
  key: string
  label: string
  color: string
  dash?: string
  /** 'right': its own scale (0 included) and an axis on the right; the bars' axis ignores it. Default 'left'. */
  axis?: 'left' | 'right'
  /** The right axis' tick labels (default `yTickFormat`). */
  tickFormat?: (v: number) => string
  /** Default 2. */
  strokeWidth?: number
}

/** A small mark on one category: on top of the stack in a series' colour, or across the whole column. */
export type BarMarker = {
  /** Unique within its category (a React key and the `data-marker` hook). */
  key: string
  /** A series key: the mark is that series' (told by `color`); undefined: across the column (a dashed line too). */
  seriesKey?: string
  color: string
}

/**
 * A selectable chart must also have a `label`: the label makes it a keyboard
 * stop, and Enter / Space on that stop are its only keyboard path. Without one
 * the chart is aria-hidden and mouse / touch only.
 */
export type BarSelection<Row> = {
  /** The selected category's index, or null. An index outside the rows (or not a whole number) draws nothing. */
  selected: number | null
  onSelect: (index: number) => void
  /** Whether a category can be selected (the Energi chart: it has readings). */
  canSelect: (row: Row) => boolean
}

export type BarChartProps<Row> = {
  rows: readonly Row[]
  /** The category's x label (also the tooltip's title). Keep its identity across renders (a geometry memo input). */
  category: (row: Row) => string
  /** Bars in stack, legend and tooltip order (bottom to top within a stack). */
  series: readonly BarSeries[]
  /** A series' value for a row; null draws nothing. Keep its identity across renders (a geometry memo input). */
  value: (row: Row, key: string) => number | null
  /** One line over the bars (Spot's month average), through its non-null points. */
  line?: LineSeries
  yTickFormat: (v: number) => string
  /** Whole-number ticks (recharts' allowDecimals={false}). */
  yIntegers?: boolean
  yDomain?: readonly [number, number]
  /** No y axis and no grid (a year with no kronor to scale against). */
  hideYAxis?: boolean
  /** Draw the y axis line (default true; Economy and Spot hide it). */
  yAxisLine?: boolean
  /** Label every nth category; default: as many as fit, the first and last always. */
  xTickEvery?: number
  barGap?: number
  height?: number
  legend?: boolean
  /** A row's tooltip content; null shows no tooltip for that row. */
  tooltip: (row: Row, index: number) => React.ReactNode
  /** The category label on top of the card (default true). */
  tooltipTitle?: boolean
  /** Accessible name. With it the chart is a keyboard stop; without, it is aria-hidden (bring an sr-only table). */
  label?: string
  /** 'diverging' hangs negative values below zero (default 'none'). */
  stackOffset?: StackOffset
  /** A `var(--border)` line at 0 across the plot. */
  zeroLine?: boolean
  /**
   * With it every category is labelled: full labels when they fit, else every label short, and
   * `xTickEvery` is ignored. Like `category` and `value`, keep its identity across renders.
   */
  shortCategory?: (row: Row) => string
  /** The axis labels' font size, also used to measure them (default 12). */
  tickPx?: number
  /** The smallest drawn bar height in px (default MIN_BAR_PX; 0 draws true heights). */
  minBarPx?: number
  /** Classes merged over the tooltip card's. */
  tooltipClassName?: string
  /** Classes merged over the legend's. */
  legendClassName?: string
  /** The sr-only keyboard hint (default: the shared one). */
  keyboardHint?: string
  /**
   * Click / tap / Enter selects a category; adds the selected tint, the outline and the pointer cursor.
   * Pass `label` with it: the labelled group is the selection's keyboard path (see BarSelection).
   */
  selection?: BarSelection<Row>
  /** A short label above a category's stack (e.g. a winter loss share); null draws none. */
  barLabel?: (row: Row, index: number) => string | null
  /**
   * Marks on a category (logged events); null or [] draws none. Keep its identity across renders. Its headroom is
   * above the stack only: it doesn't make room for a `barLabel` too (no chart combines them).
   */
  markers?: (row: Row, index: number) => readonly BarMarker[] | null
}

const DOT_R = 3
const MARKER_W = 8
const MARKER_MIN_W = 3
const MARKER_H = 6
const MARKER_GAP = 2

// One bar chart for the category charts (months, hours): visx shapes on d3
// scales, the geometry in barLayout.ts. The SVG is visual; a labelled chart is
// one Tab stop whose arrows walk the categories, showing each tooltip and
// announcing it once (the SessionPriceChart idiom). The tooltip is a card in a
// portal above the hovered category (ChartPopover), so no ancestor clips it.
export function BarChart<Row>({
  rows,
  category,
  series,
  value,
  line,
  yTickFormat,
  yIntegers = false,
  yDomain,
  hideYAxis = false,
  yAxisLine = true,
  xTickEvery,
  barGap = 4,
  height = CHART_HEIGHT,
  legend = false,
  tooltip,
  tooltipTitle = true,
  label,
  stackOffset = 'none',
  zeroLine = false,
  shortCategory,
  tickPx = TICK_PX,
  minBarPx = MIN_BAR_PX,
  tooltipClassName,
  legendClassName,
  keyboardHint,
  selection,
  barLabel,
  markers,
}: BarChartProps<Row>) {
  // No debounce: a resize that wraps the legend re-lays the plot at once,
  // as recharts' ResponsiveContainer did (a stale plot would overlap it).
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  // followScroll: the card is portalled, so it re-measures while a scroll
  // container moves the chart under it.
  const popover = useChartPopover<number>({ followScroll: true })
  const hintId = useId()
  const patternId = useId()
  const [announced, setAnnounced] = useState<number | null>(null)
  // The category the pointer or the keys last moved to (null: none). Kept apart
  // from the popover, which stays closed on a category without a tooltip: the
  // keyboard walk must step over it, not restart at the first category.
  const cursor = useRef<number | null>(null)
  // The cursor's category as it named it: when the rows change under it (a selected month's days in place of the
  // year's months), the card, outline, announcement and cursor point at a category that is gone, so they close below.
  // A refetch of the same categories keeps them; fewer of them (the first category unchanged) clamp (onKeyDown).
  // Fewer rows that start elsewhere (Totalt's months → a month's days, the cursor past the last day) are other rows
  // too. Never a remount: focus stays.
  const [cursorAt, setCursorAt] = useState<{
    index: number
    category: string
    first: string
  } | null>(null)
  const pin = (i: number) => {
    cursor.current = i
    if (
      cursorAt?.index !== i ||
      cursorAt.category !== category(rows[i]) ||
      cursorAt.first !== category(rows[0])
    )
      setCursorAt({ index: i, category: category(rows[i]), first: category(rows[0]) })
  }
  // The outlined category (selection only): where the pointer or the keys
  // are. From the keyboard one that can't be selected is outlined dashed, so
  // focus stays visible; the pointer outlines only selectable ones; never touch.
  const [outline, setOutline] = useState<{ index: number; keyboard: boolean } | null>(null)
  const at = (i: number, key: string) => value(rows[i], key)
  const count = rows.length
  if (
    cursorAt !== null &&
    (cursorAt.index < count
      ? category(rows[cursorAt.index]) !== cursorAt.category
      : count === 0 || category(rows[0]) !== cursorAt.first)
  ) {
    setCursorAt(null)
    popover.hide()
    setAnnounced(null)
    setOutline(null)
  }
  // A label over the tallest bar, and a marker above it, need room above the plot.
  const marginTop =
    (barLabel ? MARGIN.top + tickPx + 6 : MARGIN.top) + (markers ? MARKER_H + MARKER_GAP : 0)
  const tickLabel = { fill: 'var(--muted-foreground)', fontSize: tickPx }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is rows + value, both listed
  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const right = line?.axis === 'right' ? line : undefined
    const keys = line && !right ? [...series, { key: line.key, label: '', color: '' }] : series
    const measure = measureAt(tickPx)
    const extent = stackExtent({ count, series: keys, value: at, offset: stackOffset })
    const plotH = Math.max(0, plotBoxH - marginTop - MARGIN.bottom - X_AXIS_H)
    const y = yScaleFor({ extent, height: plotH, integers: yIntegers, domain: yDomain })
    const yLabels = y.ticks.map(yTickFormat)
    const yAxisW = hideYAxis ? 0 : yAxisWidth(yLabels, measure)
    const left = MARGIN.left + yAxisW
    let yRight: { scale: ScaleLinear<number, number>; ticks: number[] } | null = null
    let rightW: number = MARGIN.right
    if (right) {
      const values = range(count).flatMap((i) => {
        const v = at(i, right.key)
        return v === null ? [] : [v]
      })
      yRight = yScaleFor({
        extent: values.length ? [Math.min(...values), Math.max(...values)] : [0, 0],
        height: plotH,
      })
      rightW = Math.max(
        MARGIN.right,
        yAxisWidth(yRight.ticks.map(right.tickFormat ?? yTickFormat), measure),
      )
    }
    const plotW = Math.max(0, width - left - rightW)
    const x = scaleBand<number>().domain(range(count)).range([0, plotW])
    const centres = range(count).map((i) => (x(i) ?? 0) + x.bandwidth() / 2)
    const fullWidths = rows.map((r) => measure(category(r)))
    // With short labels every category is labelled: full when they all fit, else all short.
    const short = shortCategory !== undefined && !labelsFit(centres, fullWidths)
    const xTicks =
      shortCategory !== undefined
        ? range(count)
        : xTickEvery === undefined
          ? thinTicks(centres, fullWidths)
          : range(0, count, xTickEvery)
    const rects = layoutBars({
      count,
      series,
      value: at,
      x,
      y: y.scale,
      barGap,
      offset: stackOffset,
      minPx: minBarPx,
    })
    return { x, y, yRight, left, plotW, plotH, xTicks, rects, centres, short }
  }, [
    width,
    plotBoxH,
    rows,
    series,
    line,
    value,
    yTickFormat,
    yIntegers,
    yDomain,
    hideYAxis,
    xTickEvery,
    barGap,
    category,
    count,
    stackOffset,
    shortCategory,
    tickPx,
    minBarPx,
    marginTop,
  ])
  // The top of a category's stack (its tallest bar, an outline bar beside it included), or the baseline when nothing
  // is drawn.
  const stackTop = (i: number) => {
    if (!geometry) return 0
    const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
    return tops.length > 0 ? Math.min(...tops) : geometry.plotH
  }

  const chosen = selection?.selected
  const selected =
    chosen != null && Number.isInteger(chosen) && chosen >= 0 && chosen < count ? chosen : null
  // The line's scale: its own on the right axis, else the bars'.
  const lineScale = (geometry?.yRight ?? geometry?.y)?.scale ?? ((v: number) => v)
  // The outline on screen (range-guarded: a refetch may have dropped its category).
  const outlined = selection && outline !== null && outline.index < count ? outline.index : null
  // Only a keyboard outline is ever dashed: a pointer outline stays solid even
  // if a refetch under the mouse makes its category unselectable.
  const dashed =
    outlined !== null && outline?.keyboard === true && !selection?.canSelect(rows[outlined])

  // The card's anchor: the category's centre, at the top of its tallest bar.
  const anchor = (i: number) => {
    if (!geometry) return { left: 0, top: 0 }
    const tops = [stackTop(i)]
    // The line's dot too, so the card never covers it.
    const dot = line ? at(i, line.key) : null
    if (dot !== null) tops.push((geometry.yRight ?? geometry.y).scale(dot) - DOT_R)
    // And the category's marks.
    if ((markers?.(rows[i], i)?.length ?? 0) > 0) tops.push(stackTop(i) - MARKER_GAP - MARKER_H)
    return {
      left: geometry.left + geometry.centres[i],
      top: marginTop + Math.min(geometry.plotH, ...tops),
    }
  }
  const open = (i: number) => {
    pin(i)
    if (tooltip(rows[i], i) === null) return popover.hide()
    const { left, top } = anchor(i)
    popover.show(i, left, top)
  }
  // A pointer event is a mouse event, so this serves the click too.
  const indexAt = (e: React.MouseEvent<SVGRectElement>) => {
    if (!geometry || count === 0) return null
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.floor(((e.clientX - box.left) / box.width) * count)
    return Math.min(Math.max(i, 0), count - 1)
  }
  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    const i = indexAt(e)
    if (i === null) return
    if (selection && e.pointerType === 'touch') {
      // A tap selects (onClick) and shows nothing: the page shows the selection.
      pin(i)
      if (popover.open) popover.hide()
      if (outline !== null) setOutline(null)
      return
    }
    const next = selection?.canSelect(rows[i]) ? { index: i, keyboard: false } : null
    const sameOutline = next?.index === outline?.index && next?.keyboard === outline?.keyboard
    // Moving within the same category (open, or one without a tooltip) changes
    // nothing: no re-render per pixel.
    if (i === cursor.current && sameOutline && (popover.open || tooltip(rows[i], i) === null))
      return
    setAnnounced(null)
    if (selection && !sameOutline) setOutline(next)
    open(i)
  }
  const onClick = (e: React.MouseEvent<SVGRectElement>) => {
    if (!selection) return
    const i = indexAt(e)
    if (i !== null && selection.canSelect(rows[i])) selection.onSelect(i)
  }

  const close = () => {
    cursor.current = null
    setCursorAt(null)
    popover.hide()
    setAnnounced(null)
    setOutline(null)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Browser shortcuts (Alt+← back, Cmd+Home …) pass through.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') return close()
    // Enter / Space act on what is shown: the outlined category. With nothing
    // outlined (say the mouse left) they do nothing here, so Space scrolls.
    if (selection && outlined !== null && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      // A held key selects once.
      if (!e.repeat && selection.canSelect(rows[outlined])) selection.onSelect(outlined)
      return
    }
    if (count === 0) return
    const last = count - 1
    // Clamped: a refetch may have returned fewer categories since. Other rows start the walk over (above).
    const current = cursorAt === null ? -1 : Math.min(cursor.current ?? -1, last)
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
    if (next === null) return
    e.preventDefault()
    open(next)
    if (selection) setOutline({ index: next, keyboard: true })
    setAnnounced(tooltip(rows[next], next) === null ? null : next)
  }

  const legendItems = [
    ...series.map(({ key, label: l, color, pattern, outline }) => ({
      key,
      label: l,
      color,
      pattern,
      outline,
    })),
    ...(line ? [{ key: line.key, label: line.label, color: line.color }] : []),
  ]
  const active =
    popover.open && popover.data !== undefined && popover.data < count ? popover.data : null
  const card = (i: number) => (
    <>
      {tooltipTitle ? <div className="font-medium">{category(rows[i])}</div> : null}
      <div className="grid gap-1.5">{tooltip(rows[i], i)}</div>
    </>
  )

  const tickText = (i: number) =>
    geometry?.short && shortCategory ? shortCategory(rows[i]) : category(rows[i])

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the group (or the caller's sr-only table) is the accessible path
    <svg
      data-chart-svg
      width={width}
      height={plotBoxH}
      aria-hidden
      className="block overflow-visible"
    >
      {series.some((s) => s.pattern === 'hatch') ? (
        <defs>
          {series
            .filter((s) => s.pattern === 'hatch')
            .map((s) => (
              <pattern
                key={s.key}
                id={`${patternId}-${s.key}`}
                width={5}
                height={5}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect
                  width={5}
                  height={5}
                  fill={`color-mix(in srgb, ${s.color} 40%, var(--card))`}
                />
                <rect width={2.5} height={5} fill={s.color} />
              </pattern>
            ))}
        </defs>
      ) : null}
      <Group left={geometry.left} top={marginTop}>
        {hideYAxis ? null : (
          <g data-grid>
            <GridRows
              scale={geometry.y.scale}
              tickValues={geometry.y.ticks}
              width={geometry.plotW}
              stroke="var(--border)"
              strokeOpacity={0.5}
            />
          </g>
        )}
        {selected === null ? null : (
          <rect
            data-slot="category-selected"
            x={geometry.x(selected) ?? 0}
            y={0}
            width={geometry.x.bandwidth()}
            height={geometry.plotH}
            fill="var(--brand)"
            fillOpacity={0.12}
            pointerEvents="none"
          />
        )}
        {series.map((s) => (
          <g key={s.key} data-series={s.key} data-kind="bar">
            {geometry.rects
              .filter((r) => r.key === s.key)
              .map((r) => {
                const common = {
                  'data-bar': true,
                  'data-index': r.index,
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height,
                  fill: s.outline
                    ? 'none'
                    : s.pattern === 'hatch'
                      ? `url(#${patternId}-${s.key})`
                      : s.color,
                  stroke: s.outline ? s.color : s.stroke,
                  strokeWidth: s.outline ? (s.strokeWidth ?? 1.5) : s.strokeWidth,
                }
                if (!s.radius) return <Bar key={r.index} {...common} />
                const end = r.value >= 0 ? { top: true } : { bottom: true }
                return (
                  <BarRounded
                    key={r.index}
                    {...common}
                    radius={s.radius}
                    {...(s.roundEndOnly ? end : { all: true })}
                  />
                )
              })}
          </g>
        ))}
        {barLabel
          ? (() => {
              // Placed by priority: the tallest stack first (smallest top y), ties left to right. A label whose
              // box would come within 4 px of one already placed is skipped. Drawn left to right.
              const measure = measureAt(tickPx)
              const items = range(count).flatMap((i) => {
                const text = barLabel(rows[i], i)
                const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
                if (text === null || tops.length === 0) return []
                return [{ i, text, top: Math.min(...tops), half: measure(text) / 2 }]
              })
              const placed: { left: number; right: number }[] = []
              const drawn = new Set<number>()
              for (const it of [...items].sort((p, q) => p.top - q.top || p.i - q.i)) {
                const c = geometry.centres[it.i]
                const left = c - it.half
                const right = c + it.half
                if (placed.some((o) => left < o.right + 4 && right > o.left - 4)) continue
                placed.push({ left, right })
                drawn.add(it.i)
              }
              return items
                .filter((it) => drawn.has(it.i))
                .map((it) => (
                  <text
                    key={it.i}
                    data-bar-label
                    x={geometry.centres[it.i]}
                    y={it.top - 6}
                    textAnchor="middle"
                    fontSize={tickPx}
                    fontWeight={600}
                    className="fill-foreground tabular-nums"
                    pointerEvents="none"
                  >
                    {it.text}
                  </text>
                ))
            })()
          : null}
        {line ? (
          <g data-series={line.key} data-kind="line">
            <LinePath
              data-line-curve
              data={range(count)}
              defined={(i) => at(i, line.key) !== null}
              x={(i) => geometry.centres[i]}
              y={(i) => lineScale(at(i, line.key) ?? 0)}
              stroke={line.color}
              strokeWidth={line.strokeWidth ?? 2}
              strokeDasharray={line.dash}
              fill="none"
            />
            {range(count)
              .filter((i) => at(i, line.key) !== null)
              .map((i) => (
                <circle
                  key={i}
                  data-line-dot
                  cx={geometry.centres[i]}
                  cy={lineScale(at(i, line.key) ?? 0)}
                  r={DOT_R}
                  fill="#fff"
                  stroke={line.color}
                  strokeWidth={2}
                />
              ))}
          </g>
        ) : null}
        {markers ? (
          // Visual only (the svg is aria-hidden): the caller's tooltip names what a mark means. After the line, so a
          // mark stays visible over its dots.
          <g data-markers pointerEvents="none">
            {range(count).flatMap((i) => {
              const list = markers(rows[i], i) ?? []
              if (list.length === 0) return []
              const tip = stackTop(i) - MARKER_GAP
              // Narrowed to the column (the band step), so several marks on a narrow day stay inside it: the mark
              // shrinks to MARKER_MIN_W, then the gap goes, then the mark shrinks on (the height stays).
              const step = Math.min(MARKER_W + MARKER_GAP, geometry.x.step() / list.length)
              const w = Math.min(step, Math.max(MARKER_MIN_W, step - MARKER_GAP))
              const centre = geometry.centres[i]
              const first = centre - ((list.length - 1) * step) / 2
              return list.map((mk, j) => {
                const cx = first + j * step
                return (
                  <g
                    key={`${i}-${mk.key}`}
                    data-marker={mk.key}
                    data-index={i}
                    data-across={mk.seriesKey === undefined ? true : undefined}
                  >
                    {mk.seriesKey === undefined ? (
                      <line
                        x1={centre}
                        x2={centre}
                        y1={0}
                        y2={geometry.plotH}
                        stroke={mk.color}
                        strokeOpacity={0.6}
                        strokeDasharray="3 3"
                      />
                    ) : null}
                    {/* ▼ pointing at the category's stack. */}
                    <path
                      d={`M${cx - w / 2},${tip - MARKER_H} L${cx + w / 2},${tip - MARKER_H} L${cx},${tip} Z`}
                      fill={mk.color}
                      stroke="var(--card)"
                      strokeWidth={1}
                    />
                  </g>
                )
              })
            })}
          </g>
        ) : null}
        {zeroLine ? (
          <line
            data-zero-line
            x1={0}
            x2={geometry.plotW}
            y1={geometry.y.scale(0)}
            y2={geometry.y.scale(0)}
            stroke="var(--border)"
          />
        ) : null}
        {hideYAxis ? null : (
          <g data-axis="y">
            <AxisLeft
              scale={geometry.y.scale}
              tickValues={geometry.y.ticks}
              tickFormat={(v) => yTickFormat(Number(v))}
              hideTicks
              tickLength={TICK_SIZE}
              hideAxisLine={!yAxisLine}
              stroke={AXIS_COLOR}
              tickLabelProps={() => ({
                ...tickLabel,
                dx: -Y_TICK_MARGIN,
                dy: '0.32em',
                textAnchor: 'end' as const,
              })}
            />
          </g>
        )}
        {geometry.yRight && line ? (
          <g data-axis="y-right">
            <AxisRight
              left={geometry.plotW}
              scale={geometry.yRight.scale}
              tickValues={geometry.yRight.ticks}
              tickFormat={(v) => (line.tickFormat ?? yTickFormat)(Number(v))}
              hideTicks
              tickLength={TICK_SIZE}
              hideAxisLine={!yAxisLine}
              stroke={AXIS_COLOR}
              tickLabelProps={() => ({
                ...tickLabel,
                dx: Y_TICK_MARGIN,
                dy: '0.32em',
                textAnchor: 'start' as const,
              })}
            />
          </g>
        ) : null}
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(i) => tickText(Number(i))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickLabelProps={(v) => ({
              ...tickLabel,
              dy: X_TICK_MARGIN,
              textAnchor: 'middle' as const,
              ...(Number(v) === selected ? { fontWeight: 600, fill: 'var(--foreground)' } : {}),
            })}
          />
        </g>
        {outlined === null ? null : (
          // The whole column, its label included, inset so it never clips at the chart's edges.
          <rect
            data-slot="category-outline"
            x={(geometry.x(outlined) ?? 0) + 2}
            y={-4}
            width={Math.max(0, geometry.x.bandwidth() - 4)}
            height={geometry.plotH + 4 + X_AXIS_H}
            rx={6}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray={dashed ? '4 3' : undefined}
            strokeOpacity={dashed ? 0.6 : 1}
            pointerEvents="none"
          />
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer surface in the aria-hidden svg; a selectable chart is labelled (BarSelection), and its group's onKeyDown (Enter / Space) is the keyboard path */}
        <rect
          data-hover-overlay
          width={geometry.plotW}
          // With selection the labels are clickable too.
          height={geometry.plotH + (selection ? X_AXIS_H : 0)}
          fill="transparent"
          // A horizontal finger drag scrubs across the categories (pointer
          // moves keep coming); a vertical one still scrolls the page.
          style={{
            touchAction: 'pan-y',
            cursor: outlined !== null && !outline?.keyboard ? 'pointer' : undefined,
          }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onClick={onClick}
          // Off the plot (onto an axis or the legend) the card closes, as
          // recharts' did; a lifted finger keeps it (ChartPopover's touch rule).
          onPointerLeave={(e) => {
            if (e.pointerType === 'touch') return
            popover.hide()
            if (outline !== null) setOutline(null)
          }}
        />
      </Group>
    </svg>
  ) : null

  const keyboard = label !== undefined
  // A labelled chart is one named Tab stop (the SessionPriceChart idiom).
  const focusProps = keyboard
    ? {
        'data-chart-focus': true,
        role: 'group',
        'aria-label': label,
        'aria-describedby': hintId,
        tabIndex: 0,
        onKeyDown,
        // Leaving the chart by keyboard closes its card, as recharts did:
        // a card left behind would cover whatever takes focus next.
        onBlur: close,
      }
    : {}
  return (
    <div
      data-chart="bar"
      {...popover.containerProps}
      aria-hidden={keyboard ? undefined : true}
      // The box is inline styles, not Tailwind: the plot must measure before
      // CSS loads and in the CSS-less browser tests.
      className="w-full text-xs"
      style={{ height, display: 'flex', flexDirection: 'column' }}
    >
      <div
        ref={parentRef}
        {...focusProps}
        className={cn(
          'rounded-sm',
          keyboard && 'outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50',
        )}
        style={{ flex: '1 1 0', minHeight: 0 }}
      >
        {svg}
      </div>
      {legend ? <ChartLegend items={legendItems} className={legendClassName} /> : null}
      {keyboard ? (
        <>
          <p id={hintId} className="sr-only">
            {keyboardHint ?? m.chart_keyboard_hint()}
          </p>
          {/* Read whole (atomic): only the changed text would otherwise be read,
              e.g. a new value without its series label. Always with its
              category, even when the card shows no title. */}
          <div className="sr-only" aria-live="polite" aria-atomic="true" data-chart-announce>
            {announced === null || announced >= count ? null : (
              <span key={announced}>
                {category(rows[announced])}
                {tooltip(rows[announced], announced)}
              </span>
            )}
          </div>
        </>
      ) : null}
      <ChartPopover
        // Anchored from the current layout on every render, so a refetch or a
        // resize moves the card with its category.
        state={active === null ? popover : { ...popover, ...anchor(active) }}
        variant="card"
        className={tooltipClassName}
        dataKey={active === null ? undefined : String(active)}
      >
        {active === null ? null : card(active)}
      </ChartPopover>
    </div>
  )
}
