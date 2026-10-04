import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { EvChargingDomainError } from './errors'
import {
  earliestCountedStartAt,
  earliestCountedStartEndingAfter,
  getSessionEnergy,
  listSessionEnergy,
} from './sessionEnergy'

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

test('getSessionEnergy returns one counted session with its stretches', async () => {
  const id = await insertSession({ startAt: new Date('2026-09-03T20:00:00Z') })
  await db.insert(evChargeInterval).values({
    sessionId: id,
    startAt: new Date('2026-09-03T20:00:00Z'),
    endAt: new Date('2026-09-03T21:00:00Z'),
    energyKwh: 10,
  })
  const s = await getSessionEnergy(id)
  expect(s).toMatchObject({ sessionId: id, energyKwh: 10, estimated: false })
  expect(s.stretches).toHaveLength(1)
})

test('getSessionEnergy throws EV_SESSION_NOT_FOUND for an unknown id', async () => {
  await expect(getSessionEnergy('00000000-0000-4000-8000-000000000000')).rejects.toEqual(
    new EvChargingDomainError('EV_SESSION_NOT_FOUND'),
  )
})

test('getSessionEnergy picks the requested session among several counted ones', async () => {
  const a = await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') })
  const b = await insertSession({ startAt: new Date('2026-09-02T20:00:00Z') })
  expect((await getSessionEnergy(b)).sessionId).toBe(b)
  expect((await getSessionEnergy(a)).sessionId).toBe(a)
  await expect(getSessionEnergy('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
    code: 'EV_SESSION_NOT_FOUND',
  })
})

test('getSessionEnergy throws EV_SESSION_NOT_FOUND for an uncounted (voided or noise) session', async () => {
  const voided = await insertSession({ voided: true })
  const noise = await insertSession({ energyKwh: 0.2 })
  for (const id of [voided, noise]) {
    await expect(getSessionEnergy(id)).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND' })
  }
})

test('getSessionEnergy throws EV_SESSION_NOT_FOUND for a non-uuid id instead of a Postgres error', async () => {
  await expect(getSessionEnergy('not-a-uuid')).rejects.toEqual(
    new EvChargingDomainError('EV_SESSION_NOT_FOUND'),
  )
})

test('listSessionEnergy scopes { all: true } by vehicle; id lookups and the earliest start stay unscoped', async () => {
  const ours = await insertSession({ startAt: new Date('2026-09-02T20:00:00Z') })
  const guest = await insertSession({
    startAt: new Date('2026-09-01T20:00:00Z'),
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  const ids = async (vehicle?: 'ours' | 'other' | 'all') =>
    (await listSessionEnergy({ all: true, vehicle })).map((s) => s.sessionId)
  expect(await ids('ours')).toEqual([ours])
  expect(await ids('other')).toEqual([guest])
  expect(await ids('all')).toEqual([guest, ours])
  expect(await ids()).toEqual([guest, ours])
  expect(await getSessionEnergy(guest)).toMatchObject({ vehicle: 'other', vehicleSource: 'admin' })
  expect(await getSessionEnergy(ours)).toMatchObject({ vehicle: 'ours', vehicleSource: 'default' })
  expect(await earliestCountedStartAt()).toEqual(new Date('2026-09-01T20:00:00Z'))
})

test('endsAfter lists the counted sessions ending after an instant', async () => {
  await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') }) // ends 22:00
  await insertSession({ startAt: new Date('2026-09-01T22:00:00Z') }) // ends exactly at midnight
  const spanning = await insertSession({ startAt: new Date('2026-09-01T23:00:00Z') })
  const after = await insertSession({ startAt: new Date('2026-09-02T10:00:00Z') })
  await insertSession({ startAt: new Date('2026-09-02T12:00:00Z'), voided: true })
  const list = await listSessionEnergy({ endsAfter: new Date('2026-09-02T00:00:00Z') })
  expect(list.map((s) => s.sessionId)).toEqual([spanning, after])
  expect(list[0]).toMatchObject({
    estimated: true,
    stretches: [
      {
        startMs: Date.parse('2026-09-01T23:00:00Z'),
        endMs: Date.parse('2026-09-02T01:00:00Z'),
        kwh: 10,
      },
    ],
  })
})

test('earliestCountedStartEndingAfter: the earliest counted start among sessions ending after an instant', async () => {
  const midnight = new Date('2026-09-02T00:00:00Z')
  expect(await earliestCountedStartEndingAfter(midnight)).toBeNull()
  await insertSession({ startAt: new Date('2026-09-01T20:00:00Z') }) // ends before
  await insertSession({ startAt: new Date('2026-09-01T22:30:00Z'), voided: true }) // spans, voided
  await insertSession({ startAt: new Date('2026-09-01T23:00:00Z') }) // spans
  await insertSession({ startAt: new Date('2026-09-02T08:00:00Z') })
  expect(await earliestCountedStartEndingAfter(midnight)).toEqual(new Date('2026-09-01T23:00:00Z'))
})

test('endsAfter and earliestCountedStartEndingAfter leave out replaced and noise sessions', async () => {
  const midnight = new Date('2026-09-02T00:00:00Z')
  // Both span midnight and start before the counted one.
  await insertSession({
    startAt: new Date('2026-09-01T22:30:00Z'),
    replacedByZaptecSessionId: 'zap-x',
  })
  await insertSession({ startAt: new Date('2026-09-01T22:40:00Z'), energyKwh: 0.1 })
  await insertSession({ startAt: new Date('2026-09-01T22:00:00Z') }) // ends exactly at midnight
  const counted = await insertSession({ startAt: new Date('2026-09-01T23:00:00Z') })
  expect((await listSessionEnergy({ endsAfter: midnight })).map((x) => x.sessionId)).toEqual([
    counted,
  ])
  expect(await earliestCountedStartEndingAfter(midnight)).toEqual(new Date('2026-09-01T23:00:00Z'))
})

test('endsAfter reads intervals of the matching sessions only', async () => {
  const before = await insertSession({ startAt: new Date('2026-09-01T10:00:00Z') })
  const after = await insertSession({ startAt: new Date('2026-09-02T10:00:00Z') })
  const iv = (sessionId: string, from: string, to: string) => ({
    sessionId,
    startAt: new Date(from),
    endAt: new Date(to),
    energyKwh: 5,
  })
  await db
    .insert(evChargeInterval)
    .values([
      iv(before, '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'),
      iv(after, '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z'),
      iv(after, '2026-09-02T11:00:00Z', '2026-09-02T12:00:00Z'),
    ])
  const [only, ...rest] = await listSessionEnergy({ endsAfter: new Date('2026-09-02T00:00:00Z') })
  expect(rest).toEqual([])
  expect(only).toMatchObject({ sessionId: after, estimated: false })
  expect(only.stretches).toHaveLength(2)
})

test("listSessionEnergy and earliestCountedStartEndingAfter read inside a caller's transaction", async () => {
  // The test pool has one connection: using `db` instead of `tx` would hang.
  await db.transaction(async (tx) => {
    await tx
      .insert(evCharger)
      .values({ id: 'charger-tx', name: 'Charger', installationId: 'install-1' })
    const [row] = await tx
      .insert(evChargeSession)
      .values({
        zaptecSessionId: 'zap-tx',
        chargerId: 'charger-tx',
        startAt: new Date('2026-09-01T23:00:00Z'),
        endAt: new Date('2026-09-02T01:00:00Z'),
        energyKwh: 4,
      })
      .returning({ id: evChargeSession.id })
    await tx.insert(evChargeInterval).values({
      sessionId: row.id,
      startAt: new Date('2026-09-01T23:00:00Z'),
      endAt: new Date('2026-09-02T01:00:00Z'),
      energyKwh: 4,
    })
    const midnight = new Date('2026-09-02T00:00:00Z')
    const [listed] = await listSessionEnergy({ endsAfter: midnight }, tx)
    expect(listed).toMatchObject({ sessionId: row.id, estimated: false })
    expect(await earliestCountedStartEndingAfter(midnight, tx)).toEqual(
      new Date('2026-09-01T23:00:00Z'),
    )
  })
})
