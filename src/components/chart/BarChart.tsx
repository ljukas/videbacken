import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, BarRounded, LinePath } from '@visx/shape'
import { getStringWidth } from '@visx/text'
import { max, range } from 'd3-array'
import { scaleBand } from 'd3-scale'
import type * as React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
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
export type LineSeries = { key: string; label: string; color: string; dash?: string }

export type BarSelection<Row> = {
  /** The selected category's index, or null. An index outside the rows draws nothing. */
  selected: number | null
  onSelect: (index: number) => void
  /** Whether a category can be selected (the Energi chart: it has readings). */
  canSelect: (row: Row) => boolean
}

export type BarChartProps<Row> = {
  rows: readonly Row[]
  /** The category's x label (also the tooltip's title). */
  category: (row: Row) => string
  /** Bars in stack, legend and tooltip order (bottom to top within a stack). */
  series: readonly BarSeries[]
  /** A series' value for a row; null draws nothing. */
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
  /** With it every category is labelled: full labels when they fit, else every label short. */
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
  /** Click / tap / Enter selects a category; adds the selected tint, the outline and the pointer cursor. */
  selection?: BarSelection<Row>
}

const MARGIN = { top: 8, right: 12, bottom: 0, left: 4 }
const X_AXIS_H = 30
// recharts' tick size: labels keep their distance from the axis even with
// the tick lines hidden (visx places labels at tickLength too).
const TICK_SIZE = 6
const X_TICK_MARGIN = 8
const Y_TICK_MARGIN = 4
const TICK_PX = 12
// recharts' default axis colour; our ChartContainer never restyled it.
const AXIS = '#666'
const DOT_R = 3
const measureAt = (px: number) => (s: string) =>
  getStringWidth(s, { fontSize: px }) ?? s.length * px * 0.6

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
}: BarChartProps<Row>) {
  // No debounce: a resize that wraps the legend re-lays the plot at once,
  // as recharts' ResponsiveContainer did (a stale plot would overlap it).
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  // followScroll: the card is portalled, so it re-measures while a scroll
  // container moves the chart under it.
  const popover = useChartPopover<number>({ followScroll: true })
  const hintId = useId()
  const [announced, setAnnounced] = useState<number | null>(null)
  // The category the pointer or the keys last moved to (null: none). Kept apart
  // from the popover, which stays closed on a category without a tooltip: the
  // keyboard walk must step over it, not restart at the first category.
  const cursor = useRef<number | null>(null)
  // The outlined category (selection only): where the pointer or the keys
  // are. From the keyboard one that can't be selected is outlined dashed, so
  // focus stays visible; the pointer outlines only selectable ones; never touch.
  const [outline, setOutline] = useState<{ index: number; keyboard: boolean } | null>(null)
  const at = (i: number, key: string) => value(rows[i], key)
  const count = rows.length
  const tickLabel = { fill: 'var(--muted-foreground)', fontSize: tickPx }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is rows + value, both listed
  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const keys = line ? [...series, { key: line.key, label: '', color: '' }] : series
    const measure = measureAt(tickPx)
    const extent = stackExtent({ count, series: keys, value: at, offset: stackOffset })
    const plotH = Math.max(0, plotBoxH - MARGIN.top - MARGIN.bottom - X_AXIS_H)
    const y = yScaleFor({ extent, height: plotH, integers: yIntegers, domain: yDomain })
    const yLabels = y.ticks.map(yTickFormat)
    const yAxisW = hideYAxis ? 0 : (max(yLabels, measure) ?? 0) + TICK_SIZE + Y_TICK_MARGIN + 2
    const left = MARGIN.left + yAxisW
    const plotW = Math.max(0, width - left - MARGIN.right)
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
    return { x, y, left, plotW, plotH, xTicks, rects, centres, short }
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
  ])

  // The card's anchor: the category's centre, at the top of its tallest bar.
  const anchor = (i: number) => {
    if (!geometry) return { left: 0, top: 0 }
    const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
    // The line's dot too, so the card never covers it.
    const dot = line ? at(i, line.key) : null
    if (dot !== null) tops.push(geometry.y.scale(dot) - DOT_R)
    return {
      left: geometry.left + geometry.centres[i],
      top: MARGIN.top + Math.min(geometry.plotH, ...tops),
    }
  }
  const open = (i: number) => {
    cursor.current = i
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
      cursor.current = i
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
    popover.hide()
    setAnnounced(null)
    setOutline(null)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Browser shortcuts (Alt+← back, Cmd+Home …) pass through.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') return close()
    if (selection && (e.key === 'Enter' || e.key === ' ')) {
      // Space would scroll the page; Enter has nothing else to do here.
      e.preventDefault()
      const i = cursor.current
      if (i !== null && i < count && selection.canSelect(rows[i])) selection.onSelect(i)
      return
    }
    if (count === 0) return
    const last = count - 1
    // Clamped: a refetch may have returned fewer categories since.
    const current = Math.min(cursor.current ?? -1, last)
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
    ...series.map(({ key, label: l, color }) => ({ key, label: l, color })),
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

  const selected =
    selection?.selected != null && selection.selected >= 0 && selection.selected < count
      ? selection.selected
      : null
  const outlined = selection && outline !== null && outline.index < count ? outline.index : null
  const dashed = outlined !== null && !selection?.canSelect(rows[outlined])

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the group (or the caller's sr-only table) is the accessible path
    <svg
      data-chart-svg
      width={width}
      height={plotBoxH}
      aria-hidden
      className="block overflow-visible"
    >
      <Group left={geometry.left} top={MARGIN.top}>
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
                  fill: s.color,
                  stroke: s.stroke,
                  strokeWidth: s.strokeWidth,
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
        {line ? (
          <g data-series={line.key} data-kind="line">
            <LinePath
              data-line-curve
              data={range(count)}
              defined={(i) => at(i, line.key) !== null}
              x={(i) => geometry.centres[i]}
              y={(i) => geometry.y.scale(at(i, line.key) ?? 0)}
              stroke={line.color}
              strokeWidth={2}
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
                  cy={geometry.y.scale(at(i, line.key) ?? 0)}
                  r={DOT_R}
                  fill="#fff"
                  stroke={line.color}
                  strokeWidth={2}
                />
              ))}
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
              stroke={AXIS}
              tickLabelProps={() => ({
                ...tickLabel,
                dx: -Y_TICK_MARGIN,
                dy: '0.32em',
                textAnchor: 'end' as const,
              })}
            />
          </g>
        )}
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(i) => tickText(Number(i))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS}
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer surface in the aria-hidden svg; the keyboard path is the group's onKeyDown (Enter / Space) */}
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
      // CSS loads and in the CSS-less browser tests (as ChartFrame does).
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
