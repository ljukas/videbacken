import { type Locale as DateFnsLocale, formatDistanceStrict } from 'date-fns'
import { enGB, sv } from 'date-fns/locale'
import { getLocale, type Locale } from '~/paraglide/runtime'

// BCP 47 tags for Intl formatting. UI locale `en` maps to en-GB: dates render
// day-first/ISO-like for a European crew, never US middle-endian.
const INTL_LOCALES: Record<Locale, string> = {
  sv: 'sv-SE',
  en: 'en-GB',
}

const dateFormatters = new Map<Locale, Intl.DateTimeFormat>()

// Locale is resolved per call, not at module scope — a module-level formatter
// would pin the first request's locale for the whole server process.
export function formatDate(date: Date): string {
  const locale = getLocale()
  let formatter = dateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(INTL_LOCALES[locale], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dateFormatters.set(locale, formatter)
  }
  return formatter.format(date)
}

export function getDateFnsLocale(): DateFnsLocale {
  return getLocale() === 'sv' ? sv : enGB
}

// Short, suffix-less distance from now in the active locale — e.g. "6 dagar" /
// "6 days". Used for the invite-expiry countdown ("Går ut om {time}"); the
// caller decides the surrounding phrasing and the expired state.
export function formatDistanceShort(date: Date): string {
  return formatDistanceStrict(date, new Date(), { locale: getDateFnsLocale() })
}
