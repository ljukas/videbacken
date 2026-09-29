import { expect, test } from 'vitest'
import { parseDecimal } from './parseDecimal'

test.each([
  ['5,331', 5.331],
  ['35.60', 35.6],
  ['36', 36],
  [' 1 000,5 ', 1000.5],
  ['−3', -3],
  ['-0,5', -0.5],
  ['0', 0],
])('parses %j as %d', (input, expected) => {
  expect(parseDecimal(input)).toBe(expected)
})

test.each([
  '',
  'abc',
  '1,2,3',
  '1.2.3',
  ',5',
  '5,',
  '1e3',
  'NaN',
  '--1',
  '12 %',
])('rejects %j', (input) => {
  expect(parseDecimal(input)).toBeNull()
})
