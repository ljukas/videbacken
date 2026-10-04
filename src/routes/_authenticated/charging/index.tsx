import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { CostNotice, type CostNoticeReason } from '~/components/evCharging/CostNotice'
import { CredentialExpiryAlert } from '~/components/evCharging/CredentialExpiryAlert'
import { DeleteTariffDialog } from '~/components/evCharging/DeleteTariffDialog'
import { LiveStatusTile, useLiveStatus } from '~/components/evCharging/LiveStatusTile'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import {
  type ChartMetric,
  chartMetricOptions,
  MonthlyChart,
} from '~/components/evCharging/MonthlyChart'
import { PriceFootnote } from '~/components/evCharging/PriceFootnote'
import { SessionList } from '~/components/evCharging/SessionList'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { TariffDialog } from '~/components/evCharging/TariffDialog'
import { TotalsTiles } from '~/components/evCharging/TotalsTiles'
import { VehicleImportDialog } from '~/components/evCharging/VehicleImportDialog'
import { VehicleLogCard } from '~/components/evCharging/VehicleLogCard'
import { scopeNote, VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { type VehicleScope, vehicleScope } from '~/lib/evCharging/vehicle'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
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
  // Whose charging: a clean URL means our car.
  vehicle: vehicleScope.optional().catch(undefined),
})
type ChargingSearch = z.infer<typeof searchSchema>
type ChargingDialog = NonNullable<ChargingSearch['dialog']>

const SESSIONS_PAGE = 20
const SESSIONS_MAX = 500 // the `sessions` procedure's `limit` cap
const RECENT_RUNS = 20

const sessionsQuery = (limit: number, vehicle: VehicleScope) =>
  orpc.evCharging.sessions.queryOptions({ input: { limit, vehicle } })
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
// Sync health polls every minute, every 5 s while a run is in flight (a run's
// lease lasts at most 5 min), so "Synkar…" clears soon after the run ends.
const healthPoll = (query: { state: { data?: { running: boolean } } }) =>
  query.state.data?.running ? 5_000 : 60_000

export const Route = createFileRoute('/_authenticated/charging/')({
  head: () => ({
    meta: seo({ title: m.meta_charging_title(), description: m.meta_charging_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year, vehicle: search.vehicle ?? 'ours' }),
  loader: async ({ context: { queryClient, user }, deps }) => {
    await Promise.all([
      // Prefetched, not ensured: a failed read must not take down the page (and
      // with it the scope toggle) — the component shows an alert with a retry.
      queryClient.prefetchQuery(
        orpc.evCharging.overview.queryOptions({
          input: { year: deps.year, vehicle: deps.vehicle },
        }),
      ),
      // Cost is best-effort: prefetchQuery never throws, so a price/tariff
      // failure degrades only the cost figures, never the page. Awaited so the
      // tiles render with their kronor headline instead of jumping when it
      // arrives; the sessions' costs follow the sessions (they need the ids).
      // Prefetched too (a failed read must not unmount the scope toggle); the
      // costs chain reads the sessions back from the cache.
      queryClient.prefetchQuery(sessionsQuery(SESSIONS_PAGE, deps.vehicle)).then(() => {
        const sessions = queryClient.getQueryData(
          sessionsQuery(SESSIONS_PAGE, deps.vehicle).queryKey,
        )?.sessions
        return sessions?.length
          ? queryClient.prefetchQuery(sessionCostsQuery(sessions.map((sess) => sess.id)))
          : undefined
      }),
      queryClient.prefetchQuery(
        orpc.evCharging.costOverview.queryOptions({
          input: { year: deps.year, vehicle: deps.vehicle },
        }),
      ),
      queryClient.ensureQueryData(orpc.tariff.list.queryOptions()),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
      user.role === 'admin' ? queryClient.ensureQueryData(pricesHealthQuery) : null,
      // Sync histories are diagnostics behind the Datakällor overlay: prefetched,
      // so a failed read shows there (with a retry) and never takes the page down.
      user.role === 'admin'
        ? queryClient.prefetchQuery(
            orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
          )
        : null,
      user.role === 'admin' ? queryClient.prefetchQuery(pricesRunsQuery) : null,
      // Prefetched: a failed read shows in its card, it must not take the page down.
      user.role === 'admin' ? queryClient.prefetchQuery(vehicleCoverageQuery) : null,
      // Prefetched too: a failed car read must not take the page down.
      user.role === 'admin' ? queryClient.prefetchQuery(skodaHealthQuery) : null,
      user.role === 'admin' ? queryClient.prefetchQuery(skodaRunsQuery) : null,
      user.role === 'admin' ? queryClient.prefetchQuery(emaldoHealthQuery) : null,
      user.role === 'admin' ? queryClient.prefetchQuery(emaldoRunsQuery) : null,
      user.role === 'admin' ? queryClient.prefetchQuery(vehicleLatestQuery) : null,
    ])
  },
  component: ChargingPage,
})

function ChargingPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const navigate = Route.useNavigate()
  const year = Route.useSearch({ select: (s) => s.year })
  const vehicle = Route.useSearch({ select: (s) => s.vehicle ?? 'ours' })
  const queryClient = useQueryClient()
  // The page size belongs to the scope it was grown in: another scope starts at its first page.
  const [limitState, setLimitState] = useState({ vehicle, limit: SESSIONS_PAGE })
  const sessionLimit = limitState.vehicle === vehicle ? limitState.limit : SESSIONS_PAGE
  const syncNow = useSyncNow()
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const tariffId = Route.useSearch({ select: (s) => s.tariffId })
  const runsSource = Route.useSearch({ select: (s) => s.source })
  const { isOpen, open, close } = useUrlDialog<ChargingDialog, ChargingSearch>({
    current: dialog,
    navigate,
    clearKeys: ['tariffId', 'source'],
  })
  const { data: tariffs } = useSuspenseQuery(orpc.tariff.list.queryOptions())
  const selectedTariff = tariffs.find((t) => t.id === tariffId)
  // A dialog that can't show (a non-admin; a tariffId that no longer exists;
  // a sync history without a valid source) is cleared from the URL instead of
  // lingering there.
  const dialogUnavailable =
    dialog !== undefined &&
    (!isAdmin ||
      (dialog === 'syncRuns'
        ? runsSource === undefined
        : dialog !== 'tariffNew' && dialog !== 'vehicleImport' && !selectedTariff))
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
  const latestTariff = tariffs.at(-1)

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
    ...sessionsQuery(sessionLimit, vehicle),
    placeholderData: keepPreviousData, // never flash the empty state while another scope loads
  })
  const { data: cost, isPlaceholderData: costIsStale } = useQuery({
    ...orpc.evCharging.costOverview.queryOptions({ input: { year, vehicle } }),
    placeholderData: keepPreviousData,
  })
  // Cost is shown once anything at all is priced in the chosen scope (all-time,
  // so a year switch doesn't flicker the kr toggle away; a scope with nothing
  // priced, e.g. guests, shows the notice instead); until then one notice says why.
  const showCost = tariffs.length > 0 && cost?.tiles.allTime.avgOre != null
  const hasEnergy = (overview?.tiles.allTime.kwh ?? 0) > 0
  const costNotice: CostNoticeReason | null = !hasEnergy
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
    () => sessions.data?.sessions.map((sess) => sess.id) ?? [],
    [sessions.data],
  )
  const sessionCostsResult = useQuery({
    ...sessionCostsQuery(sessionIds),
    enabled: sessionIds.length > 0,
    placeholderData: keepPreviousData,
  })
  const sessionCostList = sessionCostsResult.data
  // Rows still waiting for their cost (first load, or new rows after "Visa
  // fler") show a placeholder, not the "missing" dash.
  const sessionCostsPending = sessionCostsResult.isPending || sessionCostsResult.isPlaceholderData
  const sessionCosts = useMemo(
    () => new Map(sessionCostList?.map((c) => [c.sessionId, c])),
    [sessionCostList],
  )
  const { data: health } = useSuspenseQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    // Members read only the alert: a plain minute. Admins also watch "Synkar…".
    refetchInterval: isAdmin ? healthPoll : 60_000,
  })
  // Admin-only (see the alerts and the Datakällor panel below). Polled like
  // Zaptec's, so a tile's "running" state (a cron run seen mid-flight) clears
  // on its own instead of waiting for a focus refetch (ADR-0018: polled).
  const { data: pricesHealth } = useQuery({
    ...pricesHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll,
  })
  const live = useLiveStatus()
  const zaptecRuns = useQuery({
    ...orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
    enabled: isAdmin,
  })
  const pricesRuns = useQuery({ ...pricesRunsQuery, enabled: isAdmin })
  const vehicleCoverage = useQuery({ ...vehicleCoverageQuery, enabled: isAdmin })
  const { data: skodaHealth } = useQuery({
    ...skodaHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll,
  })
  const skodaRuns = useQuery({ ...skodaRunsQuery, enabled: isAdmin })
  const { data: emaldoHealth } = useQuery({
    ...emaldoHealthQuery,
    enabled: isAdmin,
    refetchInterval: healthPoll,
  })
  const emaldoRuns = useQuery({ ...emaldoRunsQuery, enabled: isAdmin })
  const vehicleLatest = useQuery({ ...vehicleLatestQuery, enabled: isAdmin })

  // "Visa fler" fetches the longer page first and only then switches to it, so
  // a failed fetch leaves the rows on screen (with a toast; the button stays
  // for a retry) instead of swapping the list for an errored, empty query.
  const showMore = useMutation({
    mutationFn: ({ limit, scope }: { limit: number; scope: VehicleScope }) =>
      queryClient.fetchQuery(sessionsQuery(limit, scope)),
    // Keyed to the scope it was fetched for: a result that lands after a scope
    // switch can't leak its limit into the new scope.
    onSuccess: (_data, { limit, scope }) => setLimitState({ vehicle: scope, limit }),
    onError: () => toast.error(m.charging_sessions_show_more_failed()),
  })

  function setYear(y: number) {
    navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false })
  }

  function setVehicle(v: VehicleScope) {
    // A clean URL means our car.
    navigate({
      to: '.',
      search: (s) => ({ ...s, vehicle: v === 'ours' ? undefined : v }),
      replace: true,
      resetScroll: false,
    })
  }

  return (
    <PageContainer>
      <ChargingHeading
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
      {/* Admin-only until prices are shown on the page: a household member
          can't see or act on the price feed, so its health is noise to them. */}
      {isAdmin && pricesHealth ? (
        <SyncHealthAlert
          health={pricesHealth}
          isAdmin
          onRetry={() => syncNow.syncSource('elpris')}
          retrying={syncNow.isPendingFor('elpris')}
        />
      ) : null}
      {/* Admin-only like prices: a household member can't act on the car feed. */}
      {isAdmin && skodaHealth ? (
        <SyncHealthAlert
          health={skodaHealth}
          isAdmin
          onRetry={() => syncNow.syncSource('skoda')}
          retrying={syncNow.isPendingFor('skoda')}
        />
      ) : null}
      {isAdmin && skodaHealth?.state === 'ok' ? (
        <CredentialExpiryAlert expiry={skodaHealth.adminDetail?.credentialExpiry ?? null} />
      ) : null}

      <LiveStatusTile live={live} />

      {overview ? (
        <>
          {costNotice ? (
            <CostNotice
              reason={costNotice}
              onAddTariff={isAdmin ? () => open('tariffNew') : undefined}
            />
          ) : null}
          <section className="flex flex-col gap-2">
            <h2 className="sr-only">{m.charging_totals_heading()}</h2>
            <div
              aria-busy={overviewStale}
              className={overviewStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}
            >
              <TotalsTiles tiles={overview.tiles} cost={showCost ? cost?.tiles : undefined} />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium text-sm">
                {showingCost ? m.charging_chart_title_cost() : m.charging_chart_title()}
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {chartCost ? (
                  <MetricToggle
                    value={chartMetric}
                    options={chartMetricOptions()}
                    onChange={setChartMetric}
                    aria-label={m.charging_chart_metric_label()}
                  />
                ) : null}
                <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
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
          {showCost ? <PriceFootnote /> : null}
        </>
      ) : (
        <>
          {/* The scope stays switchable when its read fails, or the user can't switch back. */}
          <div className="flex justify-end">
            <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
          </div>
          <LoadErrorAlert title={m.charging_overview_error_title()} query={overviewResult} />
        </>
      )}

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

      {isAdmin ? (
        <VehicleLogCard
          // Prefetched by the loader; a failed read shows an error, never "none imported".
          coverage={vehicleCoverage.data}
          loadError={vehicleCoverage}
          onImport={() => open('vehicleImport')}
          live={vehicleLatest.data}
          liveLoadError={vehicleLatest}
          onSyncLive={() => syncNow.syncSource('skoda')}
          syncingLive={syncNow.isPendingFor('skoda')}
          keyExpiry={skodaHealth?.adminDetail?.credentialExpiry ?? null}
        />
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">{m.charging_sessions_heading()}</h2>
        {loadFailed(sessions) ? (
          // An error must never read as "no sessions" (ADR-0016).
          <LoadErrorAlert title={m.charging_sessions_error_title()} query={sessions} />
        ) : sessions.data ? (
          // Not rendered while pending: an unseeded query (failed SSR prefetch) must
          // not flash "no sessions" before its first result (ADR-0016).
          <SessionList
            sessions={sessions.data.sessions}
            hasMore={sessions.data.hasMore && sessionLimit < SESSIONS_MAX}
            onShowMore={() =>
              showMore.mutate({
                limit: Math.min(sessionLimit + SESSIONS_PAGE, SESSIONS_MAX),
                scope: vehicle,
              })
            }
            loadingMore={showMore.isPending}
            costs={showCost ? { byId: sessionCosts, pending: sessionCostsPending } : undefined}
            // A sync can't create guest sessions: an admin marks them instead.
            onSync={isAdmin && vehicle !== 'other' ? () => syncNow.syncSource('zaptec') : undefined}
            syncing={syncNow.isPendingFor('zaptec')}
            emptyTitle={vehicle === 'other' ? m.charging_vehicle_sessions_empty_other() : undefined}
            emptyDescription={
              vehicle === 'other' ? m.charging_vehicle_empty_other_description() : undefined
            }
          />
        ) : null}
      </section>

      {/* Every data source's state, sync and history. Emaldo's state lives only
          here, not as an alert up top: nothing on the page uses the house data
          yet (ADR-0023, step 4), and it reads not_configured wherever EMALDO_*
          is unset. */}
      {isAdmin ? (
        <SyncSourcesPanel
          entries={[
            { source: 'zaptec', health, runs: zaptecRuns },
            { source: 'elpris', health: pricesHealth, runs: pricesRuns },
            { source: 'skoda', health: skodaHealth, runs: skodaRuns },
            { source: 'emaldo', health: emaldoHealth, runs: emaldoRuns },
          ]}
          onSync={syncNow.syncSource}
          isPendingFor={syncNow.isPendingFor}
          openSource={isOpen('syncRuns') ? runsSource : undefined}
          onOpenHistory={(source: IntegrationSource) => open('syncRuns', { source })}
          onCloseHistory={close}
        />
      ) : null}

      {isAdmin ? (
        <>
          <TariffDialog
            open={isOpen('tariffNew') || (isOpen('tariffEdit') && selectedTariff !== undefined)}
            mode={
              isOpen('tariffEdit') && selectedTariff
                ? { kind: 'edit', tariff: selectedTariff }
                : isOpen('tariffNew')
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
