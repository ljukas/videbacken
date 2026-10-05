import { environmentManager, keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { CostNotice, type CostNoticeReason } from '~/components/evCharging/CostNotice'
import { CredentialExpiryAlert } from '~/components/evCharging/CredentialExpiryAlert'
import { DeleteTariffDialog } from '~/components/evCharging/DeleteTariffDialog'
import { healthPoll } from '~/components/evCharging/healthPoll'
import { LiveStatusLine, useLiveStatus } from '~/components/evCharging/LiveStatusLine'
import {
  firstLoadPending,
  LoadErrorAlert,
  loadFailed,
} from '~/components/evCharging/LoadErrorAlert'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import {
  type ChartMetric,
  chartMetricOptions,
  MonthlyChart,
} from '~/components/evCharging/MonthlyChart'
import { PriceFootnote } from '~/components/evCharging/PriceFootnote'
import { SessionList } from '~/components/evCharging/SessionList'
import { SessionPagination } from '~/components/evCharging/SessionPagination'
import {
  SkodaSourceDetails,
  VehicleLogImportButton,
} from '~/components/evCharging/SkodaSourceDetails'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { TariffDialog } from '~/components/evCharging/TariffDialog'
import { TotalsTiles } from '~/components/evCharging/TotalsTiles'
import { VehicleImportDialog } from '~/components/evCharging/VehicleImportDialog'
import { VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { useSessionPaging } from '~/hooks/useSessionPaging'
import { useUrlDialog } from '~/hooks/useUrlDialog'
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
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// Same bounds as the `overview` procedure input; an out-of-range or garbage
// `?year=` falls back to the current year instead of erroring the loader.
const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  // Dialogs (ADR-0013): tariff new (optionally pre-filled), edit, delete; the
  // car's log import; one data source's sync history.
  dialog: z
    .enum(['tariffNew', 'tariffEdit', 'tariffDelete', 'vehicleImport', 'syncRuns'])
    .optional()
    .catch(undefined),
  tariffId: z.string().optional().catch(undefined),
  // The data source whose sync history is open (`dialog=syncRuns`).
  source: z.enum(INTEGRATION_SOURCES).optional().catch(undefined),
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
  // The session list's page and rows per page: a clean URL is its first 10.
  ...sessionPagingSearch.shape,
})
type ChargingSearch = z.infer<typeof searchSchema>
type ChargingDialog = NonNullable<ChargingSearch['dialog']>

const RECENT_RUNS = 20

const sessionsQuery = (page: number, pageSize: SessionPageSize, vehicle: VehicleScope) =>
  orpc.evCharging.sessions.queryOptions({ input: { page, pageSize, vehicle } })
const sessionCostsQuery = (sessionIds: string[]) =>
  orpc.evCharging.sessionCosts.queryOptions({ input: { sessionIds } })
// Spot price sync (elpris). Zaptec's keep their input-less calls, so their
// query keys are unchanged; prices always pass their source.
const pricesHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } })
const vehicleCoverageQuery = orpc.evCharging.vehicleRecordCoverage.queryOptions()
const pricesRunsQuery = orpc.evCharging.recentRuns.queryOptions({
  input: { source: 'elpris', limit: RECENT_RUNS },
})
// The car's live-state poll (Škoda), admin-only.
const skodaHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } })
const skodaRunsQuery = orpc.evCharging.recentRuns.queryOptions({
  input: { source: 'skoda', limit: RECENT_RUNS },
})
// The house's energy flows (Emaldo), admin-only like the car feed.
const emaldoHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'emaldo' } })
const emaldoRunsQuery = orpc.evCharging.recentRuns.queryOptions({
  input: { source: 'emaldo', limit: RECENT_RUNS },
})
const vehicleLatestQuery = orpc.evCharging.vehicleStateLatest.queryOptions()
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
  // for nothing (sections show skeletons). Datakällor's histories, the car's
  // latest state and the log coverage sit at the bottom, so they're deferred.
  loader: async ({ context: { queryClient, user }, deps, location }) => {
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
    const admin = user.role === 'admin'
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
        orpc.evCharging.syncStatus.queryOptions(),
        // The sources' health drives the alerts at the top: awaited on the server,
        // so a first load renders them in place. On a client navigation a failing
        // source's alert can appear a moment later (rare, and it needs attention).
        admin && pricesHealthQuery,
        admin && skodaHealthQuery,
        admin && emaldoHealthQuery,
      ],
      deferred: [
        admin && orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
        admin && pricesRunsQuery,
        admin && skodaRunsQuery,
        admin && emaldoRunsQuery,
        admin && vehicleCoverageQuery,
        admin && vehicleLatestQuery,
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
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const tariffId = Route.useSearch({ select: (s) => s.tariffId })
  const runsSource = Route.useSearch({ select: (s) => s.source })
  const { isOpen, open, close } = useUrlDialog<ChargingDialog, ChargingSearch>({
    current: dialog,
    navigate,
    clearKeys: ['tariffId', 'source'],
  })
  const tariffsResult = useQuery(orpc.tariff.list.queryOptions())
  const tariffs = tariffsResult.data
  const selectedTariff = tariffs?.find((t) => t.id === tariffId)
  // A dialog that can't show (a non-admin; a tariffId that no longer exists;
  // a sync history without a valid source) is cleared from the URL instead of
  // lingering there. A tariff dialog is only judged once the tariffs are known.
  const dialogUnavailable =
    dialog !== undefined &&
    (!isAdmin ||
      (dialog === 'syncRuns'
        ? runsSource === undefined
        : dialog !== 'tariffNew' &&
          dialog !== 'vehicleImport' &&
          tariffs !== undefined && // still loading: not "gone" yet
          !selectedTariff))
  useEffect(() => {
    // `replace`, so Back doesn't return to the bad URL (and bounce again).
    if (dialogUnavailable) {
      navigate({
        to: '.',
        replace: true,
        resetScroll: false,
        search: (prev) => ({ ...prev, dialog: undefined, tariffId: undefined, source: undefined }),
      })
    }
  }, [dialogUnavailable, navigate])
  // "Ny period" starts from the newest period's amounts (the list is oldest first).
  const latestTariff = tariffs?.at(-1)

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
  const healthResult = useQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    // Members read only the alert: a plain minute. Admins also watch "Synkar…".
    refetchInterval: isAdmin ? healthPoll(syncNow.isPendingFor('zaptec')) : 60_000,
  })
  // Admin-only (see the alerts and the Datakällor panel below). Polled like
  // Zaptec's, so a tile's "running" state (a cron run seen mid-flight) clears
  // on its own instead of waiting for a focus refetch (ADR-0018: polled).
  const pricesHealthResult = useQuery({
    ...pricesHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll(syncNow.isPendingFor('elpris')),
  })
  const live = useLiveStatus()
  const zaptecRuns = useQuery({
    ...orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
    enabled: isAdmin,
  })
  const pricesRuns = useQuery({ ...pricesRunsQuery, enabled: isAdmin })
  const vehicleCoverage = useQuery({ ...vehicleCoverageQuery, enabled: isAdmin })
  const skodaHealthResult = useQuery({
    ...skodaHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll(syncNow.isPendingFor('skoda')),
  })
  const skodaRuns = useQuery({ ...skodaRunsQuery, enabled: isAdmin })
  const emaldoHealthResult = useQuery({
    ...emaldoHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll(syncNow.isPendingFor('emaldo')),
  })
  const emaldoRuns = useQuery({ ...emaldoRunsQuery, enabled: isAdmin })
  const vehicleLatest = useQuery({ ...vehicleLatestQuery, enabled: isAdmin })
  const health = healthResult.data
  const pricesHealth = pricesHealthResult.data
  const skodaHealth = skodaHealthResult.data
  const emaldoHealth = emaldoHealthResult.data
  // Datakällor waits for every source's state: a tile without one would read
  // "Okänd status", which is not the same as still loading (ADR-0016).
  const sourcesPending =
    firstLoadPending(healthResult) ||
    firstLoadPending(pricesHealthResult) ||
    firstLoadPending(skodaHealthResult) ||
    firstLoadPending(emaldoHealthResult)

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
          onRetry={() => syncNow.syncSource('elpris')}
          retrying={syncNow.isPendingFor('elpris') || pricesHealth.running}
        />
      ) : null}
      {/* Admin-only like prices: a household member can't act on the car feed. */}
      {isAdmin && skodaHealth ? (
        <SyncHealthAlert
          health={skodaHealth}
          isAdmin
          onRetry={() => syncNow.syncSource('skoda')}
          retrying={syncNow.isPendingFor('skoda') || skodaHealth.running}
        />
      ) : null}
      {isAdmin && skodaHealth?.state === 'ok' ? (
        <CredentialExpiryAlert expiry={skodaHealth.adminDetail?.credentialExpiry ?? null} />
      ) : null}

      {/* The page filter: everything below it down to the sessions is scoped,
          and it stays when a scoped read fails, so the user can switch back. */}
      <VehicleScopeToggle value={vehicle} onChange={setVehicle} />

      {overview && costNotice && !shapePending ? (
        <CostNotice
          reason={costNotice}
          onAddTariff={isAdmin ? () => open('tariffNew') : undefined}
        />
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

      <SectionSkeleton
        name="charging-tariffs"
        loading={firstLoadPending(tariffsResult)}
        fallbackHeight="10rem"
      >
        {tariffs ? (
          <TariffCard
            tariffs={tariffs}
            admin={
              isAdmin
                ? {
                    onNew: () => open('tariffNew'),
                    onEdit: (id) => open('tariffEdit', { tariffId: id }),
                    onDelete: (id) => open('tariffDelete', { tariffId: id }),
                  }
                : undefined
            }
          />
        ) : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_tariff_error_title()} query={tariffsResult} />

      {/* Every data source's state, sync and history. Emaldo's state lives only
          here, not as an alert up top: nothing on the page uses the house data
          yet (ADR-0023, step 4), and it reads not_configured wherever EMALDO_*
          is unset. */}
      {isAdmin ? (
        <SectionSkeleton name="charging-sources" loading={sourcesPending} fallbackHeight="20rem">
          <SyncSourcesPanel
            entries={[
              { source: 'zaptec', health, runs: zaptecRuns },
              { source: 'elpris', health: pricesHealth, runs: pricesRuns },
              {
                source: 'skoda',
                health: skodaHealth,
                runs: skodaRuns,
                // The car's log and live poll are one source to the admin: its last
                // contact, key expiry and log (+ import) live on its tile. Prefetched
                // by the loader; a failed read shows an error, never "none".
                details: (
                  <SkodaSourceDetails
                    live={vehicleLatest.data}
                    liveQuery={vehicleLatest}
                    keyExpiry={skodaHealth?.adminDetail?.credentialExpiry ?? null}
                    coverage={vehicleCoverage.data}
                    coverageQuery={vehicleCoverage}
                  />
                ),
                actions: <VehicleLogImportButton onImport={() => open('vehicleImport')} />,
              },
              { source: 'emaldo', health: emaldoHealth, runs: emaldoRuns },
            ]}
            onSync={syncNow.syncSource}
            isPendingFor={syncNow.isPendingFor}
            openSource={isOpen('syncRuns') ? runsSource : undefined}
            onOpenHistory={(source: IntegrationSource) => open('syncRuns', { source })}
            onCloseHistory={close}
          />
        </SectionSkeleton>
      ) : null}

      {isAdmin ? (
        <>
          {/* Waits for the tariffs: "new" starts from the newest period's
              amounts, and the form keeps the defaults it mounted with. */}
          <TariffDialog
            open={
              tariffs !== undefined &&
              (isOpen('tariffNew') || (isOpen('tariffEdit') && selectedTariff !== undefined))
            }
            mode={
              isOpen('tariffEdit') && selectedTariff
                ? { kind: 'edit', tariff: selectedTariff }
                : isOpen('tariffNew') && tariffs !== undefined
                  ? { kind: 'new', from: latestTariff }
                  : undefined
            }
            onOpenChange={(o) => {
              if (!o) close()
            }}
          />
          <VehicleImportDialog
            open={isOpen('vehicleImport')}
            onOpenChange={(o) => {
              if (!o) close()
            }}
          />
          <DeleteTariffDialog
            open={isOpen('tariffDelete') && selectedTariff !== undefined}
            tariff={selectedTariff}
            onOpenChange={(o) => {
              if (!o) close()
            }}
          />
        </>
      ) : null}
    </PageContainer>
  )
}
