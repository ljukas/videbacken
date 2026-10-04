import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evCharger, evChargeSession, spotPrice } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import { type ElprisClient, ElprisError } from '~/lib/effects/elpris'
import { createServerLogger } from '~/lib/logger/server'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { beginAttempt, getHealth, listRecentRuns } from '~/lib/services/integrationSync'
import { daysWithSlots } from '~/lib/services/spotPrice'
import type { PriceSlot } from '~/lib/spotPrice/slots'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { addDays } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { planDays, runElprisSync } from './sync'

setupDatabase()

// 2026-09-28 14:00 local (CEST) — tomorrow's prices are normally out by now.
const NOW = new Date('2026-09-28T12:00:00Z')
const TODAY = '2026-09-28'
const TOMORROW = '2026-09-29'

// In-memory elprisetjustnu: every day is published up to `publishedThrough`,
// except days listed in `missing`.
function fakeElpris(opts: { publishedThrough?: string; missing?: string[] } = {}) {
  const publishedThrough = opts.publishedThrough ?? TODAY
  const missing = new Set(opts.missing ?? [])
  const requested: string[] = []
  const client: ElprisClient = {
    async dayPrices(day, _zone, o) {
      requested.push(day)
      if (o?.stats) o.stats.requests++
      if (day > publishedThrough || missing.has(day)) return null
      return daySlots(day, day < '2025-10-01' ? 60 : 15, () => 0.5)
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
  const runLines = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string; level: number })
      .filter((e) => e.msg === 'integration sync run')
  return { log, runLines }
}

let counter = 0
async function insertSession(
  startAt: Date,
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
) {
  counter += 1
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger', installationId: 'install-1' })
    .onConflictDoNothing()
  await db.insert(evChargeSession).values({
    zaptecSessionId: `zap-${counter}`,
    chargerId: 'charger-1',
    startAt,
    endAt: new Date(startAt.getTime() + 2 * 3_600_000),
    energyKwh: 10,
    ...overrides,
  })
}

const run = (client: ElprisClient, extra: Parameters<typeof runElprisSync>[0]['deps'] = {}) =>
  runElprisSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { elpris: client, sleep: async () => {}, ...extra },
  })

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('planDays', () => {
  test('tomorrow back to the first day, newest first, skipping stored days', () => {
    expect(
      planDays({ today: TODAY, first: '2026-09-25', have: new Set(['2026-09-27']), max: 100 }),
    ).toEqual(['2026-09-29', '2026-09-28', '2026-09-26', '2026-09-25'])
  })

  test('caps the plan and never goes before the API floor', () => {
    expect(planDays({ today: TODAY, first: '2026-01-01', have: new Set(), max: 3 })).toEqual([
      '2026-09-29',
      '2026-09-28',
      '2026-09-27',
    ])
    const floored = planDays({
      today: '2022-11-02',
      first: '2020-01-01',
      have: new Set(),
      max: 100,
    })
    expect(floored.at(-1)).toBe('2022-11-01')
  })
})

test('with no sessions yet it fetches just today and tomorrow', async () => {
  const { client, requested } = fakeElpris({ publishedThrough: TOMORROW })
  const result = await run(client)

  expect(requested).toEqual([TOMORROW, TODAY])
  expect(result).toMatchObject({ outcome: 'ok', days: 2, daysFetched: 2, upserted: 192 })
  expect(await daysWithSlots('SE3', TODAY, TOMORROW)).toEqual(new Set([TODAY, TOMORROW]))
})

test('backfills from the first counted session; an unpublished tomorrow is fine', async () => {
  await insertSession(new Date('2026-09-20T18:00:00Z'))
  await insertSession(new Date('2026-09-10T18:00:00Z'), { energyKwh: 0.1 }) // noise: ignored
  const { client, requested } = fakeElpris()

  const result = await run(client)

  expect(requested[0]).toBe(TOMORROW)
  expect(requested.at(-1)).toBe('2026-09-20')
  expect(result).toMatchObject({
    outcome: 'ok',
    code: null,
    days: 10,
    daysFetched: 9,
    notPublished: 1,
    gaps: 0,
    upserted: 9 * 96,
  })
  expect(result.since).toEqual(new Date('2026-09-19T22:00:00Z'))
  expect((await getHealth('elpris', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('a later run only asks for what is still missing', async () => {
  await insertSession(new Date('2026-09-25T18:00:00Z'))
  await run(fakeElpris().client)

  const second = fakeElpris({ publishedThrough: TOMORROW })
  const result = await run(second.client)

  expect(second.requested).toEqual([TOMORROW])
  expect(result).toMatchObject({ outcome: 'ok', daysFetched: 1 })
})

test('stores hourly days before the 15-min switch', async () => {
  await insertSession(new Date('2025-09-29T18:00:00Z'))
  const { client } = fakeElpris({ publishedThrough: '2025-10-01' })
  await runElprisSync({
    trigger: 'cron',
    now: () => new Date('2025-10-01T12:00:00Z'),
    deps: { elpris: client, sleep: async () => {} },
  })
  const rows = await db.select().from(spotPrice)
  // 09-29 and 09-30 hourly, 10-01 in quarters; tomorrow (10-02) isn't out yet.
  expect(rows).toHaveLength(24 + 24 + 96)
})

test('a missing today fails the run as unexpected_response — after storing the rest', async () => {
  await insertSession(new Date('2026-09-25T18:00:00Z'))
  const { log, runLines } = capturingLogger()

  const result = await run(fakeElpris({ missing: [TODAY] }).client, { log })

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', daysFetched: 3 })
  const health = await getHealth('elpris', { now: NOW, includeAdminDetail: true })
  expect(health).toMatchObject({ state: 'failing', code: 'unexpected_response' })
  expect(health.adminDetail?.lastErrorMessage).toBe(`No spot prices published for ${TODAY}`)
  expect(await daysWithSlots('SE3', '2026-09-25', '2026-09-27')).toHaveProperty('size', 3)
  expect(runLines()).toEqual([expect.objectContaining({ level: 40, source: 'elpris' })])
  expect(publish).not.toHaveBeenCalled() // no admins in this test DB
})

test('an older day the API lacks is a counted gap, not a failure', async () => {
  await insertSession(new Date('2026-09-20T18:00:00Z'))
  const result = await run(fakeElpris({ missing: ['2026-09-22'] }).client)
  expect(result).toMatchObject({ outcome: 'ok', gaps: 1, daysFetched: 8 })
})

test('a first backfill is capped per run and later runs continue until done', async () => {
  // 2025-11-01 … 2026-09-29 is 333 days. The unpublished tomorrow takes a
  // planned slot every run, so 119 are stored per run: 120, 120, then 95.
  await insertSession(new Date('2025-11-01T18:00:00Z'))
  const plans: number[] = []
  let last: Awaited<ReturnType<typeof runElprisSync>> | undefined
  for (let i = 0; i < 3; i++) {
    last = await run(fakeElpris().client)
    plans.push(last.days)
  }
  expect(plans).toEqual([120, 120, 95])
  expect(last?.since).toEqual(new Date('2025-10-31T23:00:00Z')) // 2025-11-01 local midnight

  // Done: only the unpublished tomorrow is still missing.
  const done = fakeElpris()
  await run(done.client)
  expect(done.requested).toEqual([TOMORROW])
})

test('a remote failure is failed with its code, and alerts on the streak start', async () => {
  await db
    .insert((await import('~/lib/db/schema')).user)
    .values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const client: ElprisClient = {
    async dayPrices() {
      throw new ElprisError('unreachable', 'prices', 503)
    },
  }

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      source: 'elpris',
      transition: 'started_failing',
      to: 'a@example.com',
    }),
  )
})

test('a call that outlives the deadline fails as unreachable', async () => {
  const client: ElprisClient = { dayPrices: () => new Promise<PriceSlot[] | null>(() => {}) }
  const result = await runElprisSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 20,
    deps: { elpris: client, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('records one run row with the elpris stats mapping', async () => {
  const { client } = fakeElpris({ publishedThrough: TOMORROW })
  await run(client)
  const [row] = await listRecentRuns('elpris', { limit: 5 })
  // Zaptec-era columns: pages = day requests, sessionsSeen = slots parsed.
  expect(row).toMatchObject({ outcome: 'ok', pages: 2, sessionsSeen: 192, upserted: 192 })
})

test('backfill pauses between requests to be polite', async () => {
  await insertSession(new Date(`${addDays(TODAY, -9)}T18:00:00Z`))
  const sleeps: number[] = []
  await run(fakeElpris().client, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  expect(sleeps.length).toBeGreaterThan(0)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('an older day that fails validation is skipped and warned; the backfill goes on', async () => {
  await insertSession(new Date('2026-09-20T18:00:00Z'))
  const good = fakeElpris()
  const client: ElprisClient = {
    async dayPrices(day, zone, o) {
      if (day === '2026-09-22') {
        throw new ElprisError('unexpected_response', 'prices', undefined, { message: 'bad day' })
      }
      return good.client.dayPrices(day, zone, o)
    },
  }
  const warns: unknown[] = []
  const { log } = capturingLogger()
  const spyLog = { ...log, warn: (msg: string, fields?: unknown) => warns.push([msg, fields]) }

  const result = await run(client, { log: spyLog as typeof log })

  expect(result).toMatchObject({ outcome: 'ok', rejected: 1, daysFetched: 8 })
  expect(warns).toEqual([['elpris day rejected', expect.objectContaining({ day: '2026-09-22' })]])
})

test('a recent day that fails validation still fails the run', async () => {
  const client: ElprisClient = {
    async dayPrices() {
      throw new ElprisError('unexpected_response', 'prices')
    },
  }
  const result = await run(client)
  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', rejected: 0 })
})

test('a network failure on an old day still fails the run', async () => {
  await insertSession(new Date('2026-09-20T18:00:00Z'))
  const good = fakeElpris()
  const client: ElprisClient = {
    async dayPrices(day, zone, o) {
      if (day === '2026-09-22') throw new ElprisError('unreachable', 'prices', 503)
      return good.client.dayPrices(day, zone, o)
    },
  }
  const result = await run(client)
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('a success after a failure is a recovered transition, alerting admins', async () => {
  const { user } = await import('~/lib/db/schema')
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const failing: ElprisClient = {
    async dayPrices() {
      throw new ElprisError('unreachable', 'prices', 503)
    },
  }
  await run(failing)
  const recovered = await run(fakeElpris({ publishedThrough: TOMORROW }).client)

  expect(recovered).toMatchObject({ outcome: 'ok', transition: 'recovered' })
  expect(publish).toHaveBeenLastCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({ source: 'elpris', transition: 'recovered' }),
  )
})

test('a held lease skips the run without calling elpris', async () => {
  await beginAttempt('elpris', { now: NOW })
  const { client, requested } = fakeElpris()
  const result = await run(client)
  expect(result.outcome).toBe('skipped')
  expect(requested).toEqual([])
})

test('reports progress over every planned day, skipped ones included', async () => {
  // 09-20 … 09-29 planned (10 days): tomorrow is not published yet and 09-22 is a gap — both still count.
  await insertSession(new Date('2026-09-20T10:00:00Z'))
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeElpris({ missing: ['2026-09-22'] })
  await runElprisSync({
    trigger: 'cron',
    now: () => {
      clock += 1_001
      return new Date(clock)
    },
    deps: { elpris: client, sleep: async () => {} },
  })
  expect(spy.mock.calls.map(([, , p]) => p)).toEqual(
    Array.from({ length: 10 }, (_, i) => ({ done: i + 1, total: 10 })),
  )
})

test('a budget stop leaves the last progress report below its total', async () => {
  await insertSession(new Date('2026-09-20T10:00:00Z')) // 10 planned days
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const good = fakeElpris()
  const client: ElprisClient = {
    async dayPrices(day, zone, o) {
      clock += 50_000
      return good.client.dayPrices(day, zone, o)
    },
  }
  const result = await runElprisSync({
    trigger: 'cron',
    now: () => new Date(clock),
    deps: { elpris: client, sleep: async () => {} },
  })
  const reports = spy.mock.calls.map(([, , p]) => p)
  expect(result).toMatchObject({ outcome: 'ok', days: 10 })
  expect(result.dayRequests).toBeLessThan(10)
  expect(reports.at(-1)).toEqual({ done: result.dayRequests, total: 10 })
  expect(reports.some((p) => p.done === p.total)).toBe(false)
})

test('a rejected day still moves the progress bar', async () => {
  await insertSession(new Date('2026-09-20T10:00:00Z'))
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  const good = fakeElpris()
  const client: ElprisClient = {
    async dayPrices(day, zone, o) {
      if (day === '2026-09-22') {
        throw new ElprisError('unexpected_response', 'prices', undefined, { message: 'bad day' })
      }
      return good.client.dayPrices(day, zone, o)
    },
  }
  let clock = NOW.getTime()
  const result = await runElprisSync({
    trigger: 'cron',
    now: () => {
      clock += 1_001
      return new Date(clock)
    },
    deps: { elpris: client, sleep: async () => {}, log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'ok', rejected: 1 })
  expect(spy.mock.calls.map(([, , p]) => p)).toEqual(
    Array.from({ length: 10 }, (_, i) => ({ done: i + 1, total: 10 })),
  )
})
