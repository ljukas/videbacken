import { type EnergyPeriod, periodQueryYear } from '~/lib/houseEnergy/period'
import { orpc } from '~/lib/orpc/client'
import { stockholmYearMonth } from '~/lib/time/stockholm'

// Shared by both Energi pages: one cache entry per year, so switching between
// Översikt and Batteri costs no request (spec "Pages").
export const energyOverviewQuery = (year: number | undefined) =>
  orpc.energy.overview.queryOptions({ input: { year } })

/**
 * The overview year a period asks for: its own, else (Totalt, the default) the
 * current Stockholm year, the one the service would pick for no year. Always
 * concrete, so the default and a month of this year share one cache entry: a
 * month switch inside a year costs no request.
 */
export const energyOverviewQueryYear = (period: EnergyPeriod | null): number =>
  periodQueryYear(period) ?? stockholmYearMonth(Date.now()).year

/** The overview query for a period: every Energi page builds its key this way. */
export const energyOverviewQueryFor = (period: EnergyPeriod | null) =>
  energyOverviewQuery(energyOverviewQueryYear(period))
