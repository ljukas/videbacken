import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { scaleLinear } from 'd3-scale'
import type * as React from 'react'
import { useId, useMemo, useRef } from 'react'
import {
  AXIS_COLOR,
  CHART_MARGIN,
  measureAt,
  TICK_PX,
  TICK_SIZE,
  X_AXIS_H,
  X_TICK_MARGIN,
  Y_TICK_MARGIN,
  yAxisWidth,
} from '~/components/chart/axis'
import { TooltipRow } from '~/components/chart/ChartParts'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatDay, formatDecimal } from '~/components/evCharging/format'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { m } from '~/paraglide/messages'
import { formatCelsius, formatKwhOneDecimal } from './format'
import { nearestPoint, type Segment, signatureDomains, signatureSegments } from './signatureChart'

/** The whole chart's height, legend included (fixed: switching unit or event moves nothing). */
export const SIGNATURE_CHART_HEIGHT = 300
export const SIGNATURE_COLORS = {
  before: 'var(--signature-before)',
  after: 'var(--signature-after)',
} as const
/** Room for an axis title beside its axis. */
const TITLE_GAP = 18
/** Marker radius: 8 px marks (dataviz). */
const R = 4
/** The after line's dash: the two lines differ by more than colour (dataviz). */
const AFTER_DASH = '6 4'

const setLabel = (p: SignaturePoint) =>
  p.set === 'before' ? m.heat_pump_signature_before() : m.heat_pump_signature_after()

// The Energisignatur scatter (step 4b): x = the day's indoor − outdoor ΔT, y = its kWh;
// before-days filled circles, after-days filled squares, extrapolated after-days hollow
// squares; each set's fitted line over its own ΔT range. Visual only (aria-hidden): the
// card's readout and its "Visa som tabell" carry everything. Hover snaps to the nearest
// point within 24 px and shows it in the shared chart card.
export function SignatureScatter({ result }: { result: SignatureResult }) {
  // No debounce: a resize re-lays the plot at once (BarChart's rule).
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  const clipId = useId()
  const popover = useChartPopover<number>({ followScroll: true })
  const cursor = useRef<number | null>(null)
  const { points } = result
  const segments = useMemo(() => signatureSegments(result), [result])

  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const lines = [segments.before, segments.after].filter((s): s is Segment => s !== null)
    const domains = signatureDomains(points, lines)
    const plotH = Math.max(0, plotBoxH - CHART_MARGIN.top - X_AXIS_H - TITLE_GAP)
    const y = scaleLinear().domain(domains.y).range([plotH, 0])
    const yTicks = y.ticks(5)
    const left =
      CHART_MARGIN.left + TITLE_GAP + yAxisWidth(yTicks.map(formatDecimal), measureAt(TICK_PX))
    const plotW = Math.max(0, width - left - CHART_MARGIN.right)
    const x = scaleLinear().domain(domains.x).range([0, plotW])
    const xTicks = x.ticks(plotW < 360 ? 4 : 8)
    const pixels = points.map((p) => ({ x: x(p.deltaT), y: y(p.kwh) }))
    return { x, y, xTicks, yTicks, left, plotW, plotH, pixels }
  }, [width, plotBoxH, points, segments])

  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry) return
    const box = e.currentTarget.getBoundingClientRect()
    const i = nearestPoint(geometry.pixels, e.clientX - box.left, e.clientY - box.top)
    // Same point (or still none): no re-render per pixel.
    if (i === cursor.current && (i === null || popover.open)) return
    cursor.current = i
    if (i === null) return popover.hide()
    popover.show(
      i,
      geometry.left + geometry.pixels[i].x,
      CHART_MARGIN.top + geometry.pixels[i].y - R,
    )
  }
  const active =
    popover.open && popover.data !== undefined && popover.data < points.length ? popover.data : null

  const line = (s: Segment | null, key: 'before' | 'after') =>
    s && geometry ? (
      <line
        data-fit={key}
        x1={geometry.x(s.x1)}
        y1={geometry.y(s.y1)}
        x2={geometry.x(s.x2)}
        y2={geometry.y(s.y2)}
        stroke={SIGNATURE_COLORS[key]}
        strokeWidth={2}
        strokeDasharray={key === 'after' ? AFTER_DASH : undefined}
        strokeLinecap="round"
        pointerEvents="none"
      />
    ) : null

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the card's readout and table are the accessible path
    <svg
      data-chart-svg
      width={width}
      height={plotBoxH}
      aria-hidden
      className="block overflow-visible"
    >
      <Group left={geometry.left} top={CHART_MARGIN.top}>
        {/* The fit lines stop at the plot's edges: a line can dip below 0 kWh at low ΔT, and
            the axis stays at 0 (kWh can't be negative). The markers are never outside. */}
        <clipPath id={clipId}>
          <rect width={geometry.plotW} height={geometry.plotH} />
        </clipPath>
        <g data-grid>
          <GridRows
            scale={geometry.y}
            tickValues={geometry.yTicks}
            width={geometry.plotW}
            stroke="var(--border)"
            strokeOpacity={0.5}
          />
        </g>
        <g data-fits clipPath={`url(#${clipId})`}>
          {line(segments.before, 'before')}
          {line(segments.after, 'after')}
        </g>
        {points.map((p, i) => {
          const { x, y } = geometry.pixels[i]
          const color = SIGNATURE_COLORS[p.set]
          // A 1,5 px card-coloured ring keeps overlapping marks apart (dataviz).
          return p.set === 'before' ? (
            <circle
              key={p.day}
              data-point={p.day}
              data-set="before"
              cx={x}
              cy={y}
              r={R}
              fill={color}
              stroke="var(--card)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          ) : (
            <rect
              key={p.day}
              data-point={p.day}
              data-set="after"
              data-extrapolated={p.extrapolated || undefined}
              x={x - R}
              y={y - R}
              width={2 * R}
              height={2 * R}
              rx={1}
              fill={p.extrapolated ? 'var(--card)' : color}
              stroke={p.extrapolated ? color : 'var(--card)'}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )
        })}
        <g data-axis="y">
          <AxisLeft
            scale={geometry.y}
            tickValues={geometry.yTicks}
            tickFormat={(v) => formatDecimal(Number(v))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dx: -Y_TICK_MARGIN,
              dy: '0.32em',
              textAnchor: 'end' as const,
            })}
          />
        </g>
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(v) => formatDecimal(Number(v))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dy: X_TICK_MARGIN,
              textAnchor: 'middle' as const,
            })}
          />
        </g>
        <text
          data-axis-label="x"
          x={geometry.plotW / 2}
          y={geometry.plotH + X_AXIS_H + TITLE_GAP - 4}
          textAnchor="middle"
          fontSize={TICK_PX}
          fill="var(--muted-foreground)"
        >
          {m.heat_pump_signature_axis_x()}
        </text>
        <text
          data-axis-label="y"
          transform="rotate(-90)"
          x={-geometry.plotH / 2}
          y={-geometry.left + CHART_MARGIN.left + TICK_PX}
          textAnchor="middle"
          fontSize={TICK_PX}
          fill="var(--muted-foreground)"
        >
          {m.heat_pump_signature_axis_y()}
        </text>
        {/* A pointer surface in the aria-hidden svg; the card's table is the keyboard path. */}
        <rect
          data-hover-overlay
          width={geometry.plotW}
          height={geometry.plotH}
          fill="transparent"
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={(e) => {
            if (e.pointerType === 'touch') return
            cursor.current = null
            popover.hide()
          }}
        />
      </Group>
    </svg>
  ) : null

  return (
    <div
      data-chart="scatter"
      {...popover.containerProps}
      aria-hidden
      // Inline box: the plot must measure before CSS loads and in the CSS-less browser tests.
      className="w-full text-xs"
      style={{ height: SIGNATURE_CHART_HEIGHT, display: 'flex', flexDirection: 'column' }}
    >
      <div ref={parentRef} style={{ flex: '1 1 0', minHeight: 0 }}>
        {svg}
      </div>
      {/* Always all three items, so the legend's height never changes with the data. */}
      <div
        data-slot="signature-legend"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3 text-sm"
      >
        <LegendItem shape="circle" label={m.heat_pump_signature_before()} />
        <LegendItem shape="square" label={m.heat_pump_signature_after()} />
        <LegendItem shape="hollow" label={m.heat_pump_signature_extrapolated()} />
      </div>
      <ChartPopover
        state={
          active === null || !geometry
            ? popover
            : {
                ...popover,
                left: geometry.left + geometry.pixels[active].x,
                top: CHART_MARGIN.top + geometry.pixels[active].y - R,
              }
        }
        variant="card"
        dataKey={active === null ? undefined : points[active].day}
      >
        {active === null ? null : (
          <>
            <div className="font-medium">{formatDay(points[active].day)}</div>
            <div className="grid gap-1.5">
              <TooltipRow label={m.heat_pump_signature_tooltip_delta()}>
                {formatCelsius(points[active].deltaT)}
              </TooltipRow>
              <TooltipRow
                label={m.heat_pump_signature_tooltip_kwh()}
                color={SIGNATURE_COLORS[points[active].set]}
              >
                {formatKwhOneDecimal(points[active].kwh)}
              </TooltipRow>
              <div className="text-muted-foreground">
                {points[active].extrapolated
                  ? m.heat_pump_signature_extrapolated()
                  : setLabel(points[active])}
              </div>
            </div>
          </>
        )}
      </ChartPopover>
    </div>
  )
}

/**
 * A legend swatch: the set's marker on a short stroke of its line (solid before, the
 * plot's dash after: dash, marker, dash), so the lines aren't told apart by colour
 * alone. No stroke for the extrapolated days: they have no line.
 */
function LegendItem({ shape, label }: { shape: 'circle' | 'square' | 'hollow'; label: string }) {
  const color = shape === 'circle' ? SIGNATURE_COLORS.before : SIGNATURE_COLORS.after
  return (
    <div data-legend-item className="flex items-center gap-1.5">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative swatch; the label beside it names it */}
      <svg width={28} height={10} aria-hidden className="shrink-0">
        {shape === 'hollow' ? null : (
          <line
            x1={0}
            y1={5}
            x2={28}
            y2={5}
            stroke={color}
            strokeWidth={2}
            strokeDasharray={shape === 'square' ? AFTER_DASH : undefined}
          />
        )}
        {shape === 'circle' ? (
          <circle cx={14} cy={5} r={4} fill={color} stroke="var(--card)" strokeWidth={1.5} />
        ) : (
          <rect
            x={10}
            y={1}
            width={8}
            height={8}
            rx={1}
            fill={shape === 'hollow' ? 'var(--card)' : color}
            stroke={shape === 'hollow' ? color : 'var(--card)'}
            strokeWidth={1.5}
          />
        )}
      </svg>
      {label}
    </div>
  )
}
