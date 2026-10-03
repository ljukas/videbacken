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
import { expectConstraintViolation } from '~test/expectConstraintViolation'
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

test('a duplicate (session_id, start_at) interval is rejected', async () => {
  const chargerId = await insertCharger('charger-dup')
  const sessionId = await insertSession(chargerId, 'session-dup')
  const startAt = new Date('2026-01-01T10:00:00Z')
  await db.insert(evChargeInterval).values({
    sessionId,
    startAt,
    endAt: new Date('2026-01-01T10:15:00Z'),
    energyKwh: 1,
  })
  await expectConstraintViolation(
    db.insert(evChargeInterval).values({
      sessionId,
      startAt,
      endAt: new Date('2026-01-01T10:20:00Z'),
      energyKwh: 2,
    }),
    'ev_charge_interval_pk',
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

test('an integration_sync row with lease_until set but no lease_token is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({
      source: 'zaptec',
      runningSince: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      leaseToken: null,
    }),
    'integration_sync_lease_until_token_check',
  )
})

test('an integration_sync row with a credential_reminder_days outside the thresholds is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({
      source: 'skoda',
      credentialExpiresAt: new Date(Date.now() + 86_400_000),
      credentialReminderDays: 14,
    }),
    'integration_sync_credential_reminder_days_check',
  )
})

test('an integration_sync row with credential_reminder_days but no credential_expires_at is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({
      source: 'skoda',
      credentialExpiresAt: null,
      credentialReminderDays: 30,
    }),
    'integration_sync_credential_reminder_expiry_check',
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
  const stored = new Map<(typeof sources)[number], string | null>()
  for (const [index, errorCode] of INTEGRATION_ERROR_CODES.entries()) {
    const source = sources[index % sources.length]
    await db
      .insert(integrationSync)
      .values({ source, consecutiveFailures: 1, errorCode, failingSince: new Date() })
      .onConflictDoUpdate({
        target: integrationSync.source,
        set: { consecutiveFailures: 1, errorCode, failingSince: new Date() },
      })
    // Only the LAST write per source (3 sources, 7 codes) survives the upsert
    // cycle; track that expectation instead of asserting mid-loop.
    stored.set(source, errorCode)
  }

  const rows = await db
    .select({ source: integrationSync.source, errorCode: integrationSync.errorCode })
    .from(integrationSync)
  expect(rows).toHaveLength(stored.size)
  for (const row of rows) {
    expect(row.errorCode).toBe(stored.get(row.source as (typeof sources)[number]))
  }
})
