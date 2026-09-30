import { expect, test } from 'vitest'
import type { CatalogueEntry } from '~/lib/effects/eltariff'
import { findCoveringEntry, parseFacilityId } from './coverage'

// Synthetic ranges in the catalogue's shape (not real registrations).
const entry = (companyName: string, from: string, to: string): CatalogueEntry => ({
  companyName,
  meteringPointIdFrom: from,
  meteringPointIdTo: to,
  apiUrl: `https://${companyName.toLowerCase()}.example/tariffs`,
})
const catalogue = [
  entry('Alpha', '735999144000000000', '735999144999999999'),
  entry('Beta', '735999199000000001', '735999199999999999'),
]

test('finds the entry whose range contains the facility', () => {
  expect(findCoveringEntry('735999144123456789', catalogue)?.companyName).toBe('Alpha')
})

test('ranges are inclusive at both ends', () => {
  expect(findCoveringEntry('735999199000000001', catalogue)?.companyName).toBe('Beta')
  expect(findCoveringEntry('735999199999999999', catalogue)?.companyName).toBe('Beta')
})

test('an ID just outside every range is not covered', () => {
  expect(findCoveringEntry('735999199000000000', catalogue)).toBeUndefined()
  expect(findCoveringEntry('735999145000000000', catalogue)).toBeUndefined()
})

test('compares exactly beyond Number precision', () => {
  // As Numbers both ends round to the same double, so a float compare would match.
  const narrow = [entry('Gamma', '735999100000000002', '735999100000000003')]
  expect(Number('735999100000000001')).toBe(Number('735999100000000002'))
  expect(findCoveringEntry('735999100000000001', narrow)).toBeUndefined()
  expect(findCoveringEntry('735999100000000002', narrow)?.companyName).toBe('Gamma')
})

test('an empty catalogue covers nothing', () => {
  expect(findCoveringEntry('735999144123456789', [])).toBeUndefined()
})

test('parseFacilityId accepts exactly 18 digits, trimmed', () => {
  expect(parseFacilityId('735999144123456789')).toBe('735999144123456789')
  expect(parseFacilityId(' 735999144123456789\n')).toBe('735999144123456789')
})

test('parseFacilityId fails closed on anything else', () => {
  for (const raw of [
    undefined,
    '',
    '   ',
    '73599914412345678',
    '7359991441234567890',
    '735999144x23456789',
    '-735999144123456789',
  ]) {
    expect(parseFacilityId(raw)).toBeNull()
  }
})
