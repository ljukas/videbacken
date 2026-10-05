import { afterEach, describe, expect, test } from 'vitest'
import { getLocale, overwriteGetLocale } from '~/paraglide/runtime'
import { formatSolarValue, SOLAR_VALUE_MIN_KWH, solarValueView } from './solarValue'

const original = getLocale
afterEach(() => overwriteGetLocale(original))

const totals = (solarPricedKwh: number, solarUnpricedKwh: number, solarValueSek: number) => ({
  solarPricedKwh,
  solarUnpricedKwh,
  solarValueSek,
})

describe('solarValueView', () => {
  test('no solar is hidden', () => {
    expect(solarValueView(totals(0, 0, 0))).toEqual({ kind: 'hidden' })
  })

  test('solar that rounds to 0,0 kWh is hidden, even with a value', () => {
    expect(solarValueView(totals(SOLAR_VALUE_MIN_KWH - 0.01, 0, 0.05))).toEqual({ kind: 'hidden' })
  })

  test('from 0,05 kWh it shows', () => {
    expect(solarValueView(totals(SOLAR_VALUE_MIN_KWH, 0, 0.04))).toEqual({
      kind: 'value',
      sek: 0.04,
      atLeast: false,
    })
  })

  test('fully priced solar is its value', () => {
    expect(solarValueView(totals(300, 0, 212))).toEqual({ kind: 'value', sek: 212, atLeast: false })
  })

  test('battery-only solar still shows: visibility counts solar-origin kWh, not direct solar', () => {
    // A night session from a solar-filled battery: no direct solar, a real value.
    expect(solarValueView(totals(6, 0, 4.62))).toEqual({ kind: 'value', sek: 4.62, atLeast: false })
  })

  test('some solar lacks a price: the value is a floor, "minst"', () => {
    expect(solarValueView(totals(10, 2, 9))).toEqual({ kind: 'value', sek: 9, atLeast: true })
  })

  test('only unpriced solar: the value is unknown, never 0 kr', () => {
    expect(solarValueView(totals(0, 3, 0))).toEqual({ kind: 'unknown' })
  })

  test('a float crumb of unpriced solar is not "minst"', () => {
    expect(solarValueView(totals(10, 1e-9, 9))).toEqual({ kind: 'value', sek: 9, atLeast: false })
  })

  test('a non-finite total is hidden rather than printed', () => {
    expect(solarValueView(totals(Number.NaN, 0, 0))).toEqual({ kind: 'hidden' })
    expect(solarValueView(totals(10, Number.NaN, 9))).toEqual({ kind: 'hidden' })
    expect(solarValueView(totals(10, 0, Number.NaN))).toEqual({ kind: 'hidden' })
    expect(solarValueView(totals(10, 0, Number.POSITIVE_INFINITY))).toEqual({ kind: 'hidden' })
  })

  test('a sliver of unpriced-only solar is hidden, not "okänt"', () => {
    expect(solarValueView(totals(0, SOLAR_VALUE_MIN_KWH - 0.01, 0))).toEqual({ kind: 'hidden' })
  })

  test('the threshold counts priced and unpriced solar together', () => {
    expect(solarValueView(totals(0.03, 0.03, 1))).toEqual({ kind: 'value', sek: 1, atLeast: true })
  })

  test('a priced crumb beside real unpriced solar is still unknown', () => {
    expect(solarValueView(totals(1e-9, 3, 0))).toEqual({ kind: 'unknown' })
  })

  test('unknown ignores whatever value the crumbs carry', () => {
    expect(solarValueView(totals(0, 3, 5))).toEqual({ kind: 'unknown' })
  })

  test('a negative value passes through with its sign (exporting would have cost money)', () => {
    expect(solarValueView(totals(10, 0, -3))).toEqual({ kind: 'value', sek: -3, atLeast: false })
  })
})

describe('formatSolarValue', () => {
  test('whole kronor by default, the unit joined by a no-break space', () => {
    expect(formatSolarValue({ kind: 'value', sek: 212.4, atLeast: false })).toBe('212 kr')
  })

  test('two decimals for a session', () => {
    expect(formatSolarValue({ kind: 'value', sek: 4.62, atLeast: false }, 2)).toBe('4,62 kr')
  })

  test('"minst" when part of the solar lacks a price', () => {
    expect(formatSolarValue({ kind: 'value', sek: 212, atLeast: true })).toBe('minst 212 kr')
  })

  test('a negative value keeps its sign; a tiny negative is 0 kr, never −0 kr', () => {
    expect(formatSolarValue({ kind: 'value', sek: -3.4, atLeast: false })).toBe('−3 kr')
    expect(formatSolarValue({ kind: 'value', sek: -0.2, atLeast: false })).toBe('0 kr')
  })

  test('a floor can be negative: "minst −3 kr"', () => {
    expect(formatSolarValue({ kind: 'value', sek: -3, atLeast: true })).toBe('minst −3 kr')
  })

  test('follows the UI locale', () => {
    overwriteGetLocale(() => 'en')
    expect(formatSolarValue({ kind: 'value', sek: 1234.5, atLeast: true }, 2)).toBe(
      'at least 1,234.50 kr',
    )
    expect(formatSolarValue({ kind: 'value', sek: -3.4, atLeast: false })).toBe('−3 kr')
  })
})
