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
