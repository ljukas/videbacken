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

/** A temperature with one decimal ("−2,6 °C"). */
export function formatCelsius(c: number): string {
  return `${formatOneDecimal(c)} °C`
}

/** A right-axis tick ("−5°", "2,5°"). */
export function formatCelsiusTick(c: number): string {
  return `${new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(c)}°`
}

/** A tile's kWh: one decimal under 100 ("42,3 kWh"), whole from 100 ("1 512 kWh"). */
export function formatKwh(kwh: number): string {
  return `${kwh < 100 ? formatOneDecimal(kwh) : formatCount(Math.round(kwh))} kWh`
}
