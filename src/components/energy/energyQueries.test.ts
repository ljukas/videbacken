import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import {
  ENERGY_OVERVIEW_STALE_TIME,
  energyOverviewQuery,
  energyOverviewQueryFor,
  energyOverviewQueryYear,
} from './energyQueries'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const keyFor = (p: EnergyPeriod | null) => JSON.stringify(energyOverviewQueryFor(p).queryKey)
const keyOf = (year: number) => JSON.stringify(energyOverviewQuery(year).queryKey)

test.each([
  ['Totalt', { kind: 'all' } as const],
  ['no period', null],
])('%s asks for the current Stockholm year', (_name, p) => {
  expect(energyOverviewQueryYear(p)).toBe(2026)
  expect(keyFor(p)).toBe(keyOf(2026))
})

test('a month of a year and the year itself share one cache entry', () => {
  expect(keyFor({ kind: 'month', year: 2025, month: 3 })).toBe(keyOf(2025))
  expect(keyFor({ kind: 'year', year: 2025 })).toBe(keyOf(2025))
  // The default and a month of this year share one too.
  expect(keyFor({ kind: 'month', year: 2026, month: 9 })).toBe(keyFor(null))
  expect(keyOf(2025)).not.toBe(keyOf(2026))
})

test('the current year is Stockholm’s, not UTC’s', () => {
  // 23:30 UTC on New Year's Eve is 00:30 on 1 January in Stockholm.
  vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
  expect(energyOverviewQueryYear({ kind: 'all' })).toBe(2027)
  expect(keyFor(null)).toBe(keyOf(2027))
})

test('stays fresh for 5 minutes (hourly data)', () => {
  expect(ENERGY_OVERVIEW_STALE_TIME).toBe(300_000)
  expect(energyOverviewQueryFor(null).staleTime).toBe(300_000)
})
