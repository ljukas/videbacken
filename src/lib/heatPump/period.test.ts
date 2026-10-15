import { expect, test } from 'vitest'
import { HEAT_PUMP_DAYS_MAX, monthDays } from './period'

test("a month's first and last day, leap years included", () => {
  expect(monthDays(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  expect(monthDays(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  expect(monthDays(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  expect(HEAT_PUMP_DAYS_MAX).toBe(800)
})
