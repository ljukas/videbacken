import { enGB, sv } from 'date-fns/locale'
import { expect, test } from 'vitest'
import { formatAlertDayTime, formatAlertDuration } from './alertTime'

const min = 60_000

test('formats whole minutes, hours and days, leaving zero parts out', () => {
  expect(formatAlertDuration(0)).toBe('0 min')
  expect(formatAlertDuration(59_999)).toBe('0 min')
  expect(formatAlertDuration(45 * min)).toBe('45 min')
  expect(formatAlertDuration(120 * min)).toBe('2 h')
  expect(formatAlertDuration(390 * min)).toBe('6 h 30 min')
  expect(formatAlertDuration(27 * 60 * min)).toBe('1 d 3 h')
})

// 12:00 in Stockholm (CEST): the machine's own zone (Stockholm locally, UTC in CI) plays no part.
const NOW = new Date('2026-10-20T10:00:00Z')

test('a day and time in Stockholm, with the year only outside the current Stockholm year', () => {
  expect(formatAlertDayTime(new Date('2026-10-19T20:00:00Z'), sv, NOW)).toBe('19 okt. 22:00')
  expect(formatAlertDayTime(new Date('2025-10-19T20:00:00Z'), sv, NOW)).toBe('19 okt. 2025 22:00')
  expect(formatAlertDayTime(new Date('2025-10-19T20:00:00Z'), enGB, NOW)).toBe('19 Oct 2025 22:00')
  // 00:30 on 1 January in Stockholm is the new year, though it is still the old one in UTC.
  const newYear = new Date('2027-01-01T10:00:00Z')
  expect(formatAlertDayTime(new Date('2026-12-31T23:30:00Z'), sv, newYear)).toBe('1 jan. 00:30')
  expect(formatAlertDayTime(new Date('2026-12-31T22:30:00Z'), sv, newYear)).toBe(
    '31 dec. 2026 23:30',
  )
})
