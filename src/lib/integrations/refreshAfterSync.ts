// Server-only. A sync's best-effort refresh of a materialized view over the
// readings it writes (`house_energy_month`, ADR-0024; `heat_pump_day`,
// ADR-0027): once per run that stored something, also when the run then
// failed or hit its deadline (it is short, and skipping it leaves the pages a
// run behind). Health tracks the source: a failure is a warning, never a
// failed run. The next run that stores repairs a missed refresh.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'

/** How long a run waits for the refresh (≈ 50 ms on prod for either view). */
export const REFRESH_BUDGET_MS = 10_000

/** Refreshes when the run stored something; returns the milliseconds spent (0 when not). Never throws. */
export async function refreshAfterSync(a: {
  stored: boolean
  /** Names the view in the warning, e.g. 'house energy month'. */
  label: string
  refresh: () => Promise<void>
  log: Logger
  budgetMs?: number
}): Promise<number> {
  if (!a.stored) return 0
  const started = performance.now()
  try {
    await withDeadline(
      a.refresh(),
      AbortSignal.timeout(a.budgetMs ?? REFRESH_BUDGET_MS),
      () => new Error(`${a.label} refresh did not finish within its budget`),
    )
  } catch (error) {
    a.log.warn(`${a.label} refresh failed`, { error })
  }
  return Math.round(performance.now() - started)
}
