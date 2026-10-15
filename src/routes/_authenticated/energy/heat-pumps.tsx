import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import heatPumpConsumptionBones from '~/bones/heat-pump-consumption.bones.json'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import type { EnergySearchWrite } from '~/components/energy/useEnergyPeriod'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { HeatPumpConsumption } from '~/components/heatPump/HeatPumpConsumption'
import { HeatPumpEmpty } from '~/components/heatPump/HeatPumpEmpty'
import { heatPumpDaysQueryFor, heatPumpMonthsQueryFor } from '~/components/heatPump/heatPumpQueries'
import { useHeatPumpPeriod } from '~/components/heatPump/useHeatPumpPeriod'
import { LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/energy/heat-pumps')({
  head: () => ({
    meta: seo({
      title: m.meta_energy_heat_pumps_title(),
      description: m.meta_energy_heat_pumps_description(),
    }),
  }),
  validateSearch: energySearchSchema,
  // ADR-0025: the card is above the fold, so its reads are critical on the server; a client navigation awaits
  // nothing. The period is read here, not a loader dep (see energy/index.tsx). No period asked for: the default is
  // the current month (when it has readings), so its days load with it.
  loader: ({ context: { queryClient }, location }) => {
    const requested = periodOfSearch(energySearchSchema.parse(location.search))
    const now = stockholmYearMonth(Date.now())
    const dayPeriod: EnergyPeriod = requested ?? { kind: 'month', year: now.year, month: now.month }
    return loadRouteData(queryClient, {
      critical: [
        heatPumpMonthsQueryFor(requested),
        heatPumpDaysQueryFor(dayPeriod),
        syncHealthQuery,
      ],
    })
  },
  component: HeatPumpsPage,
})

function HeatPumpsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Every source's health (one read); this page shows Comfort Cloud's: its alert and its "senast synkad", rendered
  // here with SyncHealthAlert (EnergySyncAlerts shows Emaldo's too, which this page doesn't read).
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.comfortCloud
  const navigate = Route.useNavigate()
  // Merges into the current search, so the page's other keys (step 4a's `dialog` / `eventId`) survive a period
  // change. Writing a period drops a legacy ?year=; `{}` (nothing valid asked for) drops both.
  const writeSearch = useCallback<EnergySearchWrite>(
    (next) =>
      void navigate({
        to: '.',
        search: (prev) => ({ ...prev, period: next.period, year: undefined }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  const h = useHeatPumpPeriod(Route.useSearch(), writeSearch)
  return (
    <PageContainer>
      <EnergyHeading
        title={m.heat_pump_title()}
        description={m.heat_pump_description()}
        lastSuccessAt={health?.lastSuccessAt}
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('comfortCloud')}
          retrying={syncNow.isPendingFor('comfortCloud')}
        />
      ) : null}
      {/* A skeleton is not an empty state (ADR-0016): only data says there are no readings. */}
      {h.months?.firstReadingDay === null ? (
        <HeatPumpEmpty />
      ) : (
        // The same element whatever the state, so the server HTML and the first client render agree.
        <div className="flex flex-col gap-4">
          <SectionSkeleton
            bones={heatPumpConsumptionBones}
            loading={h.pending}
            fallbackHeight="30rem"
          >
            {h.shown && h.period ? (
              <EnergySummaryCard
                title={m.heat_pump_consumption_heading()}
                period={h.period}
                monthsWithReadings={h.shown.monthsWithReadings}
                now={h.now}
                onChange={h.setPeriod}
                dimmed={h.dimmed}
                busy={h.busy}
              >
                {h.view ? (
                  <HeatPumpConsumption
                    view={h.view}
                    onSelectMonth={(month) => h.setPeriod({ kind: 'month', ...month })}
                  />
                ) : null}
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <LoadErrorAlert title={m.heat_pump_error_title()} query={h.monthsResult} />
          {h.period?.kind === 'month' ? (
            <LoadErrorAlert title={m.heat_pump_error_title()} query={h.daysResult} />
          ) : null}
        </div>
      )}
    </PageContainer>
  )
}
