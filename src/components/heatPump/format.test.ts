// src/components/heatPump/format.test.ts
import { expect, test } from 'vitest'
import { formatCelsius, formatCelsiusTick, formatChange, formatKwh } from './format'

test('a change is a signed whole percent; one that rounds to zero has no sign', () => {
  expect(formatChange(-0.190476)).toMatch(/^−19\s%$/)
  expect(formatChange(0.25)).toMatch(/^\+25\s%$/)
  expect(formatChange(0.001)).toMatch(/^0\s%$/)
  expect(formatChange(-0.001)).toMatch(/^0\s%$/)
})

test('temperatures and kWh', () => {
  expect(formatCelsius(-2.6)).toMatch(/^−2,6\s°C$/)
  expect(formatCelsius(3)).toMatch(/^3,0\s°C$/)
  expect(formatCelsiusTick(-5)).toBe('−5°')
  expect(formatCelsiusTick(2.5)).toBe('2,5°')
  expect(formatKwh(42.26)).toBe('42,3 kWh')
  expect(formatKwh(1512.4)).toMatch(/^1\s512 kWh$/)
})
