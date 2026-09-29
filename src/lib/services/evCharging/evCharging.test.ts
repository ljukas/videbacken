import { eq, sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import type { ZaptecCharger, ZaptecSession } from '~/lib/evCharging/types'
import { setupDatabase } from '~test/setup'
import { findLiveCharger, importSessions, listChargers, upsertChargers } from './evCharging'

setupDatabase()

function session(overrides: Partial<ZaptecSession> = {}): ZaptecSession {
  return {
    id: 'zap-1',
    chargerId: 'charger-1',
    startAt: new Date('2026-01-10T10:00:00Z'),
    endAt: new Date('2026-01-10T12:00:00Z'),
    energyKwh: 5,
    intervals: [],
    authorizedUser: null,
    tokenName: null,
    voided: false,
    replacedBySessionId: null,
    offline: false,
    reliableClock: true,
    ...overrides,
  }
}

test('upsertChargers inserts new chargers', async () => {
  const chargers: ZaptecCharger[] = [
    { id: 'c1', name: 'Garage 1', installationId: 'install-1', isOnline: true },
    { id: 'c2', name: 'Garage 2', installationId: 'install-1', isOnline: false },
  ]
  await upsertChargers(chargers)
  const rows = await listChargers()
  expect(rows).toEqual([
    { id: 'c1', name: 'Garage 1', installationId: 'install-1' },
    { id: 'c2', name: 'Garage 2', installationId: 'install-1' },
  ])
})

test('upsertChargers overwrites an existing charger — including a previously-created stub', async () => {
  // Import a session for an unknown charger first: creates a stub row named
  // after the charger id.
  await importSessions([session({ chargerId: 'c1' })], { installationId: 'install-1' })
  const stub = await listChargers()
  expect(stub).toEqual([{ id: 'c1', name: 'c1', installationId: 'install-1' }])

  // upsertChargers later fills in the real name for a charger Zaptec still lists.
  await upsertChargers([
    { id: 'c1', name: 'Garage real name', installationId: 'install-1', isOnline: true },
  ])
  const updated = await listChargers()
  expect(updated).toEqual([{ id: 'c1', name: 'Garage real name', installationId: 'install-1' }])
})

test('upsertChargers with an empty array is a no-op', async () => {
  await upsertChargers([])
  expect(await listChargers()).toEqual([])
})

test('importSessions imports a valid session with its intervals', async () => {
  const result = await importSessions(
    [
      session({
        intervals: [
          {
            startAt: new Date('2026-01-10T10:00:00Z'),
            endAt: new Date('2026-01-10T11:00:00Z'),
            energyKwh: 2,
          },
          {
            startAt: new Date('2026-01-10T11:00:00Z'),
            endAt: new Date('2026-01-10T12:00:00Z'),
            energyKwh: 3,
          },
        ],
      }),
    ],
    { installationId: 'install-1' },
  )
  expect(result).toEqual({ upserted: 1, voided: 0, skipped: 0 })

  const [row] = await db
    .select()
    .from(evChargeSession)
    .where(eq(evChargeSession.zaptecSessionId, 'zap-1'))
  expect(row).toMatchObject({ chargerId: 'charger-1', energyKwh: 5, voided: false })

  const intervals = await db
    .select()
    .from(evChargeInterval)
    .where(eq(evChargeInterval.sessionId, row.id))
  expect(intervals).toHaveLength(2)
})

test('importSessions is idempotent on re-import', async () => {
  const ctx = { installationId: 'install-1' }
  await importSessions([session({ energyKwh: 5 })], ctx)
  const second = await importSessions([session({ energyKwh: 5 })], ctx)
  expect(second).toEqual({ upserted: 1, voided: 0, skipped: 0 })

  const rows = await db
    .select()
    .from(evChargeSession)
    .where(eq(evChargeSession.zaptecSessionId, 'zap-1'))
  expect(rows).toHaveLength(1)
})

test('importSessions updates a session in place when its void flag flips', async () => {
  const ctx = { installationId: 'install-1' }
  await importSessions([session({ voided: false })], ctx)
  const result = await importSessions([session({ voided: true })], ctx)
  expect(result).toEqual({ upserted: 1, voided: 1, skipped: 0 })

  const rows = await db
    .select()
    .from(evChargeSession)
    .where(eq(evChargeSession.zaptecSessionId, 'zap-1'))
  expect(rows).toHaveLength(1)
  expect(rows[0].voided).toBe(true)
})

test('importSessions replaces changed intervals without duplicating them', async () => {
  const ctx = { installationId: 'install-1' }
  await importSessions(
    [
      session({
        intervals: [
          {
            startAt: new Date('2026-01-10T10:00:00Z'),
            endAt: new Date('2026-01-10T11:00:00Z'),
            energyKwh: 2,
          },
        ],
      }),
    ],
    ctx,
  )
  await importSessions(
    [
      session({
        intervals: [
          {
            startAt: new Date('2026-01-10T10:00:00Z'),
            endAt: new Date('2026-01-10T10:30:00Z'),
            energyKwh: 1,
          },
          {
            startAt: new Date('2026-01-10T10:30:00Z'),
            endAt: new Date('2026-01-10T11:00:00Z'),
            energyKwh: 1.5,
          },
        ],
      }),
    ],
    ctx,
  )

  const [sessionRow] = await db
    .select()
    .from(evChargeSession)
    .where(eq(evChargeSession.zaptecSessionId, 'zap-1'))
  const intervals = await db
    .select()
    .from(evChargeInterval)
    .where(eq(evChargeInterval.sessionId, sessionRow.id))
  expect(intervals).toHaveLength(2)
  expect(intervals.map((i) => i.energyKwh).sort()).toEqual([1, 1.5])
})

test('importSessions creates a stub charger for an unknown charger id and imports the session', async () => {
  const result = await importSessions([session({ chargerId: 'unknown-charger' })], {
    installationId: 'install-9',
  })
  expect(result).toEqual({ upserted: 1, voided: 0, skipped: 0 })

  const [charger] = await db.select().from(evCharger).where(eq(evCharger.id, 'unknown-charger'))
  expect(charger).toMatchObject({
    id: 'unknown-charger',
    name: 'unknown-charger',
    installationId: 'install-9',
  })

  const [sessionRow] = await db
    .select()
    .from(evChargeSession)
    .where(eq(evChargeSession.zaptecSessionId, 'zap-1'))
  expect(sessionRow.chargerId).toBe('unknown-charger')
})

test('importSessions skips an invalid session (end before start) without throwing, importing the rest', async () => {
  const ctx = { installationId: 'install-1' }
  const result = await importSessions(
    [
      session({ id: 'zap-a' }),
      session({
        id: 'zap-invalid',
        startAt: new Date('2026-01-10T12:00:00Z'),
        endAt: new Date('2026-01-10T10:00:00Z'), // end before start
      }),
      session({ id: 'zap-b' }),
    ],
    ctx,
  )
  expect(result).toEqual({ upserted: 2, voided: 0, skipped: 1 })

  const rows = await db.select().from(evChargeSession)
  expect(rows.map((r) => r.zaptecSessionId).sort()).toEqual(['zap-a', 'zap-b'])
})

test('importSessions skips an invalid session (negative energy) without throwing', async () => {
  const ctx = { installationId: 'install-1' }
  const result = await importSessions(
    [
      session({ id: 'zap-a' }),
      session({ id: 'zap-negative', energyKwh: -1 }),
      session({ id: 'zap-b' }),
    ],
    ctx,
  )
  expect(result).toEqual({ upserted: 2, voided: 0, skipped: 1 })
})

test('importSessions with all-invalid sessions returns skipped only, no throw', async () => {
  const result = await importSessions(
    [session({ id: 'zap-a', energyKwh: -1 }), session({ id: 'zap-b', energyKwh: -2 })],
    { installationId: 'install-1' },
  )
  expect(result).toEqual({ upserted: 0, voided: 0, skipped: 2 })
  expect(await db.select().from(evChargeSession)).toHaveLength(0)
})

test('importSessions skips a session with an invalid interval (end before start)', async () => {
  const result = await importSessions(
    [
      session({
        intervals: [
          {
            startAt: new Date('2026-01-10T11:00:00Z'),
            endAt: new Date('2026-01-10T10:00:00Z'),
            energyKwh: 1,
          },
        ],
      }),
    ],
    { installationId: 'install-1' },
  )
  expect(result).toEqual({ upserted: 0, voided: 0, skipped: 1 })
})

test('findLiveCharger picks the charger with the newest session over stubs and old chargers', async () => {
  expect(await findLiveCharger()).toBeNull()

  await upsertChargers([
    { id: 'a-old', name: 'A old', installationId: 'install-1', isOnline: false },
    { id: 'b-new', name: 'B new', installationId: 'install-1', isOnline: true },
  ])
  // No sessions yet → first by name.
  expect(await findLiveCharger()).toEqual({ id: 'a-old' })

  await importSessions(
    [
      session({ id: 'z1', chargerId: 'a-old' }),
      // A stub charger named after its id ('0-stub' sorts first by name).
      session({
        id: 'z2',
        chargerId: '0-stub',
        startAt: new Date('2025-01-10T10:00:00Z'),
        endAt: new Date('2025-01-10T12:00:00Z'),
      }),
      session({
        id: 'z3',
        chargerId: 'b-new',
        startAt: new Date('2026-03-01T10:00:00Z'),
        endAt: new Date('2026-03-01T12:00:00Z'),
      }),
    ],
    { installationId: 'install-1' },
  )
  expect(await findLiveCharger()).toEqual({ id: 'b-new' })
})

test('importSessions inserts more intervals than one statement can bind', async () => {
  // 4 params per interval: 20,000 rows would need 80,000 bound params, past
  // Postgres's 65,535 cap for a single statement.
  const start = new Date('2026-01-10T00:00:00Z').getTime()
  const intervals = Array.from({ length: 20_000 }, (_, i) => ({
    startAt: new Date(start + i * 1000),
    endAt: new Date(start + (i + 1) * 1000),
    energyKwh: 0.001,
  }))
  const result = await importSessions(
    [
      session({
        id: 'long',
        startAt: new Date(start),
        endAt: new Date(start + 20_000 * 1000),
        energyKwh: 20,
        intervals,
      }),
    ],
    { installationId: 'install-1' },
  )
  expect(result).toEqual({ upserted: 1, voided: 0, skipped: 0 })
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(evChargeInterval)
  expect(count).toBe(20_000)
})
