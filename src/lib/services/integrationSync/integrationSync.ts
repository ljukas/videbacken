import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { integrationSync, integrationSyncRun } from '~/lib/db/schema'
import type {
  HealthState,
  HealthTransition,
  IntegrationErrorCode,
  IntegrationSource,
  SyncTrigger,
} from '~/lib/integrationHealth'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { LEASE_DURATION_MS, RUN_RETENTION_MS } from './policy'
import { sanitizeErrorMessage } from './sanitize'
import { deriveState, type HealthSnapshot, nextRow, type SyncOutcome } from './transition'

export type { RunStats, SyncOutcome } from './transition'

export type IntegrationHealth = {
  source: IntegrationSource
  state: HealthState
  running: boolean
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  failingSince: Date | null
  consecutiveFailures: number
  code: IntegrationErrorCode | null
  adminDetail: { lastErrorMessage: string | null } | null
}

export type RunRow = {
  id: string
  trigger: SyncTrigger
  startedAt: Date
  finishedAt: Date
  durationMs: number
  outcome: 'ok' | 'failed' | 'error'
  errorCode: IntegrationErrorCode | null
  errorMessage: string | null
  upserted: number
  sessionsSeen: number
  pages: number
}

type SyncRow = typeof integrationSync.$inferSelect

function toSnapshot(row: SyncRow): HealthSnapshot {
  return {
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastSuccessStartedAt: row.lastSuccessStartedAt,
    failingSince: row.failingSince,
    consecutiveFailures: row.consecutiveFailures,
    errorCode: row.errorCode as IntegrationErrorCode | null,
    lastErrorMessage: row.lastErrorMessage,
  }
}

function toHealth(
  source: IntegrationSource,
  row: SyncRow | undefined,
  now: Date,
  includeAdminDetail: boolean,
): IntegrationHealth {
  const snapshot = row ? toSnapshot(row) : null
  return {
    source,
    state: deriveState(source, snapshot, now),
    running: row?.leaseUntil != null && row.leaseUntil.getTime() > now.getTime(),
    lastAttemptAt: snapshot?.lastAttemptAt ?? null,
    lastSuccessAt: snapshot?.lastSuccessAt ?? null,
    failingSince: snapshot?.failingSince ?? null,
    consecutiveFailures: snapshot?.consecutiveFailures ?? 0,
    code: snapshot?.errorCode ?? null,
    adminDetail: includeAdminDetail
      ? { lastErrorMessage: snapshot?.lastErrorMessage ?? null }
      : null,
  }
}

// Takes the source's sync lease unless an unexpired one is held. A row lease
// (not an advisory lock): prod runs behind the Supabase transaction pooler,
// where session-level locks don't survive. The random `lease_token` is the
// attempt's identity — `recordOutcome` compares it, never timestamps.
export async function beginAttempt(
  source: IntegrationSource,
  { now }: { now: Date },
): Promise<{ acquired: true; attemptId: string } | { acquired: false; runningSince: Date }> {
  await db.insert(integrationSync).values({ source, updatedAt: now }).onConflictDoNothing()
  const [acquired] = await db
    .update(integrationSync)
    .set({
      runningSince: now,
      leaseUntil: new Date(now.getTime() + LEASE_DURATION_MS),
      leaseToken: sql`gen_random_uuid()`,
      updatedAt: now,
    })
    .where(
      and(
        eq(integrationSync.source, source),
        or(isNull(integrationSync.leaseUntil), lt(integrationSync.leaseUntil, now)),
      ),
    )
    .returning({ leaseToken: integrationSync.leaseToken })
  if (acquired?.leaseToken) return { acquired: true, attemptId: acquired.leaseToken }

  const [held] = await db
    .select({ runningSince: integrationSync.runningSince })
    .from(integrationSync)
    .where(eq(integrationSync.source, source))
  // The holder may have finished between the two statements; it still counts
  // as "was running" — the next scheduled run picks up.
  return { acquired: false, runningSince: held?.runningSince ?? now }
}

// Records one attempt's result: in a single transaction, locks the row, checks
// the attempt still holds the lease, applies `nextRow`, clears the lease and
// appends the run row. The row lock serializes concurrent finishers, so at most
// one of them sees the streak edge — at most one alert per transition. A lost
// lease (expired and taken over) writes nothing and reports `none`.
export async function recordOutcome(
  source: IntegrationSource,
  outcome: SyncOutcome,
  {
    attemptId,
    trigger,
    startedAt,
    now,
    log = logger,
  }: { attemptId: string; trigger: SyncTrigger; startedAt: Date; now: Date; log?: Logger },
): Promise<{ transition: HealthTransition; health: IntegrationHealth }> {
  const result = await db.transaction(async (tx) => {
    const [prev] = await tx
      .select()
      .from(integrationSync)
      .where(eq(integrationSync.source, source))
      .for('update')
    if (!prev || prev.leaseToken !== attemptId) {
      log.warn('integration sync lease lost; outcome discarded', {
        source,
        trigger,
        outcome: outcome.ok ? 'ok' : outcome.kind,
      })
      return { transition: 'none' as const, row: prev, recorded: false }
    }

    const { row, transition } = nextRow(toSnapshot(prev), outcome, now, startedAt)
    const [updated] = await tx
      .update(integrationSync)
      .set({
        ...row,
        runningSince: null,
        leaseUntil: null,
        leaseToken: null,
        updatedAt: now,
      })
      .where(eq(integrationSync.source, source))
      .returning()

    const { stats } = outcome
    await tx.insert(integrationSyncRun).values({
      source,
      trigger,
      startedAt,
      finishedAt: now,
      durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
      outcome: outcome.ok ? 'ok' : outcome.kind,
      errorCode: outcome.ok ? null : outcome.code,
      errorMessage: outcome.ok ? null : sanitizeErrorMessage(outcome.message),
      since: stats.since,
      pages: stats.pages,
      sessionsSeen: stats.sessionsSeen,
      upserted: stats.upserted,
      voided: stats.voided,
      timings: stats.timings,
    })
    return { transition, row: updated, recorded: true }
  })

  // Pruned after commit, so a failing DELETE can never roll back (or abort)
  // the outcome it follows.
  if (result.recorded) {
    try {
      await db
        .delete(integrationSyncRun)
        .where(
          and(
            eq(integrationSyncRun.source, source),
            lt(integrationSyncRun.startedAt, new Date(now.getTime() - RUN_RETENTION_MS)),
          ),
        )
    } catch (error) {
      log.warn('integration sync run pruning failed', { source, error })
    }
  }

  return {
    transition: result.transition,
    health: toHealth(source, result.row, now, true),
  }
}

export async function getHealth(
  source: IntegrationSource,
  { now, includeAdminDetail }: { now: Date; includeAdminDetail: boolean },
): Promise<IntegrationHealth> {
  const [row] = await db.select().from(integrationSync).where(eq(integrationSync.source, source))
  return toHealth(source, row, now, includeAdminDetail)
}

// The sync run's watermark: the next fetch window starts from here.
export async function getLastSuccessStartedAt(source: IntegrationSource): Promise<Date | null> {
  const [row] = await db
    .select({ lastSuccessStartedAt: integrationSync.lastSuccessStartedAt })
    .from(integrationSync)
    .where(eq(integrationSync.source, source))
  return row?.lastSuccessStartedAt ?? null
}

export async function listRecentRuns(
  source: IntegrationSource,
  { limit }: { limit: number },
): Promise<RunRow[]> {
  const rows = await db
    .select({
      id: integrationSyncRun.id,
      trigger: integrationSyncRun.trigger,
      startedAt: integrationSyncRun.startedAt,
      finishedAt: integrationSyncRun.finishedAt,
      durationMs: integrationSyncRun.durationMs,
      outcome: integrationSyncRun.outcome,
      errorCode: integrationSyncRun.errorCode,
      errorMessage: integrationSyncRun.errorMessage,
      upserted: integrationSyncRun.upserted,
      sessionsSeen: integrationSyncRun.sessionsSeen,
      pages: integrationSyncRun.pages,
    })
    .from(integrationSyncRun)
    .where(eq(integrationSyncRun.source, source))
    .orderBy(desc(integrationSyncRun.startedAt))
    .limit(limit)
  return rows.map((r) => ({
    ...r,
    trigger: r.trigger as SyncTrigger,
    outcome: r.outcome as RunRow['outcome'],
    errorCode: r.errorCode as IntegrationErrorCode | null,
  }))
}
