import { expect, test } from 'vitest'
import { monthGrid } from './calendar'

test('September 2026 starts on a Tuesday and spans 5 week rows', () => {
  const g = monthGrid(2026, 9)
  expect(g).toHaveLength(30)
  expect(g[0]).toEqual({ day: '2026-09-01', date: 1, weekday: 1, week: 0 })
  expect(g.at(-1)).toEqual({ day: '2026-09-30', date: 30, weekday: 2, week: 4 })
})

test('a month starting on Sunday puts day 2 on the next row', () => {
  const g = monthGrid(2026, 3) // 1 March 2026 is a Sunday
  expect(g[0]).toMatchObject({ weekday: 6, week: 0 })
  expect(g[1]).toMatchObject({ weekday: 0, week: 1 })
})

test('the DST month still has every day exactly once', () => {
  expect(monthGrid(2026, 10).map((d) => d.date)).toEqual(
    Array.from({ length: 31 }, (_, i) => i + 1),
  )
})
