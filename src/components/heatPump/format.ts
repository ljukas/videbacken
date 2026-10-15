// src/components/heatPump/format.ts
import { formatCount, formatOneDecimal } from '~/components/evCharging/format'
import { getIntlLocale } from '~/lib/i18n/format'

/** A change as a signed whole percent ("−19 %", "+25 %"); one that rounds to zero reads "0 %", never "−0 %". */
export function formatChange(change: number): string {
  const rounded = Math.round(change * 100) / 100
  return new Intl.NumberFormat(getIntlLocale(), {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(rounded === 0 ? 0 : rounded)
}

// A value Intl rounds to zero at one decimal (|c| < 0,05; Intl rounds half away from zero) is passed as +0, so
// −0,04 reads "0,0", never "−0,0". Not Intl's `signDisplay: 'negative'`: engines before Intl.NumberFormat v3
// (Firefox 115 ESR) throw on it.
const zeroIfRoundsToZero = (c: number) => (Math.abs(c) < 0.05 ? 0 : c)

/** A temperature with one decimal ("−2,6 °C"). */
export function formatCelsius(c: number): string {
  return `${formatOneDecimal(zeroIfRoundsToZero(c))} °C`
}

/** A right-axis tick ("−5°", "2,5°"). */
export function formatCelsiusTick(c: number): string {
  const n = new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(
    zeroIfRoundsToZero(c),
  )
  return `${n}°`
}

/** kWh with one decimal ("42,3 kWh"), a no-break space before the unit (as Översikt). */
export function formatKwhOneDecimal(kwh: number): string {
  return `${formatOneDecimal(kwh)} kWh`
}

/** A tile's kWh: one decimal under 100 ("42,3 kWh"), whole from 100 ("1 512 kWh"); a no-break space before the unit. */
export function formatKwh(kwh: number): string {
  return kwh < 100 ? formatKwhOneDecimal(kwh) : `${formatCount(Math.round(kwh))} kWh`
}
