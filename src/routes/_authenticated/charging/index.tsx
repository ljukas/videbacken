import { environmentManager, keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { CostNotice, type CostNoticeReason } from '~/components/evCharging/CostNotice'
import { CredentialExpiryAlert } from '~/components/evCharging/CredentialExpiryAlert'
import { healthPoll } from '~/components/evCharging/healthPoll'
import { LiveStatusLine, useLiveStatus } from '~/components/evCharging/LiveStatusLine'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import {
  type ChartMetric,
  chartMetricOptions,
  MonthlyChart,
} from '~/components/evCharging/MonthlyChart'
import { PriceFootnote } from '~/components/evCharging/PriceFootnote'
import { SessionList } from '~/components/evCharging/SessionList'
import { SessionPagination } from '~/components/evCharging/SessionPagination'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { TotalsTiles } from '~/components/evCharging/TotalsTiles'
import { VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
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
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// Same bounds as the `overview` procedure input; an out-of-range or garbage
// `?year=` falls back to the current year instead of erroring the loader.
const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
  // The session list's page and rows per page: a clean URL is its first 10.
  ...sessionPagingSearch.shape,
})
type ChargingSearch = z.infer<typeof searchSchema>

const sessionsQuery = (page: number, pageSize: SessionPageSize, vehicle: VehicleScope) =>
  orpc.evCharging.sessions.queryOptions({ input: { page, pageSize, vehicle } })
const sessionCostsQuery = (sessionIds: string[]) =>
  orpc.evCharging.sessionCosts.queryOptions({ input: { sessionIds } })
export const Route = createFileRoute('/_authenticated/charging/')({
  head: () => ({
    meta: seo({ title: m.meta_charging_title(), description: m.meta_charging_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    year: search.year,
    vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE,
  }),
  // ADR-0025: the server waits for what renders at the top; the client waits
  // for nothing (sections show skeletons). The sessions' costs are deferred
  // (below). The data sources' tiles and histories live on /charging/settings.
  loader: async ({ context: { queryClient }, deps, location }) => {
    // The session list's page is deliberately not a loader dep: a dep change
    // blocks the navigation on this whole loader (every prefetch below), so a
    // page click would freeze on the old page with no feedback. Read here, it
    // still prefetches the page a URL asks for (SSR, a shared link), and a page
    // click becomes the list's own query: its old rows stay, dimmed, until the
    // next page lands. Parsed with the route's own fallbacks.
    const paging = sessionPagingSearch.parse(location.search)
    const sessionPage = sessionsQuery(
      paging.page ?? 1,
      paging.size ?? DEFAULT_SESSION_PAGE_SIZE,
      deps.vehicle,
    )
    await loadRouteData(queryClient, {
      critical: [
        orpc.evCharging.overview.queryOptions({
          input: { year: deps.year, vehicle: deps.vehicle },
        }),
        sessionPage,
        orpc.evCharging.costOverview.queryOptions({
          input: { year: deps.year, vehicle: deps.vehicle },
        }),
        orpc.tariff.list.queryOptions(),
        // Every source's health (one read) drives the alerts at the top: awaited on
        // the server, so a first load renders them in place. On a client navigation
        // a failing source's alert can appear a moment later (rare, and it needs attention).
        syncHealthQuery,
      ],
    })
    // The costs need the sessions' ids, and are deferred: never started on the
    // server (see loadRouteData), so the server and the hydrating client both
    // render them pending. On the client, cached sessions (a revisit) start
    // them here; otherwise the page's own query starts them once the sessions land.
    if (environmentManager.isServer()) return
    const sessions = queryClient.getQueryData(sessionPage.queryKey)
    if (sessions?.sessions.length) {
      void queryClient.prefetchQuery(sessionCostsQuery(sessions.sessions.map((s) => s.id)))
    }
  },
  component: ChargingPage,
})

function ChargingPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const navigate = Route.useNavigate()
  const year = Route.useSearch({ select: (s) => s.year })
  const vehicle = Route.useSearch({ select: (s) => s.vehicle ?? DEFAULT_VEHICLE_SCOPE })
  const sessionPage = Route.useSearch({ select: (s) => s.page ?? 1 })
  const sessionPageSize = Route.useSearch({ select: (s) => s.size ?? DEFAULT_SESSION_PAGE_SIZE })
  const syncNow = useSyncNow()
  // Only for the cost display (whether to price, and the notice): the tariff
  // card and its dialogs live on /charging/settings.
  const tariffsResult = useQuery(orpc.tariff.list.queryOptions())
  const tariffs = tariffsResult.data

  // Hourly data: no polling on overview/sessions — the default focus refetch
  // plus `syncNow`'s invalidation keep them fresh (ADR-0018).
  const overviewResult = useQuery({
    ...orpc.evCharging.overview.queryOptions({ input: { year, vehicle } }),
    placeholderData: keepPreviousData, // keep the old chart while another year loads
  })
  const { isPlaceholderData: overviewStale } = overviewResult
  // Placeholder data is the previous key's, so a failed read doesn't show it.
  const overview = loadFailed(overviewResult) ? undefined : overviewResult.data
  const sessions = useQuery({
    ...sessionsQuery(sessionPage, sessionPageSize, vehicle),
    // Never flash the empty state while another scope or page loads: the
    // current rows stay until the next ones arrive.
    placeholderData: keepPreviousData,
  })
  // The page on screen. Placeholder data lasts only while the next page is
  // pending; once that fetch has failed for good, `data` is gone. The last page
  // that loaded in this scope stays then, under the error alert (rows and the
  // pagination control, with the focus on it) instead of unmounting. Only this
  // scope's: another scope's rows would read as this one's. Set during render:
  // React's pattern for state derived from a changing value.
  const [lastLoaded, setLastLoaded] = useState(() =>
    sessions.data && !sessions.isPlaceholderData ? { vehicle, data: sessions.data } : undefined,
  )
  if (sessions.data && !sessions.isPlaceholderData && sessions.data !== lastLoaded?.data) {
    setLastLoaded({ vehicle, data: sessions.data })
  }
  const lastInScope = lastLoaded?.vehicle === vehicle ? lastLoaded.data : undefined
  // Once the read has failed (retries included), only this scope's last page:
  // the placeholder may be another scope's rows.
  const shownSessions = loadFailed(sessions) ? lastInScope : (sessions.data ?? lastInScope)
  const paging = useSessionPaging<ChargingSearch>(navigate)
  // Rows that aren't this URL's (another page still loading, or one that failed) are dimmed.
  const sessionsStale = sessions.data === undefined || sessions.isPlaceholderData
  const costResult = useQuery({
    ...orpc.evCharging.costOverview.queryOptions({ input: { year, vehicle } }),
    placeholderData: keepPreviousData,
  })
  const { data: cost, isPlaceholderData: costIsStale } = costResult
  // The totals and the chart keep their skeletons until every read that changes
  // their shape is in (ADR-0025 §3): the overview, and the cost and tariffs that
  // add the kr readout, the metric toggle, the notice and the footnote. On a
  // client navigation those land separately. A failed read isn't pending, so the
  // page then shows the grid-only figures and that read's alert.
  const shapePending =
    firstLoadPending(overviewResult) ||
    firstLoadPending(costResult) ||
    firstLoadPending(tariffsResult)
  // Cost is shown once anything at all is priced in the chosen scope (all-time,
  // so a year switch doesn't flicker the kr toggle away; a scope with nothing
  // priced, e.g. guests, shows the notice instead); until then one notice says why.
  // Energy that was all own solar bought nothing, so it is priced too: 0 kr (ADR-0023).
  const allTimeCost = cost?.tiles.allTime
  const showCost =
    tariffs !== undefined &&
    tariffs.length > 0 &&
    allTimeCost != null &&
    (allTimeCost.avgOre != null || (allTimeCost.kwh > 0 && allTimeCost.gridKwh === 0))
  const hasEnergy = (overview?.tiles.allTime.kwh ?? 0) > 0
  // Tariffs still loading (or failed): no claim either way.
  const costNotice: CostNoticeReason | null =
    !hasEnergy || tariffs === undefined
      ? null
      : tariffs.length === 0
        ? 'noTariff'
        : cost && !showCost
          ? 'unpriced'
          : null
  const [chartMetric, setChartMetric] = useState<ChartMetric>('kwh')
  const chartCost = showCost && cost ? { year: cost.year, months: cost.months } : undefined
  const showingCost = chartMetric === 'sek' && chartCost !== undefined
  // Cost for the sessions on screen, keyed by id for the list's cost column.
  const sessionIds = useMemo(
    () => shownSessions?.sessions.map((sess) => sess.id) ?? [],
    [shownSessions],
  )
  const sessionCostsResult = useQuery({
    ...sessionCostsQuery(sessionIds),
    enabled: sessionIds.length > 0,
    placeholderData: keepPreviousData,
  })
  const sessionCostList = sessionCostsResult.data
  // Rows still waiting for their cost (first load, or another page's rows)
  // show a placeholder, not the "missing" dash.
  const sessionCostsPending = sessionCostsResult.isPending || sessionCostsResult.isPlaceholderData
  const sessionCosts = useMemo(
    () => new Map(sessionCostList?.map((c) => [c.sessionId, c])),
    [sessionCostList],
  )
  // Every source's health in one read. Members see only Zaptec's alert, polled
  // at a plain minute; admins also follow "Synkar…" on any source, so an alert's
  // retry state clears on its own (ADR-0018: polled).
  const healthResult = useQuery({
    ...syncHealthQuery,
    refetchInterval: isAdmin
      ? healthPoll(INTEGRATION_SOURCES.some((source) => syncNow.isPendingFor(source)))
      : 60_000,
  })
  const live = useLiveStatus()
  const health = healthResult.data?.zaptec
  // Admin-only until prices are shown on the page (see the alerts below).
  const pricesHealth = isAdmin ? healthResult.data?.elpris : undefined
  const skodaHealth = isAdmin ? healthResult.data?.skoda : undefined

  function setYear(y: number) {
    navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false })
  }

  function setVehicle(v: VehicleScope) {
    // The default scope is a clean URL. Another scope is another list: back to its first page.
    navigate({
      to: '.',
      search: (s) => ({ ...s, vehicle: vehicleScopeParam(v), page: undefined }),
      replace: true,
      resetScroll: false,
    })
  }

  return (
    <PageContainer>
      <ChargingHeading
        lastSuccessAt={health?.lastSuccessAt}
        live={<LiveStatusLine live={live} />}
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
          retrying={syncNow.isPendingFor('zaptec') || health.running}
        />
      ) : null}
      {/* Admin-only until prices are shown on the page: a household member
          can't see or act on the price feed, so its health is noise to them. */}
      {isAdmin && pricesHealth ? (
        <SyncHealthAlert
          health={pricesHealth}
          isAdmin
          settingsLink
          onRetry={() => syncNow.syncSource('elpris')}
          retrying={syncNow.isPendingFor('elpris') || pricesHealth.running}
        />
      ) : null}
      {/* Admin-only like prices: a household member can't act on the car feed. */}
      {isAdmin && skodaHealth ? (
        <SyncHealthAlert
          health={skodaHealth}
          isAdmin
          settingsLink
          onRetry={() => syncNow.syncSource('skoda')}
          retrying={syncNow.isPendingFor('skoda') || skodaHealth.running}
        />
      ) : null}
      {isAdmin && skodaHealth?.state === 'ok' ? (
        <CredentialExpiryAlert
          expiry={skodaHealth.adminDetail?.credentialExpiry ?? null}
          settingsLink
        />
      ) : null}

      {/* The page filter: everything below it down to the sessions is scoped,
          and it stays when a scoped read fails, so the user can switch back. */}
      <VehicleScopeToggle value={vehicle} onChange={setVehicle} />

      {overview && costNotice && !shapePending ? (
        <CostNotice reason={costNotice} canAddTariff={isAdmin} />
      ) : null}
      <SectionSkeleton name="charging-totals" loading={shapePending} fallbackHeight="7rem">
        {overview ? (
          <section className="flex flex-col gap-2">
            <h2 className="sr-only">{m.charging_totals_heading()}</h2>
            <div
              aria-busy={overviewStale}
              className={overviewStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}
            >
              <TotalsTiles
                tiles={overview.tiles}
                cost={showCost ? cost?.tiles : undefined}
                houseData={cost?.houseDataFrom != null}
              />
            </div>
          </section>
        ) : null}
      </SectionSkeleton>
      <SectionSkeleton name="charging-chart" loading={shapePending} fallbackHeight="20rem">
        {overview ? (
          <section className="@container flex flex-col gap-2">
            {/* Wide: title left, controls grouped right. Narrow: the title on its
                own line and the controls spread edge to edge beneath it. */}
            <div className="flex @2xl:flex-row flex-col @2xl:items-center @2xl:justify-between gap-2">
              <h2 className="font-medium text-sm">
                {showingCost ? m.charging_chart_title_cost() : m.charging_chart_title()}
              </h2>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {chartCost ? (
                  <MetricToggle
                    value={chartMetric}
                    options={chartMetricOptions()}
                    onChange={setChartMetric}
                    aria-label={m.charging_chart_metric_label()}
                  />
                ) : null}
                <YearSelector years={overview.years} value={overview.year} onChange={setYear} />
              </div>
            </div>
            {overview.months.some((mo) => mo.kwh > 0) ? (
              // Dimmed while the kr view still shows the previous year's cost.
              <div
                aria-busy={showingCost && costIsStale}
                className={showingCost && costIsStale ? 'opacity-60 transition-opacity' : undefined}
              >
                <MonthlyChart months={overview.months} cost={chartCost} metric={chartMetric} />
              </div>
            ) : (
              <div className="flex h-[260px] items-center justify-center rounded-lg border text-muted-foreground text-sm">
                {vehicle === 'other'
                  ? m.charging_vehicle_chart_empty_other({ year: overview.year })
                  : m.charging_chart_empty({ year: overview.year })}
              </div>
            )}
          </section>
        ) : null}
      </SectionSkeleton>
      {overview && showCost ? (
        <PriceFootnote coverage={{ houseDataFrom: cost?.houseDataFrom ?? null }} />
      ) : null}
      <LoadErrorAlert title={m.charging_overview_error_title()} query={overviewResult} />

      <section className="flex flex-col gap-2">
        <h2
          ref={paging.headingRef}
          tabIndex={-1}
          className="scroll-mt-4 rounded-sm font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {m.charging_sessions_heading()}
        </h2>
        {/* An error must never read as "no sessions" (ADR-0016). A page that
            failed to load keeps the last page on screen below the alert,
            dimmed, so the pagination control stays for another try. */}
        <LoadErrorAlert title={m.charging_sessions_error_title()} query={sessions} />
        {/* The skeleton only while nothing has loaded yet: another page or scope
            keeps the current rows on screen, dimmed (placeholder data). */}
        <SectionSkeleton
          name="charging-sessions"
          loading={firstLoadPending(sessions)}
          fallbackHeight="24rem"
        >
          {shownSessions ? (
            // Not rendered before the first result: an unseeded query (failed SSR
            // prefetch) must not flash "no sessions" (ADR-0016).
            <div
              aria-busy={sessionsStale && !loadFailed(sessions)}
              className={sessionsStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}
            >
              <SessionList
                sessions={shownSessions.sessions}
                pagination={
                  // All from the page on screen, the one the server served: a stale
                  // `?page=` past the end shows as the last.
                  <SessionPagination
                    page={shownSessions.page}
                    pageSize={shownSessions.pageSize}
                    total={shownSessions.total}
                    onPageChange={paging.setPage}
                    onPageSizeChange={paging.setPageSize}
                  />
                }
                costs={showCost ? { byId: sessionCosts, pending: sessionCostsPending } : undefined}
                // A sync can't create guest sessions: an admin marks them instead.
                onSync={
                  isAdmin && vehicle !== 'other' ? () => syncNow.syncSource('zaptec') : undefined
                }
                syncing={syncNow.isPendingFor('zaptec')}
                emptyTitle={
                  vehicle === 'other' ? m.charging_vehicle_sessions_empty_other() : undefined
                }
                emptyDescription={
                  vehicle === 'other' ? m.charging_vehicle_empty_other_description() : undefined
                }
              />
            </div>
          ) : null}
        </SectionSkeleton>
      </section>
    </PageContainer>
  )
}
