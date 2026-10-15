// src/components/heatPump/format.test.ts
import { afterEach, expect, test, vi } from 'vitest'
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
  // A no-break space before the unit, as Översikt: "1 512" and "kWh" never wrap apart.
  expect(formatKwh(42.26)).toBe('42,3\u00a0kWh')
  expect(formatKwh(1512.4)).toMatch(/^1\s512\u00a0kWh$/)
})

test('a temperature that rounds to zero reads 0, never −0', () => {
  expect(formatCelsius(-0.04)).toMatch(/^0,0\s°C$/)
  expect(formatCelsius(-0.05)).toMatch(/^−0,1\s°C$/)
  expect(formatCelsiusTick(-0.04)).toBe('0°')
  expect(formatCelsiusTick(-0)).toBe('0°')
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("temperatures format on engines without Intl's signDisplay 'negative' (Firefox 115 ESR)", () => {
  const Real = Intl.NumberFormat
  // An engine without Intl.NumberFormat v3: `new` on a class whose constructor throws on the option.
  class OldEngineNumberFormat extends Real {
    constructor(locale?: string | string[], options?: Intl.NumberFormatOptions) {
      if ((options?.signDisplay as string) === 'negative') throw new RangeError('signDisplay')
      super(locale, options)
    }
  }
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(
    OldEngineNumberFormat as unknown as typeof Intl.NumberFormat,
  )
  expect(formatCelsius(-2.6)).toMatch(/^−2,6\s°C$/)
  expect(formatCelsius(-0.04)).toMatch(/^0,0\s°C$/)
  expect(formatCelsius(-2.65)).toMatch(/^−2,7\s°C$/) // Intl's own rounding, unchanged
  expect(formatCelsiusTick(-5)).toBe('−5°')
  expect(formatCelsiusTick(-0.04)).toBe('0°')
})
