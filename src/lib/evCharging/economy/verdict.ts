// Client-safe: how the session summary reads a session's counterfactuals
// (docs/superpowers/specs/2026-10-01-ev-charging-session-summary-redesign.md).
import type { Counterfactual } from './types'

export type TimingVerdict = 'good' | 'ok' | 'poor' | 'none'

/**
 * The timing score in thirds, graded on the whole percent the UI shows (so "67 %" is never "Okej"
 * and "33 %" never "Dyr"); `none` when the window left nothing to choose between.
 */
export function timingVerdict(score: number | null): TimingVerdict {
  if (score === null) return 'none'
  const percent = Math.round(score * 100)
  if (percent >= 67) return 'good'
  if (percent >= 33) return 'ok'
  return 'poor'
}

/** Where `value` sits on the cheapest (0) → dearest (1) track, clamped; 0 for an empty range. */
export function rangePosition(value: number, cheapest: number, dearest: number): number {
  const span = dearest - cheapest
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (value - cheapest) / span))
}

/** A kronor gap below this reads as "about the same" in the summary sentence. */
export const NEGLIGIBLE_SEK = 0.5

export type SummarySentence =
  /** No score: every charging time would have cost about the same. */
  | 'no_choice'
  /** Some left on the table, but cheaper than charging at once. */
  | 'saved'
  /** Some left on the table, and dearer than charging at once. */
  | 'lost'
  /** Some left on the table, about what charging at once would have cost. */
  | 'like_immediate'
  /** Next to nothing left, and cheaper than charging at once. */
  | 'near_optimal_saved'
  /** Next to nothing left, and charging at once would have been about as cheap. */
  | 'near_optimal_like_immediate'

/**
 * Which sentence explains the figures. Near-optimal can't also be dearer than
 * charging at once: immediate ≥ optimal, so saved > −left > −0,50 kr.
 */
export function summarySentence(
  cf: Pick<Counterfactual, 'score' | 'leftOnTableSek' | 'savedVsImmediateSek'>,
): SummarySentence {
  if (cf.score === null) return 'no_choice'
  const likeImmediate = Math.abs(cf.savedVsImmediateSek) < NEGLIGIBLE_SEK
  if (cf.leftOnTableSek < NEGLIGIBLE_SEK) {
    return likeImmediate ? 'near_optimal_like_immediate' : 'near_optimal_saved'
  }
  if (likeImmediate) return 'like_immediate'
  return cf.savedVsImmediateSek > 0 ? 'saved' : 'lost'
}
