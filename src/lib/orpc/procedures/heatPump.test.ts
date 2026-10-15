import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { addDays } from '~/lib/time/stockholm'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { heatPumpRouter } from './heatPump'

setupDatabase()

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}
const context = (timings?: Record<string, number>) => ({
  headers: new Headers(),
  log: noopLog,
  requestId: 'test-request',
  timings,
})

// As energy.test.ts: a real user row, the session mocked.
async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({
    session: {
      id: 'session-id',
      userId: row.id,
      token: 'token',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: row.id,
      email: row.email,
      name: 'Test',
      role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function seedDay() {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z')
}

test('a member reads months and days; both record their timing', async () => {
  await seedDay()
  await signIn('user')
  const timings: Record<string, number> = {}
  const months = await call(heatPumpRouter.months, { year: 2026 }, { context: context(timings) })
  expect(months.year).toBe(2026)
  const days = await call(
    heatPumpRouter.days,
    { from: '2026-02-01', to: '2026-02-28' },
    { context: context(timings) },
  )
  expect(days.days.length).toBeGreaterThan(0)
  expect(typeof timings.heatPumpMonthsMs).toBe('number')
  expect(typeof timings.heatPumpDaysMs).toBe('number')
})

test('each read records its sub-timings beside its total', async () => {
  await seedDay()
  await signIn('user')
  const months: Record<string, number> = {}
  // 2026 holds the newest stored hour (February 2026), so the running comparison is read too.
  await call(heatPumpRouter.months, { year: 2026 }, { context: context(months) })
  // The session guard records its own (getSessionMs, findActiveByIdMs).
  const ours = (t: Record<string, number>) => Object.keys(t).filter((k) => k.startsWith('heatPump'))
  expect(ours(months).sort()).toEqual([
    'heatPumpCoverageMs',
    'heatPumpMonthSumsMs',
    'heatPumpMonthsMs',
    'heatPumpSoFarMs',
  ])
  const days: Record<string, number> = {}
  await call(
    heatPumpRouter.days,
    { from: '2026-02-01', to: '2026-02-28' },
    { context: context(days) },
  )
  expect(ours(days).sort()).toEqual(['heatPumpCoverageMs', 'heatPumpDaySumsMs', 'heatPumpDaysMs'])
  for (const ms of [...Object.values(months), ...Object.values(days)])
    expect(Number.isInteger(ms)).toBe(true)
})

test('rejects an unauthenticated caller', async () => {
  await expect(call(heatPumpRouter.months, {}, { context: context() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await expect(
    call(heatPumpRouter.days, { from: '2026-02-01', to: '2026-02-28' }, { context: context() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('months: a year outside 2020–2100 or not whole is a bad request', async () => {
  await signIn('user')
  for (const year of [2019, 2101, 2026.5]) {
    await expect(
      call(heatPumpRouter.months, { year }, { context: context() }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

test('days: at most 800 days, from ≤ to, real days only; never a server error', async () => {
  await signIn('user')
  const from = '2024-01-01'
  await expect(
    call(heatPumpRouter.days, { from, to: addDays(from, 799) }, { context: context() }),
  ).resolves.toBeDefined()
  for (const input of [
    { from, to: addDays(from, 800) }, // 801 days
    { from: '2026-02-10', to: '2026-02-09' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-2-1', to: '2026-02-28' },
    { from: 'junk', to: 'junk' },
  ]) {
    await expect(call(heatPumpRouter.days, input, { context: context() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

test('privacy: only month and day sums leave; no hour and no timestamp in any output', async () => {
  await seedDay()
  await signIn('user')
  const months = await call(heatPumpRouter.months, { year: 2026 }, { context: context() })
  expect(Object.keys(months).sort()).toEqual([
    'availableYears',
    'firstReadingDay',
    'lastYear',
    'lastYearSoFar',
    'months',
    'monthsWithReadings',
    'newestMonth',
    'units',
    'year',
  ])
  const cellKeys = [
    'coolKwh',
    'expectedHours',
    'heatKwh',
    'heatPumpId',
    'hours',
    'kwh',
    'month',
    'outsideC',
    'spanHours',
    'year',
  ]
  expect(months.months.length).toBeGreaterThan(0) // the key check is not vacuous
  for (const c of [...months.months, ...months.lastYear, ...(months.lastYearSoFar ?? [])]) {
    expect(Object.keys(c).sort()).toEqual(cellKeys)
  }
  expect(months.units.every((u) => Object.keys(u).sort().join() === 'id,name')).toBe(true)

  const days = await call(
    heatPumpRouter.days,
    { from: '2026-02-01', to: '2026-02-28' },
    { context: context() },
  )
  expect(Object.keys(days).sort()).toEqual(['days', 'units'])
  // One row per unit and day, never per hour: 2026-02-10 (23 of its hours), 02-11 (the 23:00 Z hour), then gap days
  // to the 28th (the readings stopped long before `now`, so the coverage runs on: 19 days in all).
  expect(days.days).toHaveLength(19)
  expect(days.days.slice(0, 2).map((d) => [d.day, d.hours])).toEqual([
    ['2026-02-10', 23],
    ['2026-02-11', 1],
  ])
  expect(days.days.slice(2).every((d) => d.hours === 0 && d.expectedHours === 24)).toBe(true)
  for (const d of days.days) {
    expect(Object.keys(d).sort()).toEqual([
      'coolKwh',
      'day',
      'expectedHours',
      'heatKwh',
      'heatPumpId',
      'hours',
      'insideC',
      'kwh',
      'outsideC',
      'setpointC',
    ])
    expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
  for (const out of [months, days])
    expect(JSON.stringify(out)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
})
