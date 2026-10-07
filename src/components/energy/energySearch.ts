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
