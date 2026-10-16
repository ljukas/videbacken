import { monthDays } from '~/lib/heatPump/period'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { orpc } from '~/lib/orpc/client'
import { stockholmYearMonth } from '~/lib/time/stockholm'

/** Fresh for 5 minutes, as the Energi overview (the sync runs every six hours; focus refetch still applies, ADR-0018). */
export const HEAT_PUMP_STALE_TIME = 5 * 60_000

/** A year's months and the year before; `undefined`: the whole history (Totalt). */
export const heatPumpMonthsQuery = (year: number | undefined) =>
  orpc.heatPump.months.queryOptions({
    input: year === undefined ? {} : { year },
    staleTime: HEAT_PUMP_STALE_TIME,
  })

/**
 * A month or a year asks for its year, Totalt for the history, no period (the default) for the current Stockholm
 * year, so the default and any month of this year share one cache entry.
 */
export const heatPumpMonthsQueryFor = (period: EnergyPeriod | null) =>
  heatPumpMonthsQuery(
    period?.kind === 'all' ? undefined : (period?.year ?? stockholmYearMonth(Date.now()).year),
  )

export const heatPumpDaysQuery = (range: { from: string; to: string }) =>
  orpc.heatPump.days.queryOptions({ input: range, staleTime: HEAT_PUMP_STALE_TIME })

/** A month's days; null for a year or Totalt (no day chart). */
export const heatPumpDaysQueryFor = (period: EnergyPeriod | null) =>
  period?.kind === 'month' ? heatPumpDaysQuery(monthDays(period.year, period.month)) : null

/**
 * Every logged event, newest first (step 4a). Its key sits under `orpc.heatPump.events.key()`, the prefix the event
 * dialogs invalidate after a write.
 */
export const heatPumpEventsQuery = orpc.heatPump.events.list.queryOptions({
  staleTime: HEAT_PUMP_STALE_TIME,
})
