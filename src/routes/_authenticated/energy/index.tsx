import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
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
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
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
  loaderDeps: ({ search }) => ({ year: search.year }),
  // Prefetched, not ensured: a failed read shows its own alert under a
  // working heading and health alert (like /charging/economy).
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.prefetchQuery(energyOverviewQuery(deps.year)),
      queryClient.ensureQueryData(emaldoHealthQuery),
    ])
  },
  component: EnergyOverviewPage,
})

function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({ ...emaldoHealthQuery, refetchInterval: 60_000 })
  const year = Route.useSearch({ select: (s) => s.year })
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({ ...energyOverviewQuery(year), placeholderData: keepPreviousData })
  const { data: overview, isPlaceholderData: stale } = result
  const navigate = Route.useNavigate()
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()
  const metricLabelId = useId()
  const setYear = useCallback(
    (y: number) =>
      navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false }),
    [navigate],
  )
  const now = stockholmYearMonth(Date.now())

  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health.lastSuccessAt} />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('emaldo')}
        retrying={syncNow.isPendingFor('emaldo')}
      />
      {overview && !loadFailed(result) ? (
        overview.firstReadingDay === null ? (
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
          <div className="flex flex-col gap-4">
            {/* Tiles are always the current periods: they don't dim on a year switch. */}
            <EnergyTiles tiles={overview.tiles} />
            <section aria-labelledby={chartHeadingId}>
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={chartHeadingId} className="font-medium text-sm">
                    {m.energy_chart_title()}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <span id={metricLabelId} className="sr-only">
                      {m.energy_metric_label()}
                    </span>
                    <MetricToggle
                      value={metric}
                      options={energyMetricOptions()}
                      onChange={setMetric}
                      aria-labelledby={metricLabelId}
                    />
                    <YearSelector
                      years={overview.availableYears}
                      value={overview.year}
                      onChange={setYear}
                    />
                  </div>
                </CardHeader>
                <CardContent
                  className={cn('transition-opacity', stale && 'opacity-60')}
                  aria-busy={stale}
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
          </div>
        )
      ) : (
        <LoadErrorAlert title={m.energy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
