import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PiggyBankIcon } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import { z } from 'zod'
import chargingEconomyBones from '~/bones/charging-economy.bones.json'
import chargingEconomySessionsBones from '~/bones/charging-economy-sessions.bones.json'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { EconomyGridOnlyLead } from '~/components/evCharging/EconomyGridOnlyLead'
import { EconomyMonthlyChart } from '~/components/evCharging/EconomyMonthlyChart'
import { EconomySessionTable } from '~/components/evCharging/EconomySessionTable'
import { EconomyTiles } from '~/components/evCharging/EconomyTiles'
import { SessionPagination } from '~/components/evCharging/SessionPagination'
import { SpotComparisonChart } from '~/components/evCharging/SpotComparisonChart'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { useNextPagePrefetch } from '~/hooks/useNextPagePrefetch'
import { useSessionPaging } from '~/hooks/useSessionPaging'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import {
  DEFAULT_SESSION_PAGE_SIZE,
  type SessionPageSize,
  sessionPagingSearch,
} from '~/lib/evCharging/paging'
import {
  DEFAULT_VEHICLE_SCOPE,
  type VehicleScope,
  vehicleScope,
  vehicleScopeParam,
} from '~/lib/evCharging/vehicle'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
  // The session table's page and rows per page: a clean URL is its first 10.
  // Not loader deps: the page loads only the table's page (economySessions),
  // read from the URL in the loader, as /charging's list.
  ...sessionPagingSearch.shape,
})

const economyQuery = (year: number | undefined, vehicle: VehicleScope) =>
  orpc.evCharging.economy.queryOptions({ input: { year, vehicle } })
const economySessionsQuery = (
  year: number | undefined,
  vehicle: VehicleScope,
  page: number,
  pageSize: SessionPageSize,
) => orpc.evCharging.economySessions.queryOptions({ input: { year, vehicle, page, pageSize } })

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
  // ADR-0025: awaited on the server only; the client shows the skeleton. A
  // failed economy read shows its own alert under a working heading.
  // The list's page and size are deliberately not loader deps: a dep change
  // blocks the navigation on this whole loader, so a page click would freeze on
  // the old page. Read here, SSR and a shared link still render the page the
  // URL asks for; a page click is the list's own query (see /charging).
  loader: ({ context: { queryClient }, deps, location }) => {
    const paging = sessionPagingSearch.parse(location.search)
    return loadRouteData(queryClient, {
      critical: [
        economyQuery(deps.year, deps.vehicle),
        economySessionsQuery(
          deps.year,
          deps.vehicle,
          paging.page ?? 1,
          paging.size ?? DEFAULT_SESSION_PAGE_SIZE,
        ),
        syncHealthQuery,
      ],
    })
  },
  component: EconomyPage,
})

function EconomyPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Every source's health (one read); this page shows Zaptec's and the price feed's.
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.zaptec
  const pricesHealth = sourcesHealth?.elpris
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
          settingsLink={isAdmin}
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
          settingsLink={isAdmin}
          onRetry={() => syncNow.syncSource('elpris')}
          retrying={syncNow.isPendingFor('elpris')}
        />
      ) : null}
      {/* The page filter, outside the load branches: a failed read for one
          scope must not take the control away, or the user can't switch back.
          Same row as Mönster's: scope left, year right. */}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
        {economy && !loadFailed(result) ? (
          <YearSelector years={economy.years} value={economy.year} onChange={setYear} />
        ) : null}
      </div>
      <SectionSkeleton
        bones={chargingEconomyBones}
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
              // The year's figures dim while another year or scope loads; the
              // session table sits outside them and dims by its own query only
              // (nested, it would dim twice and stay dimmed after its rows land).
              <div className="flex flex-col gap-4">
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
                </div>
                <EconomySessionsCard year={year} vehicle={vehicle} />
                <div className={cn('transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
                  <EconomyFootnote excluded={economy.tiles.excluded} />
                </div>
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

// The year's sessions, newest first, one page at a time from the server
// (economySessions). Its own query and component, so a page click re-renders
// only this card. Another page or scope keeps the current rows, dimmed, until
// the next ones land; after a failed read only this scope's last page stays,
// dimmed under the alert (the rule /charging's list follows). The pagination
// stays usable throughout: focus stays on the control while a page loads, and
// after a failure it steps to another page or retries this one (a click on the
// old page's control pages from the URL, which already holds the new page).
function EconomySessionsCard({
  year,
  vehicle,
}: {
  year: number | undefined
  vehicle: VehicleScope
}) {
  const headingId = useId()
  const page = Route.useSearch({ select: (s) => s.page ?? 1 })
  const pageSize = Route.useSearch({ select: (s) => s.size ?? DEFAULT_SESSION_PAGE_SIZE })
  const list = useQuery({
    ...economySessionsQuery(year, vehicle, page, pageSize),
    placeholderData: keepPreviousData,
  })
  const queryClient = useQueryClient()
  const prefetchPage = useCallback(
    (p: number) => void queryClient.prefetchQuery(economySessionsQuery(year, vehicle, p, pageSize)),
    [queryClient, year, vehicle, pageSize],
  )
  useNextPagePrefetch(list, prefetchPage)
  const scope = `${year ?? 'current'}:${vehicle}`
  const [lastLoaded, setLastLoaded] = useState(() =>
    list.data && !list.isPlaceholderData ? { scope, data: list.data } : undefined,
  )
  if (list.data && !list.isPlaceholderData && list.data !== lastLoaded?.data) {
    setLastLoaded({ scope, data: list.data })
  }
  const lastInScope = lastLoaded?.scope === scope ? lastLoaded.data : undefined
  const shown = loadFailed(list) ? lastInScope : (list.data ?? lastInScope)
  const stale = list.data === undefined || list.isPlaceholderData
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
          <LoadErrorAlert title={m.charging_sessions_error_title()} query={list} />
          <SectionSkeleton
            bones={chargingEconomySessionsBones}
            loading={firstLoadPending(list)}
            fallbackHeight="24rem"
          >
            {/* An empty scope has no table at all: its empty state comes from the figures, and
                a header-only table would show under their old, dimmed ones until they land. */}
            {shown && shown.total > 0 ? (
              <div
                aria-busy={stale && !loadFailed(list)}
                className={cn('flex flex-col gap-3 transition-opacity', stale && 'opacity-60')}
              >
                <EconomySessionTable sessions={shown.rows} labelledBy={headingId} />
                <SessionPagination
                  page={shown.page}
                  pageSize={shown.pageSize}
                  total={shown.total}
                  onPageChange={paging.setPage}
                  onPageSizeChange={paging.setPageSize}
                  prefetchPage={prefetchPage}
                />
              </div>
            ) : null}
          </SectionSkeleton>
        </CardContent>
      </Card>
    </section>
  )
}
