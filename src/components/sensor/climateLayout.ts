import { bisectCenter } from 'd3-array'
import { labelsFit, thinTicks } from '~/components/chart/barLayout'
import type { SeriesPoint } from '~/lib/sensor/chartData'
import type { TimeAxis } from '~/lib/sensor/tickFormat'

// The Klimat chart's pure geometry (step 5c). The y scale and the card's rows
// stay in ~/lib/sensor/chartData (niceYScale, valueRange, nearestReadings).

/** px kept clear between two time labels. */
export const TIME_TICK_GAP = 16

/**
 * The axis' tick times: the finest of the axis' intervals whose labels all fit
 * `TIME_TICK_GAP` apart; when none does, the coarsest, thinned to fit.
 * The domain's end counts as a tick when it falls on one.
 */
export function pickTimeTicks({
  domain,
  x,
  axis,
  measure,
}: {
  domain: readonly [number, number]
  x: (t: number) => number
  axis: TimeAxis
  measure: (s: string) => number
}): number[] {
  let thinned: number[] = []
  for (const interval of axis.intervals) {
    // range() stops before its end: one ms more keeps a tick on the end itself.
    const ticks = interval.range(new Date(domain[0]), new Date(domain[1] + 1)).map(Number)
    const centres = ticks.map(x)
    const widths = ticks.map((t) => measure(axis.format(t)))
    if (labelsFit(centres, widths, TIME_TICK_GAP)) return ticks
    thinned = thinTicks(centres, widths, TIME_TICK_GAP).map((i) => ticks[i])
  }
  return thinned
}

/** Every real reading time of the visible devices, ascending and distinct: where hover and the keys stop. */
export function readingTimes(
  devices: readonly { id: string; hidden?: boolean; points: readonly SeriesPoint[] }[],
): number[] {
  const times = new Set<number>()
  for (const d of devices) {
    if (d.hidden) continue
    // Outage markers (`<id>: null`) aren't readings.
    for (const p of d.points) if (typeof p[d.id] === 'number') times.add(p.t)
  }
  return [...times].sort((a, b) => a - b)
}

/** The time in `times` (ascending) closest to `t`; null when there is none. */
export function nearestTime(times: readonly number[], t: number): number | null {
  return times.length === 0 ? null : times[bisectCenter(times, t)]
}
