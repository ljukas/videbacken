import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SunIcon } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import { z } from 'zod'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import {
  type EnergyMetric,
  EnergyMonthlyChart,
  energyMetricOptions,
} from '~/components/energy/EnergyMonthlyChart'
import { EnergyReadouts } from '~/components/energy/EnergyTiles'
import { energyOverviewQuery } from '~/components/energy/energyQueries'
import { PeriodControl } from '~/components/energy/PeriodControl'
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
  periodQueryYear,
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

/**
 * The overview year to request: the period's, else (Totalt, the default) the
 * current Stockholm year, the one the service would pick. Always concrete, so
 * the default and a month of this year share one cache entry: a month switch
 * inside a year costs no request.
 */
const queryYear = (period: EnergyPeriod | null) =>
  periodQueryYear(period) ?? stockholmYearMonth(Date.now()).year

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
    const year = queryYear(periodOf(searchSchema.parse(location.search)))
    return loadRouteData(queryClient, {
      critical: [energyOverviewQuery(year), syncHealthQuery],
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
  const requested = periodOf(Route.useSearch())
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({
    ...energyOverviewQuery(queryYear(requested)),
    placeholderData: keepPreviousData,
  })
  const { data, isPlaceholderData: stale } = result
  // Placeholder data counts as data (the old year, dimmed); a failed read doesn't.
  const overview = data && !loadFailed(result) ? data : undefined
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
  // Same in the server render and the hydrating one (one request, one month).
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
  // While another year loads, the placeholder can't answer for a month of the
  // new year: keep the figures the card showed last, dimmed with the chart.
  const [lastSums, setLastSums] = useState<PeriodSums | null>(periodSums)
  if (!stale && periodSums !== lastSums) setLastSums(periodSums)
  const tileSums = stale ? lastSums : periodSums

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
                <Card
                  className={cn('transition-opacity', stale && 'opacity-60')}
                  aria-busy={stale || undefined}
                >
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
                  <CardContent>
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
                      {m.energy_chart_title()} · {overview.year}
                    </h2>
                    <MetricToggle
                      value={metric}
                      options={energyMetricOptions()}
                      onChange={setMetric}
                      aria-label={m.energy_metric_label()}
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
