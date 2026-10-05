import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PiggyBankIcon } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { EconomyGridOnlyLead } from '~/components/evCharging/EconomyGridOnlyLead'
import { EconomyMonthlyChart } from '~/components/evCharging/EconomyMonthlyChart'
import { EconomySessionTable } from '~/components/evCharging/EconomySessionTable'
import { EconomyTiles } from '~/components/evCharging/EconomyTiles'
import {
  firstLoadPending,
  LoadErrorAlert,
  loadFailed,
} from '~/components/evCharging/LoadErrorAlert'
import { SessionPagination } from '~/components/evCharging/SessionPagination'
import { SpotComparisonChart } from '~/components/evCharging/SpotComparisonChart'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { useSessionPaging } from '~/hooks/useSessionPaging'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { DEFAULT_SESSION_PAGE_SIZE, pageSlice, sessionPagingSearch } from '~/lib/evCharging/paging'
import {
  DEFAULT_VEHICLE_SCOPE,
  type VehicleScope,
  vehicleScope,
  vehicleScopeParam,
} from '~/lib/evCharging/vehicle'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
  // The session table's page and rows per page: a clean URL is its first 10.
  // Not loader deps: the page loads the whole year (the tiles and charts need
  // all of it) and the table shows a slice of it.
  ...sessionPagingSearch.shape,
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
  loaderDeps: ({ search }) => ({
    year: search.year,
    vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE,
  }),
  // ADR-0024: awaited on the server only; the client shows the skeleton. A
  // failed economy read shows its own alert under a working heading.
  loader: ({ context: { queryClient }, deps }) =>
    loadRouteData(queryClient, {
      critical: [
        economyQuery(deps.year, deps.vehicle),
        orpc.evCharging.syncStatus.queryOptions(),
        pricesHealthQuery,
      ],
    }),
  component: EconomyPage,
})

function EconomyPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  // Daily data: focus refetch only, no polling interval.
  const { data: pricesHealth } = useQuery(pricesHealthQuery)
  const sekHeadingId = useId()
  const spotHeadingId = useId()
  const navigate = Route.useNavigate()
  // Per-key selects: a page click in the session table re-renders only its card.
  const year = Route.useSearch({ select: (s) => s.year })
  const vehicleParam = Route.useSearch({ select: (s) => s.vehicle })
  const vehicle: VehicleScope = vehicleParam ?? DEFAULT_VEHICLE_SCOPE
  const result = useQuery({
    ...economyQuery(year, vehicle),
    placeholderData: keepPreviousData,
  })
  const { data: economy, isPlaceholderData: stale } = result
  // Another year or scope is another table: back to its first page.
  const setYear = useCallback(
    (year: number) =>
      navigate({
        to: '.',
        search: (s) => ({ ...s, year, page: undefined }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  const setVehicle = useCallback(
    (v: VehicleScope) =>
      navigate({
        to: '.',
        search: (s) => ({ ...s, vehicle: vehicleScopeParam(v), page: undefined }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  return (
    <PageContainer>
      <ChargingHeading
        title={m.charging_economy_title()}
        lastSuccessAt={health?.lastSuccessAt}
        action={
          isAdmin ? <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} /> : null
        }
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('zaptec')}
          retrying={syncNow.isPendingFor('zaptec')}
        />
      ) : null}
      {/* Every signed-in user sees the price feed's health here: this page is
          all prices, so a stale feed affects what they read. */}
      {pricesHealth ? (
        <SyncHealthAlert
          health={pricesHealth}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('elpris')}
          retrying={syncNow.isPendingFor('elpris')}
        />
      ) : null}
      {/* The page filter, outside the load branches: a failed read for one
          scope must not take the control away, or the user can't switch back.
          Same row as Mönster's: scope left, year right. */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
        {economy && !loadFailed(result) ? (
          <YearSelector years={economy.years} value={economy.year} onChange={setYear} />
        ) : null}
      </div>
      <SectionSkeleton
        name="charging-economy"
        loading={firstLoadPending(result)}
        fallbackHeight="40rem"
      >
        {economy && !loadFailed(result) ? (
          <>
            {/* The grid-only lead frames the whole page's figures. Inside the
                skeleton so it can't push the body down when the data lands, but
                outside the content that dims on a switch. */}
            {economy.tiles.sessions > 0 ? (
              <EconomyGridOnlyLead year={economy.year} vehicle={vehicleParam} />
            ) : null}
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
                <EconomySessionsCard sessions={economy.sessions} stale={stale} />
                <EconomyFootnote excluded={economy.tiles.excluded} />
              </div>
            ) : (
              <Empty
                className={cn(
                  'brand-wash rounded-lg border transition-opacity',
                  stale && 'opacity-60',
                )}
                aria-busy={stale}
              >
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
        ) : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_economy_error_title()} query={result} />
    </PageContainer>
  )
}

type EconomyRow = RouterOutputs['evCharging']['economy']['sessions'][number]

// The year's sessions, newest first, one page at a time, sliced from the year
// the page already loaded (a page past the end shows the last). Its own
// component, reading only its own params, so a page click re-renders this card
// and not the charts. While another year or scope loads (`stale`, the old
// payload dimmed) it keeps slicing at the page it showed: the URL has already
// gone back to page 1, and slicing the old year there would flash its first
// page before the new year lands.
function EconomySessionsCard({ sessions, stale }: { sessions: EconomyRow[]; stale: boolean }) {
  const headingId = useId()
  // The same URL conventions as /charging's list.
  const requestedPage = Route.useSearch({ select: (s) => s.page ?? 1 })
  const pageSize = Route.useSearch({ select: (s) => s.size ?? DEFAULT_SESSION_PAGE_SIZE })
  // Set during render: React's pattern for state derived from a changing value.
  const [shownPage, setShownPage] = useState(requestedPage)
  if (!stale && shownPage !== requestedPage) setShownPage(requestedPage)
  const page = pageSlice(sessions, stale ? shownPage : requestedPage, pageSize)
  const paging = useSessionPaging<z.infer<typeof searchSchema>>(Route.useNavigate())

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <h2
            id={headingId}
            ref={paging.headingRef}
            tabIndex={-1}
            className="scroll-mt-4 rounded-sm font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {m.charging_economy_sessions_title()}
          </h2>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <EconomySessionTable sessions={page.rows} labelledBy={headingId} />
          {/* Inert while another year or scope loads: a page picked in the old
              year's table would carry into the new one's. */}
          <div inert={stale}>
            <SessionPagination
              page={page.page}
              pageSize={pageSize}
              total={sessions.length}
              onPageChange={paging.setPage}
              onPageSizeChange={paging.setPageSize}
            />
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
