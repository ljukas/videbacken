import { test } from 'vitest'
import { db } from '~/lib/db'
import { integrationCredential, integrationSync, integrationSyncRun } from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/): drizzle-kit scans schema/ and would try to
// require() this file.
setupDatabase()

const runRow = (source: string) => ({
  source,
  trigger: 'cron',
  startedAt: new Date('2026-04-01T10:00:00Z'),
  finishedAt: new Date('2026-04-01T10:00:01Z'),
  durationMs: 1000,
  outcome: 'ok',
})
// Any well-formed envelope: the CHECK looks at the shape, never decrypts.
const ENVELOPE = 'v1.aaaa.bbbb.cccc'

test('comfortCloud passes both sync source CHECKs', async () => {
  await db.insert(integrationSync).values({ source: 'comfortCloud' })
  await db.insert(integrationSyncRun).values(runRow('comfortCloud'))
})

test('comfortCloud passes the credential source CHECK with its two field names', async () => {
  await db
    .insert(integrationCredential)
    .values({ source: 'comfortCloud', ciphertext: ENVELOPE, fieldsSet: ['user', 'password'] })
})

test('a failed comfortCloud run may blame user and password (suspect_fields unchanged)', async () => {
  await db.insert(integrationSyncRun).values({
    ...runRow('comfortCloud'),
    outcome: 'failed',
    errorCode: 'auth_failed',
    suspectFields: ['user', 'password'],
  })
})

test('a source outside the vocabulary is still rejected by every source CHECK', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'comfort_cloud' }),
    'integration_sync_source_check',
  )
  await expectConstraintViolation(
    db.insert(integrationSyncRun).values(runRow('comfort_cloud')),
    'integration_sync_run_source_check',
  )
  await expectConstraintViolation(
    db
      .insert(integrationCredential)
      .values({ source: 'comfort_cloud', ciphertext: ENVELOPE, fieldsSet: ['user'] }),
    'integration_credential_source_check',
  )
})
