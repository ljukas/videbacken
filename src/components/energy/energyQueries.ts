import { type EnergyPeriod, periodQueryYear } from '~/lib/houseEnergy/period'
import { orpc } from '~/lib/orpc/client'
import { stockholmYearMonth } from '~/lib/time/stockholm'

/**
 * Fresh for 5 minutes: the readings are hourly. Under the app's 20 s default,
 * stepping back into a year seen a minute ago, refocusing the tab or coming
 * back to the page (the loader's prefetch) would each refetch the year.
 * Focus refetch still applies once it is stale.
 */
export const ENERGY_OVERVIEW_STALE_TIME = 5 * 60_000

// Shared by both Energi pages: one cache entry per year, so switching between
// Översikt and Batteri costs no request (spec "Pages"). Always a concrete year
// (build it with `energyOverviewQueryFor`): the service's "no year" default
// would be a second cache entry for the same data.
export const energyOverviewQuery = (year: number) =>
  orpc.energy.overview.queryOptions({ input: { year }, staleTime: ENERGY_OVERVIEW_STALE_TIME })

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
