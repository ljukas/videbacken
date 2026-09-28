import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import {
  evChargeInterval,
  evCharger,
  evChargeSession,
  integrationSync,
  integrationSyncRun,
} from '~/lib/db/schema'
import { INTEGRATION_ERROR_CODES } from '~/lib/integrationHealth'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not src/lib/db/schema/) because drizzle-kit scans the
// schema directory as schema — a *.test.ts there breaks `db:generate` (it tries
// to `require()` this file, which imports vitest, an ESM-only package).
setupDatabase()

async function insertCharger(id: string) {
  await db.insert(evCharger).values({ id, name: 'Charger', installationId: 'install-1' })
  return id
}

async function insertSession(
  chargerId: string,
  zaptecSessionId: string,
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
) {
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId,
      chargerId,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T11:00:00Z'),
      energyKwh: 10,
      ...overrides,
    })
    .returning({ id: evChargeSession.id })
  return row.id
}

// drizzle wraps the driver error: its `.message` is "Failed query: ...", and the
// violated constraint name lives on the postgres-js cause (`constraint_name` /
// message). Assert against that so the test pins the *specific* constraint.
async function expectConstraintViolation(promise: Promise<unknown>, constraint: string) {
  let error: unknown = null
  try {
    await promise
  } catch (e) {
    error = e
  }
  expect(error, 'expected the insert to be rejected').not.toBeNull()
  const cause = (error as { cause?: unknown }).cause ?? error
  const detail =
    (cause as { constraint_name?: string }).constraint_name ??
    (cause as { message?: string }).message ??
    String(error)
  expect(detail).toContain(constraint)
}

test('a session with end_at < start_at is rejected', async () => {
  const chargerId = await insertCharger('charger-1')
  await expectConstraintViolation(
    insertSession(chargerId, 'session-1', {
      startAt: new Date('2026-01-01T11:00:00Z'),
      endAt: new Date('2026-01-01T10:00:00Z'),
    }),
    'ev_charge_session_end_at_check',
  )
})

test('an interval with energy_kwh < 0 is rejected', async () => {
  const chargerId = await insertCharger('charger-2')
  const sessionId = await insertSession(chargerId, 'session-2')
  await expectConstraintViolation(
    db.insert(evChargeInterval).values({
      sessionId,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T10:15:00Z'),
      energyKwh: -1,
    }),
    'ev_charge_interval_energy_kwh_nonneg_check',
  )
})

test('deleting a session cascades its intervals', async () => {
  const chargerId = await insertCharger('charger-3')
  const sessionId = await insertSession(chargerId, 'session-3')
  await db.insert(evChargeInterval).values({
    sessionId,
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T10:15:00Z'),
    energyKwh: 1,
  })

  await db.delete(evChargeSession).where(eq(evChargeSession.id, sessionId))

  const remaining = await db
    .select()
    .from(evChargeInterval)
    .where(eq(evChargeInterval.sessionId, sessionId))
  expect(remaining).toHaveLength(0)
})

test('an integration_sync row with consecutive_failures = 1 and error_code = null is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({
      source: 'zaptec',
      consecutiveFailures: 1,
      errorCode: null,
    }),
    'integration_sync_failures_error_code_check',
  )
})

test("an integration_sync_run with outcome = 'ok' and an error_code is rejected", async () => {
  await expectConstraintViolation(
    db.insert(integrationSyncRun).values({
      source: 'zaptec',
      trigger: 'cron',
      startedAt: new Date('2026-01-01T10:00:00Z'),
      finishedAt: new Date('2026-01-01T10:00:01Z'),
      durationMs: 1000,
      outcome: 'ok',
      errorCode: 'unreachable',
    }),
    'integration_sync_run_outcome_error_code_check',
  )
})

test('every INTEGRATION_ERROR_CODES value is accepted by integration_sync.error_code', async () => {
  const sources = ['zaptec', 'elpris', 'skoda'] as const
  for (const [index, errorCode] of INTEGRATION_ERROR_CODES.entries()) {
    const source = sources[index % sources.length]
    await db
      .insert(integrationSync)
      .values({ source, consecutiveFailures: 1, errorCode, failingSince: new Date() })
      .onConflictDoUpdate({
        target: integrationSync.source,
        set: { consecutiveFailures: 1, errorCode, failingSince: new Date() },
      })
  }
})
