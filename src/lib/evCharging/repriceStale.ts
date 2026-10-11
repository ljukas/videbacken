// Server-only. The eager reprice of stale session costs (ADR-0020, amended
// 2026-10-11): after each Zaptec, elpris and Emaldo sync (after the energy-mix
// derive) and after a tariff edit, so the next costOverview reads only stored
// sums. Best effort with its own budget: a failure or a timeout is a warning,
// and the read path prices whatever is still stale.
import { withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import * as sessionCostService from '~/lib/services/sessionCost'
import { PRICING_VERSION } from './cost'
import { priceSessions, storePriced } from './costing'

/**
 * How long a sync waits for the reprice. A run's 240 s deadline, the 10 s
 * month refresh, the 30 s derive and this 10 s add up to 290 s, under Vercel's
 * 300 s function limit. A reprice given up on may still finish; the write-back
 * guard keeps it correct either way.
 */
export const REPRICE_BUDGET_MS = 10_000

async function repriceAll(log: Logger): Promise<{ stale: number; written: number }> {
  // Generations first, then the inputs (priceSessions): see writePriced.
  const stale = await sessionCostService.listStale({ pricingVersion: PRICING_VERSION })
  if (stale.length === 0) return { stale: 0, written: 0 }
  const priced = await priceSessions(stale.map((s) => s.sessionId))
  const { written } = await storePriced(stale, priced, { log })
  return { stale: stale.length, written }
}

/** Reprices every stale counted session. Returns the milliseconds spent. Never throws. */
export async function repriceStale(a: {
  trigger: string
  log: Logger
  /** The run's deadline signal: once fired, the reprice is skipped (the read path covers it). */
  signal?: AbortSignal
  budgetMs?: number
  /** The reprice (tests). */
  reprice?: () => Promise<{ stale: number; written: number }>
}): Promise<number> {
  if (a.signal?.aborted) {
    a.log.warn('session cost reprice skipped: run deadline reached', { trigger: a.trigger })
    return 0
  }
  const started = performance.now()
  try {
    const result = await withDeadline(
      (a.reprice ?? (() => repriceAll(a.log)))(),
      AbortSignal.timeout(a.budgetMs ?? REPRICE_BUDGET_MS),
      () => new Error('session cost reprice did not finish within its budget'),
    )
    // Every run, nothing stale included: the line shows the reprice ran.
    a.log.info('session costs repriced', {
      trigger: a.trigger,
      ...result,
      repriceMs: Math.round(performance.now() - started),
    })
  } catch (error) {
    a.log.warn('session cost reprice failed', { trigger: a.trigger, error })
  }
  return Math.round(performance.now() - started)
}
