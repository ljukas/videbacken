import { type LatLon, newCallStats, type SkodaClient, SkodaError, skoda } from '~/lib/effects/skoda'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import * as evChargingService from '~/lib/services/evCharging'
import * as vehicleStateService from '~/lib/services/vehicleState'
import { atHome, parseHomePoint } from './geofence'

/**
 * One poll of the MyŠkoda Public API (ADR-0022), inside the shared
 * pulled-integration lifecycle (lease, health, alert email, one run line).
 * Called by the 15-min cron and the admin `syncNow`. The parked position is
 * reduced to `atHome` here and dropped; no presence (plug, position, at home)
 * is ever logged. A stateless source: `since`/`syncedUntil` stay null (the
 * health watermark then defaults to `startedAt`, which nothing reads for Škoda).
 */
export type SkodaSyncRun = RunBase & {
  source: 'skoda'
  fetchMs: number
  snapshotMs: number
  requests: number
  retries: number
  /** The poll was written to vehicle_state_snapshot. */
  stored: boolean
  /** Whether a valid home point was configured for this run. */
  geofence: 'on' | 'off'
  missingParts: number
  invalidParts: number
  reattributeMs: number
  reattributeChanged: number
}

const SOURCE = 'skoda'
/**
 * Budget for the one GET (10 s per attempt, ≤ 1 retry + ≤ 10 s Retry-After ≈
 * 30 s) plus the insert and re-match. Well under Vercel's 300 s maxDuration,
 * which is no longer than the 5-min lease (ADR-0019), so a slow run still records.
 */
const RUN_DEADLINE_MS = 60_000

// Warn once per instance, not every 15 min; the run line carries `geofence`.
let warnedNoHomePoint = false

export async function runSkodaSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  deadlineMs?: number
  deps?: { skoda?: SkodaClient; log?: Logger; homePoint?: LatLon | null }
}): Promise<SkodaSyncRun> {
  const client = opts.deps?.skoda ?? skoda
  const stats = newCallStats()
  const homePoint =
    opts.deps && 'homePoint' in opts.deps
      ? (opts.deps.homePoint ?? null)
      : parseHomePoint(process.env.SKODA_HOME_COORDINATES)
  return runPulledSync<SkodaSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      source: SOURCE,
      fetchMs: 0,
      snapshotMs: 0,
      requests: 0,
      retries: 0,
      stored: false,
      geofence: homePoint ? 'on' : 'off',
      missingParts: 0,
      invalidParts: 0,
      reattributeMs: 0,
      reattributeChanged: 0,
    }),
    execute: async ({ run, signal, now, log }) => {
      const { state } = await withDeadline(
        client.vehicleState({ signal, stats }),
        signal,
        () =>
          new SkodaError('unreachable', 'vehicle', undefined, {
            cause: { name: 'TimeoutError' },
            message: 'Škoda vehicle did not answer within the sync deadline',
          }),
      )
      run.missingParts = state.missingParts.length
      run.invalidParts = state.invalidParts.length
      // Only counts and our own part names — no API text or codes.
      if (run.invalidParts > 0) {
        // Drift: a part came back in a shape we reject.
        log.warn('skoda sync: parts invalid', { invalidParts: state.invalidParts })
      }
      if (run.missingParts > 0) {
        // Škoda said so; normal while the car sleeps, so info. Only the count: an
        // unavailability code (parking, "in motion") could tell where the car is.
        log.info('skoda sync: parts unavailable', { missingParts: state.missingParts.length })
      }
      if (!homePoint && !warnedNoHomePoint) {
        warnedNoHomePoint = true
        log.warn('skoda sync: home point unset or invalid, geofence off')
      }
      const started = performance.now()
      await vehicleStateService.recordSnapshot({
        polledAt: now(),
        capturedAt: state.chargingCapturedAt,
        chargingState: state.chargingState,
        chargeType: state.chargeType,
        plugState: state.plugState,
        chargePowerKw: state.chargePowerKw,
        parkingState: state.parking?.state ?? null,
        atHome: atHome(state.parking, homePoint),
        socPercent: state.socPercent,
        odometerKm: state.odometerKm,
        odometerCapturedAt: state.odometerCapturedAt,
      })
      run.snapshotMs = Math.round(performance.now() - started)
      run.stored = true
      // Recovery path. In steady state the Zaptec sync that imports a finished
      // session already re-matches it (every poll in its window exists by then);
      // this catches a Zaptec re-match that failed or hit its deadline, and the
      // first-deploy backfill. Don't remove either.
      // Health tracks the poll, not attribution: a failure here only warns.
      const rematchStart = performance.now()
      try {
        if (signal.aborted) {
          log.warn('skoda sync: vehicle re-match skipped, run deadline reached')
        } else {
          const result = await withDeadline(
            evChargingService.reattributeSessions(),
            signal,
            () => new Error('vehicle re-match did not finish within the sync deadline'),
          )
          run.reattributeChanged = result.changed
        }
      } catch (error) {
        log.warn('skoda sync: vehicle re-match failed', { error })
      } finally {
        run.reattributeMs = Math.round(performance.now() - rematchStart)
      }
    },
    // Run-history columns are session-named: for Škoda, sessionsSeen/upserted
    // = 1 when a poll was read/stored (documented in ADR-0022).
    toRunStats: (run) => ({
      since: null,
      pages: 0,
      sessionsSeen: run.stored ? 1 : 0,
      upserted: run.stored ? 1 : 0,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        snapshotMs: run.snapshotMs,
        reattributeMs: run.reattributeMs,
        requests: stats.requests,
        retries: stats.retries,
      },
    }),
    finalize: (run) => {
      run.fetchMs = Math.round(stats.fetchMs)
      run.requests = stats.requests
      run.retries = stats.retries
    },
    logFields: (run) => ({
      fetchMs: run.fetchMs,
      snapshotMs: run.snapshotMs,
      requests: run.requests,
      retries: run.retries,
      stored: run.stored,
      geofence: run.geofence,
      missingParts: run.missingParts,
      invalidParts: run.invalidParts,
      reattributeMs: run.reattributeMs,
      reattributeChanged: run.reattributeChanged,
    }),
  })
}
