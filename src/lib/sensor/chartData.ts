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

// The chart's x-axis must span EVERY device's readings, including hidden ones, so
// toggling a device's visibility never rescales the time axis. (With per-<Line>
// `data`, Recharts otherwise recomputes the domain from visible lines only.)
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

// Round a raw step up to the nearest "nice" number (1, 2, or 5 × 10ⁿ), the
// increments people read axes in.
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const pow = 10 ** exp
  const frac = raw / pow
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return niceFrac * pow
}

// Decimals a nice step needs (0.5 → 1, 0.05 → 2, 2 → 0). Loop-based to dodge the
// float error `-log10` accumulates.
function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step >= 1) return 0
  let d = 0
  let s = step
  while (s < 1 && d < 6) {
    s *= 10
    d++
  }
  return d
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

export type YScale = { domain: [number, number]; ticks: number[]; decimals: number }

// A "nice" y-axis for a value range: round bounds and evenly-spaced ticks on a
// round step. Recharts equal-divides a narrow auto-domain into arbitrary
// fractional ticks (24.595, 24.49, …) that overflow a fixed-width axis and read
// as noise; supplying round ticks keeps labels short, aligned to sensible
// increments, and free of rounding collisions. A flat series (all readings
// equal) is padded to a 1-unit band so its line sits mid-axis.
export function niceYScale(min: number, max: number, targetCount = 5): YScale {
  if (!(max > min)) {
    min -= 0.5
    max += 0.5
  }
  const step = niceStep((max - min) / Math.max(1, targetCount - 1))
  const decimals = decimalsForStep(step)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const count = Math.round((niceMax - niceMin) / step) + 1
  const ticks: number[] = []
  for (let i = 0; i < count; i++) ticks.push(roundTo(niceMin + i * step, decimals))
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks, decimals }
}

// Min/max of every visible device's own readings, for the y-axis scale. Hidden
// devices are excluded so the axis matches what's drawn (Recharts' per-<Line>
// auto-domain does the same). Returns undefined when nothing is visible.
export function valueRange(
  devices: { id: string; hidden?: boolean; points: SeriesPoint[] }[],
): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const d of devices) {
    if (d.hidden) continue
    for (const p of d.points) {
      const v = p[d.id]
      if (typeof v === 'number') {
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
  // The device's value lives under its own id key (matching the <Line dataKey>),
  // so shadcn's config-by-id (colors, legend labels) keeps working. `null` under
  // that key is an outage break marker.
  [deviceId: string]: number | null | boolean | undefined
}
export type DeviceSeries = { id: string; points: SeriesPoint[] }

// Reshape server buckets into one series per device for Recharts' per-<Line>
// `data`. Each device carries only its OWN readings, so a null means exactly one
// thing — a real outage — which we insert as a break marker only when a device was
// silent longer than the threshold. The chart uses connectNulls={false}, so it
// connects real readings and breaks at markers. A reading with no connected
// neighbour is flagged `isolated` so the chart shows a dot instead of nothing.
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
