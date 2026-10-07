// Server-only. The Emaldo sync's best-effort refresh of the monthly sums view
// (ADR-0024, amended 2026-10-07), at the end of `execute`, before the derive:
// once per run that stored a day, also when the run then failed or hit its
// deadline (it is short, and skipping it leaves the pages an hour behind).
// Health tracks the source: a failure is a warning, never a failed run. Every
// run stores yesterday and today, so the next run repairs a missed refresh.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { refreshMonthSums } from '~/lib/services/houseEnergy'

/** How long a run waits for the refresh (≈ 50 ms on prod at 75k readings). */
export const REFRESH_BUDGET_MS = 10_000

/** Refreshes when the run stored a day; returns the milliseconds spent (0 when not). Never throws. */
export async function refreshAfterSync(a: {
  stored: boolean
  log: Logger
  /** The refresh (tests). */
  refresh?: () => Promise<void>
  budgetMs?: number
}): Promise<number> {
  if (!a.stored) return 0
  const started = performance.now()
  try {
    await withDeadline(
      (a.refresh ?? refreshMonthSums)(),
      AbortSignal.timeout(a.budgetMs ?? REFRESH_BUDGET_MS),
      () => new Error('house energy month refresh did not finish within its budget'),
    )
  } catch (error) {
    a.log.warn('house energy month refresh failed', { error })
  }
  return Math.round(performance.now() - started)
}
