import { z } from 'zod'
import { ZaptecError, zaptec } from '~/lib/effects/zaptec'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { runZaptecSync } from '~/lib/evCharging/sync'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as evChargingService from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'

const SOURCE = 'zaptec' as const
/** Upper bound on how long `liveStatus` may wait on Zaptec. */
const LIVE_BUDGET_MS = 6_000

export const evChargingRouter = {
  // Reads — any signed-in (approved) user; the app is read-only for
  // non-admins. Overview runs several queries (see `getOverview`), so it's
  // one of the "heavier than a single query" cases the timing rule calls out.
  overview: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const overview = await evChargingService.getOverview({ year: input.year })
      if (context.timings) context.timings.overviewMs = Math.round(performance.now() - startedAt)
      return overview
    }),

  sessions: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500) }))
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const result = await evChargingService.listSessions({ limit: input.limit })
      if (context.timings) context.timings.sessionsMs = Math.round(performance.now() - startedAt)
      return result
    }),

  // `includeAdminDetail` is a flag derived from the caller's own role, never
  // trusted client input (ADR-0002 amendment) — a non-admin never sees
  // `adminDetail`, even if it asked for it.
  syncStatus: protectedProcedure.handler(({ context }) =>
    integrationSyncService.getHealth(SOURCE, {
      now: new Date(),
      includeAdminDetail: context.user.role === 'admin',
    }),
  ),

  // Live charger power/mode for the dashboard tile. Deliberately independent
  // of the sync health snapshot: a `ZaptecError` here (including
  // `not_configured`) just means "no live tile", not a health transition.
  // The whole Zaptec wait (shared login included) is capped at 6 s so a slow
  // Zaptec can never hold this polled request open (ADR-0018); failures are
  // cached in the client, so the poll doesn't re-hit a down/rejecting Zaptec.
  liveStatus: protectedProcedure.handler(async ({ context }) => {
    const findStart = performance.now()
    const charger = await evChargingService.findLiveCharger()
    if (context.timings) context.timings.findChargerMs = Math.round(performance.now() - findStart)
    if (!charger) return null
    const liveStart = performance.now()
    try {
      return await zaptec.liveState(charger.id, { signal: AbortSignal.timeout(LIVE_BUDGET_MS) })
    } catch (err) {
      if (err instanceof ZaptecError) {
        context.log.debug('evCharging: liveStatus unavailable', { code: err.code })
        return null
      }
      throw err
    } finally {
      if (context.timings) context.timings.zaptecLiveMs = Math.round(performance.now() - liveStart)
    }
  }),

  recentRuns: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }))
    .handler(({ input }) => integrationSyncService.listRecentRuns(SOURCE, { limit: input.limit })),

  // Manual sync trigger. `runZaptecSync` never throws for a failed/skipped
  // run — those are ordinary (non-throwing) outcomes recorded in health — so
  // this handler has nothing to catch; only a genuine bug propagates.
  syncNow: adminProcedure.handler(async ({ context }) => {
    const run = await runZaptecSync({ trigger: 'admin', deps: { log: context.log } })
    if (context.timings) {
      context.timings.zaptecSyncMs = run.durationMs
      context.timings.zaptecFetchMs = run.fetchMs
      context.timings.zaptecImportMs = run.importMs
    }
    return { outcome: run.outcome, code: run.code, upserted: run.upserted }
  }),
}
