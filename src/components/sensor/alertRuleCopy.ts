import { getIntlLocale } from '~/lib/i18n/format'
import { alertSpanMinutes } from '~/lib/sensor/alertGroups'
import type { SensorAlertDirection, SensorAlertKind, SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'

// The alert rules' copy (ADR-0028): kind and direction labels, a rule's one-line description and
// the "I rad" hint. Formatters are built per call: the locale is per request/render.

export function alertKindLabel(kind: SensorAlertKind): string {
  switch (kind) {
    case 'temperature':
      return m.sensors_alert_kind_temperature()
    case 'humidity':
      return m.sensors_alert_kind_humidity()
    case 'battery':
      return m.sensors_alert_kind_battery()
    case 'silence':
      return m.sensors_alert_kind_silence()
  }
}

export function alertDirectionLabel(direction: SensorAlertDirection): string {
  return direction === 'below'
    ? m.sensors_alert_direction_below()
    : m.sensors_alert_direction_above()
}

/** A limit for display: "4,5", "−3", "80" (Swedish decimal comma and minus in sv). */
export function formatAlertNumber(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(value)
}

/** A limit as a form field's starting text: no grouping, so `parseDecimal` reads it back. */
export function formatAlertInput(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(value)
}

/** "Temperatur under 4,5 °C · 2 mätningar", "Tyst i 6 h". */
export function alertRuleDescription(rule: SensorAlertRuleDto): string {
  const threshold = formatAlertNumber(rule.threshold ?? 0)
  const count = String(rule.count ?? 0)
  const above = rule.direction === 'above'
  switch (rule.kind) {
    case 'temperature':
      return above
        ? m.sensors_alert_desc_temperature_above({ threshold, count })
        : m.sensors_alert_desc_temperature_below({ threshold, count })
    case 'humidity':
      return above
        ? m.sensors_alert_desc_humidity_above({ threshold, count })
        : m.sensors_alert_desc_humidity_below({ threshold, count })
    case 'battery':
      return m.sensors_alert_desc_battery({ threshold, count })
    case 'silence':
      return m.sensors_alert_desc_silence({ hours: String(rule.silenceHours ?? 0) })
  }
}

/**
 * What `count` readings in a row mean for this sensor: "≈ 2–4 timmar för Förråd". Both ends in
 * minutes while the longer end is under two hours ("≈ 30–60 min", not "≈ 1 timme"), else both in
 * whole hours (the shorter at least 1); ends that round alike are one number. Null without a
 * typical gap.
 */
export function alertCountHint(count: number, gapMinutes: number | null, name: string) {
  if (gapMinutes === null || gapMinutes <= 0) return null
  const { lowMin, highMin } = alertSpanMinutes(count, gapMinutes)
  // A positive gap keeps the ends apart in minutes; only rounding to hours can merge them.
  if (highMin < 120) {
    return m.sensors_alert_count_hint_minutes({ low: String(lowMin), high: String(highMin), name })
  }
  const low = Math.max(1, Math.round(lowMin / 60))
  const high = Math.max(low, Math.round(highMin / 60))
  return low === high
    ? m.sensors_alert_count_hint_hours_single({ value: String(low), name })
    : m.sensors_alert_count_hint_hours({ low: String(low), high: String(high), name })
}
