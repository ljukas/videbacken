import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { evSessionCost } from '~/lib/db/schema'
import { bumpAll, bumpSessions } from '~/lib/services/sessionCost/invalidate'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { create, list, remove, type TariffInput, update } from './tariff'

// The real bumps, wrapped so a test can fail bumpAll inside a tariff write.
vi.mock('~/lib/services/sessionCost/invalidate', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/services/sessionCost/invalidate')>()
  return { ...real, bumpAll: vi.fn(real.bumpAll) }
})

setupDatabase()

async function generationOf(sessionId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ generation: evSessionCost.generation })
    .from(evSessionCost)
    .where(eq(evSessionCost.sessionId, sessionId))
  return row?.generation
}

const AUG_2026: TariffInput = {
  validFrom: '2026-08-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}

test('create stores a period and list returns periods oldest first', async () => {
  await create(AUG_2026)
  await create({ ...AUG_2026, validFrom: '2026-01-01', retailMarkupOre: 4 })
  await create({ ...AUG_2026, validFrom: '2026-09-01', retailMarkupOre: 6 })

  const rows = await list()
  expect(rows.map((r) => r.validFrom)).toEqual(['2026-01-01', '2026-08-01', '2026-09-01'])
  expect(rows[1]).toMatchObject(AUG_2026)
})

test('a negative retail markup (spot minus X öre) is allowed', async () => {
  const row = await create({ ...AUG_2026, retailMarkupOre: -3 })
  expect(row.retailMarkupOre).toBe(-3)
})

test('a second period on the same day is TARIFF_VALID_FROM_TAKEN', async () => {
  await create(AUG_2026)
  await expect(create({ ...AUG_2026, retailMarkupOre: 1 })).rejects.toMatchObject({
    code: 'TARIFF_VALID_FROM_TAKEN',
  })
})

test('concurrent creates on the same day: one wins, the other is TARIFF_VALID_FROM_TAKEN', async () => {
  const results = await Promise.allSettled([create(AUG_2026), create(AUG_2026)])
  const rejected = results.filter((r) => r.status === 'rejected')
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
    code: 'TARIFF_VALID_FROM_TAKEN',
  })
})

test.each([
  ['a markup below −1000', { retailMarkupOre: -1000.5 }],
  ['a negative grid transfer', { gridTransferOre: -1 }],
  ['an energy tax above 1000', { energyTaxOre: 1001 }],
  ['VAT above 100 %', { vatPercent: 101 }],
  ['a NaN amount', { gridTransferOre: Number.NaN }],
  ['an infinite amount', { energyTaxOre: Number.POSITIVE_INFINITY }],
])('%s is TARIFF_INVALID_VALUE', async (_, override) => {
  await expect(create({ ...AUG_2026, ...override })).rejects.toMatchObject({
    code: 'TARIFF_INVALID_VALUE',
  })
  expect(await list()).toEqual([])
})

test.each([
  '2026-02-30',
  '2026-8-1',
  'yesterday',
  '',
])('valid_from %j is TARIFF_INVALID_DATE', async (validFrom) => {
  await expect(create({ ...AUG_2026, validFrom })).rejects.toMatchObject({
    code: 'TARIFF_INVALID_DATE',
  })
})

test('update changes a period, may keep its own day, and bumps updated_at', async () => {
  const row = await create(AUG_2026)
  const updated = await update(row.id, { ...AUG_2026, gridTransferOre: 40 })
  expect(updated).toMatchObject({ id: row.id, validFrom: '2026-08-01', gridTransferOre: 40 })
  expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime())
})

test('update onto another period’s day is TARIFF_VALID_FROM_TAKEN', async () => {
  await create(AUG_2026)
  const other = await create({ ...AUG_2026, validFrom: '2026-09-01' })
  await expect(update(other.id, AUG_2026)).rejects.toMatchObject({
    code: 'TARIFF_VALID_FROM_TAKEN',
  })
})

test('update validates like create', async () => {
  const row = await create(AUG_2026)
  await expect(update(row.id, { ...AUG_2026, vatPercent: -1 })).rejects.toMatchObject({
    code: 'TARIFF_INVALID_VALUE',
  })
  await expect(update(row.id, { ...AUG_2026, validFrom: 'nope' })).rejects.toMatchObject({
    code: 'TARIFF_INVALID_DATE',
  })
})

test('update and remove of an unknown id are TARIFF_NOT_FOUND', async () => {
  const missing = '00000000-0000-4000-8000-000000000000'
  await expect(update(missing, AUG_2026)).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND' })
  // Not found wins even when the day is also taken.
  await create(AUG_2026)
  await expect(update(missing, AUG_2026)).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND' })
  await expect(remove(missing)).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND' })
})

test('remove deletes a period, including the last one', async () => {
  const row = await create(AUG_2026)
  await remove(row.id)
  expect(await list()).toEqual([])
})

test('concurrent updates onto the same day: one wins, the other is TARIFF_VALID_FROM_TAKEN', async () => {
  const a = await create(AUG_2026)
  const b = await create({ ...AUG_2026, validFrom: '2026-09-01' })
  const target = { ...AUG_2026, validFrom: '2026-10-01' }

  const results = await Promise.allSettled([update(a.id, target), update(b.id, target)])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const [rejected] = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  expect(rejected.reason).toMatchObject({ code: 'TARIFF_VALID_FROM_TAKEN' })
})

test('writes only the tariff columns, ignoring extra fields on the input', async () => {
  const sneaky = { ...AUG_2026, id: '11111111-1111-4111-8111-111111111111', createdAt: new Date(0) }
  const row = await create(sneaky)
  expect(row.id).not.toBe(sneaky.id)
  expect(row.createdAt.getTime()).toBeGreaterThan(0)
})

test('every tariff write bumps every stored session; a refused write bumps nothing', async () => {
  const a = await insertSession()
  const b = await insertSession()
  await bumpSessions([a]) // a has a row, b has none: bumpAll must create b's
  const created = await create(AUG_2026)
  expect(await generationOf(a)).toBe(2)
  expect(await generationOf(b)).toBe(1)
  await update(created.id, { ...AUG_2026, gridTransferOre: AUG_2026.gridTransferOre + 1 })
  expect(await generationOf(a)).toBe(3)
  await remove(created.id)
  expect(await generationOf(a)).toBe(4)

  await expect(remove(created.id)).rejects.toMatchObject({ code: 'TARIFF_NOT_FOUND' })
  expect(await generationOf(a)).toBe(4)
})

test('a tariff write waits for an in-flight session import, then bumps its session', async () => {
  const { rows } = await db.execute<{ schema: string }>(sql`select current_schema() as schema`)
  const other = new Client({ connectionString: process.env.DATABASE_URL })
  await other.connect()
  try {
    await other.query(`set search_path to "${rows[0].schema}", public`)
    await other.query('begin')
    await other.query(
      `insert into ev_charger (id, name, installation_id) values ('charger-1', 'Charger', 'install-1')`,
    )
    const inserted = await other.query<{ id: string }>(
      `insert into ev_charge_session (zaptec_session_id, charger_id, start_at, end_at, energy_kwh)
       values ('zap-import', 'charger-1', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 5)
       returning id`,
    )

    let resolved = false
    const pending = create(AUG_2026).then((row) => {
      resolved = true
      return row
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(resolved).toBe(false)

    await other.query('commit')
    await pending
    expect(await generationOf(inserted.rows[0].id)).toBe(1)
  } finally {
    await other.end()
  }
})

test('a failed bump rolls the tariff write back', async () => {
  const session = await insertSession()
  const real = await vi.importActual<typeof import('~/lib/services/sessionCost/invalidate')>(
    '~/lib/services/sessionCost/invalidate',
  )
  // The bump itself succeeds; the transaction fails right after it.
  vi.mocked(bumpAll).mockImplementationOnce(async (tx) => {
    await real.bumpAll(tx)
    throw new Error('bump failed')
  })
  await expect(create(AUG_2026)).rejects.toThrow('bump failed')
  expect(await list()).toEqual([])
  expect(await generationOf(session)).toBeUndefined()
})
