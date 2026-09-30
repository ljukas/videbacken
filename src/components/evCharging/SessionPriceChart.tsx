import { tz } from '@date-fns/tz'
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis'
import { curveStepAfter } from '@visx/curve'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, LinePath } from '@visx/shape'
import { max, min, range, sum } from 'd3-array'
import { scaleLinear, scaleTime } from 'd3-scale'
import { getHours } from 'date-fns'
import { millisecondsInHour } from 'date-fns/constants'
import { useId, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import type { RouterOutputs } from '~/lib/orpc/client'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { ChartPopover, useChartPopover } from './ChartPopover'
import { formatOneDecimal, formatOre, formatTime } from './format'

type Detail = RouterOutputs['evCharging']['session']
type Stretch = Detail['intervals'][number]
type Slot = Detail['prices'][number]
type StepPoint = { t: number; ore: number | null }

const HEIGHT = 260
const MARGIN = { top: 20, right: 44, bottom: 28, left: 44 }
const NARROW_PX = 480
const TICK_STEPS_H = [1, 2, 3, 4, 6, 12, 24]

// Series colours keep >=3:1 against the card in both themes (--chart-1 and
// --chart-4 fail one theme each; see EconomyMonthlyChart). Light / dark:
//   actual   --chart-3     9.1 / 8.1
//   optimal  --chart-2     3.7 / 7.0 (a dashed outline over the bars)
//   spot     --foreground  ~18 / ~14, over a card-coloured halo so the line
//            stays readable where it crosses a bar
// Outside the plug-in window is a --muted background, not a series.
const ACTUAL = 'var(--chart-3)'
const OPTIMAL = 'var(--chart-2)'
const SPOT = 'var(--foreground)'
const OUTSIDE = 'var(--muted)'
const TICK_LABEL = () => ({ className: 'fill-muted-foreground text-[10px]' })

// Average kW over the stretch, so an hour bar and a quarter bar compare fairly.
const avgKw = (s: Stretch) => (s.kwh / (s.endMs - s.startMs)) * millisecondsInHour

/**
 * The kWh of `stretches` that falls inside `slot`, each stretch's energy spread
 * evenly over its span; null when no stretch overlaps it (no data, not 0 kWh).
 * The tooltip and the sr-only table both read this, so they always agree.
 */
function kwhWithin(stretches: readonly Stretch[], slot: Slot): number | null {
  const overlap = (s: Stretch) => Math.min(s.endMs, slot.endMs) - Math.max(s.startMs, slot.startMs)
  const overlapping = stretches.filter((s) => overlap(s) > 0)
  if (overlapping.length === 0) return null
  return sum(overlapping, (s) => (s.kwh * overlap(s)) / (s.endMs - s.startMs))
}

const kwhLabel = (kwh: number | null) => (kwh === null ? '—' : formatOneDecimal(kwh))
const oreLabel = (ore: number | null) => (ore === null ? '—' : formatOre(ore))
const slotLabel = (slot: Slot) =>
  `${formatTime(new Date(slot.startMs))}–${formatTime(new Date(slot.endMs))}`

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
// hours start on UTC hours (a whole-hour offset).
function hourTicks(startMs: number, endMs: number, maxTicks: number): number[] {
  const first = Math.ceil(startMs / millisecondsInHour) * millisecondsInHour
  const hours = range(first, endMs + 1, millisecondsInHour)
  const step = TICK_STEPS_H.find((s) => hours.length / s <= maxTicks) ?? 24
  return hours.filter((ms) => getHours(ms, { in: tz(STOCKHOLM_TIME_ZONE) }) % step === 0)
}

// A session's energy (bars at their true times: Zaptec's hourly intervals)
// against the 15-min spot price (a step line), with the cheapest schedule as
// dashed ghost bars. Mixed resolution needs a real time axis, hence visx +
// d3-scale rather than Recharts' category axis. Outside the plug-in window is
// shaded. An estimated session has no intervals: no bars, still the price.
export function SessionPriceChart({ detail }: { detail: Detail }) {
  const headingId = useId()
  const toggleId = useId()
  const [showOptimal, setShowOptimal] = useState(true)
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const popover = useChartPopover<Slot>()
  const { markProps, containerProps } = popover
  const { window: win, intervals, prices, optimalSchedule } = detail

  // The SVG depends only on layout + data, so hovering doesn't redraw it.
  const svg = useMemo(() => {
    if (width <= 0) return null
    const innerW = Math.max(0, width - MARGIN.left - MARGIN.right)
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom
    const startMs = Math.min(win.startMs - millisecondsInHour, prices[0]?.startMs ?? Infinity)
    const endMs = Math.max(win.endMs + millisecondsInHour, prices.at(-1)?.endMs ?? -Infinity)
    const x = scaleTime().domain([startMs, endMs]).range([0, innerW])
    const charged = intervals.filter((s) => s.kwh > 0 && s.endMs > s.startMs)
    const optimal = (optimalSchedule ?? []).filter((s) => s.endMs > s.startMs)
    // The kW scale includes the schedule even while it's hidden, so the toggle never rescales.
    const yKw = scaleLinear()
      .domain([0, Math.max(1, max([...charged, ...optimal], avgKw) ?? 0)])
      .nice()
      .range([innerH, 0])
    const ores = prices.flatMap((p) => (p.spotOre === null ? [] : [p.spotOre]))
    // Negative spot prices happen: the price axis reaches below 0 to keep them.
    const yOre = scaleLinear()
      .domain([Math.min(0, min(ores) ?? 0), Math.max(1, max(ores) ?? 0)])
      .nice()
      .range([innerH, 0])
    const bar = (s: Stretch) => {
      const x0 = x(s.startMs)
      const y0 = yKw(avgKw(s))
      return { x: x0, y: y0, width: Math.max(1, x(s.endMs) - x0 - 1), height: innerH - y0 }
    }
    const steps = stepPoints(prices)
    const line = {
      data: steps,
      x: (d: StepPoint) => x(d.t),
      y: (d: StepPoint) => yOre(d.ore ?? 0),
      defined: (d: StepPoint) => d.ore !== null,
      curve: curveStepAfter,
    }
    const winStart = Math.max(0, x(win.startMs))
    const winEnd = Math.min(innerW, x(win.endMs))
    const axisProps = { stroke: 'var(--border)', tickStroke: 'var(--border)' }

    // Named like the table below, which carries the same numbers for screen readers.
    return (
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={m.charging_session_chart_table_caption()}
      >
        <Group left={MARGIN.left} top={MARGIN.top}>
          <rect x={0} y={0} width={winStart} height={innerH} style={{ fill: OUTSIDE }} />
          <rect
            x={winEnd}
            y={0}
            width={Math.max(0, innerW - winEnd)}
            height={innerH}
            style={{ fill: OUTSIDE }}
          />
          {charged.map((s) => (
            <Bar
              key={`a${s.startMs}`}
              data-series="actual"
              {...bar(s)}
              rx={2}
              style={{ fill: ACTUAL }}
            />
          ))}
          {showOptimal
            ? optimal.map((s) => (
                <Bar
                  key={`o${s.startMs}`}
                  data-series="optimal"
                  {...bar(s)}
                  style={{
                    fill: 'none',
                    stroke: OPTIMAL,
                    strokeWidth: 1.5,
                    strokeDasharray: '4 2',
                  }}
                />
              ))
            : null}
          <LinePath
            {...line}
            style={{ fill: 'none', stroke: 'var(--card)', strokeWidth: 5, strokeLinejoin: 'round' }}
          />
          <LinePath
            {...line}
            data-series="spot"
            style={{ fill: 'none', stroke: SPOT, strokeWidth: 2, strokeLinejoin: 'round' }}
          />
          {/* Hover/tap targets, one per price slot. Keyboard and screen-reader
              users read the table below instead, so they take no focus. */}
          {prices.map((p) => {
            const x0 = x(p.startMs)
            const x1 = x(p.endMs)
            const top = p.spotOre === null ? innerH / 2 : yOre(p.spotOre)
            return (
              <rect
                key={`h${p.startMs}`}
                data-hover-slot={p.startMs}
                x={x0}
                y={0}
                width={Math.max(1, x1 - x0)}
                height={innerH}
                style={{ fill: 'transparent' }}
                {...markProps(p, MARGIN.left + (x0 + x1) / 2, MARGIN.top + top)}
              />
            )
          })}
          <AxisBottom
            top={innerH}
            scale={x}
            tickValues={hourTicks(startMs, endMs, width < NARROW_PX ? 4 : 8)}
            tickFormat={(d) => formatTime(new Date(Number(d)))}
            tickLabelProps={TICK_LABEL}
            {...axisProps}
          />
          <AxisLeft
            scale={yKw}
            numTicks={4}
            tickFormat={(v) => formatOneDecimal(Number(v))}
            tickLabelProps={TICK_LABEL}
            {...axisProps}
          />
          <g data-axis="ore">
            <AxisRight
              left={innerW}
              scale={yOre}
              numTicks={4}
              tickFormat={(v) => formatOre(Number(v))}
              tickLabelProps={TICK_LABEL}
              {...axisProps}
            />
          </g>
          <text x={-8} y={-8} textAnchor="end" className="fill-muted-foreground text-[10px]">
            kW
          </text>
          <text x={innerW + 8} y={-8} className="fill-muted-foreground text-[10px]">
            öre
          </text>
        </Group>
      </svg>
    )
  }, [width, win, intervals, prices, optimalSchedule, showOptimal, markProps])

  const table = useMemo(
    () => (
      <table className="sr-only">
        <caption>{m.charging_session_chart_table_caption()}</caption>
        <thead>
          <tr>
            <th scope="col">{m.charging_session_chart_col_time()}</th>
            <th scope="col">{m.charging_session_chart_col_kwh()}</th>
            <th scope="col">{m.charging_session_chart_col_ore()}</th>
            {optimalSchedule ? <th scope="col">{m.charging_session_chart_optimal()}</th> : null}
          </tr>
        </thead>
        <tbody>
          {prices.map((p) => (
            <tr key={p.startMs}>
              <th scope="row">{slotLabel(p)}</th>
              <td>{kwhLabel(kwhWithin(intervals, p))}</td>
              <td>{oreLabel(p.spotOre)}</td>
              {optimalSchedule ? <td>{kwhLabel(kwhWithin(optimalSchedule, p))}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [prices, intervals, optimalSchedule],
  )

  const active = popover.data

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
                    from: formatTime(new Date(active.startMs)),
                    to: formatTime(new Date(active.endMs)),
                    kwh: kwhLabel(kwhWithin(intervals, active)),
                    ore: oreLabel(active.spotOre),
                  })
                : null}
            </ChartPopover>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
            <li className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: ACTUAL }} />
              {m.charging_session_chart_actual()}
            </li>
            {optimalSchedule ? (
              <li className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-sm border-[1.5px] border-dashed"
                  style={{ borderColor: OPTIMAL }}
                />
                {m.charging_session_chart_optimal()}
              </li>
            ) : null}
            <li className="flex items-center gap-1.5">
              <span className="h-0.5 w-3" style={{ background: SPOT }} />
              {m.charging_session_chart_spot()}
            </li>
          </ul>
          {table}
        </CardContent>
      </Card>
    </section>
  )
}
