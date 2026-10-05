import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import * as tariffService from '~/lib/services/tariff'
import { TariffDomainError } from '~/lib/services/tariff'
import { setupDatabase } from '~test/setup'
import { evChargingRouter } from './evCharging'
import { tariffRouter } from './tariff'

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

const baseContext = () => ({ headers: new Headers(), log: noopLog, requestId: 'test-request' })

function mockSession(row: { id: string; email: string; role: 'user' | 'admin' }) {
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
      role: row.role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

const AUG = {
  validFrom: '2026-08-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}

test('list is readable by any signed-in user and rejects anonymous callers', async () => {
  await expect(call(tariffRouter.list, undefined, { context: baseContext() })).rejects.toThrow()
  await signIn('user')
  expect(await call(tariffRouter.list, undefined, { context: baseContext() })).toEqual([])
})

test.each([
  'create',
  'update',
  'remove',
] as const)('%s is forbidden for a non-admin', async (name) => {
  await signIn('user')
  const input =
    name === 'create'
      ? AUG
      : name === 'update'
        ? { ...AUG, id: '00000000-0000-4000-8000-000000000000' }
        : { id: '00000000-0000-4000-8000-000000000000' }
  await expect(
    // biome-ignore lint/suspicious/noExplicitAny: one table-driven gate test over three procedures
    call(tariffRouter[name] as any, input, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('an admin creates, updates and removes a period', async () => {
  await signIn('admin')
  const created = await call(tariffRouter.create, AUG, { context: baseContext() })
  expect(created).toMatchObject(AUG)

  const updated = await call(
    tariffRouter.update,
    { ...AUG, id: created.id, gridTransferOre: 40 },
    { context: baseContext() },
  )
  expect(updated.gridTransferOre).toBe(40)

  await call(tariffRouter.remove, { id: created.id }, { context: baseContext() })
  expect(await call(tariffRouter.list, undefined, { context: baseContext() })).toEqual([])
})

test('domain errors surface as typed codes', async () => {
  await signIn('admin')
  await call(tariffRouter.create, AUG, { context: baseContext() })

  await expect(call(tariffRouter.create, AUG, { context: baseContext() })).rejects.toMatchObject({
    code: 'TARIFF_VALID_FROM_TAKEN',
    status: 409,
  })
  await expect(
    call(tariffRouter.create, { ...AUG, validFrom: '2026-02-30' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'TARIFF_INVALID_DATE', status: 422 })
  await expect(
    call(
      tariffRouter.remove,
      { id: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND', status: 404 })
})

test('out-of-range amounts are rejected at the input boundary', async () => {
  await signIn('admin')
  await expect(
    call(tariffRouter.create, { ...AUG, vatPercent: 101 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  // A negative markup (spot minus X öre) is allowed.
  expect(
    await call(tariffRouter.create, { ...AUG, retailMarkupOre: -2 }, { context: baseContext() }),
  ).toMatchObject({ retailMarkupOre: -2 })
})

test('costOverview is readable by users and records cost sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  const overview = await call(
    evChargingRouter.costOverview,
    { year: 2026 },
    { context: { ...baseContext(), timings } },
  )
  expect(overview.months).toHaveLength(12)
  expect(overview.houseDataFrom).toBeNull()
  expect(timings).toMatchObject({
    costEnergyMs: expect.any(Number),
    costSlotsMs: expect.any(Number),
    costTariffMs: expect.any(Number),
    costMixMs: expect.any(Number),
    costHouseFromMs: expect.any(Number),
    costComputeMs: expect.any(Number),
  })
})

test('update surfaces every domain error as its typed code', async () => {
  await signIn('admin')
  const a = await call(tariffRouter.create, AUG, { context: baseContext() })
  await call(tariffRouter.create, { ...AUG, validFrom: '2026-09-01' }, { context: baseContext() })
  const missing = '00000000-0000-4000-8000-000000000000'

  await expect(
    call(tariffRouter.update, { ...AUG, id: missing }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND', status: 404 })
  await expect(
    call(
      tariffRouter.update,
      { ...AUG, id: a.id, validFrom: '2026-09-01' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'TARIFF_VALID_FROM_TAKEN', status: 409 })
  await expect(
    call(
      tariffRouter.update,
      { ...AUG, id: a.id, validFrom: '2026-13-01' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'TARIFF_INVALID_DATE', status: 422 })
})

test('a service-level TARIFF_INVALID_VALUE maps to its typed 422', async () => {
  // Zod bounds mirror TARIFF_LIMITS, so this path is only reachable if they
  // ever drift; drive the mapping directly.
  await signIn('admin')
  vi.spyOn(tariffService, 'create').mockRejectedValueOnce(
    new TariffDomainError('TARIFF_INVALID_VALUE'),
  )
  await expect(call(tariffRouter.create, AUG, { context: baseContext() })).rejects.toMatchObject({
    code: 'TARIFF_INVALID_VALUE',
    status: 422,
  })
})

test('an unexpected service error propagates as-is (the HTTP handler makes it a 500)', async () => {
  await signIn('admin')
  vi.spyOn(tariffService, 'remove').mockRejectedValueOnce(new Error('db down'))
  await expect(
    call(
      tariffRouter.remove,
      { id: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toThrow('db down')
  // …and not as one of the typed tariff errors.
  vi.spyOn(tariffService, 'remove').mockRejectedValueOnce(new Error('db down'))
  const error = await call(
    tariffRouter.remove,
    { id: '00000000-0000-4000-8000-000000000000' },
    { context: baseContext() },
  ).catch((e: unknown) => e)
  expect(error).not.toHaveProperty('defined', true)
})

test('cost procedures reject anonymous callers and out-of-range input', async () => {
  await expect(
    call(evChargingRouter.costOverview, {}, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await signIn('user')
  await expect(
    call(evChargingRouter.costOverview, { year: 1999 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})
