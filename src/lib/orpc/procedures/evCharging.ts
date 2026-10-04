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
import {
  MAX_IMPORT_ROWS,
  VEHICLES,
  vehicleRecordInput,
  vehicleScope,
} from '~/lib/evCharging/vehicle'
import { runEmaldoSync } from '~/lib/houseEnergy/sync'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import type { PatternTimings } from '~/lib/services/evCharging'
import * as evChargingService from '~/lib/services/evCharging'
import { EvChargingDomainError, type EvChargingDomainErrorCode } from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'
import * as vehicleChargeService from '~/lib/services/vehicleCharge'
import * as vehicleStateService from '~/lib/services/vehicleState'
import { runElprisSync } from '~/lib/spotPrice/sync'
import { runSkodaSync } from '~/lib/vehicleState/sync'

/**
 * The sources the charging page tracks: sessions (Zaptec), spot prices
 * (elpris), the car's live state (Škoda) and the house's energy flows (Emaldo).
 */
const chargingSource = z.enum(['zaptec', 'elpris', 'skoda', 'emaldo'])
/** `{ source }`, defaulting to Zaptec so existing callers keep their meaning. */
const sourceInput = z.object({ source: chargingSource.default('zaptec') }).optional()
const yearInput = z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional()
/** Whose charging a read shows; defaults to every counted session. */
const vehicleInput = vehicleScope.default('all')
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
    .input(z.object({ year: yearInput, vehicle: vehicleInput }))
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const overview = await evChargingService.getOverview({
        year: input.year,
        vehicle: input.vehicle,
      })
      if (context.timings) context.timings.overviewMs = Math.round(performance.now() - startedAt)
      return overview
    }),

  sessions: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500), vehicle: vehicleInput }))
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const result = await evChargingService.listSessions({
        limit: input.limit,
        vehicle: input.vehicle,
      })
      if (context.timings) context.timings.sessionsMs = Math.round(performance.now() - startedAt)
      return result
    }),

  // Cost per month/tile (spot + tariff), kept apart from `overview` so a price
  // or tariff problem degrades only the cost figures, never the kWh ones.
  // Several queries + the pure cost math → sub-timings (timing rule).
  costOverview: protectedProcedure
    .input(z.object({ year: yearInput, vehicle: vehicleInput }))
    .handler(async ({ input, context }) => {
      const timings: CostTimings = {}
      const overview = await getCostOverview({ year: input.year, timings, vehicle: input.vehicle })
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
    .input(z.object({ year: yearInput, vehicle: vehicleInput }))
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingPatterns({
        year: input.year,
        timings,
        vehicle: input.vehicle,
      })
      recordPrefixedTimings(context.timings, 'patterns', timings)
      return result
    }),

  timeline: protectedProcedure
    .input(
      z.object({
        year: yearInput,
        month: z.number().int().min(1).max(12).optional(),
        vehicle: vehicleInput,
      }),
    )
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingTimeline({ ...input, timings })
      recordPrefixedTimings(context.timings, 'timeline', timings)
      return result
    }),

  // How economically we charge (/charging/economy): counterfactual schedules
  // over each plug-in window. Several queries + the pure math -> sub-timings.
  economy: protectedProcedure
    .input(z.object({ year: yearInput, vehicle: vehicleInput }))
    .handler(async ({ input, context }) => {
      const timings: EconomyTimings = {}
      const result = await getEconomyOverview({ year: input.year, timings, vehicle: input.vehicle })
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

  // Admin's call on who charged one session (ADR-0021); null = back to automatic.
  setSessionVehicle: adminProcedure
    .errors(evChargingErrors)
    .input(z.object({ sessionId: z.uuid(), vehicle: z.enum(VEHICLES).nullable() }))
    .handler(async ({ input, errors, context }) => {
      // The reset path (vehicle = null) runs three statements, so time it.
      const start = performance.now()
      try {
        return await evChargingService.setSessionVehicle(input.sessionId, input.vehicle)
      } catch (err) {
        if (err instanceof EvChargingDomainError) throw errors[err.code]()
        throw err
      } finally {
        if (context.timings) context.timings.vehicleTagMs = Math.round(performance.now() - start)
      }
    }),

  // The car's own charging log, parsed in the admin's browser (no file bytes
  // here — ADR-0006), then one re-match. Two writes -> sub-timings.
  // Deliberately NOT one transaction: if the re-match fails the records stay
  // stored, and re-importing is the recovery (the re-match runs regardless of
  // `inserted`); the next Zaptec sync re-derives attribution anyway.
  // `ours`/`other` count every session any rule decided — including the live
  // branch (ADR-0022) — not just the import's, and not just changed ones.
  importVehicleRecords: adminProcedure
    .input(z.object({ rows: z.array(vehicleRecordInput).min(1).max(MAX_IMPORT_ROWS) }))
    .handler(async ({ input, context }) => {
      const importStart = performance.now()
      let reattributeStart: number | undefined
      try {
        const imported = await vehicleChargeService.importRecords(input.rows)
        reattributeStart = performance.now()
        const { ours, other } = await evChargingService.reattributeSessions()
        return { ...imported, ours, other }
      } finally {
        if (context.timings) {
          const end = performance.now()
          context.timings.vehicleImportMs = Math.round((reattributeStart ?? end) - importStart)
          if (reattributeStart !== undefined) {
            context.timings.vehicleReattributeMs = Math.round(end - reattributeStart)
          }
        }
      }
    }),

  vehicleRecordCoverage: adminProcedure.handler(() => vehicleChargeService.coverage()),

  // Admin card: when the Škoda poll last heard from the car (ADR-0022). Times only.
  vehicleStateLatest: adminProcedure.handler(() => vehicleStateService.latestSnapshot()),

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
  // nu" fires one call per source (sessions, prices, house energy) in
  // parallel, so the quick session sync isn't held behind a long price or
  // house backfill, and each alert's retry runs only
  // its own source. A run never throws for a failed/skipped outcome (those
  // are recorded in health); only a genuine bug propagates.
  syncNow: adminProcedure.input(sourceInput).handler(async ({ input, context }) => {
    if (input?.source === 'emaldo') {
      const run = await runEmaldoSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.emaldoSyncMs = run.durationMs
        // Summed request time over the five parallel series: busy time, not latency.
        context.timings.emaldoFetchMs = run.fetchMs
        context.timings.emaldoStoreMs = run.storeMs
        context.timings.emaldoDeriveMs = run.deriveMs
      }
      // Counts only: readings never leave the server (ADR-0023).
      return { outcome: run.outcome, code: run.code, upserted: run.bucketsStored }
    }
    if (input?.source === 'skoda') {
      const run = await runSkodaSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.skodaSyncMs = run.durationMs
        context.timings.skodaFetchMs = run.fetchMs
        context.timings.skodaSnapshotMs = run.snapshotMs
        context.timings.skodaReattributeMs = run.reattributeMs
        context.timings.skodaReminderMs = run.reminderMs
      }
      return { outcome: run.outcome, code: run.code, upserted: run.stored ? 1 : 0 }
    }
    if ((input?.source ?? 'zaptec') === 'elpris') {
      const run = await runElprisSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.elprisSyncMs = run.durationMs
        context.timings.elprisFetchMs = run.fetchMs
        context.timings.elprisImportMs = run.importMs
        context.timings.elprisDeriveMs = run.deriveMs
      }
      return { outcome: run.outcome, code: run.code, upserted: run.upserted }
    }
    const run = await runZaptecSync({ trigger: 'admin', deps: { log: context.log } })
    if (context.timings) {
      context.timings.zaptecSyncMs = run.durationMs
      context.timings.zaptecFetchMs = run.fetchMs
      context.timings.zaptecImportMs = run.importMs
      context.timings.zaptecDeriveMs = run.deriveMs
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
