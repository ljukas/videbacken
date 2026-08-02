import type { SeriesRange } from '~/lib/sensor/range'

// Range-aware x-axis / tooltip-header time label. Client-safe and locale-explicit
// (the caller passes a BCP 47 tag from getIntlLocale()) so it stays a pure
// function the chart ranges can be tested against.
//
// Three levels of precision, each matching its range's bucket width:
//   24h (10-min buckets)  → time of day; the window never repeats an hour.
//   1w  (2-h buckets)     → weekday + time; ~12 points a day would otherwise all
//                           carry the same date, in the tooltip header too.
//   coarser (3h..1 day)   → short date; the time of day is noise at that scale.
export function makeTickFormatter(range: SeriesRange, locale: string): (t: number) => string {
  const options: Intl.DateTimeFormatOptions =
    range === '24h'
      ? { hour: '2-digit', minute: '2-digit' }
      : range === '1w'
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
        : { month: 'short', day: 'numeric' }
  const fmt = new Intl.DateTimeFormat(locale, options)
  return (t: number) => fmt.format(new Date(t))
}
