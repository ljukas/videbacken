// Server-only. The best-effort trigger the Emaldo, Zaptec and elpris syncs run
// at the end of `execute` (ADR-0023): re-derive from the earliest day the run
// stored or changed — even when the run then failed, since a stored change is
// never detected as new again. Health tracks the source, not the derive: a
// failure or a derive past its budget is a warning, never a failed run.
import type { IntegrationSource } from '~/lib/integrationHealth'
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import * as energyMixService from '~/lib/services/energyMix'
import { deriveFrom } from './derive'

/**
 * How long a sync waits for its derive. Added to a run's 240 s deadline it
 * stays under Vercel's 300 s function limit. A derive given up on keeps
 * running; if the instance is frozen first, Postgres ends its idle transaction
 * after 60 s and the next trigger redoes the work.
 */
export const DERIVE_BUDGET_MS = 30_000

/**
 * Queues the day (so a failed derive is retried by the next one), then
 * derives. Returns the milliseconds spent (0 when `fromDay` is null). Never
 * throws.
 */
export async function deriveAfterSync(a: {
  source: IntegrationSource
  fromDay: string | null
  log: Logger
  derive?: typeof deriveFrom
  /** Queues the day (tests). */
  request?: (day: string) => Promise<void>
  budgetMs?: number
}): Promise<number> {
  if (a.fromDay === null) return 0
  const started = performance.now()
  try {
    await (a.request ?? energyMixService.requestDerive)(a.fromDay)
  } catch (error) {
    // The derive below still runs; only a later retry of this day is lost.
    a.log.warn('energy mix derive request failed', { source: a.source, fromDay: a.fromDay, error })
  }
  try {
    await withDeadline(
      (a.derive ?? deriveFrom)(a.fromDay, { log: a.log }),
      AbortSignal.timeout(a.budgetMs ?? DERIVE_BUDGET_MS),
      () => new Error('energy mix derive did not finish within its budget'),
    )
  } catch (error) {
    a.log.warn('energy mix derive failed', { source: a.source, fromDay: a.fromDay, error })
  }
  return Math.round(performance.now() - started)
}
