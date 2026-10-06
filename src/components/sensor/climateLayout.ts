import { bisectCenter } from 'd3-array'
import type { TimeInterval } from 'd3-time'
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
 *
 * Data shorter than the range can leave that with fewer than two ticks (a few
 * weeks of data on 1 y has one month start). Then the axis' `fallbacks` are
 * tried from coarsest to finest, and the first with two or more ticks that all
 * fit wins; when none does, the original result stands.
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
  // range() stops before its end: one ms more keeps a tick on the end itself.
  const ticksOf = (interval: TimeInterval) =>
    interval.range(new Date(domain[0]), new Date(domain[1] + 1)).map(Number)
  const fits = (ticks: number[]) =>
    labelsFit(
      ticks.map(x),
      ticks.map((t) => measure(axis.format(t))),
      TIME_TICK_GAP,
    )

  let thinned: number[] = []
  for (const interval of axis.intervals) {
    const ticks = ticksOf(interval)
    if (fits(ticks)) {
      if (ticks.length >= 2 || axis.fallbacks.length === 0) return ticks
      thinned = ticks
      break
    }
    thinned = thinTicks(
      ticks.map(x),
      ticks.map((t) => measure(axis.format(t))),
      TIME_TICK_GAP,
    ).map((i) => ticks[i])
  }
  if (thinned.length >= 2) return thinned
  for (let i = axis.fallbacks.length - 1; i >= 0; i--) {
    const ticks = ticksOf(axis.fallbacks[i])
    if (ticks.length >= 2 && fits(ticks)) return ticks
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
