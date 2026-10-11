import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { heatPumpReading, integrationSyncRun, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import {
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  ComfortCloudError,
  type ComfortCloudHistory,
  type ComfortCloudHour,
} from '~/lib/effects/comfortCloud'
import { createServerLogger } from '~/lib/logger/server'
import * as heatPumpService from '~/lib/services/heatPump'
import { listUnits } from '~/lib/services/heatPump'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { beginAttempt, getHealth, listRecentRuns } from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { backfillCandidates, recentDays, runComfortCloudSync } from './sync'

setupDatabase()

// All days are UTC calendar days; nothing here depends on the local zone.
const NOW = new Date('2026-04-03T10:00:00Z')
const TODAY = '2026-04-03'
const DAY_MS = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const plus = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const daysFrom = (from: string, to: string) => {
  const out: string[] = []
  for (let d = from; d <= to; d = plus(d, 1)) out.push(d)
  return out
}
const daysOfMonth = (month: string) =>
  daysFrom(`${month}-01`, plus(`${plus(`${month}-01`, 31).slice(0, 7)}-01`, -1))

const MATSAL = 'CS-HZ25ZKE+0000000001'
const OVERVANING = 'CS-HZ25ZKE+0000000002'

// Synthetic values only — never real consumption (the repo is public).
function hoursOf(day: string, upTo: Date, kwh = 0.03): ComfortCloudHour[] {
  return Array.from(
    { length: 24 },
    (_, h) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`),
  )
    .filter((hourStart) => hourStart.getTime() <= upTo.getTime())
    .map((hourStart) => ({
      hourStart,
      energyKwh: kwh,
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 21.5,
      outsideC: 4,
    }))
}

type FakeUnit = {
  guid: string
  name: string
  registeredOn: string
  /** Days with data, besides dataFrom ≤ day ≤ today (default: every such day). */
  hasData?: (day: string) => boolean
  /** The first day with data (default: registeredOn); earlier for a local register date. */
  dataFrom?: string
  /** Days monthDays lists but dayHours answers without hours. */
  emptyHours?: (day: string) => boolean
  kwh?: number
}
type History = ComfortCloudHistory<ComfortCloudHour>

// In-memory Comfort Cloud: data on every day from dataFrom (registeredOn) to today unless
// `hasData` says otherwise; `days` scripts one `${guid}:${day}` answer.
function fakeComfortCloud(
  units: FakeUnit[],
  opts: {
    now?: Date
    onCall?: () => void
    days?: Record<string, () => History | Promise<History>>
  } = {},
) {
  const now = opts.now ?? NOW
  const calls: string[] = []
  const byGuid = new Map(units.map((u) => [u.guid, u]))
  const unit = (guid: string) => {
    const u = byGuid.get(guid)
    if (!u) throw new Error(`unknown guid ${guid}`)
    return u
  }
  const hasData = (u: FakeUnit, day: string) =>
    day >= (u.dataFrom ?? u.registeredOn) &&
    day <= dayOf(now.getTime()) &&
    (u.hasData?.(day) ?? true)
  // Like 1a's client: every call counts into the caller's stats sink.
  const count = (o?: { stats?: ComfortCloudCallStats }, login = false) => {
    if (!o?.stats) return
    o.stats.requests += 1
    o.stats.fetchMs += 5
    if (login) o.stats.logins += 1
  }
  const client: ComfortCloudClient = {
    async units(o) {
      calls.push('units')
      count(o, true)
      opts.onCall?.()
      return units.map(({ guid, name }) => ({ guid, name, model: 'CS-HZ25ZKE' }))
    },
    async dayHours(guid, day, o) {
      calls.push(`day:${guid}:${day}`)
      count(o)
      opts.onCall?.()
      const scripted = opts.days?.[`${guid}:${day}`]
      if (scripted) return scripted()
      const u = unit(guid)
      const hours = hasData(u, day) && !u.emptyHours?.(day)
      return { registeredOn: u.registeredOn, rows: hours ? hoursOf(day, now, u.kwh) : [] }
    },
    async monthDays(guid, month, o) {
      calls.push(`month:${guid}:${month}`)
      count(o)
      opts.onCall?.()
      const u = unit(guid)
      return {
        registeredOn: u.registeredOn,
        rows: daysOfMonth(month)
          .filter((day) => hasData(u, day))
          .map((day) => ({ day, energyKwh: 0.65 })),
      }
    },
  }
  return { client, calls }
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
const run = (client: ComfortCloudClient, extra: RunExtra = {}) =>
  runComfortCloudSync({
    trigger: 'cron',
    now: extra.now ?? (() => NOW),
    deps: {
      comfortCloud: client,
      log: extra.log ?? capturingLogger().log,
      sleep: extra.sleep ?? (async () => {}),
    },
  })

/** Stored hours of the unit called `name`, optionally on one UTC day. */
async function hoursStored(name: string, day?: string) {
  const unit = (await listUnits()).find((u) => u.name === name)
  if (!unit) return 0
  const rows = await db.select().from(heatPumpReading)
  return rows.filter(
    (r) => r.heatPumpId === unit.id && (!day || r.hourStart.toISOString().startsWith(day)),
  ).length
}
const unitNamed = async (name: string) => (await listUnits()).find((u) => u.name === name)
/** The unit's backfill calls: from its first month call on (the recent days come before). */
const backfillCalls = (calls: string[], guid: string) => {
  const ofUnit = calls.filter((c) => c.startsWith(`month:${guid}`) || c.startsWith(`day:${guid}`))
  const first = ofUnit.findIndex((c) => c.startsWith('month:'))
  return first < 0 ? [] : ofUnit.slice(first)
}

const matsal = (registeredOn: string, extra: Partial<FakeUnit> = {}): FakeUnit => ({
  guid: MATSAL,
  name: 'Matsal',
  registeredOn,
  ...extra,
})
const overvaning = (registeredOn: string, extra: Partial<FakeUnit> = {}): FakeUnit => ({
  guid: OVERVANING,
  name: 'Övervåning',
  registeredOn,
  ...extra,
})

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('recentDays', () => {
  test('today and the two days before, without a previous success', () => {
    expect(recentDays(TODAY, null)).toEqual({
      days: ['2026-04-01', '2026-04-02', TODAY],
      skipped: 0,
    })
  })

  test('a recent success keeps the three-day window', () => {
    expect(recentDays(TODAY, new Date('2026-04-03T04:20:00Z')).days).toEqual([
      '2026-04-01',
      '2026-04-02',
      TODAY,
    ])
  })

  test('after an outage it reaches back to the day the last success started', () => {
    expect(recentDays(TODAY, new Date('2026-03-28T18:20:00Z'))).toEqual({
      days: daysFrom('2026-03-28', TODAY),
      skipped: 0,
    })
  })

  test('the catch-up is capped at 14 days and says how many it skipped', () => {
    const result = recentDays(TODAY, new Date('2026-03-04T00:20:00Z'))
    expect(result.days).toEqual(daysFrom('2026-03-21', TODAY))
    expect(result.days).toHaveLength(14)
    expect(result.skipped).toBe(17) // 2026-03-04 … 2026-03-20
  })

  test('a last success in the future changes nothing', () => {
    expect(recentDays(TODAY, new Date('2026-04-09T00:00:00Z')).days).toHaveLength(3)
  })
})

describe('backfillCandidates', () => {
  test('days with data at or before `from` and not before registeredOn, newest first', () => {
    const rows = ['2026-03-01', '2026-03-05', '2026-03-09', '2026-03-12', '2026-03-31'].map(
      (day) => ({ day, energyKwh: 0.6 }),
    )
    expect(backfillCandidates(rows, { from: '2026-03-12', registeredOn: '2026-03-05' })).toEqual([
      '2026-03-12',
      '2026-03-09',
      '2026-03-05',
    ])
  })

  test('nothing listed, nothing to fetch', () => {
    expect(backfillCandidates([], { from: '2026-03-31', registeredOn: '2026-03-01' })).toEqual([])
  })
})

test('a first run stores the recent days of every unit, backfills each to registered_on and completes both', async () => {
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')])

  const result = await run(client)

  const recent = ['2026-04-01', '2026-04-02', TODAY]
  expect(calls).toEqual([
    'units',
    ...recent.map((d) => `day:${MATSAL}:${d}`),
    ...recent.map((d) => `day:${OVERVANING}:${d}`),
    `month:${MATSAL}:2026-03`,
    ...daysFrom('2026-03-25', '2026-03-31')
      .reverse()
      .map((d) => `day:${MATSAL}:${d}`),
    `month:${OVERVANING}:2026-03`,
    ...daysFrom('2026-03-28', '2026-03-31')
      .reverse()
      .map((d) => `day:${OVERVANING}:${d}`),
  ])
  // Today is filled up to 10:00 (11 hours); every past day has 24.
  expect(result).toMatchObject({
    source: 'comfortCloud',
    outcome: 'ok',
    code: null,
    units: 2,
    daysFetched: 17,
    monthsFetched: 2,
    hoursStored: 9 * 24 + 11 + 6 * 24 + 11,
    emptyDays: 0,
    rejectedDays: 0,
    unitsCompleted: 2,
    backfillDaysLeft: 0,
    since: new Date('2026-03-25T00:00:00Z'),
  })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await hoursStored('Matsal', '2026-03-24')).toBe(0)
  expect(await unitNamed('Matsal')).toMatchObject({
    registeredOn: '2026-03-25',
    historyCompleteAt: NOW,
  })
  expect(await unitNamed('Övervåning')).toMatchObject({
    registeredOn: '2026-03-28',
    historyCompleteAt: NOW,
  })
  expect((await getHealth('comfortCloud', { now: NOW, includeAdminDetail: false })).state).toBe(
    'ok',
  )
})

test('a complete unit is not backfilled again: the next run fetches only the recent days', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])

  await run(client)

  expect(calls).toEqual([
    'units',
    `day:${MATSAL}:2026-04-01`,
    `day:${MATSAL}:2026-04-02`,
    `day:${MATSAL}:${TODAY}`,
  ])
})

test('after a five-day outage the next run re-fetches every missed day', async () => {
  await run(fakeComfortCloud([matsal('2026-04-01')]).client) // last success starts at NOW (2026-04-03)
  const later = new Date('2026-04-08T10:00:00Z')
  const { client, calls } = fakeComfortCloud([matsal('2026-04-01')], { now: later })

  await run(client, { now: () => later })

  expect(calls.filter((c) => c.startsWith('day:'))).toEqual(
    daysFrom(TODAY, '2026-04-08').map((d) => `day:${MATSAL}:${d}`),
  )
  for (const day of daysFrom('2026-04-04', '2026-04-07'))
    expect(await hoursStored('Matsal', day)).toBe(24)
})

test('a catch-up capped at 14 days warns how many days it skipped', async () => {
  await run(fakeComfortCloud([matsal('2026-03-01')]).client)
  const later = new Date('2026-05-03T10:00:00Z')
  const cap = capturingLogger()

  await run(fakeComfortCloud([matsal('2026-03-01')], { now: later }).client, {
    now: () => later,
    log: cap.log,
  })

  expect(cap.entries().find((e) => e.msg === 'comfort cloud catch-up capped')).toMatchObject({
    skippedDays: 17,
  })
})

test('a gap month costs one month call and no day calls', async () => {
  const { client, calls } = fakeComfortCloud([
    matsal('2026-01-20', { hasData: (day) => !day.startsWith('2026-02') }),
  ])

  const result = await run(client)

  expect(calls).toContain(`month:${MATSAL}:2026-02`)
  expect(calls.filter((c) => c.startsWith(`day:${MATSAL}:2026-02`))).toEqual([])
  expect(result).toMatchObject({ outcome: 'ok', monthsFetched: 3, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', '2026-01-20')).toBe(24)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
})

// Comfort Cloud's register day may be a local (Stockholm) date, so the unit's
// first UTC hours can fall on the UTC day before it.
test('a unit whose data starts the day before registered_on (a local register date) gets that day backfilled', async () => {
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25', { dataFrom: '2026-03-24' })])

  const result = await run(client)

  expect(calls).toContain(`day:${MATSAL}:2026-03-24`)
  expect(await hoursStored('Matsal', '2026-03-24')).toBe(24)
  expect(result).toMatchObject({
    outcome: 'ok',
    unitsCompleted: 1,
    backfillDaysLeft: 0,
    since: new Date('2026-03-24T00:00:00Z'),
  })
  expect(await unitNamed('Matsal')).toMatchObject({
    registeredOn: '2026-03-25',
    historyCompleteAt: NOW,
  })
})

test('at most 60 backfill days per unit a run; the next run resumes below the oldest stored day', async () => {
  const first = fakeComfortCloud([matsal('2025-12-01')])

  const result = await run(first.client)

  const days = backfillCalls(first.calls, MATSAL).filter((c) => c.startsWith('day:'))
  expect(days).toHaveLength(60)
  expect(days.at(-1)).toBe(`day:${MATSAL}:2026-01-31`)
  // 2025-12-01 … 2026-01-30 are still missing.
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 0, backfillDaysLeft: 61 })
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toBeNull()

  const second = fakeComfortCloud([matsal('2025-12-01')])
  await run(second.client)
  expect(backfillCalls(second.calls, MATSAL).slice(0, 2)).toEqual([
    `month:${MATSAL}:2026-01`,
    `day:${MATSAL}:2026-01-30`,
  ])
})

test('no new backfill call once the run is 120 s old; the estimate says what is left', async () => {
  let clock = NOW.getTime()
  const tick = () => {
    clock += 10_000
  }
  const { client, calls } = fakeComfortCloud([matsal('2026-03-01')], { onCall: tick })

  const result = await run(client, { now: () => new Date(clock) })

  // units + 3 recent days + the month = 50 s; then one day per 10 s until 120 s.
  expect(backfillCalls(calls, MATSAL)).toEqual([
    `month:${MATSAL}:2026-03`,
    ...daysFrom('2026-03-25', '2026-03-31')
      .reverse()
      .map((d) => `day:${MATSAL}:${d}`),
  ])
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 0, backfillDaysLeft: 24 })
})

// Comfort Cloud may keep hourly rows for less time than monthly totals: days
// listed by the month call can answer no hours. The persisted cursor walks past them.
test('a long listed-but-empty stretch does not wedge the backfill: it completes over runs', async () => {
  const unit = matsal('2026-01-01', {
    emptyHours: (day) => day >= '2026-01-05' && day <= '2026-03-20',
  })
  const first = fakeComfortCloud([unit])
  expect(await run(first.client)).toMatchObject({ outcome: 'ok', unitsCompleted: 0 })
  const firstDays = backfillCalls(first.calls, MATSAL).filter((c) => c.startsWith('day:'))
  expect(firstDays).toHaveLength(60)
  expect(firstDays.at(-1)).toBe(`day:${MATSAL}:2026-01-31`)
  // The oldest stored day is 2026-03-21, but the walk continues below where it stopped.
  expect((await unitNamed('Matsal'))?.backfillCursor).toBe('2026-01-30')

  const second = fakeComfortCloud([unit])
  const result = await run(second.client)
  expect(backfillCalls(second.calls, MATSAL).slice(0, 2)).toEqual([
    `month:${MATSAL}:2026-01`,
    `day:${MATSAL}:2026-01-30`,
  ])
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 1, backfillDaysLeft: 0 })
  for (const day of daysFrom('2026-01-01', '2026-01-04')) {
    expect(await hoursStored('Matsal', day)).toBe(24)
  }
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
})

test('the walk position persists across a budget stop: the next run starts below the last day walked', async () => {
  let clock = NOW.getTime()
  const unit = matsal('2026-03-01', { emptyHours: (day) => day === '2026-03-25' })
  const first = fakeComfortCloud([unit], {
    onCall: () => {
      clock += 10_000
    },
  })
  await run(first.client, { now: () => new Date(clock) })
  // As in the 120 s test, the last backfill day is 2026-03-25 — here it answered
  // no hours, so the oldest stored day is 2026-03-26.
  expect(backfillCalls(first.calls, MATSAL).at(-1)).toBe(`day:${MATSAL}:2026-03-25`)
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(0)

  const second = fakeComfortCloud([unit])
  await run(second.client)
  expect(backfillCalls(second.calls, MATSAL).slice(0, 2)).toEqual([
    `month:${MATSAL}:2026-03`,
    `day:${MATSAL}:2026-03-24`,
  ])
})

test('a backfill call that fails keeps the walk position at that day, for the next run to retry', async () => {
  const { client } = fakeComfortCloud(
    [matsal('2026-03-25', { emptyHours: (d) => d === '2026-03-28' })],
    {
      days: {
        [`${MATSAL}:2026-03-27`]: () => {
          throw new ComfortCloudError('rate_limited', 'history', 429)
        },
      },
    },
  )
  expect(await run(client)).toMatchObject({ outcome: 'failed', code: 'rate_limited' })
  expect((await unitNamed('Matsal'))?.backfillCursor).toBe('2026-03-27')
})

test('a cursor that cannot be saved never masks the walk error', async () => {
  vi.spyOn(heatPumpService, 'setBackfillCursor').mockRejectedValue(new Error('db down'))
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: {
      [`${MATSAL}:2026-03-27`]: () => {
        throw new ComfortCloudError('rate_limited', 'history', 429)
      },
    },
  })
  expect(await run(client, { log: cap.log })).toMatchObject({
    outcome: 'failed',
    code: 'rate_limited',
  })
  expect(
    cap.entries().find((e) => e.msg === 'comfort cloud backfill cursor not saved'),
  ).toMatchObject({
    unit: 'Matsal',
  })
})

test('a rejected backfill day is skipped, warned without values, and the walk still completes', async () => {
  const bad = '2026-03-28'
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: {
      // 7.654321 kWh in an hour is outside the reading CHECK (< 5): INVALID_READING.
      [`${MATSAL}:${bad}`]: () => ({
        registeredOn: '2026-03-25',
        rows: hoursOf(bad, NOW, 7.654321),
      }),
    },
  })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', bad)).toBe(0)
  expect(await hoursStored('Matsal', '2026-03-27')).toBe(24)
  expect(cap.entries().find((e) => e.msg === 'comfort cloud day rejected')).toMatchObject({
    unit: 'Matsal',
    day: bad,
    code: 'INVALID_READING',
  })
  expect(cap.raw()).not.toContain('7.654321')
  expect(cap.raw()).not.toContain(MATSAL)
})

test('a listed day that answers no hours is skipped and the walk still completes', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-03-27`]: () => ({ registeredOn: '2026-03-25', rows: [] }) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', emptyDays: 1, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', '2026-03-26')).toBe(24)
})

test('an empty recent day keeps its stored hours', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client)
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-04-01`]: () => ({ registeredOn: '2026-03-25', rows: [] }) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', emptyDays: 1 })
  expect(await hoursStored('Matsal', '2026-04-01')).toBe(24)
})

test('yesterday empty fails the run, after the rest has landed', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${OVERVANING}:2026-04-02`]: () => ({ registeredOn: '2026-03-28', rows: [] }) },
  })

  const result = await run(client)

  // Övervåning's backfill waits for a healthy yesterday; Matsal's completes.
  expect(result).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    unitsCompleted: 1,
  })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await hoursStored('Övervåning', '2026-04-01')).toBe(24)
  const health = await getHealth('comfortCloud', { now: NOW, includeAdminDetail: true })
  expect(health.adminDetail?.lastErrorMessage).toContain('Övervåning')
  expect(health.adminDetail?.lastErrorMessage).toContain('2026-04-02')
  expect(health.adminDetail?.lastErrorMessage).not.toContain('Matsal')
})

test('a rejected yesterday fails the run as unexpected_response, after the rest has landed', async () => {
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: {
      // 7.654321 kWh in an hour is outside the reading CHECK (< 5): INVALID_READING.
      [`${OVERVANING}:2026-04-02`]: () => ({
        registeredOn: '2026-03-28',
        rows: hoursOf('2026-04-02', NOW, 7.654321),
      }),
    },
  })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    rejectedDays: 1,
    unitsCompleted: 1, // Övervåning's backfill waits for a healthy yesterday
  })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await hoursStored('Övervåning', '2026-04-01')).toBe(24)
  expect(await hoursStored('Övervåning', '2026-04-02')).toBe(0)
  const message = (await getHealth('comfortCloud', { now: NOW, includeAdminDetail: true }))
    .adminDetail?.lastErrorMessage
  expect(message).toContain('Övervåning')
  expect(message).toContain('2026-04-02')
  expect(message).toContain('failed validation')
  expect(message).not.toContain('Matsal')
  expect(message).not.toContain('7.654321')
  expect(message).not.toContain(OVERVANING)
  expect(cap.raw()).not.toContain('7.654321')
  expect(cap.raw()).not.toContain(OVERVANING)
})

// A bad yesterday (a changed unit, a transient outage) must not walk the
// history past days it would reject or find empty: the backfill waits for a healthy yesterday.
test.each([
  ['rejected', () => ({ registeredOn: '2026-03-25', rows: hoursOf('2026-04-02', NOW, 7.654321) })],
  ['quiet', () => ({ registeredOn: '2026-03-25', rows: [] })],
])('a unit whose yesterday was %s is not backfilled in that run, and resumes once yesterday is healthy', async (_, yesterday) => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  const first = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${MATSAL}:2026-04-02`]: yesterday },
  })

  expect(await run(first.client)).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    unitsCompleted: 1,
    backfillDaysLeft: 7, // 2026-03-25 … 2026-03-31
  })
  expect(backfillCalls(first.calls, MATSAL)).toEqual([])
  expect(backfillCalls(first.calls, OVERVANING)[0]).toBe(`month:${OVERVANING}:2026-03`)
  expect(await unitNamed('Matsal')).toMatchObject({ backfillCursor: null, historyCompleteAt: null })
  // Matsal's 60 planned days are given back: the run still ends at done === total.
  expect(spy.mock.calls.at(-1)?.[2]).toEqual({ done: 10, total: 10 })

  const second = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')])
  expect(await run(second.client)).toMatchObject({ outcome: 'ok', unitsCompleted: 1 })
  expect(backfillCalls(second.calls, MATSAL).slice(0, 2)).toEqual([
    `month:${MATSAL}:2026-03`,
    `day:${MATSAL}:2026-03-31`,
  ])
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
})

test('a rejected older recent day only warns', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client) // complete: no backfill below
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: {
      [`${MATSAL}:2026-04-01`]: () => ({
        registeredOn: '2026-03-25',
        rows: hoursOf('2026-04-01', NOW, 7.654321),
      }),
    },
  })
  expect(await run(client)).toMatchObject({ outcome: 'ok', rejectedDays: 1 })
})

// What the client throws for a day answer it can't parse (a repeated hour, a
// row outside the day). A day like that must not wedge the run for 14 days of
// catch-up, nor the backfill cursor: it counts as rejected, like INVALID_READING.
const unparsed = (guid: string) => () => {
  throw new ComfortCloudError('unexpected_response', 'history', undefined, {
    message: `Comfort Cloud day history for ${guid} row 3 repeats an hour (0.654321)`,
  })
}

test('a recent day the client cannot parse is rejected: warned without the message, the run still lands', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client) // complete: no backfill below
  const cap = capturingLogger()
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${MATSAL}:2026-04-01`]: unparsed(MATSAL) },
  })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, unitsCompleted: 1 })
  expect(calls).toContain(`day:${MATSAL}:${TODAY}`)
  expect(await hoursStored('Matsal', '2026-04-01')).toBe(24) // what's stored is kept
  for (const day of daysFrom('2026-03-28', '2026-04-02')) {
    expect(await hoursStored('Övervåning', day)).toBe(24)
  }
  expect(await hoursStored('Övervåning', TODAY)).toBe(11)
  expect(cap.entries().find((e) => e.msg === 'comfort cloud day rejected')).toMatchObject({
    unit: 'Matsal',
    day: '2026-04-01',
    code: 'unexpected_response',
  })
  expect(cap.raw()).not.toContain('repeats an hour')
  expect(cap.raw()).not.toContain('0.654321')
  expect(cap.raw()).not.toContain(MATSAL)
})

test('a backfill day the client cannot parse is passed over and the walk completes', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-03-28`]: unparsed(MATSAL) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', '2026-03-28')).toBe(0)
  expect(await hoursStored('Matsal', '2026-03-27')).toBe(24)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
})

test('a yesterday the client cannot parse fails the run as a rejected yesterday', async () => {
  const cap = capturingLogger()
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${OVERVANING}:2026-04-02`]: unparsed(OVERVANING) },
  })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    rejectedDays: 1,
    unitsCompleted: 1, // Övervåning's backfill waits for a healthy yesterday
  })
  expect(backfillCalls(calls, OVERVANING)).toEqual([])
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  const message = (await getHealth('comfortCloud', { now: NOW, includeAdminDetail: true }))
    .adminDetail?.lastErrorMessage
  expect(message).toContain('Övervåning')
  expect(message).toContain('2026-04-02')
  expect(message).not.toContain('repeats an hour')
  expect(message).not.toContain(OVERVANING)
  expect(cap.raw()).not.toContain(OVERVANING)
})

test('any other day error still fails the run with its own code', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: {
      [`${MATSAL}:2026-04-01`]: () => {
        throw new ComfortCloudError('unreachable', 'history')
      },
    },
  })
  expect(await run(client)).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('a unit that never stored an hour only warns, without a day count', async () => {
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25', { hasData: () => false })])
  expect(await run(client, { log: cap.log })).toMatchObject({
    outcome: 'ok',
    emptyDays: 3,
    unitsCompleted: 0, // a quiet yesterday holds the backfill
  })
  expect(cap.entries().find((e) => e.msg === 'comfort cloud unit without data')).toMatchObject({
    unit: 'Matsal',
    daysWithoutData: null,
  })
})

// No false "recovered" email: day after day without data keeps the source failing.
test('an outage keeps the run failing until data returns', async () => {
  const quiet = matsal('2026-03-25', { hasData: (day) => day < '2026-04-01' })
  // A healthy run before the outage stores the unit's history (a quiet yesterday holds the backfill).
  const before = new Date('2026-03-31T10:00:00Z')
  await run(fakeComfortCloud([quiet], { now: before }).client, { now: () => before })
  // From the last success's day: 2026-03-31 answers, 2026-04-01 … 2026-04-03 don't.
  expect(await run(fakeComfortCloud([quiet]).client)).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    emptyDays: 3,
  })
  const nextDay = new Date('2026-04-04T10:00:00Z')
  expect(
    await run(fakeComfortCloud([quiet], { now: nextDay }).client, { now: () => nextDay }),
  ).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
  const health = await getHealth('comfortCloud', { now: nextDay, includeAdminDetail: true })
  expect(health.state).toBe('failing')
  expect(health.adminDetail?.lastErrorMessage).toContain('Matsal')

  // Data back (yesterday answered): green again.
  const back = new Date('2026-04-05T10:00:00Z')
  expect(
    await run(fakeComfortCloud([matsal('2026-03-25')], { now: back }).client, { now: () => back }),
  ).toMatchObject({ outcome: 'ok' })
})

// NOW − 14 days = 2026-03-20T10:00Z. The unit's data stops on 2026-03-20; the
// scripted last day decides whether its newest hour is exactly 14 days old or an hour older.
const lastDataUpTo = (upTo: string, now = NOW) =>
  fakeComfortCloud([matsal('2026-03-15', { hasData: (day) => day <= '2026-03-20' })], {
    now,
    days: {
      [`${MATSAL}:2026-03-20`]: () => ({
        registeredOn: '2026-03-15',
        rows: hoursOf('2026-03-20', new Date(upTo)),
      }),
    },
  })

// A healthy run on 2026-03-21 stores the history (a quiet yesterday holds the backfill).
const seedLastData = async (upTo: string) => {
  const seededAt = new Date('2026-03-21T10:00:00Z')
  await run(lastDataUpTo(upTo, seededAt).client, { now: () => seededAt })
}

test('the newest hour exactly 14 days old still fails the run', async () => {
  await seedLastData('2026-03-20T10:00:00Z')
  const result = await run(lastDataUpTo('2026-03-20T10:00:00Z').client)
  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
})

test('data older than 14 days only warns, every run', async () => {
  await seedLastData('2026-03-20T09:00:00Z')
  const cap = capturingLogger()
  expect(await run(lastDataUpTo('2026-03-20T09:00:00Z').client, { log: cap.log })).toMatchObject({
    outcome: 'ok',
  })
  expect(await run(lastDataUpTo('2026-03-20T09:00:00Z').client, { log: cap.log })).toMatchObject({
    outcome: 'ok',
  })
  const warnings = cap.entries().filter((e) => e.msg === 'comfort cloud unit without data')
  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toMatchObject({ unit: 'Matsal', daysWithoutData: 14 })
})

test('a unit registered today has no yesterday to miss', async () => {
  const { client } = fakeComfortCloud([matsal(TODAY)])
  expect(await run(client)).toMatchObject({ outcome: 'ok', emptyDays: 2 })
})

test('no units listed fails the run as unexpected_response', async () => {
  const { client, calls } = fakeComfortCloud([])
  expect(await run(client)).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    units: 0,
  })
  expect(calls).toEqual(['units'])
})

// setRegisteredOn clears history_complete_at when the day moves earlier (step 1a):
// the sync backfills the newly reported days in the same run.
test('a complete unit whose registered_on moves earlier is backfilled again', async () => {
  await run(fakeComfortCloud([matsal('2026-03-28')]).client)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])

  const result = await run(client)

  expect(backfillCalls(calls, MATSAL).filter((c) => !c.includes(':2026-04-'))).toEqual([
    `month:${MATSAL}:2026-03`,
    `day:${MATSAL}:2026-03-27`,
    `day:${MATSAL}:2026-03-26`,
    `day:${MATSAL}:2026-03-25`,
  ])
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 1, backfillDaysLeft: 0 })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await unitNamed('Matsal')).toMatchObject({
    registeredOn: '2026-03-25',
    historyCompleteAt: NOW,
  })
})

test('a reopened unit adds its 60 days to the progress total', async () => {
  await run(fakeComfortCloud([matsal('2026-03-28')]).client)
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  // One second per clock read, so the 1 s throttle passes every write.
  let clock = NOW.getTime()
  await run(fakeComfortCloud([matsal('2026-03-25')]).client, {
    now: () => {
      clock += 1_000
      return new Date(clock)
    },
  })
  const reports = spy.mock.calls.map(([, , p]) => p)
  // Complete at the start: 3 recent days; reopened: + 60; done after 3 backfill days.
  expect(reports[0]).toEqual({ done: 1, total: 3 })
  expect(reports).toContainEqual({ done: 3, total: 63 })
  expect(reports.at(-1)).toEqual({ done: 6, total: 6 })
})

test('a later registered_on is stored and keeps the unit complete', async () => {
  await run(fakeComfortCloud([matsal('2026-03-27')]).client)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-28')])
  await run(client)
  expect(calls.filter((c) => c.startsWith('month:'))).toEqual([])
  expect((await unitNamed('Matsal'))?.registeredOn).toBe('2026-03-28')
})

test('a remote failure is failed with its code; admins are alerted on the second in a row', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const client: ComfortCloudClient = {
    units: async () => {
      throw new ComfortCloudError('auth_failed', 'login', 401)
    },
    dayHours: async () => ({ registeredOn: '2026-03-01', rows: [] }),
    monthDays: async () => ({ registeredOn: '2026-03-01', rows: [] }),
  }

  expect(await run(client)).toMatchObject({
    outcome: 'failed',
    code: 'auth_failed',
    daysFetched: 0,
  })
  expect(publish).not.toHaveBeenCalled()

  await run(client)
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      source: 'comfortCloud',
      transition: 'started_failing',
      to: 'a@example.com',
    }),
  )
})

test('a call that outlives the deadline fails as unreachable', async () => {
  const client: ComfortCloudClient = {
    units: () => new Promise(() => {}),
    dayHours: () => new Promise(() => {}),
    monthDays: () => new Promise(() => {}),
  }
  const result = await runComfortCloudSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 20,
    deps: { comfortCloud: client, log: capturingLogger().log, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('a day call that outlives the deadline mid-run fails as unreachable and keeps what landed', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:${TODAY}`]: () => new Promise<History>(() => {}) },
  })
  const result = await runComfortCloudSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 1_000,
    deps: { comfortCloud: client, log: capturingLogger().log, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable', daysFetched: 2 })
  expect(await unitNamed('Matsal')).toBeDefined()
  expect(await hoursStored('Matsal', '2026-04-01')).toBe(24)
  expect(await hoursStored('Matsal', '2026-04-02')).toBe(24)
})

test('a held lease skips the run without calling Comfort Cloud', async () => {
  await beginAttempt('comfortCloud', { now: NOW })
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])
  expect((await run(client)).outcome).toBe('skipped')
  expect(calls).toEqual([])
})

test('without credentials (the real facade under VITEST) the run is not_configured and alerts nobody', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const result = await runComfortCloudSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  expect(publish).not.toHaveBeenCalled()
})

test('backfill pauses between day calls', async () => {
  const sleeps: number[] = []
  await run(fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')]).client, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  // Matsal 7 backfill days → 6 pauses; Övervåning 4 → 3.
  expect(sleeps).toHaveLength(9)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('progress: recent days plus 60 per unit to backfill, shrunk as units complete, ending at the total', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')]).client)
  const reports = spy.mock.calls.map(([, , p]) => p)
  // A constant clock: the 1 s throttle passes the first write and every done === total write.
  // 126 = 2 units × 3 recent days + 2 units × 60; Matsal gives back 53, Övervåning 56.
  expect(reports).toEqual([
    { done: 1, total: 126 },
    { done: 17, total: 17 },
  ])
})

test('one run row and one run line, counts only, never an hourly value', async () => {
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-04-01', { kwh: 0.123456 })])

  const result = await run(client, { log: cap.log })

  const [row] = await listRecentRuns('comfortCloud', { limit: 5 })
  // Zaptec-era columns: pages = days fetched, sessionsSeen/upserted = hours stored.
  expect(row).toMatchObject({
    outcome: 'ok',
    pages: 3,
    sessionsSeen: result.hoursStored,
    upserted: result.hoursStored,
  })
  const [stored] = await db.select().from(integrationSyncRun)
  // Registered on the 1st: the backfill floor (registered_on − 1) is 2026-03-31,
  // so March's listing is fetched once (it lists no day with data).
  expect(stored.timings).toEqual({
    fetchMs: 25, // the fake: 5 ms × 5 calls
    requests: 5,
    retries: 0,
    logins: 1,
    storeMs: expect.any(Number),
    units: 1,
    daysFetched: 3,
    monthsFetched: 1,
    emptyDays: 0,
    rejectedDays: 0,
    unitsCompleted: 1,
    backfillDaysLeft: 0,
  })
  const lines = cap.entries().filter((e) => e.msg === 'integration sync run')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    source: 'comfortCloud',
    units: 1,
    daysFetched: 3,
    hoursStored: 2 * 24 + 11,
    unitsCompleted: 1,
  })
  expect(cap.raw()).not.toContain('0.123456')
  expect(cap.raw()).not.toContain(MATSAL)
})
