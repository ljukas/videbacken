import { AxisBottom, AxisLeft } from '@visx/axis'
import { curveMonotoneX } from '@visx/curve'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { LinePath } from '@visx/shape'
import { bisectCenter } from 'd3-array'
import { scaleLinear } from 'd3-scale'
import type * as React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { ChartLegend } from '~/components/chart/ChartParts'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import {
  type ClimateTooltipRow,
  nearestReadings,
  niceYScale,
  type SeriesPoint,
  timeDomain,
  valueRange,
} from '~/lib/sensor/chartData'
import { CADENCE_SEC } from '~/lib/sensor/range'
import type { TimeAxis } from '~/lib/sensor/tickFormat'
import { m } from '~/paraglide/messages'
import { nearestTime, pickTimeTicks, readingTimes } from './climateLayout'

export type ClimateChartDevice = {
  id: string
  displayName: string
  // Stable color assigned by the parent from the FULL device roster, so a device
  // keeps its color regardless of which siblings are toggled off.
  color: string
  hidden?: boolean
  // This device's own readings (ascending t) with outage break markers already
  // inserted by toDeviceSeries — `<id>: null` is a real gap, not structural noise.
  points: SeriesPoint[]
}

type Props = {
  devices: ClimateChartDevice[]
  unit: string // "°C" | "%"
  /** The card's time header (range-aware). */
  formatTick: (t: number) => string
  /** The time axis' round ticks and labels (makeTimeAxis). */
  timeAxis: TimeAxis
  /** The chart's accessible name: its section's title. */
  label: string
}

const HEIGHT = 260
const ISOLATED_DOT_R = 3
const ACTIVE_DOT_R = 4
// A reading counts for a hovered time within one reporting cadence (nearestReadings).
const WINDOW_MS = CADENCE_SEC * 1000

// The legend's order: by display name, as recharts' legend sorted its entries
// (plain code-unit comparison, so "Visible one" comes before "a").
const byName = (a: ClimateChartDevice, b: ClimateChartDevice) =>
  a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0

// The card: one row per visible device, each at its reading nearest the
// hovered time. A row shows its own time only when it differs from the header
// (the hovered reading's time), so a sensor's offset stays visible.
function CardContent({
  t,
  rows,
  unit,
  formatTick,
}: {
  t: number
  rows: ClimateTooltipRow[]
  unit: string
  formatTick: (t: number) => string
}) {
  return (
    <>
      <div className="font-medium">{formatTick(t)}</div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div key={row.id} className="flex w-full items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="inline-block size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
              {row.displayName}
            </span>
            <span className="flex items-baseline gap-2">
              {row.t !== t ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatTick(row.t)}
                </span>
              ) : null}
              <span className="font-medium font-mono text-foreground tabular-nums">
                {row.value.toFixed(1)}
                <span className="ml-0.5 font-sans text-muted-foreground">{unit}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// One coloured line per visible device on a shared time axis, drawn with visx
// on d3 scales (the geometry in climateLayout.ts). Each line reads its own
// points, so a null is only an outage break. The time axis spans every device,
// hidden ones too, so a toggle never rescales time; the y axis spans the
// visible ones. Hover snaps to the nearest reading of any visible device and
// shows every device's reading nearest that time. The section's <h2> names the
// chart, so the svg has no <title>.
export function ClimateChart({ devices, unit, formatTick, timeAxis, label }: Props) {
  // No debounce: a resize that wraps the legend re-lays the plot at once.
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  // followScroll: the card is portalled, so it re-measures while a scroll
  // container moves the chart under it.
  const popover = useChartPopover<number>({ followScroll: true })
  // The reading time the pointer last moved to (Task 5's keys continue from it).
  const cursor = useRef<number | null>(null)
  const hintId = useId()
  // The time the keyboard last stepped to, read out by the live region; a mouse move clears it.
  const [announced, setAnnounced] = useState<number | null>(null)
  const times = useMemo(() => readingTimes(devices), [devices])
  const visible = useMemo(() => devices.filter((d) => !d.hidden), [devices])

  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const measure = measureAt(TICK_PX)
    const plotH = Math.max(0, plotBoxH - CHART_MARGIN.top - CHART_MARGIN.bottom - X_AXIS_H)
    const values = valueRange(devices)
    const yNice = values ? niceYScale(values[0], values[1]) : null
    const yFormat = (v: number) => `${v.toFixed(yNice?.decimals ?? 0)}${unit}`
    const yTicks = yNice?.ticks ?? []
    const y = scaleLinear()
      .domain(yNice?.domain ?? [0, 1])
      .range([plotH, 0])
    const left = CHART_MARGIN.left + (yNice ? yAxisWidth(yTicks.map(yFormat), measure) : 0)
    const plotW = Math.max(0, width - left - CHART_MARGIN.right)
    const domain = timeDomain(devices)
    const x = scaleLinear()
      .domain(domain ?? [0, 1])
      .range([0, plotW])
    const xTicks = domain ? pickTimeTicks({ domain, x, axis: timeAxis, measure }) : []
    return { x, y, yTicks, yFormat, left, plotW, plotH, xTicks }
  }, [width, plotBoxH, devices, unit, timeAxis])

  // The open time's rows. Empty when the data moved away from it (a refetch or
  // a range switch): then nothing shows, not a stale card.
  const active = popover.open && popover.data !== undefined ? popover.data : null
  const rows = active === null ? [] : nearestReadings(devices, active, WINDOW_MS)
  const shown = active !== null && rows.length > 0 && geometry !== null ? active : null
  // …and the card closes for good: a later refetch that brings the time back
  // must not pop it up again unprompted.
  const stale = active !== null && shown === null
  const { hide } = popover
  useEffect(() => {
    if (stale) {
      // The next → starts from the first reading, not from a time the data dropped.
      cursor.current = null
      setAnnounced(null)
      hide()
    }
  }, [stale, hide])

  // The card's anchor: time `t`, above the highest of its rows' dots.
  const anchor = (t: number, at: readonly ClimateTooltipRow[]) => {
    if (!geometry) return { left: 0, top: 0 }
    return {
      left: geometry.left + geometry.x(t),
      top:
        CHART_MARGIN.top +
        Math.min(geometry.plotH, ...at.map((r) => geometry.y(r.value))) -
        ACTIVE_DOT_R,
    }
  }
  const open = (t: number) => {
    cursor.current = t
    const { left, top } = anchor(t, nearestReadings(devices, t, WINDOW_MS))
    popover.show(t, left, top)
  }
  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry) return
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    const t = nearestTime(
      times,
      geometry.x.invert(((e.clientX - box.left) / box.width) * geometry.plotW),
    )
    // Nothing visible: no reading to show. Same reading: no re-render per pixel.
    if (t === null || (popover.open && popover.data === t)) return
    setAnnounced(null)
    open(t)
  }
  const close = () => {
    cursor.current = null
    popover.hide()
    setAnnounced(null)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Browser shortcuts (Alt+← back, Cmd+Home …) pass through.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'Escape') return close()
    if (times.length === 0) return
    const last = times.length - 1
    // Found again by time: a refetch may have shifted every index since.
    const current = cursor.current === null ? null : bisectCenter(times, cursor.current)
    const next =
      e.key === 'ArrowRight'
        ? current === null
          ? 0
          : Math.min(current + 1, last)
        : e.key === 'ArrowLeft'
          ? current === null
            ? last
            : Math.max(current - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    open(times[next])
    setAnnounced(times[next])
  }

  // The lines and isolated dots, kept across hovers: a pointer move re-renders
  // only the cursor, the active dots and the card.
  const series = useMemo(
    () =>
      geometry === null
        ? null
        : visible.map((d) => (
            <g key={d.id} data-series={d.id} data-kind="line">
              <LinePath
                data-line-curve
                data={d.points}
                // Outage markers break the line (recharts' connectNulls={false}).
                defined={(p) => typeof p[d.id] === 'number'}
                x={(p) => geometry.x(p.t)}
                y={(p) => geometry.y(p[d.id] as number)}
                curve={curveMonotoneX}
                stroke={d.color}
                strokeWidth={2}
                fill="none"
              />
              {d.points
                .filter((p) => p.isolated && typeof p[d.id] === 'number')
                .map((p) => (
                  <circle
                    key={p.t}
                    data-reading-dot
                    cx={geometry.x(p.t)}
                    cy={geometry.y(p[d.id] as number)}
                    r={ISOLATED_DOT_R}
                    fill={d.color}
                    stroke={d.color}
                  />
                ))}
            </g>
          )),
    [visible, geometry],
  )

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the labelled group is the accessible path
    <svg
      data-chart-svg
      width={width}
      height={plotBoxH}
      aria-hidden
      className="block overflow-visible"
    >
      <Group left={geometry.left} top={CHART_MARGIN.top}>
        {geometry.yTicks.length === 0 ? null : (
          <g data-grid>
            <GridRows
              scale={geometry.y}
              tickValues={geometry.yTicks}
              width={geometry.plotW}
              stroke="var(--border)"
              strokeOpacity={0.5}
            />
          </g>
        )}
        {series}
        {geometry.yTicks.length === 0 ? null : (
          <g data-axis="y">
            <AxisLeft
              scale={geometry.y}
              tickValues={geometry.yTicks}
              tickFormat={(v) => geometry.yFormat(Number(v))}
              tickLength={TICK_SIZE}
              stroke={AXIS_COLOR}
              tickStroke={AXIS_COLOR}
              tickLabelProps={() => ({
                fill: 'var(--muted-foreground)',
                fontSize: TICK_PX,
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
            tickFormat={(t) => timeAxis.format(Number(t))}
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dy: X_TICK_MARGIN,
              textAnchor: 'middle' as const,
            })}
          />
        </g>
        {/* The hover paints over the lines and axes, as recharts' did (its z-index layers). */}
        {shown === null ? null : (
          <line
            data-hover-cursor
            x1={geometry.x(shown)}
            x2={geometry.x(shown)}
            y1={0}
            y2={geometry.plotH}
            stroke="var(--border)"
            pointerEvents="none"
          />
        )}
        {shown === null
          ? null
          : rows.map((r) => (
              <circle
                key={r.id}
                data-active-dot
                cx={geometry.x(r.t)}
                cy={geometry.y(r.value)}
                r={ACTIVE_DOT_R}
                fill={r.color}
                pointerEvents="none"
              />
            ))}
        {/* A pointer surface in the aria-hidden svg; the labelled group is the keyboard path. */}
        <rect
          data-hover-overlay
          width={geometry.plotW}
          height={geometry.plotH}
          fill="transparent"
          // A horizontal finger drag scrubs through the readings; a vertical one scrolls.
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          // Off the plot the card closes; a lifted finger keeps it (ChartPopover's touch rule).
          onPointerLeave={(e) => {
            if (e.pointerType !== 'touch') popover.hide()
          }}
        />
      </Group>
    </svg>
  ) : null

  return (
    <div
      data-chart="line"
      {...popover.containerProps}
      // The box is inline styles, not Tailwind: the plot must measure before
      // CSS loads and in the CSS-less browser tests.
      className="w-full text-xs"
      style={{ height: HEIGHT, display: 'flex', flexDirection: 'column' }}
    >
      {/* A named group that takes focus; the svg inside stays aria-hidden. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a chart, not a form's fieldset */}
      <div
        ref={parentRef}
        data-chart-focus
        role="group"
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart's one named Tab stop, the keyboard path to its card
        tabIndex={0}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onBlur={close}
        className="rounded-sm outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ flex: '1 1 0', minHeight: 0 }}
      >
        {svg}
      </div>
      <ChartLegend
        items={[...devices]
          .sort(byName)
          .map((d) => ({ key: d.id, label: d.displayName, color: d.color }))}
      />
      <p id={hintId} className="sr-only">
        {m.sensors_chart_keyboard_hint()}
      </p>
      {/* Read whole (atomic): only the changed text would otherwise be read. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-chart-announce>
        {announced === null ? null : (
          <span key={announced}>
            <CardContent
              t={announced}
              rows={nearestReadings(devices, announced, WINDOW_MS)}
              unit={unit}
              formatTick={formatTick}
            />
          </span>
        )}
      </div>
      <ChartPopover
        // Anchored from the current layout on every render, so a refetch or a
        // resize moves the card with its time.
        state={
          shown === null ? { ...popover, open: false } : { ...popover, ...anchor(shown, rows) }
        }
        variant="card"
        dataKey={shown === null ? undefined : String(shown)}
      >
        {shown === null ? null : (
          <CardContent t={shown} rows={rows} unit={unit} formatTick={formatTick} />
        )}
      </ChartPopover>
    </div>
  )
}
