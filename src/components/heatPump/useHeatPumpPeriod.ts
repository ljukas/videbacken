import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type EnergySearch,
  periodOfSearch,
  periodRewrite,
  periodSearchValue,
} from '~/components/energy/energySearch'
import type { EnergySearchWrite } from '~/components/energy/useEnergyPeriod'
import { firstLoadPending, loadFailed } from '~/components/layout/LoadErrorAlert'
import { monthDays } from '~/lib/heatPump/period'
import {
  type EnergyPeriod,
  formatPeriod,
  parsePeriod,
  resolvePeriod,
} from '~/lib/houseEnergy/period'
import { stockholmDayOf, stockholmYearMonth } from '~/lib/time/stockholm'
import { heatPumpDaysQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'
import { heatPumpView } from './heatPumpView'

const ALL: EnergyPeriod = { kind: 'all' }

// The Värmepumpar page's state (heat pumps step 3), on the Energi pages' rules (useEnergyPeriod): the requested
// period, the months read (one cache entry per year, or the history for Totalt), the days read for a month, the
// period shown, the view built from them, and the URL rewrite of a period the data can't show. While another read
// loads, the last view stays, dimmed; a failed read blanks it under its alert (ADR-0016).
/** `writeSearch` must be referentially stable (wrap it in `useCallback`). */
export function useHeatPumpPeriod(search: EnergySearch, writeSearch: EnergySearchWrite) {
  const requested = periodOfSearch(search)
  // Nothing asked for: the default resolves from the months read and can be Totalt (no readings in the current year
  // yet: a new year's first hours, a stall over New Year, the integration off), which only the history read answers.
  // Once a read resolves the default to Totalt, read the history, as `?period=all` would; the URL stays.
  const [defaultAll, setDefaultAll] = useState(false)
  // Hourly data, synced every six hours: focus refetch only, no polling (ADR-0018).
  const monthsResult = useQuery({
    ...heatPumpMonthsQueryFor(requested ?? (defaultAll ? ALL : null)),
    placeholderData: keepPreviousData,
  })
  const failed = loadFailed(monthsResult)
  const months = monthsResult.data && !failed ? monthsResult.data : undefined
  const stale = monthsResult.isPlaceholderData
  // The last months read with readings: keeps the card and its period control through a failed read of another year.
  const [lastShown, setLastShown] = useState(months)
  if (months && months.firstReadingDay !== null && months !== lastShown) setLastShown(months)
  const shown = months ?? lastShown
  // Read during render on the server and the client alike (see useEnergyPeriod).
  const now = stockholmYearMonth(Date.now())
  const today = stockholmDayOf(Date.now())
  const period = shown ? resolvePeriod(requested, shown.monthsWithReadings, now) : null
  const wantsAll = requested === null && period?.kind === 'all'
  if (shown && wantsAll !== defaultAll) setDefaultAll(wantsAll)
  const periodKey = period ? formatPeriod(period) : null
  const setPeriod = useCallback(
    (p: EnergyPeriod) => writeSearch({ period: periodSearchValue(p) }),
    [writeSearch],
  )
  const monthPeriod = period?.kind === 'month' ? period : null
  const daysResult = useQuery({
    ...heatPumpDaysQuery(
      monthPeriod ? monthDays(monthPeriod.year, monthPeriod.month) : monthDays(now.year, now.month),
    ),
    enabled: monthPeriod !== null,
    placeholderData: keepPreviousData,
  })
  const isMonth = monthPeriod !== null
  const daysFailed = isMonth && loadFailed(daysResult)
  const days =
    isMonth && daysResult.data && !daysResult.isPlaceholderData && !daysFailed
      ? daysResult.data
      : null
  // Memoised on the period's key: a new object every render would loop the "last view" state below.
  const current = useMemo(() => {
    const p = periodKey === null ? null : parsePeriod(periodKey)
    return months && !stale && p
      ? heatPumpView({ months, days, period: p, now: { year: now.year, month: now.month }, today })
      : null
  }, [months, stale, days, periodKey, now.year, now.month, today])
  const [lastView, setLastView] = useState(current)
  if (current && current !== lastView) setLastView(current)
  const view = failed || daysFailed ? null : (current ?? lastView)
  const waiting = current === null && lastView !== null && !failed && !daysFailed
  const rewriteTo = periodRewrite(
    search,
    requested,
    period,
    Boolean(months && !stale && months.firstReadingDay !== null),
  )
  useEffect(() => {
    if (rewriteTo === undefined) return
    writeSearch(rewriteTo === null ? {} : { period: rewriteTo })
  }, [rewriteTo, writeSearch])
  return {
    monthsResult,
    daysResult,
    months,
    shown,
    period,
    setPeriod,
    now,
    view,
    /** The card's body is the last view (another read is loading) or blank under an alert. */
    dimmed: waiting || failed || daysFailed,
    /** aria-busy: another read is loading (not a failure). */
    busy: waiting,
    /** Nothing to show yet and nothing failed: the section's skeleton. One-way per key (see SectionSkeleton). */
    pending:
      firstLoadPending(monthsResult) ||
      (stale && !failed && lastView === null) ||
      (isMonth && firstLoadPending(daysResult) && lastView === null),
  }
}
