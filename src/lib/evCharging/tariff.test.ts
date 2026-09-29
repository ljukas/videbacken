import { expect, test } from 'vitest'
import { statutoryEnergyTaxOre } from './tariff'

test('statutory energy tax follows the calendar year of the day', () => {
  expect(statutoryEnergyTaxOre('2025-12-31')).toBe(43.9)
  expect(statutoryEnergyTaxOre('2026-01-01')).toBe(36)
  expect(statutoryEnergyTaxOre('2026-08-01')).toBe(36)
})

test('an unknown year has no default (the admin types it)', () => {
  expect(statutoryEnergyTaxOre('2031-01-01')).toBeUndefined()
})
