import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { electricityTariff, heatPumpEvent } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { isForeignKeyViolation, isUniqueViolation, pgErrorSummary } from './pgError'

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

test('recognises a real foreign-key violation on the named constraint only', async () => {
  const error = await db
    .insert(heatPumpEvent)
    .values({
      occurredOn: '2026-10-08',
      heatPumpId: '00000000-0000-4000-8000-000000000000',
      kind: 'service',
    })
    .then(() => null)
    .catch((e: unknown) => e)

  expect(isForeignKeyViolation(error, 'heat_pump_event_heat_pump_id_heat_pump_id_fk')).toBe(true)
  expect(isForeignKeyViolation(error, 'some_other_fk')).toBe(false)
  // The same constraint name under the unique-violation SQLSTATE is not a match.
  expect(isUniqueViolation(error, 'heat_pump_event_heat_pump_id_heat_pump_id_fk')).toBe(false)
  expect(isForeignKeyViolation(null, 'heat_pump_event_heat_pump_id_heat_pump_id_fk')).toBe(false)
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

test('pgErrorSummary stops at depth 3 and omits a non-string constraint', () => {
  const deep = { cause: { cause: { cause: { code: '23505' } } } }
  expect(pgErrorSummary(deep)).toBe('')
  const shallow = { cause: { cause: { code: '23505', constraint: 42 } } }
  expect(pgErrorSummary(shallow)).toBe(' (Postgres 23505)')
})
