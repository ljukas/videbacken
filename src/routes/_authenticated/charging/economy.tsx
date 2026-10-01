import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PiggyBankIcon } from 'lucide-react'
import { useCallback, useId } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { EconomyMonthlyChart } from '~/components/evCharging/EconomyMonthlyChart'
import { EconomySessionTable } from '~/components/evCharging/EconomySessionTable'
import { EconomyTiles } from '~/components/evCharging/EconomyTiles'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SpotComparisonChart } from '~/components/evCharging/SpotComparisonChart'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { scopeNote, VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { type VehicleScope, vehicleScope } from '~/lib/evCharging/vehicle'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  // Whose charging: a clean URL means our car.
  vehicle: vehicleScope.optional().catch(undefined),
})

const economyQuery = (year: number | undefined, vehicle: VehicleScope) =>
  orpc.evCharging.economy.queryOptions({ input: { year, vehicle } })
const pricesHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } })

export const Route = createFileRoute('/_authenticated/charging/economy')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_economy_title(),
      description: m.meta_charging_economy_description(),
    }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year, vehicle: search.vehicle ?? 'ours' }),
  // Prefetched, not ensured: a failed economy read shows its own alert under a
  // working heading and sync health, like /charging/patterns.
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.prefetchQuery(economyQuery(deps.year, deps.vehicle)),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
      queryClient.ensureQueryData(pricesHealthQuery),
    ])
  },
  component: EconomyPage,
})

function EconomyPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  // Daily data: focus refetch only, no polling interval.
  const { data: pricesHealth } = useSuspenseQuery(pricesHealthQuery)
  const sekHeadingId = useId()
  const spotHeadingId = useId()
  const sessionsHeadingId = useId()
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const vehicle: VehicleScope = search.vehicle ?? 'ours'
  const result = useQuery({
    ...economyQuery(search.year, vehicle),
    placeholderData: keepPreviousData,
  })
  const { data: economy, isPlaceholderData: stale } = result
  const setYear = useCallback(
    (year: number) =>
      navigate({ to: '.', search: (s) => ({ ...s, year }), replace: true, resetScroll: false }),
    [navigate],
  )
  const setVehicle = useCallback(
    (v: VehicleScope) =>
      navigate({
        to: '.',
        search: (s) => ({ ...s, vehicle: v === 'ours' ? undefined : v }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  return (
    <PageContainer>
      <ChargingHeading
        title={m.charging_economy_title()}
        note={scopeNote(vehicle) ?? ''}
        lastSuccessAt={health.lastSuccessAt}
        action={
          isAdmin ? <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} /> : null
        }
      />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('zaptec')}
        retrying={syncNow.isPendingFor('zaptec')}
      />
      {/* Every signed-in user sees the price feed's health here: this page is
          all prices, so a stale feed affects what they read. */}
      <SyncHealthAlert
        health={pricesHealth}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('elpris')}
        retrying={syncNow.isPendingFor('elpris')}
      />
      {/* Outside the load branches: a failed read for one scope must not take
          the control away, or the user can't switch back. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
        {economy && !loadFailed(result) ? (
          <YearSelector years={economy.years} value={economy.year} onChange={setYear} />
        ) : null}
      </div>
      {economy && !loadFailed(result) ? (
        <>
          {economy.tiles.sessions > 0 ? (
            <div
              className={cn('flex flex-col gap-4 transition-opacity', stale && 'opacity-60')}
              aria-busy={stale}
            >
              <EconomyTiles tiles={economy.tiles} />
              <section aria-labelledby={sekHeadingId}>
                <Card>
                  <CardHeader>
                    <h2 id={sekHeadingId} className="font-medium text-sm">
                      {m.charging_economy_chart_sek_title()}
                    </h2>
                  </CardHeader>
                  <CardContent>
                    <EconomyMonthlyChart months={economy.months} />
                  </CardContent>
                </Card>
              </section>
              <section aria-labelledby={spotHeadingId}>
                <Card>
                  <CardHeader>
                    <h2 id={spotHeadingId} className="font-medium text-sm">
                      {m.charging_economy_chart_spot_title()}
                    </h2>
                  </CardHeader>
                  <CardContent>
                    <SpotComparisonChart months={economy.months} />
                  </CardContent>
                </Card>
              </section>
              <section aria-labelledby={sessionsHeadingId}>
                <Card>
                  <CardHeader>
                    <h2 id={sessionsHeadingId} className="font-medium text-sm">
                      {m.charging_economy_sessions_title()}
                    </h2>
                  </CardHeader>
                  <CardContent>
                    <EconomySessionTable
                      sessions={economy.sessions}
                      labelledBy={sessionsHeadingId}
                    />
                  </CardContent>
                </Card>
              </section>
              <EconomyFootnote excluded={economy.tiles.excluded} />
            </div>
          ) : (
            <Empty className="brand-wash rounded-lg border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PiggyBankIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {vehicle === 'other'
                    ? m.charging_vehicle_empty_other_title({ year: economy.year })
                    : m.charging_economy_empty_title({ year: economy.year })}
                </EmptyTitle>
                <EmptyDescription>
                  {vehicle === 'other'
                    ? m.charging_vehicle_empty_other_description()
                    : m.charging_economy_empty_description()}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </>
      ) : (
        <LoadErrorAlert title={m.charging_economy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
