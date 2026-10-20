import { expect, test } from 'vitest'
import { formatAlertDuration } from './alertTime'

const min = 60_000

test('formats whole minutes, hours and days, leaving zero parts out', () => {
  expect(formatAlertDuration(0)).toBe('0 min')
  expect(formatAlertDuration(59_999)).toBe('0 min')
  expect(formatAlertDuration(45 * min)).toBe('45 min')
  expect(formatAlertDuration(120 * min)).toBe('2 h')
  expect(formatAlertDuration(390 * min)).toBe('6 h 30 min')
  expect(formatAlertDuration(27 * 60 * min)).toBe('1 d 3 h')
})
