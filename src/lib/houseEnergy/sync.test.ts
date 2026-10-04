import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { integrationSync, integrationSyncRun, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import {
  type EmaldoClient,
  type EmaldoDay,
  EmaldoError,
  type HouseBucket,
} from '~/lib/effects/emaldo'
import { createServerLogger } from '~/lib/logger/server'
import { listReadings, replaceDay } from '~/lib/services/houseEnergy'
import * as integrationSyncService from '~/lib/services/integrationSync'
import {
  beginAttempt,
  getHealth,
  getLastSuccessStartedAt,
  listRecentRuns,
  recordOutcome,
} from '~/lib/services/integrationSync'
import { LEASE_DURATION_MS } from '~/lib/services/integrationSync/policy'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { planEmaldoDays, runEmaldoSync } from './sync'

setupDatabase()

// 2026-04-01 12:00 local (CEST). Backfills from late March cross the
// 2026-03-29 spring-forward day (23 h).
const NOW = new Date('2026-04-01T10:00:00Z')
const TODAY = '2026-04-01'
const YESTERDAY = '2026-03-31'
const startOf = (day: string) => new Date(stockholmDayBounds(day).startMs)
const endOf = (day: string) => new Date(stockholmDayBounds(day).endMs)

// Synthetic values only — never real household readings (the repo is public).
const bucket = (bucketStart: Date, kwh = 0.05): HouseBucket => ({
  bucketStart,
  gridImportKwh: kwh,
  gridExportKwh: 0,
  solarKwh: 0.01,
  loadKwh: kwh,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
  batterySocPct: 50,
})

/** `n` buckets from the day's start, 5 min apart. */
function syntheticDay(day: string, n = 3, kwh?: number): EmaldoDay {
  const { startMs, endMs } = stockholmDayBounds(day)
  return {
    dayStart: new Date(startMs),
    dayEnd: new Date(endMs),
    buckets: Array.from({ length: n }, (_, i) => bucket(new Date(startMs + i * 300_000), kwh)),
    droppedBuckets: day === TODAY ? 1 : 0,
  }
}

/** A synthetic day whose buckets all lack SoC. */
function withoutSoc(day: string): EmaldoDay {
  const d = syntheticDay(day)
  return { ...d, buckets: d.buckets.map((b) => ({ ...b, batterySocPct: null })) }
}

// In-memory Emaldo: offset → day relative to TODAY, each day scriptable.
function fakeEmaldo(
  script: Record<string, (day: string) => EmaldoDay | Promise<EmaldoDay>> = {},
  onFetch?: () => void,
) {
  const requested: string[] = []
  const client: EmaldoClient = {
    async fetchDay(offset, o) {
      if (offset > 0) throw new RangeError(`offset ${offset}`)
      const day = addDays(TODAY, offset)
      requested.push(day)
      onFetch?.()
      if (o?.stats) {
        o.stats.requests += 4
        o.stats.fetchMs += 10
        o.stats.retries += 1
        o.stats.logins += 1
      }
      return (script[day] ?? ((d: string) => syntheticDay(d)))(day)
    },
  }
  return { client, requested }
}

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

type RunExtra = {
  log?: ReturnType<typeof capturingLogger>['log']
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}
const run = (client: EmaldoClient, extra: RunExtra = {}) =>
  runEmaldoSync({
    trigger: 'cron',
    now: extra.now ?? (() => NOW),
    deps: {
      emaldo: client,
      log: extra.log ?? capturingLogger().log,
      sleep: extra.sleep ?? (async () => {}),
    },
  })

const countOn = async (day: string) =>
  (await listReadings({ from: startOf(day), to: endOf(day) })).length

/** A counted session on `day` (local evening), so the backfill starts 7 days earlier. */
const sessionOn = (day: string) =>
  insertSession({
    startAt: new Date(`${day}T16:00:00Z`),
    endAt: new Date(`${day}T18:00:00Z`),
  })

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('planEmaldoDays', () => {
  test('with no watermark and no sessions there is nothing to backfill', () => {
    expect(
      planEmaldoDays({ today: TODAY, watermarkDay: null, firstSessionDay: null, max: 30 }),
    ).toEqual({
      today: TODAY,
      yesterday: YESTERDAY,
      start: YESTERDAY,
      backfill: [],
      backfillLeft: 0,
    })
  })

  test('starts 7 days before the first session and stops before yesterday', () => {
    const plan = planEmaldoDays({
      today: TODAY,
      watermarkDay: null,
      firstSessionDay: '2026-03-25',
      max: 30,
    })
    expect(plan.start).toBe('2026-03-18')
    expect(plan.backfill).toEqual(Array.from({ length: 13 }, (_, i) => addDays('2026-03-18', i)))
    expect(plan.backfillLeft).toBe(0)
  })

  test('the later of the watermark and the lead start wins', () => {
    expect(
      planEmaldoDays({
        today: TODAY,
        watermarkDay: '2026-03-28',
        firstSessionDay: '2026-03-25',
        max: 30,
      }).backfill,
    ).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    expect(
      planEmaldoDays({
        today: TODAY,
        watermarkDay: '2026-03-01',
        firstSessionDay: '2026-03-29',
        max: 30,
      }).start,
    ).toBe('2026-03-22')
  })

  test('caps the backfill and reports what is left', () => {
    const plan = planEmaldoDays({
      today: TODAY,
      watermarkDay: null,
      firstSessionDay: '2026-01-10',
      max: 30,
    })
    expect(plan.backfill).toHaveLength(30)
    expect(plan.backfill[0]).toBe('2026-01-03')
    expect(plan.backfillLeft).toBe(57)
  })

  test('a watermark at yesterday or later needs no backfill, and the start never passes today', () => {
    for (const watermarkDay of [YESTERDAY, TODAY, '2026-04-05']) {
      const plan = planEmaldoDays({
        today: TODAY,
        watermarkDay,
        firstSessionDay: '2026-01-10',
        max: 30,
      })
      expect(plan.backfill).toEqual([])
      expect(plan.start <= TODAY).toBe(true)
    }
  })
})

test('with no sessions it fetches yesterday then today and moves the watermark to today', async () => {
  const { client, requested } = fakeEmaldo()

  const result = await run(client)

  expect(requested).toEqual([YESTERDAY, TODAY])
  expect(result).toMatchObject({
    source: 'emaldo',
    outcome: 'ok',
    code: null,
    daysFetched: 2,
    bucketsStored: 6,
    droppedBuckets: 1,
    emptyDays: 0,
    backfillDaysLeft: 0,
    earliestReplacedDay: YESTERDAY,
    syncedUntil: startOf(TODAY),
    requests: 8,
    retries: 2,
  })
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(TODAY))
  expect((await getHealth('emaldo', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('backfills from 7 days before the first counted session, oldest first, across the DST switch', async () => {
  await sessionOn('2026-03-25')
  // A noise session (under the counting threshold) earlier on doesn't move the start.
  await insertSession({
    startAt: new Date('2026-03-01T16:00:00Z'),
    endAt: new Date('2026-03-01T16:10:00Z'),
    energyKwh: 0.1,
  })
  const dst = '2026-03-29'
  const { client, requested } = fakeEmaldo({ [dst]: (d) => syntheticDay(d, 276) })

  const result = await run(client)

  expect(requested.slice(0, 2)).toEqual([YESTERDAY, TODAY])
  expect(requested.slice(2)).toEqual(Array.from({ length: 13 }, (_, i) => addDays('2026-03-18', i)))
  expect(result).toMatchObject({
    outcome: 'ok',
    daysFetched: 15,
    backfillDaysLeft: 0,
    earliestReplacedDay: '2026-03-18',
    since: startOf('2026-03-18'),
    syncedUntil: startOf(TODAY),
  })
  expect(await countOn(dst)).toBe(276)
})

test('a long backfill is capped at 30 days a run and continues from the watermark', async () => {
  await sessionOn('2026-01-10')
  const left: number[] = []
  const watermarks: (Date | null)[] = []
  for (let i = 0; i < 3; i++) {
    const { client, requested } = fakeEmaldo()
    const result = await run(client)
    left.push(result.backfillDaysLeft)
    watermarks.push(await getLastSuccessStartedAt('emaldo'))
    if (i === 1) expect(requested[2]).toBe('2026-02-02')
  }
  expect(left).toEqual([57, 27, 0])
  expect(watermarks).toEqual([startOf('2026-02-02'), startOf('2026-03-04'), startOf(TODAY)])

  // Caught up: the next run fetches only the two recent days.
  const done = fakeEmaldo()
  await run(done.client)
  expect(done.requested).toEqual([YESTERDAY, TODAY])
})

test('reports progress over yesterday, today and the backfill, in days', async () => {
  // A session on 03-28 → the backfill starts 7 days earlier (03-21): 10 backfill days + 2.
  await sessionOn('2026-03-28')
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeEmaldo()
  // Each now() 1 s later, so the throttle never drops a write.
  await run(client, {
    now: () => {
      clock += 1_001
      return new Date(clock)
    },
  })
  expect(spy.mock.calls.map(([, , p]) => p)).toEqual(
    Array.from({ length: 12 }, (_, i) => ({ done: i + 1, total: 12 })),
  )
})

test('no new backfill day once the budget is used, and the watermark stays put', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  let clock = NOW.getTime()
  const { client, requested } = fakeEmaldo({}, () => {
    clock += 70_000
  })

  const result = await run(client, { now: () => new Date(clock) })

  // Yesterday and today took 140 s, past the 120 s budget: no backfill day starts.
  expect(requested).toEqual([YESTERDAY, TODAY])
  expect(result).toMatchObject({ outcome: 'ok', backfillDaysLeft: 7 })
  // Never "now": the backfill still starts where it would have.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-24'))
})

test('an empty backfill day keeps its stored readings and still counts as done', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const empty = '2026-03-26'
  await replaceDay(
    { dayStart: startOf(empty), dayEnd: endOf(empty) },
    syntheticDay(empty, 4).buckets,
  )
  const { client } = fakeEmaldo({ [empty]: (d) => syntheticDay(d, 0) })

  const result = await run(client)

  expect(result).toMatchObject({
    outcome: 'ok',
    emptyDays: 1,
    bucketsWithoutSoc: 0,
    syncedUntil: startOf(TODAY),
  })
  expect(await countOn(empty)).toBe(4)
})

test('an empty yesterday fails the run and keeps what was stored for it', async () => {
  await replaceDay(
    { dayStart: startOf(YESTERDAY), dayEnd: endOf(YESTERDAY) },
    syntheticDay(YESTERDAY, 5).buckets,
  )
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 0) })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', emptyDays: 1 })
  expect(await countOn(YESTERDAY)).toBe(5)
  expect(await countOn(TODAY)).toBe(3)
  // Only what is fully stored counts: up to the start of yesterday.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(YESTERDAY))
  const health = await getHealth('emaldo', { now: NOW, includeAdminDetail: true })
  expect(health.adminDetail?.lastErrorMessage).toContain(YESTERDAY)
})

test('a re-fetched day replaces its stored readings', async () => {
  await replaceDay(
    { dayStart: startOf(YESTERDAY), dayEnd: endOf(YESTERDAY) },
    syntheticDay(YESTERDAY, 5).buckets,
  )
  await run(fakeEmaldo().client)
  expect(await countOn(YESTERDAY)).toBe(3)
})

test('a day whose bounds are not the asked Stockholm day fails, storing nothing for it', async () => {
  const { client } = fakeEmaldo({ [YESTERDAY]: () => syntheticDay(TODAY) })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', bucketsStored: 0 })
  expect(await countOn(TODAY)).toBe(0)
  expect(await countOn(YESTERDAY)).toBe(0)
})

test('an old day with invalid readings is skipped and warned; the backfill goes on', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const bad = '2026-03-26'
  const cap = capturingLogger()
  const { client } = fakeEmaldo({ [bad]: (d) => syntheticDay(d, 3, -0.5) })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, syncedUntil: startOf(TODAY) })
  expect(await countOn(bad)).toBe(0)
  expect(await countOn('2026-03-27')).toBe(3)
  expect(cap.entries().some((e) => e.msg === 'emaldo day rejected' && e.day === bad)).toBe(true)
  expect(cap.raw()).not.toContain('-0.5')
})

// Like an empty yesterday: today and the backfill still land, then it fails.
test('invalid readings for yesterday fail the run after today and the backfill', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const { client, requested } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 3, -0.5) })

  const result = await run(client)

  expect(result).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    rejectedDays: 1,
  })
  expect(requested).toHaveLength(9)
  expect(await countOn(TODAY)).toBe(3)
  expect(await countOn('2026-03-30')).toBe(3)
  expect(await countOn(YESTERDAY)).toBe(0)
  // Held at the start of yesterday, so the next run retries it.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(YESTERDAY))
})

test('a remote failure is failed with its code and alerts admins on the first failure', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const client: EmaldoClient = {
    async fetchDay() {
      throw new EmaldoError('auth_failed', 'login', 401)
    },
  }

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'auth_failed', daysFetched: 0 })
  // A run that never got an answer plants no watermark.
  expect(await getLastSuccessStartedAt('emaldo')).toBeNull()
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      source: 'emaldo',
      transition: 'started_failing',
      to: 'a@example.com',
    }),
  )
})

test('a failure part-way through the backfill keeps the stored days as the watermark', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const { client } = fakeEmaldo({
    '2026-03-27': () => {
      throw new EmaldoError('unreachable', 'stats', 503)
    },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-27'))

  // The next run resumes at the failed day.
  const next = fakeEmaldo()
  await run(next.client)
  expect(next.requested.slice(2)).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'])
})

test('a failed run still reports SoC gaps for the days that landed', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const { client } = fakeEmaldo({
    [YESTERDAY]: withoutSoc,
    [TODAY]: withoutSoc,
    '2026-03-24': withoutSoc,
    '2026-03-27': () => {
      throw new EmaldoError('unreachable', 'stats', 503)
    },
  })
  const cap = capturingLogger()
  const result = await run(client, { log: cap.log })
  expect(result).toMatchObject({ outcome: 'failed', bucketsWithoutSoc: 9 }) // 3 stored days × 3
  const [row] = await db.select().from(integrationSyncRun)
  expect(row.timings).toMatchObject({ bucketsWithoutSoc: 9 })
  expect(cap.entries().find((e) => e.msg === 'integration sync run')).toMatchObject({
    bucketsWithoutSoc: 9,
  })
})

test('a call that outlives the deadline fails as unreachable', async () => {
  const client: EmaldoClient = { fetchDay: () => new Promise<EmaldoDay>(() => {}) }
  const result = await runEmaldoSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 20,
    deps: { emaldo: client, log: capturingLogger().log, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('backfill pauses between days', async () => {
  await sessionOn(YESTERDAY) // 7 backfill days → 6 pauses
  const sleeps: number[] = []
  await run(fakeEmaldo().client, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  expect(sleeps).toHaveLength(6)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('one run row and one run line, with counts only — never readings', async () => {
  const cap = capturingLogger()
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 3, 0.123456) })

  await run(client, { log: cap.log })

  const [row] = await listRecentRuns('emaldo', { limit: 5 })
  // Zaptec-era columns: pages = days fetched, sessionsSeen/upserted = readings stored.
  expect(row).toMatchObject({ outcome: 'ok', pages: 2, sessionsSeen: 6, upserted: 6 })
  const lines = cap.entries().filter((e) => e.msg === 'integration sync run')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    source: 'emaldo',
    daysFetched: 2,
    bucketsStored: 6,
    earliestReplacedDay: YESTERDAY,
    requests: 8,
    bucketsWithoutSoc: 0,
  })
  expect(cap.raw()).not.toContain('0.123456')
})

test('a held lease skips the run without calling Emaldo', async () => {
  await beginAttempt('emaldo', { now: NOW })
  const { client, requested } = fakeEmaldo()
  expect((await run(client)).outcome).toBe('skipped')
  expect(requested).toEqual([])
})

test('without credentials (the real facade under VITEST) the run is not_configured and alerts nobody', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const result = await runEmaldoSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  expect(publish).not.toHaveBeenCalled()
  expect(await getLastSuccessStartedAt('emaldo')).toBeNull()
})

test('the budget can end mid-backfill: the watermark is the end of the last stored day', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  let clock = NOW.getTime()
  const { client, requested } = fakeEmaldo({}, () => {
    clock += 35_000
  })

  const result = await run(client, { now: () => new Date(clock) })

  // 35 s per day: two backfill days start before the 120 s budget is used.
  expect(requested).toEqual([YESTERDAY, TODAY, '2026-03-24', '2026-03-25'])
  expect(result).toMatchObject({ outcome: 'ok', backfillDaysLeft: 5 })
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-26'))
})

test('a budget stop leaves the last progress report below its total', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30: total 2 + 7 = 9
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeEmaldo({}, () => {
    clock += 35_000
  })
  await run(client, { now: () => new Date(clock) })
  const reports = spy.mock.calls.map(([, , p]) => p)
  expect(reports.every((p) => p.total === 9)).toBe(true)
  expect(reports.some((p) => p.done === p.total)).toBe(false)
  expect(reports.at(-1)).toEqual({ done: 4, total: 9 })
})

test('progress totals count the capped backfill, not the whole history', async () => {
  await sessionOn('2026-01-10') // 57 + 30 days wanted; 30 planned: total 2 + 30
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeEmaldo()
  await run(client, {
    now: () => {
      clock += 1_001
      return new Date(clock)
    },
  })
  const reports = spy.mock.calls.map(([, , p]) => p)
  expect(reports).toHaveLength(32)
  expect(reports.every((p) => p.total === 32)).toBe(true)
  expect(reports.at(-1)).toEqual({ done: 32, total: 32 })
})

test('a backfill day whose end is off (a DST slip) fails the run and stores nothing for it', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const dst = '2026-03-29'
  const { client } = fakeEmaldo({
    // Right start, but a 24 h day where Stockholm has 23 h.
    [dst]: (d) => ({ ...syntheticDay(d), dayEnd: new Date(startOf(d).getTime() + 86_400_000) }),
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
  expect(await countOn(dst)).toBe(0)
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(dst))
})

test('a failure storing a day that is not a validation error ends the run as error', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const transaction = db.transaction.bind(db)
  let writes = 0
  // Yesterday, today, 2026-03-24 store; the write for 2026-03-25 fails.
  vi.spyOn(db, 'transaction').mockImplementation(((fn: Parameters<typeof db.transaction>[0]) => {
    writes++
    if (writes === 4) return Promise.reject(new Error('connection lost'))
    return transaction(fn)
  }) as typeof db.transaction)

  await expect(run(fakeEmaldo().client)).rejects.toThrow()

  const [row] = await listRecentRuns('emaldo', { limit: 1 })
  expect(row).toMatchObject({ outcome: 'error', errorCode: 'internal_error' })
  // Not skipped as a rejected day: the next run retries it.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-25'))
})

test('a caught-up watermark never moves back for a session imported later', async () => {
  await run(fakeEmaldo().client)
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(TODAY))

  await sessionOn('2026-01-10')
  const { client, requested } = fakeEmaldo()
  await run(client)

  expect(requested).toEqual([YESTERDAY, TODAY])
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(TODAY))
})

// Today never moves the watermark, and becomes yesterday tomorrow (strict
// then); a bad bucket in it must not stall the backfill all day.
test('invalid readings for today are skipped and warned, not a failed run', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const cap = capturingLogger()
  const { client, requested } = fakeEmaldo({ [TODAY]: (d) => syntheticDay(d, 3, -0.5) })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, syncedUntil: startOf(TODAY) })
  expect(requested).toHaveLength(9)
  expect(await countOn(TODAY)).toBe(0)
  expect(cap.entries().some((e) => e.msg === 'emaldo day rejected' && e.day === TODAY)).toBe(true)
})

test('an empty today is normal just after midnight', async () => {
  const { client } = fakeEmaldo({ [TODAY]: (d) => syntheticDay(d, 0) })
  expect(await run(client)).toMatchObject({
    outcome: 'ok',
    emptyDays: 1,
    syncedUntil: startOf(TODAY),
  })
})

test('invalid readings for yesterday name the day in the recorded error', async () => {
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 3, -0.5) })
  await run(client)
  const health = await getHealth('emaldo', { now: NOW, includeAdminDetail: true })
  expect(health.adminDetail?.lastErrorMessage).toContain(YESTERDAY)
  expect(health.adminDetail?.lastErrorMessage).not.toContain('-0.5')
})

test('the run row records since and every counter', async () => {
  await run(fakeEmaldo().client)
  const [row] = await db.select().from(integrationSyncRun)
  expect(row.since).toEqual(startOf(YESTERDAY))
  expect(row.timings).toEqual({
    fetchMs: 20,
    storeMs: expect.any(Number),
    requests: 8,
    retries: 2,
    logins: 2,
    daysFetched: 2,
    droppedBuckets: 1,
    emptyDays: 0,
    rejectedDays: 0,
    backfillDaysLeft: 0,
    bucketsWithoutSoc: 0,
    deriveMs: expect.any(Number),
  })
})

test('stored SoC lands with the readings, and buckets without it are counted', async () => {
  const withGap = (d: string): EmaldoDay => {
    const day = syntheticDay(d, 3)
    day.buckets[0] = { ...day.buckets[0], batterySocPct: 12.5 }
    day.buckets[1] = { ...day.buckets[1], batterySocPct: null }
    return day
  }
  const { client } = fakeEmaldo({ [YESTERDAY]: withGap, [TODAY]: withGap })
  const cap = capturingLogger()
  const result = await run(client, { log: cap.log })
  expect(cap.entries().find((e) => e.msg === 'integration sync run')).toMatchObject({
    bucketsWithoutSoc: 2,
  })
  expect(result.bucketsWithoutSoc).toBe(2)
  const [row] = await db.select().from(integrationSyncRun)
  expect(row.timings).toMatchObject({ bucketsWithoutSoc: 2 })
  const stored = await listReadings({ from: startOf(YESTERDAY), to: endOf(YESTERDAY) })
  expect(stored.map((r) => r.batterySocPct)).toEqual([12.5, null, 50])
})

test('buckets without SoC on a rejected day are not counted', async () => {
  await sessionOn('2026-03-28')
  const bad = (d: string): EmaldoDay => {
    const day = syntheticDay(d, 2)
    day.buckets[0] = { ...day.buckets[0], loadKwh: -1, batterySocPct: null }
    return day
  }
  const result = await run(fakeEmaldo({ '2026-03-22': bad }).client)
  expect(result.rejectedDays).toBe(1)
  expect(result.bucketsWithoutSoc).toBe(0)
})

/** Migration 0015, run as written: the test can't drift from what prod runs. */
const resetForSoc = () =>
  db.execute(
    sql.raw(
      readFileSync(
        new URL('../../../drizzle/0015_emaldo_refetch_battery_soc.sql', import.meta.url),
        'utf8',
      ),
    ),
  )

test('migration 0015 is a no-op before Emaldo ever ran', async () => {
  await resetForSoc()
  expect(await db.select().from(integrationSync)).toEqual([])
})

test('migration 0015 makes the next run re-fetch the history and fill SoC', async () => {
  await sessionOn('2026-03-28') // backfill from 2026-03-21
  const old = { from: startOf('2026-03-21'), to: endOf('2026-03-21') }
  const first = await run(fakeEmaldo({ '2026-03-21': withoutSoc }).client)
  expect(first.bucketsWithoutSoc).toBe(3)
  expect((await listReadings(old)).map((r) => r.batterySocPct)).toEqual([null, null, null])
  const [before] = await db
    .select()
    .from(integrationSync)
    .where(eq(integrationSync.source, 'emaldo'))

  await resetForSoc()

  const [after] = await db
    .select()
    .from(integrationSync)
    .where(eq(integrationSync.source, 'emaldo'))
  expect(after.lastSuccessStartedAt).toBeNull()
  expect(after.lastSuccessAt).toEqual(before.lastSuccessAt) // health is untouched
  const second = await run(fakeEmaldo().client) // synthetic days carry SoC 50
  expect(second).toMatchObject({
    outcome: 'ok',
    bucketsWithoutSoc: 0,
    earliestReplacedDay: '2026-03-21',
  })
  expect((await listReadings(old)).map((r) => r.batterySocPct)).toEqual([50, 50, 50])
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(endOf(YESTERDAY))
})

test('a run in flight when migration 0015 commits cannot write the watermark back', async () => {
  await run(fakeEmaldo().client) // a stored watermark
  const startedAt = new Date(NOW.getTime() - 60_000)
  const inFlight = await beginAttempt('emaldo', { now: startedAt })
  if (!inFlight.acquired) throw new Error('expected the lease')

  await resetForSoc()

  await recordOutcome(
    'emaldo',
    {
      ok: true,
      stats: { since: null, pages: 0, sessionsSeen: 0, upserted: 0, voided: 0, timings: {} },
      syncedUntil: endOf(YESTERDAY),
    },
    { attemptId: inFlight.attemptId, trigger: 'cron', startedAt, now: NOW },
  )
  expect(await getLastSuccessStartedAt('emaldo')).toBeNull()
  // The lease stays held until it expires, as after a crashed run: no overlap
  // with the run still in flight. Then the next run proceeds.
  expect((await run(fakeEmaldo().client)).outcome).toBe('skipped')
  const later = new Date(startedAt.getTime() + LEASE_DURATION_MS + 1)
  expect((await run(fakeEmaldo().client, { now: () => later })).outcome).toBe('ok')
})
