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

export type ChartRow = { t: number } & Record<string, number | null>

// Pivot [{ t, perDevice: { id: {tempAvg,humAvg} } }] → [{ t, <id>: value }] for
// Recharts' wide-format multi-series. A device absent from a bucket becomes null,
// but only for devices that appear somewhere in the set — keeping the column keys
// stable across rows. These nulls are mostly structural: when devices report on
// independent schedules they rarely share a bucket, so most rows carry one
// device's value and null for the rest. ClimateChart therefore renders lines with
// connectNulls so a device's own readings join up across the other devices' rows.
export function toChartRows(buckets: Buckets, metric: 'temp' | 'hum'): ChartRow[] {
  const key = metric === 'temp' ? 'tempAvg' : 'humAvg'
  const deviceIds = new Set<string>()
  for (const b of buckets) for (const id of Object.keys(b.perDevice)) deviceIds.add(id)
  return buckets.map((b) => {
    const row: ChartRow = { t: b.t }
    for (const id of deviceIds) row[id] = b.perDevice[id]?.[key] ?? null
    return row
  })
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
  const maxGapSec =
    opts.bucketSec < opts.cadenceSec
      ? Number.POSITIVE_INFINITY
      : opts.maxGapBuckets * opts.bucketSec

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
      const brokeBefore = prev ? cur.t - prev.t > maxGapSec : true
      const brokeAfter = next ? next.t - cur.t > maxGapSec : true
      if (prev && cur.t - prev.t > maxGapSec) {
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
