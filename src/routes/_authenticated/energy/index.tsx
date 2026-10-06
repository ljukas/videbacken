import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useId, useState } from 'react'
import energyChartBones from '~/bones/energy-chart.bones.json'
import energyTilesBones from '~/bones/energy-tiles.bones.json'
import { EnergyEmpty } from '~/components/energy/EnergyEmpty'
import { EnergyFlow } from '~/components/energy/EnergyFlow'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import {
  type EnergyMetric,
  EnergyMonthlyChart,
  energyMetricOptions,
} from '~/components/energy/EnergyMonthlyChart'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energyOverviewQueryFor } from '~/components/energy/energyQueries'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import { type EnergySearchWrite, useEnergyPeriod } from '~/components/energy/useEnergyPeriod'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { loadRouteData } from '~/lib/query/routeData'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/energy/')({
  head: () => ({
    meta: seo({ title: m.meta_energy_title(), description: m.meta_energy_description() }),
  }),
  validateSearch: energySearchSchema,
  // ADR-0025: awaited on the server only (both are above the fold, so both are
  // critical); a client navigation awaits nothing and the sections show their
  // skeletons. A failed read shows its own alert under a working heading.
  // The period's year is deliberately not a loader dep: a dep change blocks the
  // navigation on this loader, freezing the old chart with no feedback. Read
  // here, it still loads the year a URL asks for (SSR, a shared link); a year
  // switch is the page's own query, whose old figures stay, dimmed, until the
  // new year lands. Parsed with the route's own fallbacks.
  loader: ({ context: { queryClient }, location }) => {
    const period = periodOfSearch(energySearchSchema.parse(location.search))
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
  const navigate = Route.useNavigate()
  const writeSearch = useCallback<EnergySearchWrite>(
    (search) => void navigate({ to: '.', search, replace: true, resetScroll: false }),
    [navigate],
  )
  const e = useEnergyPeriod(Route.useSearch(), writeSearch)
  const { overview } = e
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()

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
        <EnergyEmpty />
      ) : (
        // The same element whatever the state, so the server HTML and the first
        // client render agree (the skeletons and the alert appear only once
        // hydrated). A failed read leaves the alert in it, below the last tiles
        // card (and its period control) once the page has shown a year.
        <div className="flex flex-col gap-4">
          <SectionSkeleton bones={energyTilesBones} loading={e.pending} fallbackHeight="12rem">
            {e.tiles && e.period ? (
              <EnergySummaryCard
                period={e.period}
                monthsWithReadings={e.tiles.monthsWithReadings}
                now={e.now}
                onChange={e.setPeriod}
                dimmed={e.sumsDimmed}
                busy={e.sumsStale}
              >
                <EnergyFlow sums={e.sums} />
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <SectionSkeleton bones={energyChartBones} loading={e.pending} fallbackHeight="22rem">
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
                    className={cn('transition-opacity', e.stale && 'opacity-60')}
                    aria-busy={e.stale || undefined}
                  >
                    <EnergyMonthlyChart
                      year={overview.year}
                      months={overview.months}
                      metric={metric}
                      currentMonth={overview.year === e.now.year ? e.now.month : null}
                      selectedMonth={
                        e.period?.kind === 'month' && e.period.year === overview.year
                          ? e.period.month
                          : null
                      }
                      onSelectMonth={(month) =>
                        e.setPeriod({ kind: 'month', year: overview.year, month })
                      }
                    />
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </SectionSkeleton>
          <LoadErrorAlert title={m.energy_error_title()} query={e.result} />
        </div>
      )}
    </PageContainer>
  )
}
