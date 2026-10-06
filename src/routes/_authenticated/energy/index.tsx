import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SunIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { z } from 'zod'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import {
  type EnergyMetric,
  EnergyMonthlyChart,
  energyMetricOptions,
} from '~/components/energy/EnergyMonthlyChart'
import { EnergyReadouts } from '~/components/energy/EnergyTiles'
import { energyOverviewQueryFor } from '~/components/energy/energyQueries'
import { PeriodControl, periodLabel } from '~/components/energy/PeriodControl'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import {
  type EnergyPeriod,
  formatPeriod,
  periodFromSearch,
  resolvePeriod,
} from '~/lib/houseEnergy/period'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// The router JSON-parses search values, so `?period=2026` arrives as a number
// (and a year is written as one, keeping the URL unquoted); months and `all`
// stay strings.
const searchSchema = z.object({
  period: z
    .union([z.string().max(10), z.number()])
    .optional()
    .catch(undefined),
  /** Step-1 links: read as `?period=Y`, dropped on the next write. */
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

const periodOf = ({ period, year }: z.infer<typeof searchSchema>) =>
  periodFromSearch({ period: period === undefined ? undefined : String(period), year })

/** The URL value: a year as a number, so the router writes it unquoted. */
const searchValue = (p: EnergyPeriod) => (p.kind === 'year' ? p.year : formatPeriod(p))

export const Route = createFileRoute('/_authenticated/energy/')({
  head: () => ({
    meta: seo({ title: m.meta_energy_title(), description: m.meta_energy_description() }),
  }),
  validateSearch: searchSchema,
  // ADR-0025: awaited on the server only (both are above the fold, so both are
  // critical); a client navigation awaits nothing and the sections show their
  // skeletons. A failed read shows its own alert under a working heading.
  // The period's year is deliberately not a loader dep: a dep change blocks the
  // navigation on this loader, freezing the old chart with no feedback. Read
  // here, it still loads the year a URL asks for (SSR, a shared link); a year
  // switch is the page's own query, whose old figures stay, dimmed, until the
  // new year lands. Parsed with the route's own fallbacks.
  loader: ({ context: { queryClient }, location }) => {
    const period = periodOf(searchSchema.parse(location.search))
    return loadRouteData(queryClient, {
      critical: [energyOverviewQueryFor(period), syncHealthQuery],
    })
  },
  component: EnergyOverviewPage,
})

function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Every source's health (one read); this page shows Emaldo's. Not suspending:
  // a client navigation doesn't wait for it (ADR-0025 §3).
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.emaldo
  const search = Route.useSearch()
  const requested = periodOf(search)
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
  const navigate = Route.useNavigate()
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()
  const tilesHeadingId = useId()
  // The server render and the hydrating one read the clock independently:
  // they disagree only for a request straddling a Stockholm month (or year)
  // boundary, which re-renders with the client's month.
  const now = stockholmYearMonth(Date.now())
  // `monthsWithReadings` spans every year, so the placeholder (the old year)
  // already resolves a month of the year that is loading.
  const period = tiles ? resolvePeriod(requested, tiles.monthsWithReadings, now) : null
  // Writing `period` drops a legacy `?year=`.
  const setPeriod = useCallback(
    (p: EnergyPeriod) =>
      navigate({ to: '.', search: { period: searchValue(p) }, replace: true, resetScroll: false }),
    [navigate],
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
  const tilesStale = stale && period?.kind !== 'all'
  const tileSums = failed ? 'unavailable' : tilesStale ? lastSums : periodSums
  // A period the data can't show (a stale link, a year without readings, a
  // legacy ?year=) resolves to the default: once its year's data is in, the URL
  // follows, so the query (and the chart) move to the shown period's year.
  // Nothing valid requested (an invalid ?period= or ?year=) is the default
  // already: the URL goes back to a bare /energy.
  // undefined: the URL stays; null: back to a bare /energy; else the period.
  const rewriteTo: string | number | null | undefined = requested
    ? overview && !stale && overview.firstReadingDay !== null && period
      ? formatPeriod(requested) !== formatPeriod(period)
        ? searchValue(period)
        : undefined
      : undefined
    : search.period !== undefined || search.year !== undefined
      ? null
      : undefined
  useEffect(() => {
    if (rewriteTo === undefined) return
    void navigate({
      to: '.',
      search: rewriteTo === null ? {} : { period: rewriteTo },
      replace: true,
      resetScroll: false,
    })
  }, [rewriteTo, navigate])

  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health?.lastSuccessAt} />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('emaldo')}
          retrying={syncNow.isPendingFor('emaldo')}
        />
      ) : null}
      {/* A skeleton is not an empty state (ADR-0016): only data says there are
          no readings. */}
      {overview?.firstReadingDay === null ? (
        <Empty className="brand-wash rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SunIcon />
            </EmptyMedia>
            <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // The same element whatever the state, so the server HTML and the first
        // client render agree (the skeletons and the alert appear only once
        // hydrated). A failed read leaves the alert in it, below the last tiles
        // card (and its period control) once the page has shown a year.
        <div className="flex flex-col gap-4">
          <SectionSkeleton name="energy-tiles" loading={pending} fallbackHeight="12rem">
            {tiles && period ? (
              <section aria-labelledby={tilesHeadingId}>
                <Card>
                  {/* As tall for every period: the control's label cell is as
                      wide as its widest label, its buttons a fixed 40 px. */}
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id={tilesHeadingId} className="font-semibold text-lg">
                      {m.energy_tiles_heading()}
                    </h2>
                    <PeriodControl
                      period={period}
                      monthsWithReadings={tiles.monthsWithReadings}
                      current={now}
                      onChange={setPeriod}
                    />
                  </CardHeader>
                  {/* Announces each period change (the label sits inside a
                      button, which screen readers don't re-read). Outside the
                      busy figures, so it isn't held back while a year loads. */}
                  <p data-slot="period-announcement" aria-live="polite" className="sr-only">
                    {periodLabel(period, now)}
                  </p>
                  {/* The control stays live while a year loads: only the figures dim. */}
                  <CardContent
                    className={cn('transition-opacity', (tilesStale || failed) && 'opacity-60')}
                    aria-busy={tilesStale || undefined}
                  >
                    <EnergyReadouts sums={tileSums} />
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </SectionSkeleton>
          <SectionSkeleton name="energy-chart" loading={pending} fallbackHeight="22rem">
            {overview ? (
              <section aria-labelledby={chartHeadingId}>
                <Card>
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id={chartHeadingId} className="font-semibold text-lg">
                      {m.energy_chart_title({ year: String(overview.year) })}
                    </h2>
                    <MetricToggle
                      value={metric}
                      options={energyMetricOptions()}
                      onChange={setMetric}
                      aria-label={m.energy_metric_label()}
                      itemClassName="h-10 px-4 text-sm"
                    />
                  </CardHeader>
                  <CardContent
                    className={cn('transition-opacity', stale && 'opacity-60')}
                    aria-busy={stale || undefined}
                  >
                    <EnergyMonthlyChart
                      year={overview.year}
                      months={overview.months}
                      metric={metric}
                      currentMonth={overview.year === now.year ? now.month : null}
                      selectedMonth={
                        period?.kind === 'month' && period.year === overview.year
                          ? period.month
                          : null
                      }
                      onSelectMonth={(month) =>
                        setPeriod({ kind: 'month', year: overview.year, month })
                      }
                    />
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </SectionSkeleton>
          <LoadErrorAlert title={m.energy_error_title()} query={result} />
        </div>
      )}
    </PageContainer>
  )
}
