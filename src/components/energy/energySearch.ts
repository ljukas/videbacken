import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { type EnergyPeriod, formatPeriod, periodFromSearch } from '~/lib/houseEnergy/period'

// Both Energi pages' search (step 1b). The router JSON-parses search values, so
// `?period=2026` arrives as a number (and a year is written as one, keeping the
// URL unquoted); months and `all` stay strings.
export const energySearchSchema = z.object({
  period: z
    .union([z.string().max(10), z.number()])
    .optional()
    .catch(undefined),
  /** Step-1 links: read as `?period=Y`, dropped on the next write. */
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})
export type EnergySearch = z.infer<typeof energySearchSchema>

export const periodOfSearch = ({ period, year }: EnergySearch) =>
  periodFromSearch({ period: period === undefined ? undefined : String(period), year })

/** The URL value: a year as a number, so the router writes it unquoted. */
export const periodSearchValue = (p: EnergyPeriod) => (p.kind === 'year' ? p.year : formatPeriod(p))

/**
 * Where `?period=` should go (the Energi pages' rule, step 1b). A period the data can't show (a stale link, a year
 * without readings, a legacy ?year=) resolves to the default: once the read for it has settled, the URL follows.
 * Nothing valid asked for (an invalid ?period= or ?year=) is the default already: the URL drops the params.
 * `settled`: the read is in, not a placeholder, and has readings.
 * Returns undefined to leave the URL, null to drop the period params, else the shown period's URL value.
 */
export function periodRewrite(
  search: EnergySearch,
  requested: EnergyPeriod | null,
  shown: EnergyPeriod | null,
  settled: boolean,
): string | number | null | undefined {
  if (!requested) return search.period !== undefined || search.year !== undefined ? null : undefined
  if (!settled || !shown) return undefined
  return formatPeriod(requested) !== formatPeriod(shown) ? periodSearchValue(shown) : undefined
}
