// Client-safe merged-readings helpers for alert rules (ADR-0028). A Shelly sensor can report a
// burst of readings a minute apart; a rule counts the burst once.
import { MERGE_WINDOW_MS } from './alerts'

/**
 * Groups readings (ascending by `recordedAt`) into fixed windows that start at each group's first
 * reading: a reading under `MERGE_WINDOW_MS` after it joins, the next one starts a new group.
 */
export function mergeReadings<T extends { recordedAt: Date }>(ascending: T[]): T[][] {
  const groups: T[][] = []
  let start = 0
  for (const reading of ascending) {
    const at = reading.recordedAt.getTime()
    const current = groups[groups.length - 1]
    if (current && at - start < MERGE_WINDOW_MS) {
      current.push(reading)
    } else {
      groups.push([reading])
      start = at
    }
  }
  return groups
}

/** The median gap between consecutive groups' starts, in whole minutes; null under two groups. */
export function typicalGapMinutes(ascending: { recordedAt: Date }[]): number | null {
  const starts = mergeReadings(ascending).map((g) => g[0].recordedAt.getTime())
  if (starts.length < 2) return null
  const gaps = starts
    .slice(1)
    .map((s, i) => (s - starts[i]) / 60_000)
    .sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
  return Math.round(median)
}

/** How long `count` merged readings in a row take at one gap: (count-1) to count gaps. */
export function alertSpanMinutes(
  count: number,
  gapMinutes: number,
): { lowMin: number; highMin: number } {
  return { lowMin: (count - 1) * gapMinutes, highMin: count * gapMinutes }
}
