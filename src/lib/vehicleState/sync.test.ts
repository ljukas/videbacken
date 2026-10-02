import { asc, desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession, integrationSyncRun, user, vehicleStateSnapshot } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { type SkodaClient, SkodaError, type SkodaReading } from '~/lib/effects/skoda'
import { createServerLogger } from '~/lib/logger/server'
import * as evChargingService from '~/lib/services/evCharging'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { getHealth } from '~/lib/services/integrationSync'
import * as userService from '~/lib/services/user'
import * as vehicleStateService from '~/lib/services/vehicleState'
import { insertSession, insertSnapshot } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { runSkodaSync } from './sync'

setupDatabase()

const NOW = new Date('2026-05-04T09:07:00Z')
const HOME = { latitude: 59.3293, longitude: 18.0686 }

const reading = (
  overrides: Partial<SkodaReading['state']> = {},
  keyExpiresAt: Date | null = new Date('2027-01-15T12:00:00Z'),
): SkodaReading => ({
  keyExpiresAt,
  state: {
    chargingCapturedAt: new Date('2026-05-04T08:57:51Z'),
    chargingState: 'CHARGING',
    chargeType: 'AC',
    plugState: 'CONNECTED',
    chargePowerKw: 3.5,
    socPercent: 55,
    odometerKm: 12345,
    odometerCapturedAt: new Date('2026-05-04T08:55:01Z'),
    parking: { state: 'PARKED', position: HOME },
    missingParts: [],
    invalidParts: [],
    ...overrides,
  },
})
const fakeSkoda = (impl: () => Promise<SkodaReading>, retries = 0): SkodaClient => ({
  vehicleState: async (o) => {
    if (o?.stats) {
      o.stats.requests++
      o.stats.fetchMs += 12
      o.stats.retries += retries
    }
    return impl()
  },
})

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string })
  return { log, entries, raw: () => lines.join('') }
}

type RunOpts = {
  homePoint?: typeof HOME | null
  log?: ReturnType<typeof capturingLogger>['log']
  now?: Date
}
const run = (client: SkodaClient, opts: RunOpts = {}) =>
  runSkodaSync({
    trigger: 'cron',
    now: () => opts.now ?? NOW,
    deps: {
      skoda: client,
      homePoint: 'homePoint' in opts ? (opts.homePoint ?? null) : HOME,
      log: opts.log ?? capturingLogger().log,
    },
  })
// Alerts and reminders go to active admins (same seeding as runPulledSync.test.ts).
const seedAdmin = () => db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
const runRows = () =>
  db
    .select()
    .from(integrationSyncRun)
    .where(eq(integrationSyncRun.source, 'skoda'))
    .orderBy(desc(integrationSyncRun.startedAt))
const snapshots = () =>
  db.select().from(vehicleStateSnapshot).orderBy(asc(vehicleStateSnapshot.polledAt))

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test('stores the poll with the geofence result and no coordinates', async () => {
  const result = await run(fakeSkoda(async () => reading()))
  expect(result).toMatchObject({ source: 'skoda', outcome: 'ok', stored: true, geofence: 'on' })
  const [row] = await snapshots()
  expect(row).toMatchObject({
    polledAt: NOW,
    capturedAt: new Date('2026-05-04T08:57:51Z'),
    plugState: 'CONNECTED',
    parkingState: 'PARKED',
    atHome: true,
    socPercent: 55,
    odometerKm: 12345,
  })
  expect(JSON.stringify(row)).not.toContain('59.3293')
  expect((await getHealth('skoda', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('parked away is at_home false; no home point stores null and turns the geofence off', async () => {
  const away = { latitude: HOME.latitude + 0.05, longitude: HOME.longitude }
  await run(fakeSkoda(async () => reading({ parking: { state: 'PARKED', position: away } })))
  const off = await run(
    fakeSkoda(async () => reading()),
    { homePoint: null, now: new Date(NOW.getTime() + 1000) },
  )
  expect(off.geofence).toBe('off')
  expect((await snapshots()).map((r) => r.atHome)).toEqual([false, null])
})

test('the home point is read from SKODA_HOME_COORDINATES when not injected', async () => {
  const withEnv = (value: string) => {
    vi.stubEnv('SKODA_HOME_COORDINATES', value)
    return runSkodaSync({
      trigger: 'cron',
      now: () => NOW,
      deps: { skoda: fakeSkoda(async () => reading()), log: capturingLogger().log },
    })
  }
  expect((await withEnv('59.3293,18.0686')).geofence).toBe('on')
  expect((await withEnv('0x10,18')).geofence).toBe('off')
  vi.unstubAllEnvs()
})

test('missing parts log only their count at info, invalid parts at warn, a clean poll neither', async () => {
  const clean = capturingLogger()
  await run(
    fakeSkoda(async () => reading()),
    { log: clean.log },
  )
  expect(clean.entries().filter((e) => e.msg.startsWith('skoda sync: parts'))).toHaveLength(0)

  const { log, entries, raw } = capturingLogger()
  const result = await run(
    fakeSkoda(async () =>
      reading({
        chargingCapturedAt: null,
        chargingState: null,
        chargeType: null,
        plugState: null,
        chargePowerKw: null,
        parking: null,
        missingParts: ['CHARGING_UNAVAILABLE', 'ODOMETER_UNAVAILABLE'],
        invalidParts: ['parkingPosition'],
      }),
    ),
    { log, now: new Date(NOW.getTime() + 1000) },
  )
  expect(result).toMatchObject({ outcome: 'ok', stored: true, missingParts: 2, invalidParts: 1 })
  expect((await snapshots()).at(-1)?.plugState).toBeNull()
  const unavailable = entries().find((e) => e.msg === 'skoda sync: parts unavailable')
  expect(unavailable).toMatchObject({ level: 30, missingParts: 2 })
  for (const code of ['CHARGING_UNAVAILABLE', 'ODOMETER_UNAVAILABLE'])
    expect(raw()).not.toContain(code)
  const invalid = entries().find((e) => e.msg === 'skoda sync: parts invalid')
  expect(invalid).toMatchObject({ level: 40, invalidParts: ['parkingPosition'] })
})

test('an ok poll records the run stats', async () => {
  await run(fakeSkoda(async () => reading()))
  const [row] = await runRows()
  expect(row).toMatchObject({
    outcome: 'ok',
    sessionsSeen: 1,
    upserted: 1,
    voided: 0,
    pages: 0,
    since: null,
  })
  expect(row?.timings).toMatchObject({ fetchMs: 12, requests: 1, retries: 0 })
  expect(typeof row?.timings.snapshotMs).toBe('number')
  expect(typeof row?.timings.reattributeMs).toBe('number')
})

test('a client that never answers fails the run as unreachable at the deadline', async () => {
  const hang = fakeSkoda(() => new Promise<SkodaReading>(() => {}))
  const result = await runSkodaSync({
    trigger: 'cron',
    now: () => NOW,
    deadlineMs: 20,
    deps: { skoda: hang, homePoint: HOME, log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable', stored: false })
  expect(await snapshots()).toHaveLength(0)
  expect((await runRows())[0]).toMatchObject({ outcome: 'failed', errorCode: 'unreachable' })
})

test('an unexpected error is recorded as internal_error and rethrown', async () => {
  await expect(
    run(
      fakeSkoda(async () => {
        throw new TypeError('boom')
      }),
    ),
  ).rejects.toThrow('boom')
  expect((await runRows())[0]).toMatchObject({ outcome: 'error', errorCode: 'internal_error' })
  expect((await getHealth('skoda', { now: NOW, includeAdminDetail: false })).code).toBe(
    'internal_error',
  )
  expect(await snapshots()).toHaveLength(0)
})

test('a snapshot write that fails rethrows and stores nothing', async () => {
  vi.spyOn(vehicleStateService, 'recordSnapshot').mockRejectedValue(new Error('db down'))
  await expect(run(fakeSkoda(async () => reading()))).rejects.toThrow('db down')
  expect(await snapshots()).toHaveLength(0)
  expect((await runRows())[0]).toMatchObject({ outcome: 'error', errorCode: 'internal_error' })
})

test('an expired key fails the run as auth_failed, stores nothing, and alerts on the third poll in a row', async () => {
  await seedAdmin()
  const expired = fakeSkoda(async () => {
    throw new SkodaError('auth_failed', 'vehicle', 401)
  })
  for (let i = 0; i < 2; i++) {
    expect(await run(expired, { now: new Date(NOW.getTime() + i * 900_000) })).toMatchObject({
      outcome: 'failed',
      code: 'auth_failed',
      stored: false,
    })
  }
  expect(publish).not.toHaveBeenCalled()
  await run(expired, { now: new Date(NOW.getTime() + 2 * 900_000) })
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      source: 'skoda',
      transition: 'started_failing',
      code: 'auth_failed',
    }),
  )
  expect(await snapshots()).toHaveLength(0)
  expect((await runRows())[0]).toMatchObject({ outcome: 'failed', sessionsSeen: 0, upserted: 0 })
})

test('not configured fails closed without alerting', async () => {
  await seedAdmin()
  for (let i = 0; i < 3; i++) {
    const result = await runSkodaSync({
      trigger: 'cron',
      now: () => new Date(NOW.getTime() + i * 900_000),
      deps: { homePoint: HOME },
    })
    expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  }
  expect(publish).not.toHaveBeenCalled()
})

test('the run line carries counters but never the position or presence', async () => {
  const { log, entries, raw } = capturingLogger()
  await run(
    fakeSkoda(async () => reading()),
    { log },
  )
  const line = entries().find((e) => e.msg === 'integration sync run')
  expect(line).toMatchObject({
    source: 'skoda',
    outcome: 'ok',
    stored: true,
    geofence: 'on',
    requests: 1,
    retries: 0,
    missingParts: 0,
    invalidParts: 0,
    reattributeChanged: 0,
  })
  expect(typeof line?.fetchMs).toBe('number')
  expect(typeof line?.snapshotMs).toBe('number')
  for (const leak of ['59.3293', 'atHome', 'plugState', 'CONNECTED', 'PARKED'])
    expect(raw()).not.toContain(leak)
})

test('a poll re-derives attribution for sessions already imported', async () => {
  const id = await insertSession({
    startAt: new Date('2026-05-04T06:00:00Z'),
    endAt: new Date('2026-05-04T08:30:00Z'),
  })
  for (
    let t = Date.parse('2026-05-04T05:45:00Z');
    t <= Date.parse('2026-05-04T08:45:00Z');
    t += 900_000
  ) {
    await insertSnapshot({ polledAt: new Date(t), plugState: 'DISCONNECTED' })
  }
  const result = await run(fakeSkoda(async () => reading()))
  expect(result.reattributeChanged).toBe(1)
  const [row] = await db.select().from(evChargeSession).where(eq(evChargeSession.id, id))
  expect(row).toMatchObject({ vehicle: 'other', vehicleSource: 'skoda_live' })
})

test('a failed re-match is a warning and the poll still counts', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockRejectedValueOnce(new Error('db hiccup'))
  const { log, entries } = capturingLogger()
  const result = await run(
    fakeSkoda(async () => reading()),
    { log },
  )
  expect(result).toMatchObject({ outcome: 'ok', stored: true, reattributeChanged: 0 })
  expect(entries().some((e) => e.msg === 'skoda sync: vehicle re-match failed')).toBe(true)
  const [row] = await runRows()
  expect(row).toMatchObject({ outcome: 'ok', upserted: 1 })
  expect(typeof row?.timings.reattributeMs).toBe('number')
})

test('a re-match that never settles is cut off by the run deadline; the poll still counts', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockReturnValueOnce(new Promise(() => {}))
  const { log, entries } = capturingLogger()
  const started = performance.now()
  const result = await runSkodaSync({
    trigger: 'cron',
    now: () => NOW,
    deadlineMs: 300,
    deps: { skoda: fakeSkoda(async () => reading()), homePoint: HOME, log },
  })
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(result).toMatchObject({ outcome: 'ok', stored: true, reattributeChanged: 0 })
  expect(entries().find((e) => e.msg === 'skoda sync: vehicle re-match failed')).toMatchObject({
    level: 40,
  })
  expect(await snapshots()).toHaveLength(1)
  const [row] = await runRows()
  expect(row).toMatchObject({ outcome: 'ok', upserted: 1 })
  expect(typeof row?.timings.reattributeMs).toBe('number')
  // The wait until the deadline cut it off is timed, not left at 0.
  expect(row?.timings.reattributeMs).toBeGreaterThan(0)
  expect(row?.timings.reattributeMs).toBe(result.reattributeMs)
})

test('the re-match is skipped when the snapshot write outlasted the run deadline', async () => {
  // recordSnapshot is not raced against the deadline: a slow insert still
  // lands and the poll counts (outcome ok), but the re-match is not started.
  const recordSnapshot = vehicleStateService.recordSnapshot
  vi.spyOn(vehicleStateService, 'recordSnapshot').mockImplementationOnce(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    return recordSnapshot(input)
  })
  const rematch = vi.spyOn(evChargingService, 'reattributeSessions')
  const { log, entries } = capturingLogger()
  const result = await runSkodaSync({
    trigger: 'cron',
    now: () => NOW,
    deadlineMs: 300,
    deps: { skoda: fakeSkoda(async () => reading()), homePoint: HOME, log },
  })
  expect(rematch).not.toHaveBeenCalled()
  expect(result).toMatchObject({ outcome: 'ok', stored: true, reattributeChanged: 0 })
  expect(
    entries().find((e) => e.msg === 'skoda sync: vehicle re-match skipped, run deadline reached'),
  ).toMatchObject({ level: 40 })
  expect(await snapshots()).toHaveLength(1)
  const [row] = await runRows()
  expect(row).toMatchObject({ outcome: 'ok', upserted: 1 })
  expect(typeof row?.timings.reattributeMs).toBe('number')
})

const EXPIRES = new Date('2027-01-15T12:00:00Z')
const before = (days: number) => new Date(EXPIRES.getTime() - days * 86_400_000)
const withExpiry = (expiresAt: Date | null = EXPIRES) =>
  fakeSkoda(async () => reading({}, expiresAt))
const reminders = () => publish.mock.calls.filter(([topic]) => topic === 'email_credential_expiry')

test('stores the key expiry and emails every admin once at 30 days, again at 7', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(30) })
  await run(withExpiry(), { now: before(29) })
  expect(reminders()).toHaveLength(1)
  expect(reminders()[0]?.[1]).toMatchObject({
    to: 'a@example.com',
    source: 'skoda',
    expiresAt: EXPIRES.toISOString(),
    days: 30,
    locale: 'sv',
  })
  await run(withExpiry(), { now: before(7) })
  expect(reminders()).toHaveLength(2)
  expect(reminders()[1]?.[1]).toMatchObject({ days: 7 })
  const health = await getHealth('skoda', { now: before(7), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry).toMatchObject({ daysLeft: 7, warn: true })
})

test('no reminder with plenty of time left', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(180) })
  expect(reminders()).toHaveLength(0)
})

test('a reminder nobody could be sent is retried on the next poll', async () => {
  await seedAdmin()
  publish.mockRejectedValueOnce(new Error('queue down'))
  const { log, entries } = capturingLogger()
  expect((await run(withExpiry(), { now: before(7), log })).outcome).toBe('ok')
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    true,
  )
  await run(withExpiry(), { now: before(6) })
  expect(reminders().at(-1)?.[1]).toMatchObject({ days: 7 })
})

test('with no active admins the reminder is not used up', async () => {
  const { log, entries } = capturingLogger()
  await run(withExpiry(), { now: before(7), log })
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    true,
  )
  await seedAdmin()
  await run(withExpiry(), { now: before(6) })
  expect(reminders()).toHaveLength(1)
})

test('a missing expiry header keeps the stored date and warns', async () => {
  await run(withExpiry(), { now: before(100) })
  const { log, entries } = capturingLogger()
  await run(withExpiry(null), { now: before(99), log })
  expect(
    entries().some((e) => e.msg === 'skoda sync: key expiry header missing or unparseable'),
  ).toBe(true)
  const health = await getHealth('skoda', { now: before(99), includeAdminDetail: true })
  expect(health.adminDetail?.credentialExpiry?.expiresAt).toEqual(EXPIRES)
})

test('a hung publish does not hold the poll: ok, stored, claim released, next run sends', async () => {
  await seedAdmin()
  publish.mockReturnValueOnce(new Promise(() => {}))
  const { log, entries } = capturingLogger()
  const result = await runSkodaSync({
    trigger: 'cron',
    now: () => before(7),
    deadlineMs: 300,
    deps: { skoda: withExpiry(), homePoint: HOME, log },
  })
  expect(result).toMatchObject({ outcome: 'ok', stored: true })
  expect(typeof result.reminderMs).toBe('number')
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    true,
  )
  await run(withExpiry(), { now: before(6) })
  expect(reminders().at(-1)?.[1]).toMatchObject({ days: 7 })
})

test('partial delivery is final: warns with counts, no retry, no second send', async () => {
  await seedAdmin()
  await db.insert(user).values({ name: 'B', email: 'b@example.com', role: 'admin' })
  publish.mockRejectedValueOnce(new Error('queue down'))
  const { log, entries } = capturingLogger()
  await run(withExpiry(), { now: before(7), log })
  expect(entries().find((e) => e.msg === 'skoda sync: key reminder partly failed')).toMatchObject({
    days: 7,
    sent: 1,
    failed: 1,
  })
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    false,
  )
  await run(withExpiry(), { now: before(6) })
  expect(reminders()).toHaveLength(2)
})

test('listActiveAdmins throwing keeps the poll ok and the reminder is retried', async () => {
  await seedAdmin()
  vi.spyOn(userService, 'listActiveAdmins').mockRejectedValueOnce(new Error('db hiccup'))
  const { log, entries } = capturingLogger()
  const result = await run(withExpiry(), { now: before(7), log })
  expect(result).toMatchObject({ outcome: 'ok', stored: true })
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder failed')).toBe(true)
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    true,
  )
  await run(withExpiry(), { now: before(6) })
  expect(reminders()).toHaveLength(1)
})

test('a failing release is a warning; the poll still records', async () => {
  await seedAdmin()
  publish.mockRejectedValueOnce(new Error('queue down'))
  vi.spyOn(integrationSyncService, 'releaseCredentialReminder').mockRejectedValueOnce(
    new Error('release down'),
  )
  const { log, entries } = capturingLogger()
  const result = await run(withExpiry(), { now: before(7), log })
  expect(result).toMatchObject({ outcome: 'ok', stored: true })
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder not sent, will retry')).toBe(
    true,
  )
  expect(entries().some((e) => e.msg === 'skoda sync: key reminder release failed')).toBe(true)
  expect(await snapshots()).toHaveLength(1)
})

test('the reminder time is recorded on the run and its row', async () => {
  const result = await run(withExpiry(), { now: before(100) })
  expect(typeof result.reminderMs).toBe('number')
  expect(typeof (await runRows())[0]?.timings.reminderMs).toBe('number')
})

test('a failed poll never claims a reminder', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(100) })
  const expired = fakeSkoda(async () => {
    throw new SkodaError('auth_failed', 'vehicle', 401)
  })
  await run(expired, { now: before(7) })
  expect(reminders()).toHaveLength(0)
})

test('a missing header near expiry keeps the stored date and still sends the 7-day reminder', async () => {
  await seedAdmin()
  await run(withExpiry(), { now: before(100) })
  await run(withExpiry(null), { now: before(7) })
  expect(reminders()).toHaveLength(1)
  expect(reminders()[0]?.[1]).toMatchObject({ days: 7, expiresAt: EXPIRES.toISOString() })
})
