import { formatDistanceStrict } from 'date-fns'
import { getDateFnsLocale, getIntlLocale } from '~/lib/i18n/format'
import { STOCKHOLM_TIME_ZONE } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'

// Charging data is bucketed in Stockholm time server-side (calendar months,
// Stockholm day boundaries), so every date/time on /charging is rendered in
// that zone too. Pinning the zone also keeps SSR (Vercel runs in UTC) and the
// browser rendering identical strings.

// Formatters are built per call: the locale is per request/render, and a
// module-level formatter would pin the first request's locale (see
// `~/lib/i18n/format`).

// kWh and kW values: always one decimal ("12,4" / "12.4").
export function formatOneDecimal(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(getIntlLocale()).format(n)
}

export function formatThreshold(kwh: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 2 }).format(kwh)
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    timeZone: STOCKHOLM_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

// "fre 5 sep." / "Fri, Sep 5": weekday and day in Stockholm time, no year.
export function formatWeekdayDay(date: Date): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    timeZone: STOCKHOLM_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    timeZone: STOCKHOLM_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    timeZone: STOCKHOLM_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

// "för 5 minuter sedan" / "5 minutes ago". A server timestamp slightly ahead
// of a lagging client clock reads as "just now", never "in 3 seconds".
export function formatAgo(date: Date): string {
  const now = new Date()
  return formatDistanceStrict(date > now ? now : date, now, {
    addSuffix: true,
    locale: getDateFnsLocale(),
  })
}

// Wall-clock length of a session, rounded to whole minutes.
export function formatDuration(startAt: Date, endAt: Date): string {
  const totalMinutes = Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0
    ? m.charging_duration_hours_minutes({ hours, minutes })
    : m.charging_duration_minutes({ minutes })
}

// A sync run's duration: "850 ms" under a second, else seconds with one decimal.
export function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${formatCount(ms)} ms`
  return `${new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(ms / 1000)} s`
}

// Short month labels ("jan.", "feb." / "Jan", "Feb") for 1-based months.
export function monthLabel(month: number): string {
  // Mid-month UTC noon: the same calendar month in every time zone.
  return new Intl.DateTimeFormat(getIntlLocale(), { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 15, 12)),
  )
}

// 2024-01-01 was a Monday — a fixed UTC anchor for weekday names.
export function weekdayLabel(weekday: number, width: 'short' | 'long' = 'short'): string {
  return new Intl.DateTimeFormat(getIntlLocale(), { weekday: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 1 + weekday, 12)),
  )
}

export function hourRangeLabel(hour: number): string {
  const pad = (h: number) => String(h % 24).padStart(2, '0')
  return `${pad(hour)}–${pad(hour + 1)}`
}

export function monthName(month: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 15, 12)),
  )
}

/** A decimal as typed/read back in a form field: no grouping, up to 3 decimals. */
export function formatDecimalInput(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    maximumFractionDigits: 3,
    useGrouping: false,
  }).format(value)
}

/** A decimal for display, up to 3 decimals (tariff limits like 1 000). */
export function formatDecimal(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 3 }).format(value)
}

/** A tariff amount as bills print it: at least 2 decimals (35,60), up to 3 (5,331). */
export function formatTariffAmount(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value)
}

/**
 * A Stockholm calendar day ('YYYY-MM-DD') for display. Formatted in UTC from
 * the day's own UTC midnight, so no time zone can ever shift it a day.
 */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.UTC(y, m - 1, d),
  )
}

/** A kronor amount without its unit (for a readout that sets "kr" apart). */
export function formatKronor(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(getIntlLocale(), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** Kronor for display: whole kronor by default (tiles), or with öre (sessions). */
export function formatSek(value: number, fractionDigits = 0): string {
  // No-break space: the unit never wraps away from its number.
  return `${formatKronor(value, fractionDigits)}\u00a0kr`
}

/**
 * A share (0…1) as a whole percent ("39 %"). A small but real share never
 * rounds to "0 %": it reads "< 1 %".
 */
export function formatShare(share: number): string {
  const percent = new Intl.NumberFormat(getIntlLocale(), {
    style: 'percent',
    maximumFractionDigits: 0,
  })
  return share > 0 && share < 0.005 ? `< ${percent.format(0.01)}` : percent.format(share)
}

/** An average öre/kWh, whole öre (e.g. "159"). */
export function formatOre(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 0 }).format(value)
}
