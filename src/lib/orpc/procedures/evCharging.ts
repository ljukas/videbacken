import { z } from 'zod'
import { newCallStats, ZaptecError, zaptec } from '~/lib/effects/zaptec'
import {
  type EconomyTimings,
  getEconomyOverview,
  getSessionEconomy,
} from '~/lib/evCharging/chargingEconomy'
import { type CostTimings, getCostOverview, getSessionCosts } from '~/lib/evCharging/costing'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { runZaptecSync } from '~/lib/evCharging/sync'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import type { PatternTimings } from '~/lib/services/evCharging'
import * as evChargingService from '~/lib/services/evCharging'
import { EvChargingDomainError, type EvChargingDomainErrorCode } from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { runElprisSync } from '~/lib/spotPrice/sync'

/** The sources the charging page tracks: sessions (Zaptec) and spot prices (elpris). */
const chargingSource = z.enum(['zaptec', 'elpris'])
/** `{ source }`, defaulting to Zaptec so existing callers keep their meaning. */
const sourceInput = z.object({ source: chargingSource.default('zaptec') }).optional()
const yearInput = z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional()
/** Upper bound on how long `liveStatus` may wait on Zaptec. */
const LIVE_BUDGET_MS = 6_000

const evChargingErrors = {
  EV_SESSION_NOT_FOUND: { status: 404 },
} satisfies Record<EvChargingDomainErrorCode, { status: number }>

export const evChargingRouter = {
  // Reads — any signed-in (approved) user; the app is read-only for
  // non-admins. Overview runs several queries (see `getOverview`), so it's
  // one of the "heavier than a single query" cases the timing rule calls out.
  overview: protectedProcedure
    .input(z.object({ year: yearInput }))
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
    .input(z.object({ year: yearInput }))
    .handler(async ({ input, context }) => {
      const timings: CostTimings = {}
      const overview = await getCostOverview({ year: input.year, timings })
      recordPrefixedTimings(context.timings, 'cost', timings)
      return overview
    }),

  // Cost of the sessions on the list's current page (the client passes the
  // ids it shows, capped like `sessions`' limit).
  sessionCosts: protectedProcedure
    .input(z.object({ sessionIds: z.array(z.uuid()).max(500) }))
    .handler(async ({ input, context }) => {
      const timings: CostTimings = {}
      const costs = await getSessionCosts({ sessionIds: input.sessionIds, timings })
      recordPrefixedTimings(context.timings, 'cost', timings)
      return costs
    }),

  // When-we-charge views (/charging/patterns). Two queries + pure aggregation
  // each -> sub-timings (timing rule).
  patterns: protectedProcedure
    .input(z.object({ year: yearInput }))
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingPatterns({ year: input.year, timings })
      recordPrefixedTimings(context.timings, 'patterns', timings)
      return result
    }),

  timeline: protectedProcedure
    .input(z.object({ year: yearInput, month: z.number().int().min(1).max(12).optional() }))
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingTimeline({ ...input, timings })
      recordPrefixedTimings(context.timings, 'timeline', timings)
      return result
    }),

  // How economically we charge (/charging/economy): counterfactual schedules
  // over each plug-in window. Several queries + the pure math -> sub-timings.
  economy: protectedProcedure
    .input(z.object({ year: yearInput }))
    .handler(async ({ input, context }) => {
      const timings: EconomyTimings = {}
      const result = await getEconomyOverview({ year: input.year, timings })
      recordPrefixedTimings(context.timings, 'economy', timings)
      return result
    }),

  // One session's economy + chart data (/charging/sessions/$sessionId). An
  // unknown or uncounted id is a typed 404 the page turns into "not found".
  session: protectedProcedure
    .errors(evChargingErrors)
    .input(z.object({ sessionId: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      const timings: EconomyTimings = {}
      try {
        return await getSessionEconomy({ sessionId: input.sessionId, timings })
      } catch (err) {
        if (err instanceof EvChargingDomainError) throw errors[err.code]()
        throw err
      } finally {
        recordPrefixedTimings(context.timings, 'economy', timings)
      }
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
    // Splits `zaptecLiveMs` for the timing line. `zaptecAuthMs`/`zaptecFetchMs`
    // count only *this* caller's completed HTTP attempts (login / state read);
    // `zaptecRequests`/`zaptecRetries` its attempts started. The remainder
    // `zaptecLiveMs − auth − fetch` is waiting: on another caller's shared
    // login, on a login still in flight when the budget expired (then auth 0,
    // requests 1, `zaptecLiveFailed` 1), on retry backoff, or on the adapter's
    // lazy import. `zaptecRequests` 0 means no HTTP at all: answered from the
    // client's state cache, or — with `zaptecLiveFailed` 1 — its failure cache.
    const stats = newCallStats()
    const liveStart = performance.now()
    try {
      return await zaptec.liveState(charger.id, {
        signal: AbortSignal.timeout(LIVE_BUDGET_MS),
        stats,
      })
    } catch (err) {
      if (err instanceof ZaptecError) {
        if (context.timings) context.timings.zaptecLiveFailed = 1
        context.log.debug('evCharging: liveStatus unavailable', { code: err.code })
        return null
      }
      throw err
    } finally {
      if (context.timings) {
        context.timings.zaptecLiveMs = Math.round(performance.now() - liveStart)
        context.timings.zaptecAuthMs = Math.round(stats.authMs)
        context.timings.zaptecFetchMs = Math.round(stats.fetchMs)
        context.timings.zaptecRequests = stats.requests
        context.timings.zaptecRetries = stats.retries
      }
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

// Copies a read model's sub-timings into the request's timing line under a
// prefix (e.g. `slotsMs` -> `costSlotsMs`).
function recordPrefixedTimings(
  timings: Record<string, number> | undefined,
  prefix: string,
  sub: Record<string, number | undefined>,
): void {
  if (!timings) return
  for (const [key, ms] of Object.entries(sub)) {
    if (ms === undefined) continue
    timings[`${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`] = ms
  }
}
