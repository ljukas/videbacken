// Client-safe time copy for alerts (ADR-0028), shared by the Klimat page and the alert email.
import { tz } from '@date-fns/tz'
import { format, isSameYear, type Locale } from 'date-fns'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'

/** "45 min", "2 h", "6 h 30 min", "1 d 3 h": whole minutes rounded down, zero parts left out. */
export function formatAlertDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days} d`)
  if (hours) parts.push(`${hours} h`)
  if (minutes) parts.push(`${minutes} min`)
  return parts.length ? parts.join(' ') : '0 min'
}

/**
 * A day and time in Stockholm: "19 okt. 22:00", with the year ("19 okt. 2025 22:00") when it
 * isn't `now`'s Stockholm year. The locale is passed: the email renders outside any request.
 */
export function formatAlertDayTime(date: Date, locale: Locale, now: Date = new Date()): string {
  const inStockholm = tz(STOCKHOLM_TIME_ZONE)
  const pattern = isSameYear(date, now, { in: inStockholm }) ? 'd MMM HH:mm' : 'd MMM yyyy HH:mm'
  return format(date, pattern, { locale, in: inStockholm })
}
