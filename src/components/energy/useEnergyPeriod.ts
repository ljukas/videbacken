import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { firstLoadPending, loadFailed } from '~/components/layout/LoadErrorAlert'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { type EnergyPeriod, formatPeriod, resolvePeriod } from '~/lib/houseEnergy/period'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { energyOverviewQueryFor } from './energyQueries'
import { type EnergySearch, periodOfSearch, periodSearchValue } from './energySearch'

export type EnergySearchWrite = (search: { period?: string | number }) => void

// The Energi pages' shared state (steps 1b and 2): the requested period, the
// overview read (one cache entry per year, shared by both pages), the period
// shown, its sums with the stale/failed rules, and the URL rewrite of a period
// the data can't show. Moved from energy/index.tsx unchanged.
export function useEnergyPeriod(search: EnergySearch, writeSearch: EnergySearchWrite) {
  const requested = periodOfSearch(search)
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({
    ...energyOverviewQueryFor(requested),
    placeholderData: keepPreviousData,
  })
  const { data, isPlaceholderData: stale } = result
  const failed = loadFailed(result)
  // Placeholder data counts as data (the old year, dimmed); a failed read doesn't.
  const overview = data && !failed ? data : undefined
  // Nothing to show yet and nothing failed: the sections' skeletons.
  const pending = firstLoadPending(result)
  // The last overview with readings that the page showed. A failed read of
  // another year drops the placeholder: this keeps the tiles card and its
  // period control, so the user can step back. Set during render: React's
  // pattern for state derived from a changing value.
  const [lastShown, setLastShown] = useState(overview)
  if (overview && overview.firstReadingDay !== null && overview !== lastShown) {
    setLastShown(overview)
  }
  const tiles = overview ?? lastShown
  // The server render and the hydrating one read the clock independently:
  // they disagree only for a request straddling a Stockholm month (or year)
  // boundary, which re-renders with the client's month.
  const now = stockholmYearMonth(Date.now())
  // `monthsWithReadings` spans every year, so the placeholder (the old year)
  // already resolves a month of the year that is loading.
  const period = tiles ? resolvePeriod(requested, tiles.monthsWithReadings, now) : null
  // Writing `period` drops a legacy `?year=`.
  const setPeriod = useCallback(
    (p: EnergyPeriod) => writeSearch({ period: periodSearchValue(p) }),
    [writeSearch],
  )
  const periodSums =
    !tiles || !period
      ? null
      : period.kind === 'all'
        ? tiles.allTime
        : period.kind === 'year'
          ? tiles.yearTotal
          : period.year === tiles.year
            ? tiles.months[period.month - 1]
            : null
  // While another year loads, the placeholder can't answer for a month or the
  // year of the new year: keep the figures the card showed last, dimmed with
  // the chart. All time doesn't depend on the year, so Totalt shows at once.
  // A failed read blanks the figures under the alert: the last ones would sit
  // under the new period's label, "no data" would be a false empty claim
  // (ADR-0016).
  const [lastSums, setLastSums] = useState<PeriodSums | null>(periodSums)
  if (!stale && !failed && periodSums !== lastSums) setLastSums(periodSums)
  const sumsStale = stale && period?.kind !== 'all'
  const sums: PeriodSums | null | 'unavailable' = failed
    ? 'unavailable'
    : sumsStale
      ? lastSums
      : periodSums
  // A period the data can't show (a stale link, a year without readings, a
  // legacy ?year=) resolves to the default: once its year's data is in, the URL
  // follows, so the query (and the chart) move to the shown period's year.
  // Nothing valid requested (an invalid ?period= or ?year=) is the default
  // already: the URL goes back to a bare /energy.
  // undefined: the URL stays; null: back to a bare /energy; else the period.
  const rewriteTo: string | number | null | undefined = requested
    ? overview && !stale && overview.firstReadingDay !== null && period
      ? formatPeriod(requested) !== formatPeriod(period)
        ? periodSearchValue(period)
        : undefined
      : undefined
    : search.period !== undefined || search.year !== undefined
      ? null
      : undefined
  useEffect(() => {
    if (rewriteTo === undefined) return
    writeSearch(rewriteTo === null ? {} : { period: rewriteTo })
  }, [rewriteTo, writeSearch])
  return {
    result,
    overview,
    tiles,
    period,
    setPeriod,
    now,
    sums,
    /** The period's figures are the last ones shown while another year loads, or a failed read's blank. */
    sumsDimmed: sumsStale || failed,
    sumsStale,
    stale,
    failed,
    pending,
  }
}
