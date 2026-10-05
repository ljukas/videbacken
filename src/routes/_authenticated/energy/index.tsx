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
import { EnergyTiles } from '~/components/energy/EnergyTiles'
import { emaldoHealthQuery, energyOverviewQuery } from '~/components/energy/energyQueries'
import {
  firstLoadPending,
  LoadErrorAlert,
  loadFailed,
} from '~/components/evCharging/LoadErrorAlert'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/energy/')({
  head: () => ({
    meta: seo({ title: m.meta_energy_title(), description: m.meta_energy_description() }),
  }),
  validateSearch: searchSchema,
  // ADR-0025: awaited on the server only (both are above the fold, so both are
  // critical); a client navigation awaits nothing and the sections show their
  // skeletons. A failed read shows its own alert under a working heading.
  // The year is deliberately not a loader dep: a dep change blocks the navigation
  // on this loader, freezing the old chart with no feedback. Read here, it still
  // loads the year a URL asks for (SSR, a shared link); a year switch is the
  // page's own query, whose old chart stays, dimmed, until the new year lands.
  // Parsed with the route's own fallbacks.
  loader: ({ context: { queryClient }, location }) => {
    const { year } = searchSchema.parse(location.search)
    return loadRouteData(queryClient, {
      critical: [energyOverviewQuery(year), emaldoHealthQuery],
    })
  },
  component: EnergyOverviewPage,
})

function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Not suspending: a client navigation doesn't wait for it (ADR-0025 §3).
  const { data: health } = useQuery({ ...emaldoHealthQuery, refetchInterval: 60_000 })
  const year = Route.useSearch({ select: (s) => s.year })
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({ ...energyOverviewQuery(year), placeholderData: keepPreviousData })
  const { data, isPlaceholderData: stale } = result
  // Placeholder data counts as data (the old year, dimmed); a failed read doesn't.
  const overview = data && !loadFailed(result) ? data : undefined
  // Nothing to show yet and nothing failed: the sections' skeletons.
  const pending = firstLoadPending(result)
  const navigate = Route.useNavigate()
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()
  const tilesHeadingId = useId()
  const setYear = useCallback(
    (y: number) =>
      navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false }),
    [navigate],
  )
  const now = stockholmYearMonth(Date.now())

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
        // hydrated). A failed read leaves just the alert in it.
        <div className="flex flex-col gap-4">
          <SectionSkeleton name="energy-tiles" loading={pending} fallbackHeight="12rem">
            {overview ? (
              // Tiles are always the current periods: they don't dim on a year switch.
              <section aria-labelledby={tilesHeadingId}>
                <h2 id={tilesHeadingId} className="sr-only">
                  {m.energy_tiles_heading()}
                </h2>
                <EnergyTiles tiles={overview.tiles} />
              </section>
            ) : null}
          </SectionSkeleton>
          <SectionSkeleton name="energy-chart" loading={pending} fallbackHeight="22rem">
            {overview ? (
              <section aria-labelledby={chartHeadingId}>
                <Card>
                  <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id={chartHeadingId} className="font-medium text-sm">
                      {m.energy_chart_title()}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <MetricToggle
                        value={metric}
                        options={energyMetricOptions()}
                        onChange={setMetric}
                        aria-label={m.energy_metric_label()}
                      />
                      <YearSelector
                        years={overview.availableYears}
                        value={stale && year !== undefined ? year : overview.year}
                        onChange={setYear}
                      />
                    </div>
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
