import { extent, max } from 'd3-array'
import { scaleLinear } from 'd3-scale'
import type { SignatureFit, SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'

// The Energisignatur scatter's geometry (step 4b), pure so it is tested in node.

export type Segment = { x1: number; y1: number; x2: number; y2: number }

/** A fitted line over its own set's ΔT range: never drawn past its data. Null for an empty set. */
export function fitSegment(fit: SignatureFit, deltaTs: readonly number[]): Segment | null {
  const [lo, hi] = extent(deltaTs)
  if (lo === undefined || hi === undefined) return null
  return { x1: lo, y1: fit.a + fit.b * lo, x2: hi, y2: fit.a + fit.b * hi }
}

/** The before line (with a fit) over the before points; the after line (ok + afterFit) over the counted after points. */
export function signatureSegments(result: SignatureResult): {
  before: Segment | null
  after: Segment | null
} {
  if (result.state === 'not_enough_before') return { before: null, after: null }
  const deltaTs = (keep: (p: SignaturePoint) => boolean) =>
    result.points.filter(keep).map((p) => p.deltaT)
  return {
    before: fitSegment(
      result.fit,
      deltaTs((p) => p.set === 'before'),
    ),
    after:
      result.state === 'ok' && result.afterFit
        ? fitSegment(
            result.afterFit,
            deltaTs((p) => p.set === 'after' && !p.extrapolated),
          )
        : null,
  }
}

/** ΔT over every point (± 1 around a single value), kWh from 0 to the highest point or line end; both nice. */
export function signatureDomains(
  points: readonly SignaturePoint[],
  segments: readonly Segment[],
): { x: [number, number]; y: [number, number] } {
  const [lo, hi] = extent(points, (pt) => pt.deltaT)
  const x =
    lo === undefined || hi === undefined
      ? [0, 20]
      : scaleLinear()
          .domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi])
          .nice()
          .domain()
  const top = max([...points.map((pt) => pt.kwh), ...segments.flatMap((s) => [s.y1, s.y2])]) ?? 0
  const y = scaleLinear()
    .domain([0, top > 0 ? top : 1])
    .nice()
    .domain()
  return { x: [x[0], x[1]], y: [y[0], y[1]] }
}

/** The index of the point nearest (px, py) within `maxPx` (the dataviz hit target), first on a tie; else null. */
export function nearestPoint(
  pixels: readonly { x: number; y: number }[],
  px: number,
  py: number,
  maxPx = 24,
): number | null {
  let best: number | null = null
  let bestD = maxPx * maxPx
  for (let i = 0; i < pixels.length; i++) {
    const d = (pixels[i].x - px) ** 2 + (pixels[i].y - py) ** 2
    // Within reach, and strictly nearer than the best so far (the first wins a tie).
    if (d <= bestD && (best === null || d < bestD)) {
      best = i
      bestD = d
    }
  }
  return best
}
