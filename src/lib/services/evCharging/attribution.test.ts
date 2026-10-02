import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession } from '~/lib/db/schema'
import { insertSession, insertSnapshot, insertVehicleRecord } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { reattributeSessions, setSessionVehicle } from './attribution'
import { EvChargingDomainError } from './errors'

setupDatabase()

const at = (iso: string) => new Date(iso)
async function attribution(id: string) {
  const [row] = await db
    .select({
      vehicle: evChargeSession.vehicle,
      source: evChargeSession.vehicleSource,
      updatedAt: evChargeSession.updatedAt,
    })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, id))
  return row
}
// Coverage 2026-02-01 → 2026-03-31 via two bracketing records.
async function seedCoverage() {
  await insertVehicleRecord({
    startAt: at('2026-02-01T00:00:00Z'),
    endAt: at('2026-02-01T01:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-03-31T00:00:00Z'),
    endAt: at('2026-03-31T01:00:00Z'),
  })
}

test('no records → nothing changes', async () => {
  const id = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 0, changed: 0 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('a session overlapping a home record is ours; one overlapping nothing is other', async () => {
  await seedCoverage()
  const ours = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-02-10T11:00:00Z'),
    endAt: at('2026-02-10T13:00:00Z'),
  })
  const guest = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 1, changed: 2 })
  expect(await attribution(ours)).toMatchObject({ vehicle: 'ours', source: 'skoda' })
  expect(await attribution(guest)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('touching intervals do not overlap', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-02-10T12:00:00Z'),
    endAt: at('2026-02-10T13:00:00Z'),
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('a record ending exactly at the session start does not overlap', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-02-10T09:00:00Z'),
    endAt: at('2026-02-10T10:00:00Z'),
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('a public record never makes a session ours', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-02-10T10:30:00Z'),
    endAt: at('2026-02-10T11:00:00Z'),
    isPublic: true,
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('sessions outside coverage, admin-tagged or uncounted are left alone', async () => {
  await seedCoverage()
  const before = await insertSession({
    startAt: at('2026-01-15T10:00:00Z'),
    endAt: at('2026-01-15T12:00:00Z'),
  })
  const after = await insertSession({
    startAt: at('2026-04-02T10:00:00Z'),
    endAt: at('2026-04-02T12:00:00Z'),
  })
  const tagged = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
    vehicle: 'ours',
    vehicleSource: 'admin',
  })
  const noise = await insertSession({
    startAt: at('2026-02-11T10:00:00Z'),
    endAt: at('2026-02-11T10:05:00Z'),
    energyKwh: 0.1,
  })
  const voided = await insertSession({
    startAt: at('2026-02-12T10:00:00Z'),
    endAt: at('2026-02-12T12:00:00Z'),
    voided: true,
  })
  const replaced = await insertSession({
    startAt: at('2026-02-13T10:00:00Z'),
    endAt: at('2026-02-13T12:00:00Z'),
    replacedByZaptecSessionId: 'zap-successor',
  })
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 0, changed: 0 })
  expect(await attribution(before)).toMatchObject({ vehicle: 'ours', source: 'default' })
  expect(await attribution(after)).toMatchObject({ vehicle: 'ours', source: 'default' })
  expect(await attribution(tagged)).toMatchObject({ vehicle: 'ours', source: 'admin' })
  expect(await attribution(noise)).toMatchObject({ vehicle: 'ours', source: 'default' })
  expect(await attribution(voided)).toMatchObject({ vehicle: 'ours', source: 'default' })
  expect(await attribution(replaced)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('a session starting inside coverage and ending after it is decided', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-03-31T00:30:00Z'),
    endAt: at('2026-04-01T06:00:00Z'),
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda' })
})

test('a second pass changes nothing and leaves updated_at alone', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  await reattributeSessions()
  const before = await attribution(id)
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 1, changed: 0 })
  expect((await attribution(id)).updatedAt).toEqual(before.updatedAt)
})

test('a later home record flips a session decided as other to ours', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
  await insertVehicleRecord({
    startAt: at('2026-02-20T11:00:00Z'),
    endAt: at('2026-02-20T13:00:00Z'),
  })
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 0, changed: 1 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda' })
})

test('sessionId limits the pass to one session', async () => {
  await seedCoverage()
  const a = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  const b = await insertSession({
    startAt: at('2026-02-21T10:00:00Z'),
    endAt: at('2026-02-21T12:00:00Z'),
  })
  expect(await reattributeSessions({ sessionId: a })).toEqual({ ours: 0, other: 1, changed: 1 })
  expect(await attribution(b)).toMatchObject({ source: 'default' })
})

test('a non-uuid or empty sessionId decides nothing instead of the whole table', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  for (const sessionId of ['nope', '']) {
    expect(await reattributeSessions({ sessionId })).toEqual({ ours: 0, other: 0, changed: 0 })
  }
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('setSessionVehicle tags as admin, and a later pass keeps it', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
  })
  expect(await setSessionVehicle(id, 'ours')).toEqual({ vehicle: 'ours', vehicleSource: 'admin' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'admin' })
  expect(await setSessionVehicle(id, 'other')).toEqual({
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'admin' })
})

test('setSessionVehicle(null) resets to automatic and re-derives', async () => {
  await seedCoverage()
  const inside = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
    vehicle: 'ours',
    vehicleSource: 'admin',
  })
  const outside = await insertSession({
    startAt: at('2026-05-01T10:00:00Z'),
    endAt: at('2026-05-01T12:00:00Z'),
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  expect(await setSessionVehicle(inside, null)).toEqual({
    vehicle: 'other',
    vehicleSource: 'skoda',
  })
  expect(await setSessionVehicle(outside, null)).toEqual({
    vehicle: 'ours',
    vehicleSource: 'default',
  })
})

test('setSessionVehicle(null) on a guest tag over a home record re-derives ours', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-20T10:00:00Z'),
    endAt: at('2026-02-20T12:00:00Z'),
    vehicle: 'other',
    vehicleSource: 'admin',
  })
  await insertVehicleRecord({
    startAt: at('2026-02-20T11:00:00Z'),
    endAt: at('2026-02-20T13:00:00Z'),
  })
  expect(await setSessionVehicle(id, null)).toEqual({ vehicle: 'ours', vehicleSource: 'skoda' })
})

test('setSessionVehicle rejects unknown, non-uuid, noise, voided and replaced sessions', async () => {
  const noise = await insertSession({ energyKwh: 0.1 })
  const voided = await insertSession({ voided: true })
  const replaced = await insertSession({ replacedByZaptecSessionId: 'zap-successor' })
  for (const id of ['00000000-0000-4000-8000-000000000000', 'nope', noise, voided, replaced]) {
    await expect(setSessionVehicle(id, 'other')).rejects.toEqual(
      new EvChargingDomainError('EV_SESSION_NOT_FOUND'),
    )
  }
})

// Under READ COMMITTED the re-match's `target` is a snapshot from statement
// start; when an admin tag commits while the UPDATE waits on that row's lock,
// Postgres re-checks only the UPDATE's own WHERE against the new row version.
test('an admin tag committed while the re-match waits on the row survives', async () => {
  await seedCoverage()
  const id = await insertSession({
    startAt: at('2026-02-10T10:00:00Z'),
    endAt: at('2026-02-10T12:00:00Z'),
  })
  await insertVehicleRecord({
    startAt: at('2026-02-10T11:00:00Z'),
    endAt: at('2026-02-10T13:00:00Z'),
  })
  const {
    rows: [{ schema, pid }],
  } = await db.execute<{ schema: string; pid: number }>(
    sql`select current_schema() as schema, pg_backend_pid() as pid`,
  )
  const admin = new Client({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`,
  })
  await admin.connect()
  let pass: ReturnType<typeof reattributeSessions> | undefined
  let blocked = false
  try {
    await admin.query('begin')
    await admin.query(
      `update ev_charge_session set vehicle = 'other', vehicle_source = 'admin' where id = $1`,
      [id],
    )
    pass = reattributeSessions()
    // Commit only once the re-match is blocked on the row lock the admin holds.
    for (let i = 0; i < 500 && !blocked; i++) {
      const { rows } = await admin.query<{ waiting: boolean }>(
        `select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1`,
        [pid],
      )
      blocked = rows[0]?.waiting === true
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
    }
  } finally {
    // Whatever failed above: release the admin's row lock, close the client,
    // and settle the pass (its rejection fails the test instead of escaping).
    await admin
      .query('commit')
      .finally(() => admin.end())
      .finally(() => pass)
  }
  expect(blocked, 're-match never blocked on the admin row lock').toBe(true)
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'admin' })
})

// Live rule (ADR-0022): polls every `stepMin` between `from` and `to` (inclusive).
async function pollEvery(
  from: string,
  to: string,
  fields: { plugState?: string | null; atHome?: boolean | null } = {},
  stepMin = 15,
) {
  for (let t = at(from).getTime(); t <= at(to).getTime(); t += stepMin * 60_000) {
    await insertSnapshot({ polledAt: new Date(t), plugState: 'CONNECTED', atHome: true, ...fields })
  }
}
const liveSession = (
  start: string,
  end: string,
  extra: Partial<Parameters<typeof insertSession>[0]> = {},
) => insertSession({ startAt: at(start), endAt: at(end), ...extra })

test('live: plugged in at home throughout → ours, skoda_live', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 0, changed: 1 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: unplugged throughout → guest', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: connected but parked away (or moving) → guest', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { atHome: false })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: connected with an unknown position → plug state alone → ours', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { atHome: null })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: stale CONNECTED at the start of a long guest session is outvoted → guest', async () => {
  const id = await liveSession('2026-10-02T12:00:00Z', '2026-10-02T15:00:00Z')
  // The session ends at 12:00; the car keeps claiming CONNECTED for ≈27 min more (as in the probe).
  await pollEvery('2026-10-02T12:00:00Z', '2026-10-02T12:30:00Z')
  await pollEvery('2026-10-02T12:45:00Z', '2026-10-02T15:00:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda_live' })
})

test('live: the 10-min margin decides — with it ours, without it it would be guest', async () => {
  // Session 09:00–09:50, window 09:10–09:40. Intervals: D 08:58–09:12, C 09:12–09:30,
  // D 09:30–09:45, D 09:45–10:05. With the margin: here 18, away 12 → ours.
  // Without it (09:00–09:50): here 18, away 32 → guest.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T09:50:00Z')
  await insertSnapshot({ polledAt: at('2026-10-02T08:58:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:12:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:30:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:45:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: a session under 40 minutes is never decided', async () => {
  // 35 min → a 15-min window; dense DISCONNECTED polls would otherwise decide guest.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T09:35:00Z')
  await pollEvery('2026-10-02T08:47:00Z', '2026-10-02T09:47:00Z', { plugState: 'DISCONNECTED' }, 5)
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: known time under half the window leaves the session unchanged', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T13:00:00Z')
  // Window 09:10–12:50 (220 min); two polls know 35 min (09:15–09:30, 09:30–09:50).
  await pollEvery('2026-10-02T09:15:00Z', '2026-10-02T09:30:00Z', { plugState: 'DISCONNECTED' })
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 0, changed: 0 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('live: a long gap between polls is not bridged', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await insertSnapshot({ polledAt: at('2026-10-02T09:10:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T11:30:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test("live: an unknown poll ends the previous poll's interval", async () => {
  // Window 09:10–10:50 (100 min). C 09:00, ? 09:15, C 09:30, ? 09:45, C 10:00, ? 10:15–10:45:
  // known here = 5 + 15 + 15 = 35 < 50 → unchanged. Dropping unknowns before lead() would count 50.
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T11:00:00Z')
  const polls = [
    ['09:00', 'CONNECTED'],
    ['09:15', null],
    ['09:30', 'CONNECTED'],
    ['09:45', null],
    ['10:00', 'CONNECTED'],
    ['10:15', null],
    ['10:30', null],
    ['10:45', null],
  ] as const
  for (const [time, plugState] of polls) {
    await insertSnapshot({ polledAt: at(`2026-10-02T${time}:00Z`), plugState, atHome: null })
  }
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: polls with no plug state are unknown, not evidence', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: null, atHome: true })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: polls far outside the window do not change the result', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await pollEvery('2026-10-01T00:00:00Z', '2026-10-02T08:00:00Z', { plugState: 'DISCONNECTED' }, 60)
  await pollEvery('2026-10-02T13:00:00Z', '2026-10-03T00:00:00Z', { plugState: 'DISCONNECTED' }, 60)
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: a session with an unreliable clock is left alone', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z', {
    reliableClock: false,
  })
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ source: 'default' })
})

test('live: a tie goes to ours', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T10:20:00Z')
  // Window 09:10–10:10: 30 min here, 30 min not here.
  await insertSnapshot({ polledAt: at('2026-10-02T09:10:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:25:00Z') })
  await insertSnapshot({ polledAt: at('2026-10-02T09:40:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T09:55:00Z'), plugState: 'DISCONNECTED' })
  await insertSnapshot({ polledAt: at('2026-10-02T10:10:00Z'), plugState: 'DISCONNECTED' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda_live' })
})

test('live: the exported log keeps deciding inside its coverage; admin tags stay', async () => {
  await seedCoverage() // 2026-02-01 → 2026-03-31
  const logged = await liveSession('2026-02-10T10:00:00Z', '2026-02-10T12:00:00Z')
  await pollEvery('2026-02-10T09:45:00Z', '2026-02-10T12:15:00Z') // would say ours
  const tagged = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await setSessionVehicle(tagged, 'other')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await reattributeSessions()
  expect(await attribution(logged)).toMatchObject({ vehicle: 'other', source: 'skoda' })
  expect(await attribution(tagged)).toMatchObject({ vehicle: 'other', source: 'admin' })
})

test('live: a second pass changes nothing; sessionId narrows the live branch too', async () => {
  const a = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  const b = await liveSession('2026-10-03T09:00:00Z', '2026-10-03T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z')
  await pollEvery('2026-10-03T08:45:00Z', '2026-10-03T12:15:00Z', { plugState: 'DISCONNECTED' })
  expect(await reattributeSessions({ sessionId: a })).toEqual({ ours: 1, other: 0, changed: 1 })
  expect(await attribution(b)).toMatchObject({ source: 'default' })
  await reattributeSessions()
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 1, changed: 0 })
})

test('live: setSessionVehicle(null) re-derives from the live state', async () => {
  const id = await liveSession('2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z')
  await pollEvery('2026-10-02T08:45:00Z', '2026-10-02T12:15:00Z', { plugState: 'DISCONNECTED' })
  await setSessionVehicle(id, 'ours')
  expect(await setSessionVehicle(id, null)).toEqual({
    vehicle: 'other',
    vehicleSource: 'skoda_live',
  })
})
