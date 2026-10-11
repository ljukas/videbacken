import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { electricityTariff } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { isUniqueViolation, pgErrorSummary } from './pgError'

setupDatabase()

const ROW = {
  validFrom: '2026-08-01',
  retailMarkupOre: 5,
  gridTransferOre: 35,
  energyTaxOre: 36,
  vatPercent: 25,
}

test('recognises a real duplicate on the named constraint only', async () => {
  await db.insert(electricityTariff).values(ROW)
  const error = await db
    .insert(electricityTariff)
    .values(ROW)
    .then(() => null)
    .catch((e: unknown) => e)

  expect(isUniqueViolation(error, 'electricity_tariff_valid_from_unique')).toBe(true)
  expect(isUniqueViolation(error, 'some_other_unique')).toBe(false)
})

test('ignores other errors and non-errors', async () => {
  const checkError = await db
    .insert(electricityTariff)
    .values({ ...ROW, vatPercent: 500 })
    .then(() => null)
    .catch((e: unknown) => e)

  expect(isUniqueViolation(checkError, 'electricity_tariff_valid_from_unique')).toBe(false)
  expect(isUniqueViolation(new Error('x'), 'electricity_tariff_valid_from_unique')).toBe(false)
  expect(isUniqueViolation(null, 'electricity_tariff_valid_from_unique')).toBe(false)
})

test('pgErrorSummary names the SQLSTATE and constraint only, through drizzle’s wrapper', () => {
  const pg = Object.assign(new Error('duplicate key; Failing row contains (0.123456)'), {
    code: '23505',
    constraint: 'x_pkey',
    detail: 'Failing row contains (0.123456)',
  })
  const drizzle = Object.assign(new Error('Failed query: insert …\nparams: 0.123456'), {
    cause: pg,
  })
  expect(pgErrorSummary(drizzle)).toBe(' (Postgres 23505, x_pkey)')
  expect(pgErrorSummary(Object.assign(new Error('timeout'), { code: '57014' }))).toBe(
    ' (Postgres 57014)',
  )
  expect(pgErrorSummary(new Error('plain'))).toBe('')
  expect(pgErrorSummary(null)).toBe('')
})
