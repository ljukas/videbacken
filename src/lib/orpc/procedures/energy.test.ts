import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { refreshMonthSums, replaceDay } from '~/lib/services/houseEnergy'
import { stockholmDayBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { energyRouter } from './energy'

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

test('a signed-in member reads the overview, and the timings are recorded', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await refreshMonthSums()
  await signIn('user')
  const timings: Record<string, number> = {}
  const o = await call(energyRouter.overview, { year: 2026 }, { context: context(timings) })
  expect(o.year).toBe(2026)
  expect(o.months).toHaveLength(12)
  expect(typeof timings.getEnergyOverviewMs).toBe('number')
  expect(typeof timings.houseScanMs).toBe('number')
  expect(typeof timings.carMs).toBe('number')
})

test('rejects an unauthenticated caller', async () => {
  await expect(call(energyRouter.overview, {}, { context: context() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})

test('rejects a year outside 2020–2100 and a non-integer year', async () => {
  await signIn('user')
  for (const year of [2019, 2101, 2026.5]) {
    await expect(
      call(energyRouter.overview, { year }, { context: context() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})

// Every period is a flat object of numbers, plus its heat pumps: flat objects of an id, a name and numbers.
const flatUnit = (u: unknown) =>
  Object.entries(u as object).every(([k, v]) =>
    k === 'id' || k === 'name' ? typeof v === 'string' : typeof v === 'number',
  )
const flat = (p: unknown) =>
  p === null ||
  Object.entries(p as object).every(([k, v]) =>
    k === 'heatPumps' ? Array.isArray(v) && v.every(flatUnit) : v === null || typeof v === 'number',
  )

test('privacy: the output holds period sums only, never buckets', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await refreshMonthSums()
  await signIn('user')
  const o = await call(energyRouter.overview, { year: 2026 }, { context: context() })
  expect(Object.keys(o).sort()).toEqual([
    'allTime',
    'availableYears',
    'firstReadingDay',
    'months',
    'monthsWithReadings',
    'year',
    'yearTotal',
  ])
  // The only arrays are the 12 months, the years and the month keys; every period is flat (see `flat`).
  // Real sums are present, so the flatness check is not vacuous.
  expect(o.months.some((p) => p !== null)).toBe(true)
  expect(o.allTime).not.toBeNull()
  expect(o.months.every(flat)).toBe(true)
  expect(o.yearTotal).not.toBeNull()
  expect(o.monthsWithReadings).toEqual(['2026-02'])
  expect(o.monthsWithReadings.every((k) => /^\d{4}-\d{2}$/.test(k))).toBe(true)
  expect(flat(o.yearTotal)).toBe(true)
  expect(flat(o.allTime)).toBe(true)
})

test('privacy: the heat pumps reach the output as period sums only, and their timing is recorded', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await refreshMonthSums()
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-02-09T23:00:00Z', '2026-02-10T23:00:00Z')
  await signIn('user')
  const timings: Record<string, number> = {}
  const o = await call(energyRouter.overview, { year: 2026 }, { context: context(timings) })
  const [unit] = o.months[1]?.heatPumps ?? []
  const keys = ['expectedHours', 'hours', 'id', 'kwh', 'name']
  expect(Object.keys(unit).sort()).toEqual(keys)
  for (const total of [o.yearTotal, o.allTime]) {
    const [u] = total?.heatPumps ?? []
    expect(Object.keys(u).sort()).toEqual(keys)
  }
  expect(unit.hours).toBe(24)
  expect([o.months[1], o.yearTotal, o.allTime].every(flat)).toBe(true)
  expect(typeof timings.heatPumpMs).toBe('number')
})

test('without a year it opens on the current Stockholm year', async () => {
  await signIn('user')
  const o = await call(energyRouter.overview, {}, { context: context() })
  expect(o.year).toBe(stockholmYearMonth(Date.now()).year)
})
