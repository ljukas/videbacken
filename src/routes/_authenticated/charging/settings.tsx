import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { lazy, useEffect } from 'react'
import { z } from 'zod'
import { healthPoll } from '~/components/evCharging/healthPoll'
import {
  SkodaSourceDetails,
  VehicleLogImportButton,
} from '~/components/evCharging/SkodaSourceDetails'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending, LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// The charging section's admin page: every data source's state, sync and
// history (Datakällor), the car's log import, and the tariff periods the cost
// is priced with. Moved off the overview, which keeps only the alerts.
const searchSchema = z.object({
  // Dialogs (ADR-0013): tariff new (pre-filled from the newest period), edit,
  // delete; the car's log import; one data source's sync history.
  dialog: z
    .enum(['tariffNew', 'tariffEdit', 'tariffDelete', 'vehicleImport', 'syncRuns'])
    .optional()
    .catch(undefined),
  tariffId: z.string().optional().catch(undefined),
  // The data source whose sync history is open (`dialog=syncRuns`).
  source: z.enum(INTEGRATION_SOURCES).optional().catch(undefined),
})
type SettingsSearch = z.infer<typeof searchSchema>
type SettingsDialog = NonNullable<SettingsSearch['dialog']>

// Admin-only: loads on first open (LazyDialogMount), so a member never fetches the form code;
// an admin warms the chunks once the browser is idle (useIdlePreload).
const loadTariffDialog = () => import('~/components/evCharging/TariffDialog')
const TariffDialog = lazy(() => loadTariffDialog().then((mod) => ({ default: mod.TariffDialog })))
const loadVehicleImportDialog = () => import('~/components/evCharging/VehicleImportDialog')
const VehicleImportDialog = lazy(() =>
  loadVehicleImportDialog().then((mod) => ({ default: mod.VehicleImportDialog })),
)
const loadDeleteTariffDialog = () => import('~/components/evCharging/DeleteTariffDialog')
const DeleteTariffDialog = lazy(() =>
  loadDeleteTariffDialog().then((mod) => ({ default: mod.DeleteTariffDialog })),
)
const ADMIN_DIALOG_LOADERS = [loadTariffDialog, loadVehicleImportDialog, loadDeleteTariffDialog]

const RECENT_RUNS = 20

const runsQuery = orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } })
const vehicleCoverageQuery = orpc.evCharging.vehicleRecordCoverage.queryOptions()
const vehicleLatestQuery = orpc.evCharging.vehicleStateLatest.queryOptions()

export const Route = createFileRoute('/_authenticated/charging/settings')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_settings_title(),
      description: m.meta_charging_settings_description(),
    }),
  }),
  // Admins only: a member lands on the overview instead (before the loader, so
  // no admin read is ever fired for them).
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/charging', replace: true })
  },
  validateSearch: searchSchema,
  // ADR-0025: the server waits for what the first paint shows; the client waits
  // for nothing (sections show skeletons). Critical: each source's state (the
  // tiles at the top) and the tariff periods (the card, and a tariff dialog's
  // deep link). Deferred: the diagnostics inside the tiles, the sync histories,
  // the car's latest state and the log coverage. A failed read never throws
  // here: it shows on its tile, in its history overlay or as the tariff card's
  // alert, each with a retry.
  loader: async ({ context: { queryClient } }) => {
    await loadRouteData(queryClient, {
      critical: [syncHealthQuery, orpc.tariff.list.queryOptions()],
      deferred: [runsQuery, vehicleCoverageQuery, vehicleLatestQuery],
    })
  },
  component: ChargingSettingsPage,
})

function ChargingSettingsPage() {
  useIdlePreload(true, ADMIN_DIALOG_LOADERS)
  const navigate = Route.useNavigate()
  const syncNow = useSyncNow()
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const tariffId = Route.useSearch({ select: (s) => s.tariffId })
  const runsSource = Route.useSearch({ select: (s) => s.source })
  const { isOpen, open, close } = useUrlDialog<SettingsDialog, SettingsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['tariffId', 'source'],
  })
  const tariffsResult = useQuery(orpc.tariff.list.queryOptions())
  const tariffs = tariffsResult.data
  const selectedTariff = tariffs?.find((t) => t.id === tariffId)
  // A dialog that can't show (a tariffId that no longer exists; a sync history
  // without a valid source) is cleared from the URL instead of lingering there.
  // A tariff dialog is only judged once the tariffs are known.
  const dialogUnavailable =
    dialog !== undefined &&
    (dialog === 'syncRuns'
      ? runsSource === undefined
      : dialog !== 'tariffNew' &&
        dialog !== 'vehicleImport' &&
        tariffs !== undefined && // still loading: not "gone" yet
        !selectedTariff)
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
  const tariffDialogOpen =
    tariffs !== undefined &&
    (isOpen('tariffNew') || (isOpen('tariffEdit') && selectedTariff !== undefined))
  const deleteTariffOpen = isOpen('tariffDelete') && selectedTariff !== undefined

  // Every source's state in one read, polled together (ADR-0018: polled), so a
  // tile's "running" state (a cron run seen mid-flight) clears on its own.
  const healthResult = useQuery({
    ...syncHealthQuery,
    refetchInterval: healthPoll(INTEGRATION_SOURCES.some((source) => syncNow.isPendingFor(source))),
  })
  const sourcesHealth = healthResult.data
  // Datakällor waits for the sources' state: a tile without one would read
  // "Okänd status", which is not the same as still loading (ADR-0016).
  const sourcesPending = firstLoadPending(healthResult)
  // Every source's history is one read; each tile reads its own slice, and a
  // failed read shows on each history with its retry.
  const zaptecRuns = useQuery({ ...runsQuery, select: (runs) => runs.zaptec })
  const pricesRuns = useQuery({ ...runsQuery, select: (runs) => runs.elpris })
  const skodaRuns = useQuery({ ...runsQuery, select: (runs) => runs.skoda })
  const emaldoRuns = useQuery({ ...runsQuery, select: (runs) => runs.emaldo })
  const vehicleCoverage = useQuery(vehicleCoverageQuery)
  const vehicleLatest = useQuery(vehicleLatestQuery)

  return (
    <PageContainer>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
            {m.charging_settings_title()}
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm">
            {m.charging_settings_description()}
          </p>
        </div>
        <div className="shrink-0">
          <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} />
        </div>
      </header>

      {/* One read covers every source: when it fails, say so with a retry,
          above the tiles that then read "Okänd status" (ADR-0016). */}
      <LoadErrorAlert title={m.charging_sources_error_title()} query={healthResult} />
      <SectionSkeleton name="charging-sources" loading={sourcesPending} fallbackHeight="20rem">
        <SyncSourcesPanel
          entries={[
            { source: 'zaptec', health: sourcesHealth?.zaptec, runs: zaptecRuns },
            { source: 'elpris', health: sourcesHealth?.elpris, runs: pricesRuns },
            {
              source: 'skoda',
              health: sourcesHealth?.skoda,
              runs: skodaRuns,
              // The car's log and live poll are one source to the admin: its last
              // contact, key expiry and log (+ import) live on its tile. A failed
              // read shows an error there, never "none".
              details: (
                <SkodaSourceDetails
                  live={vehicleLatest.data}
                  liveQuery={vehicleLatest}
                  keyExpiry={sourcesHealth?.skoda?.adminDetail?.credentialExpiry ?? null}
                  coverage={vehicleCoverage.data}
                  coverageQuery={vehicleCoverage}
                />
              ),
              actions: <VehicleLogImportButton onImport={() => open('vehicleImport')} />,
            },
            { source: 'emaldo', health: sourcesHealth?.emaldo, runs: emaldoRuns },
          ]}
          onSync={syncNow.syncSource}
          isPendingFor={syncNow.isPendingFor}
          openSource={isOpen('syncRuns') ? runsSource : undefined}
          onOpenHistory={(source: IntegrationSource) => open('syncRuns', { source })}
          onCloseHistory={close}
        />
      </SectionSkeleton>

      <SectionSkeleton
        name="charging-tariffs"
        loading={firstLoadPending(tariffsResult)}
        fallbackHeight="10rem"
      >
        {tariffs ? (
          <TariffCard
            tariffs={tariffs}
            admin={{
              onNew: () => open('tariffNew'),
              onEdit: (id) => open('tariffEdit', { tariffId: id }),
              onDelete: (id) => open('tariffDelete', { tariffId: id }),
            }}
          />
        ) : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_tariff_error_title()} query={tariffsResult} />

      {/* Waits for the tariffs: "new" starts from the newest period's
          amounts, and the form keeps the defaults it mounted with. */}
      <LazyDialogMount open={tariffDialogOpen}>
        <TariffDialog
          open={tariffDialogOpen}
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
      </LazyDialogMount>
      <LazyDialogMount open={isOpen('vehicleImport')}>
        <VehicleImportDialog
          open={isOpen('vehicleImport')}
          onOpenChange={(o) => {
            if (!o) close()
          }}
        />
      </LazyDialogMount>
      <LazyDialogMount open={deleteTariffOpen}>
        <DeleteTariffDialog
          open={deleteTariffOpen}
          tariff={selectedTariff}
          onOpenChange={(o) => {
            if (!o) close()
          }}
        />
      </LazyDialogMount>
    </PageContainer>
  )
}
