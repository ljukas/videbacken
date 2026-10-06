import { tickStep } from 'd3-array'
import { precisionFixed } from 'd3-format'
import { scaleLinear } from 'd3-scale'
import type { RouterOutputs } from '~/lib/orpc/client'

type Buckets = RouterOutputs['sensor']['series']['buckets']

// Categorical palette — shadcn's chart tokens are defined for both light and
// dark themes (src/styles/app.css), plus the brand accent. Only 4 devices exist
// today; colorForIndex wraps if more are ever added.
export const DEVICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--brand)',
] as const

export function colorForIndex(i: number): string {
  return DEVICE_COLORS[i % DEVICE_COLORS.length]
}

// The chart's x-axis spans EVERY device's readings, including hidden ones, so
// toggling a device's visibility never rescales the time axis.
// Returns [min, max] over all points, or undefined when there are none.
export function timeDomain(devices: { points: SeriesPoint[] }[]): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const d of devices) {
    for (const p of d.points) {
      if (p.t < min) min = p.t
      if (p.t > max) max = p.t
    }
  }
  return min <= max ? [min, max] : undefined
}

export type YScale = { domain: [number, number]; ticks: number[]; decimals: number }

// A span this small relative to the values is float noise (e.g. two bucket
// averages that differ only in the last bits), not a real spread — treat it as
// flat rather than zooming the axis into sub-millionth ticks.
const FLAT_EPSILON = 1e-6

// A "nice" y-axis for a value range: round bounds and evenly-spaced ticks on a
// round step (1, 2, or 5 × 10ⁿ), via d3-scale. Equal-dividing a narrow domain
// gives arbitrary fractional ticks (24.595, 24.49, …) that overflow a
// fixed-width axis and read as noise; round ticks keep labels short
// and aligned to sensible increments. `decimals` is the precision the step needs,
// so ticks formatted with it are always distinct. A flat series (all readings
// equal, or equal up to float noise) is padded to a 1-unit band so its line sits
// mid-axis. d3's count is a target number of intervals, so targetCount − 1
// keeps the axis at roughly targetCount ticks on the ~260px-tall chart — but at
// least 2 intervals, since d3 neither rounds the domain nor gives two ticks for 1.
export function niceYScale(min: number, max: number, targetCount = 5): YScale {
  const magnitude = Math.max(1, Math.abs(min), Math.abs(max))
  if (!(max - min > FLAT_EPSILON * magnitude)) {
    min -= 0.5
    max += 0.5
  }
  const count = Math.max(2, targetCount - 1)
  const scale = scaleLinear().domain([min, max]).nice(count)
  const [lo, hi] = scale.domain()
  return {
    domain: [lo, hi],
    ticks: scale.ticks(count),
    decimals: precisionFixed(tickStep(lo, hi, count)),
  }
}

// Min/max of every visible device's own readings, for the y-axis scale. Hidden
// devices are excluded so the axis matches what's drawn. Returns undefined when
// nothing is visible.
export function valueRange(
  devices: { id: string; hidden?: boolean; points: SeriesPoint[] }[],
): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const d of devices) {
    if (d.hidden) continue
    for (const p of d.points) {
      const v = p[d.id]
      // Finite only: a stray Infinity would give d3 no domain to round.
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
  }
  return min <= max ? [min, max] : undefined
}

export type SeriesPoint = {
  t: number
  isolated?: boolean
  // The device's value lives under its own id key (the chart reads `p[device.id]`).
  // `null` under that key is an outage break marker.
  [deviceId: string]: number | null | boolean | undefined
}
export type DeviceSeries = { id: string; points: SeriesPoint[] }

export type ClimateTooltipRow = {
  id: string
  displayName: string
  color: string
  value: number
  t: number // the ACTUAL reading time (may differ from the hovered time)
}

// Resolve a hover at time `hoverT` to one row per visible device: that device's
// reading closest to the hover, kept only when it lands within `windowMs`.
//
// Why this exists: each device carries its OWN points, and on the 24h range the
// 10-min bucket is far finer than the ~2h reporting cadence, so different
// devices' readings almost never share a bucket timestamp. Snapping each device
// independently to its nearest reading shows "all sensors at this moment"
// without changing the bucket. The `windowMs` guard (≈ one
// reporting cadence) is the "not 10h away" rule: a device silent longer than a
// cadence is omitted rather than shown with a stale value, and on coarser ranges
// (bucket ≥ cadence) the window is narrower than a bucket, so aligned points
// resolve to an exact match and behaviour is unchanged. Null break markers are
// skipped — only real readings can win. Rows keep the roster order (the
// legend sorts by name instead).
export function nearestReadings(
  devices: readonly {
    id: string
    displayName: string
    color: string
    hidden?: boolean
    points: SeriesPoint[]
  }[],
  hoverT: number,
  windowMs: number,
): ClimateTooltipRow[] {
  const rows: ClimateTooltipRow[] = []
  for (const d of devices) {
    if (d.hidden) continue
    let best: { value: number; t: number } | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const p of d.points) {
      const v = p[d.id]
      if (typeof v !== 'number') continue // skip outage break markers
      const dist = Math.abs(p.t - hoverT)
      if (dist < bestDist) {
        bestDist = dist
        best = { value: v, t: p.t }
      }
    }
    if (best && bestDist <= windowMs) {
      rows.push({
        id: d.id,
        displayName: d.displayName,
        color: d.color,
        value: best.value,
        t: best.t,
      })
    }
  }
  return rows
}

// Reshape server buckets into one series per device, one line each. Each device
// carries only its OWN readings, so a null means exactly one thing — a real
// outage — which we insert as a break marker only when a device was silent longer
// than the threshold. The chart connects real readings and breaks the line at
// markers. A reading with no connected neighbour is flagged `isolated` so the
// chart shows a dot instead of nothing.
export function toDeviceSeries(
  buckets: Buckets,
  metric: 'temp' | 'hum',
  opts: { bucketSec: number; maxGapBuckets: number; cadenceSec: number },
): DeviceSeries[] {
  const key = metric === 'temp' ? 'tempAvg' : 'humAvg'

  // Devices in stable first-appearance order (buckets are ascending by t).
  const ids: string[] = []
  const seen = new Set<string>()
  for (const b of buckets) {
    for (const id of Object.keys(b.perDevice)) {
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }

  // When the bucket is finer than the reporting cadence (the 24h range), empty
  // buckets are normal sparseness → never break (connect across the window).
  // `bucketSec`/`cadenceSec` are seconds but `b.t` is epoch MILLISECONDS, so the
  // threshold is converted to ms — comparing ms gaps against a seconds value made
  // every realistic gap "break", collapsing non-24h ranges to disconnected dots.
  const maxGapMs =
    opts.bucketSec < opts.cadenceSec
      ? Number.POSITIVE_INFINITY
      : opts.maxGapBuckets * opts.bucketSec * 1000

  return ids.map((id) => {
    const readings: { t: number; v: number }[] = []
    for (const b of buckets) {
      const v = b.perDevice[id]?.[key]
      if (v != null) readings.push({ t: b.t, v })
    }

    const points: SeriesPoint[] = []
    for (let i = 0; i < readings.length; i++) {
      const prev = readings[i - 1]
      const cur = readings[i]
      const next = readings[i + 1]
      const brokeBefore = prev ? cur.t - prev.t > maxGapMs : true
      const brokeAfter = next ? next.t - cur.t > maxGapMs : true
      if (prev && cur.t - prev.t > maxGapMs) {
        points.push({ t: (prev.t + cur.t) / 2, [id]: null })
      }
      points.push(
        brokeBefore && brokeAfter
          ? { t: cur.t, [id]: cur.v, isolated: true }
          : { t: cur.t, [id]: cur.v },
      )
    }
    return { id, points }
  })
}
