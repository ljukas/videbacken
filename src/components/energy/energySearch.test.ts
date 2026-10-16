import { expect, test } from 'vitest'
import { periodRewrite } from './energySearch'

const sep = { kind: 'month', year: 2026, month: 9 } as const
const nov = { kind: 'month', year: 2026, month: 11 } as const

test('nothing valid asked for: an invalid ?period= is dropped, an empty search stays', () => {
  expect(periodRewrite({}, null, sep, true)).toBeUndefined()
  expect(periodRewrite({ period: 'junk' }, null, sep, true)).toBeNull()
  expect(periodRewrite({ period: 'junk' }, null, null, false)).toBeNull()
})

test('a period the data can show stays', () => {
  expect(periodRewrite({ period: '2026-09' }, sep, sep, true)).toBeUndefined()
  expect(periodRewrite({ period: 'all' }, { kind: 'all' }, { kind: 'all' }, true)).toBeUndefined()
})

test('a period the data cannot show moves to the shown one once the read has settled', () => {
  expect(periodRewrite({ period: '2026-11' }, nov, sep, true)).toBe('2026-09')
  expect(
    periodRewrite(
      { period: 2024 },
      { kind: 'year', year: 2024 },
      { kind: 'year', year: 2026 },
      true,
    ),
  ).toBe(2026)
})

test('nothing moves while the read is a placeholder or has no readings', () => {
  expect(periodRewrite({ period: '2026-11' }, nov, sep, false)).toBeUndefined()
  expect(periodRewrite({ period: '2026-11' }, nov, null, true)).toBeUndefined()
})
