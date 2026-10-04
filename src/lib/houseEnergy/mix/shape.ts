// Client-safe, pure (ADR-0023, spec "Derivation" 1). Spreads a session's
// Zaptec intervals over the house's 5-minute buckets, shaped by how far the
// house load rose above its level just before the session: Zaptec's first
// interval can span hours before the car drew anything, and the load shows the
// real start as a clean jump. Every interval's kWh stays exact.
import type { HouseReading } from '~/lib/services/houseEnergy'

/** Emaldo's bucket length; buckets start on 5-minute UTC boundaries. */
export const BUCKET_MS = 5 * 60_000
/** Pre-session buckets whose median load is the baseline (30 min). */
export const BASELINE_BUCKETS = 6
/** Fewer pre-session buckets with data than this → no baseline → uniform spread. */
export const MIN_BASELINE_BUCKETS = 3

/** The car's energy in one 5-minute bucket. */
export type CarBucket = { bucketStart: number; kwh: number }

type Stretch = { startMs: number; endMs: number; kwh: number }
type Covered = { start: number; share: number; load: number | undefined }

const floorToBucket = (ms: number) => Math.floor(ms / BUCKET_MS) * BUCKET_MS
const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0)

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The car's kWh per 5-minute bucket, ascending, zero buckets left out.
 * `readings` should cover [startMs − 30 min, the last stretch's end).
 *
 * Per stretch: weight = max(0, load − baseline) × overlap share; uniform (by
 * overlap) when there's no baseline, a covered bucket has no reading, or the
 * weights sum to 0. Then, when every covered bucket has a reading, each bucket
 * is capped at its load minus what earlier stretches already put there, and
 * the excess moves to buckets with headroom in proportion to it; whatever no
 * headroom can take is spread by overlap (the load is exceeded, the kWh kept).
 */
export function shapeSession(input: {
  startMs: number
  stretches: readonly Stretch[]
  readings: readonly HouseReading[]
}): CarBucket[] {
  const loadAt = new Map<number, number>()
  for (const r of input.readings) loadAt.set(r.bucketStart.getTime(), r.loadKwh)

  const first = floorToBucket(input.startMs)
  const before: number[] = []
  for (let i = 1; i <= BASELINE_BUCKETS; i++) {
    const load = loadAt.get(first - i * BUCKET_MS)
    if (load !== undefined) before.push(load)
  }
  const baseline = before.length >= MIN_BASELINE_BUCKETS ? median(before) : null

  const car = new Map<number, number>()
  for (const stretch of input.stretches) {
    if (!(stretch.kwh > 0)) continue
    for (const [start, kwh] of spreadStretch(stretch, loadAt, baseline, car)) {
      car.set(start, (car.get(start) ?? 0) + kwh)
    }
  }
  return [...car]
    .filter(([, kwh]) => kwh > 0)
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, kwh]) => ({ bucketStart, kwh }))
}

function spreadStretch(
  s: Stretch,
  loadAt: ReadonlyMap<number, number>,
  baseline: number | null,
  placed: ReadonlyMap<number, number>,
): [number, number][] {
  // A zero-length stretch (an `estimated` session with start = end): all of
  // it in its start bucket, so the session's total still matches.
  if (s.endMs <= s.startMs) return [[floorToBucket(s.startMs), s.kwh]]
  const duration = s.endMs - s.startMs
  const covered: Covered[] = []
  for (let b = floorToBucket(s.startMs); b < s.endMs; b += BUCKET_MS) {
    const overlap = Math.min(b + BUCKET_MS, s.endMs) - Math.max(b, s.startMs)
    covered.push({ start: b, share: overlap / duration, load: loadAt.get(b) })
  }
  const complete = covered.every((c) => c.load !== undefined)
  let weights = covered.map((c) => c.share)
  if (complete && baseline !== null) {
    const shaped = covered.map((c) => Math.max(0, (c.load ?? 0) - baseline) * c.share)
    if (sum(shaped) > 0) weights = shaped
  }
  const weightSum = sum(weights)
  const kwh = weights.map((w) => (s.kwh * w) / weightSum)
  if (complete) {
    const cap = covered.map((c) => Math.max(0, (c.load ?? 0) - (placed.get(c.start) ?? 0)))
    clampToLoad(
      kwh,
      cap,
      covered.map((c) => c.share),
    )
  }
  return covered.map((c, i) => [c.start, kwh[i]])
}

/** Caps each bucket at `cap`, moving the excess as described above. Mutates `kwh`; keeps its sum. */
function clampToLoad(kwh: number[], cap: readonly number[], share: readonly number[]): void {
  let excess = 0
  for (let i = 0; i < kwh.length; i++) {
    if (kwh[i] > cap[i]) {
      excess += kwh[i] - cap[i]
      kwh[i] = cap[i]
    }
  }
  if (!(excess > 0)) return
  const headroom = kwh.map((k, i) => cap[i] - k)
  const room = sum(headroom)
  const moved = Math.min(excess, room)
  if (moved > 0) {
    for (let i = 0; i < kwh.length; i++) kwh[i] += (moved * headroom[i]) / room
  }
  const rest = excess - moved
  if (rest > 0) {
    const shareSum = sum(share)
    for (let i = 0; i < kwh.length; i++) kwh[i] += (rest * share[i]) / shareSum
  }
}
