import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useId } from 'react'
import batteryChartBones from '~/bones/energy-battery-chart.bones.json'
import batteryFlowBones from '~/bones/energy-battery-flow.bones.json'
import { BatteryFlow } from '~/components/energy/BatteryFlow'
import { BatteryMonthlyChart } from '~/components/energy/BatteryMonthlyChart'
import { EnergyEmpty } from '~/components/energy/EnergyEmpty'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energyOverviewQueryFor } from '~/components/energy/energyQueries'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import { type EnergySearchWrite, useEnergyPeriod } from '~/components/energy/useEnergyPeriod'
import { formatDecimal } from '~/components/evCharging/format'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { BATTERY_CAPACITY_KWH } from '~/lib/houseEnergy/mix/pool'
import { loadRouteData } from '~/lib/query/routeData'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/energy/battery')({
  head: () => ({
    meta: seo({
      title: m.meta_energy_battery_title(),
      description: m.meta_energy_battery_description(),
    }),
  }),
  validateSearch: energySearchSchema,
  // As /energy (ADR-0025): both sections are above the fold, so both reads are critical on the server; a client
  // navigation awaits nothing. The same overview cache entry as Översikt, so switching sub-page costs no request.
  // The period's year is read here, not a loader dep (see energy/index.tsx).
  loader: ({ context: { queryClient }, location }) =>
    loadRouteData(queryClient, {
      critical: [
        energyOverviewQueryFor(periodOfSearch(energySearchSchema.parse(location.search))),
        syncHealthQuery,
      ],
    }),
  component: EnergyBatteryPage,
})

function EnergyBatteryPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.emaldo
  const navigate = Route.useNavigate()
  const writeSearch = useCallback<EnergySearchWrite>(
    (search) => void navigate({ to: '.', search, replace: true, resetScroll: false }),
    [navigate],
  )
  const e = useEnergyPeriod(Route.useSearch(), writeSearch)
  const chartHeadingId = useId()
  const { overview } = e
  return (
    <PageContainer>
      <EnergyHeading
        title={m.energy_battery_title()}
        description={m.energy_battery_description()}
        lastSuccessAt={health?.lastSuccessAt}
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('emaldo')}
          retrying={syncNow.isPendingFor('emaldo')}
        />
      ) : null}
      {overview?.firstReadingDay === null ? (
        <EnergyEmpty />
      ) : (
        <div className="flex flex-col gap-4">
          <SectionSkeleton bones={batteryFlowBones} loading={e.pending} fallbackHeight="12rem">
            {e.tiles && e.period ? (
              <EnergySummaryCard
                period={e.period}
                monthsWithReadings={e.tiles.monthsWithReadings}
                now={e.now}
                onChange={e.setPeriod}
                dimmed={e.sumsDimmed}
                busy={e.sumsStale}
              >
                <BatteryFlow sums={e.sums} />
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <SectionSkeleton bones={batteryChartBones} loading={e.pending} fallbackHeight="22rem">
            {overview ? (
              <section aria-labelledby={chartHeadingId}>
                <Card>
                  <CardHeader>
                    <h2 id={chartHeadingId} className="font-semibold text-lg">
                      {m.energy_battery_chart_title({ year: String(overview.year) })}
                    </h2>
                  </CardHeader>
                  <CardContent
                    className={cn('transition-opacity', e.stale && 'opacity-60')}
                    aria-busy={e.stale || undefined}
                  >
                    <BatteryMonthlyChart
                      year={overview.year}
                      months={overview.months}
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
          {overview ? (
            <p className="max-w-[70ch] text-pretty text-muted-foreground text-sm">
              {m.energy_battery_note({ capacity: formatDecimal(BATTERY_CAPACITY_KWH) })}
            </p>
          ) : null}
          <LoadErrorAlert title={m.energy_error_title()} query={e.result} />
        </div>
      )}
    </PageContainer>
  )
}
