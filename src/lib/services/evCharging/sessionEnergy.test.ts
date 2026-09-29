import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { earliestCountedStartAt, listSessionEnergy } from './sessionEnergy'

setupDatabase()

let counter = 0

async function insertSession(
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
): Promise<string> {
  counter += 1
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger', installationId: 'install-1' })
    .onConflictDoNothing()
  const startAt = overrides.startAt ?? new Date('2026-09-01T20:00:00Z')
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: `zap-${counter}`,
      chargerId: 'charger-1',
      startAt,
      endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
      energyKwh: 10,
      ...overrides,
    })
    .returning({ id: evChargeSession.id })
  return row.id
}

test('returns counted sessions oldest first with their intervals as stretches', async () => {
  const later = await insertSession({ startAt: new Date('2026-09-02T20:00:00Z') })
  const earlier = await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') })
  await db.insert(evChargeInterval).values([
    {
      sessionId: earlier,
      startAt: new Date('2026-09-01T21:00:00Z'),
      endAt: new Date('2026-09-01T22:00:00Z'),
      energyKwh: 6,
    },
    {
      sessionId: earlier,
      startAt: new Date('2026-09-01T20:00:00Z'),
      endAt: new Date('2026-09-01T21:00:00Z'),
      energyKwh: 4,
    },
  ])

  const sessions = await listSessionEnergy({ all: true })

  expect(sessions.map((s) => s.sessionId)).toEqual([earlier, later])
  expect(sessions[0]).toMatchObject({ estimated: false, energyKwh: 10 })
  // The interval-less session next to it keeps its own fallback stretch.
  expect(sessions[1]).toMatchObject({ estimated: true })
  expect(sessions[1].stretches).toEqual([
    {
      startMs: Date.parse('2026-09-02T20:00:00Z'),
      endMs: Date.parse('2026-09-02T22:00:00Z'),
      kwh: 10,
    },
  ])
  expect(sessions[0].stretches).toEqual([
    {
      startMs: Date.parse('2026-09-01T20:00:00Z'),
      endMs: Date.parse('2026-09-01T21:00:00Z'),
      kwh: 4,
    },
    {
      startMs: Date.parse('2026-09-01T21:00:00Z'),
      endMs: Date.parse('2026-09-01T22:00:00Z'),
      kwh: 6,
    },
  ])
})

test('a session without intervals becomes one estimated stretch over its whole span', async () => {
  const id = await insertSession({ energyKwh: 7 })
  const [session] = await listSessionEnergy({ all: true })
  expect(session).toMatchObject({ sessionId: id, estimated: true })
  expect(session.stretches).toEqual([
    {
      startMs: Date.parse('2026-09-01T20:00:00Z'),
      endMs: Date.parse('2026-09-01T22:00:00Z'),
      kwh: 7,
    },
  ])
})

test('noise, voided and replaced sessions are excluded', async () => {
  await insertSession({ energyKwh: 0.3 })
  await insertSession({ voided: true })
  await insertSession({ replacedByZaptecSessionId: 'zap-x' })
  const kept = await insertSession()
  expect((await listSessionEnergy({ all: true })).map((s) => s.sessionId)).toEqual([kept])
})

test('filters by session ids, still only counted ones', async () => {
  const a = await insertSession()
  const b = await insertSession({ startAt: new Date('2026-09-03T20:00:00Z') })
  const voided = await insertSession({ voided: true })
  expect((await listSessionEnergy({ sessionIds: [b, voided] })).map((s) => s.sessionId)).toEqual([
    b,
  ])
  expect(await listSessionEnergy({ sessionIds: [] })).toEqual([])
  expect(a).toBeTypeOf('string')
})

test('earliestCountedStartAt ignores uncounted sessions', async () => {
  expect(await earliestCountedStartAt()).toBeNull()
  await insertSession({ startAt: new Date('2026-01-27T08:00:00Z'), energyKwh: 0.1 })
  await insertSession({ startAt: new Date('2026-01-28T08:00:00Z'), voided: true })
  await insertSession({ startAt: new Date('2026-01-29T08:00:00Z'), replacedByZaptecSessionId: 'z' })
  await insertSession({ startAt: new Date('2026-02-03T08:00:00Z') })
  expect(await earliestCountedStartAt()).toEqual(new Date('2026-02-03T08:00:00Z'))
})
