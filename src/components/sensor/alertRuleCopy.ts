import { tz } from '@date-fns/tz'
import { format, isSameDay } from 'date-fns'
import { getDateFnsLocale, getIntlLocale } from '~/lib/i18n/format'
import { alertSpanMinutes } from '~/lib/sensor/alertGroups'
import type {
  SensorAlertDirection,
  SensorAlertEndReason,
  SensorAlertEventDto,
  SensorAlertKind,
  SensorAlertRuleDto,
} from '~/lib/sensor/alerts'
import { formatAlertDayTime, formatAlertDuration } from '~/lib/sensor/alertTime'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'

// The alert rules' copy (ADR-0028): kind and direction labels, a rule's one-line description and
// the "I rad" hint, and the alert times (Stockholm). Formatters are built per call: the locale is per request/render.

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

/** "Temperatur under 4,5 °C · 2 mätningar", "Tyst i 6 h". A history entry describes its rule as it was. */
export function alertRuleDescription(
  rule: Pick<SensorAlertRuleDto, 'kind' | 'direction' | 'threshold' | 'count' | 'silenceHours'>,
): string {
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

const inStockholm = () => ({ in: tz(STOCKHOLM_TIME_ZONE) })

function formatAlertTime(date: Date): string {
  return format(date, 'HH:mm', inStockholm())
}

/**
 * When a firing alert started: "03:10" on today's Stockholm date, else "19 okt. 22:00" (with
 * the year outside the current one).
 */
export function formatAlertSince(date: Date, now: Date = new Date()): string {
  return isSameDay(date, now, inStockholm())
    ? formatAlertTime(date)
    : formatAlertDayTime(date, getDateFnsLocale(), now)
}

function endReasonLabel(reason: Exclude<SensorAlertEndReason, 'recovered'>): string {
  switch (reason) {
    case 'paused':
      return m.sensors_alert_history_ended_paused()
    case 'edited':
      return m.sensors_alert_history_ended_edited()
    case 'deleted':
      return m.sensors_alert_history_ended_deleted()
  }
}

/** A history entry's period, piece by piece (the page keeps each piece on one line). */
export type AlertEventPeriodParts = {
  /** "19 okt. 22:00" (with the year outside the current one). */
  start: string
  /** The end's time, its day too when it is another Stockholm day; null while open. */
  end: string | null
  /** "1 h 30 min"; null while open. */
  duration: string | null
  /** Why an end that wasn't a recovery ended (no recovery email went out); else null. */
  reason: string | null
}

export function alertEventPeriodParts(
  event: Pick<SensorAlertEventDto, 'startedAt' | 'endedAt' | 'endReason'>,
  now: Date = new Date(),
): AlertEventPeriodParts {
  const locale = getDateFnsLocale()
  const start = formatAlertDayTime(event.startedAt, locale, now)
  if (event.endedAt === null) return { start, end: null, duration: null, reason: null }
  return {
    start,
    end: isSameDay(event.startedAt, event.endedAt, inStockholm())
      ? formatAlertTime(event.endedAt)
      : formatAlertDayTime(event.endedAt, locale, now),
    duration: formatAlertDuration(event.endedAt.getTime() - event.startedAt.getTime()),
    reason:
      event.endReason === null || event.endReason === 'recovered'
        ? null
        : endReasonLabel(event.endReason),
  }
}

/**
 * A history entry's period as one string: "19 okt. 22:00 – 23:30 · 1 h 30 min" (the end's day
 * only when it is another Stockholm day), "19 okt. 22:00 – pågår" while open, and
 * "· avslutat (ändrat)" after an end that wasn't a recovery.
 */
export function alertEventPeriod(
  event: Pick<SensorAlertEventDto, 'startedAt' | 'endedAt' | 'endReason'>,
  now: Date = new Date(),
): string {
  const { start, end, duration, reason } = alertEventPeriodParts(event, now)
  if (end === null || duration === null) return m.sensors_alert_history_ongoing({ start })
  const period = m.sensors_alert_history_period({ start, end, duration })
  return reason === null ? period : `${period} · ${reason}`
}
