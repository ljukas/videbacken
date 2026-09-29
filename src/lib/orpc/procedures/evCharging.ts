import { z } from 'zod'
import { ZaptecError, zaptec } from '~/lib/effects/zaptec'
import { type CostTimings, getCostOverview, getSessionCosts } from '~/lib/evCharging/costing'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { runZaptecSync } from '~/lib/evCharging/sync'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as evChargingService from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { runElprisSync } from '~/lib/spotPrice/sync'

/** The sources the charging page tracks: sessions (Zaptec) and spot prices (elpris). */
const chargingSource = z.enum(['zaptec', 'elpris'])
/** `{ source }`, defaulting to Zaptec so existing callers keep their meaning. */
const sourceInput = z.object({ source: chargingSource.default('zaptec') }).optional()
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

  // Cost per month/tile (spot + tariff), kept apart from `overview` so a price
  // or tariff problem degrades only the cost figures, never the kWh ones.
  // Several queries + the pure cost math → sub-timings (timing rule).
  costOverview: protectedProcedure
    .input(
      z.object({
        year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const timings: CostTimings = {}
      const overview = await getCostOverview({ year: input.year, timings })
      recordCostTimings(context.timings, timings)
      return overview
    }),

  // Cost of the sessions on the list's current page (the client passes the
  // ids it shows, capped like `sessions`' limit).
  sessionCosts: protectedProcedure
    .input(z.object({ sessionIds: z.array(z.uuid()).max(500) }))
    .handler(async ({ input, context }) => {
      const timings: CostTimings = {}
      const costs = await getSessionCosts({ sessionIds: input.sessionIds, timings })
      recordCostTimings(context.timings, timings)
      return costs
    }),

  // `includeAdminDetail` is a flag derived from the caller's own role, never
  // trusted client input (ADR-0002 amendment) — a non-admin never sees
  // `adminDetail`, even if it asked for it.
  syncStatus: protectedProcedure.input(sourceInput).handler(({ input, context }) =>
    integrationSyncService.getHealth(input?.source ?? 'zaptec', {
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
    .input(
      z.object({
        source: chargingSource.default('zaptec'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .handler(({ input }) =>
      integrationSyncService.listRecentRuns(input.source, { limit: input.limit }),
    ),

  // Manual sync trigger for one source (default Zaptec). The page's "Synka
  // nu" fires one call per source in parallel, so the quick session sync
  // isn't held behind a long price backfill, and each alert's retry runs only
  // its own source. A run never throws for a failed/skipped outcome (those
  // are recorded in health); only a genuine bug propagates.
  syncNow: adminProcedure.input(sourceInput).handler(async ({ input, context }) => {
    if ((input?.source ?? 'zaptec') === 'elpris') {
      const run = await runElprisSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.elprisSyncMs = run.durationMs
        context.timings.elprisFetchMs = run.fetchMs
        context.timings.elprisImportMs = run.importMs
      }
      return { outcome: run.outcome, code: run.code, upserted: run.upserted }
    }
    const run = await runZaptecSync({ trigger: 'admin', deps: { log: context.log } })
    if (context.timings) {
      context.timings.zaptecSyncMs = run.durationMs
      context.timings.zaptecFetchMs = run.fetchMs
      context.timings.zaptecImportMs = run.importMs
    }
    return { outcome: run.outcome, code: run.code, upserted: run.upserted }
  }),
}

// Copies the cost read model's sub-timings into the request's timing line
// under `cost*` labels (e.g. `slotsMs` → `costSlotsMs`).
function recordCostTimings(timings: Record<string, number> | undefined, cost: CostTimings): void {
  if (!timings) return
  for (const [key, ms] of Object.entries(cost)) {
    timings[`cost${key.charAt(0).toUpperCase()}${key.slice(1)}`] = ms
  }
}
