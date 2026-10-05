import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { replaceDay } from '~/lib/services/houseEnergy'
import { stockholmDayBounds } from '~/lib/time/stockholm'
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

test('privacy: the output holds period sums only, never buckets', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await signIn('user')
  const o = await call(energyRouter.overview, {}, { context: context() })
  expect(Object.keys(o).sort()).toEqual([
    'availableYears',
    'firstReadingDay',
    'months',
    'tiles',
    'year',
  ])
  // The only arrays are the 12 months and the years; every period is a flat object of numbers.
  const flat = (p: unknown) =>
    p === null || Object.values(p as object).every((v) => v === null || typeof v === 'number')
  expect(o.months.every(flat)).toBe(true)
  expect(Object.values(o.tiles).every(flat)).toBe(true)
})
