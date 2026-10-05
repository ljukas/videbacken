import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { DeleteTariffDialog } from '~/components/evCharging/DeleteTariffDialog'
import { healthPoll } from '~/components/evCharging/healthPoll'
import {
  SkodaSourceDetails,
  VehicleLogImportButton,
} from '~/components/evCharging/SkodaSourceDetails'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { TariffDialog } from '~/components/evCharging/TariffDialog'
import { VehicleImportDialog } from '~/components/evCharging/VehicleImportDialog'
import { PageContainer } from '~/components/layout/PageContainer'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
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

const RECENT_RUNS = 20

// Zaptec's keep their input-less calls, so they share the overview's cache
// entries; every other source passes its own.
const healthQueries = {
  zaptec: orpc.evCharging.syncStatus.queryOptions(),
  elpris: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } }),
  skoda: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } }),
  emaldo: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'emaldo' } }),
} satisfies Record<IntegrationSource, unknown>
const runsQueries = {
  zaptec: orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
  elpris: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'elpris', limit: RECENT_RUNS },
  }),
  skoda: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'skoda', limit: RECENT_RUNS },
  }),
  emaldo: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'emaldo', limit: RECENT_RUNS },
  }),
} satisfies Record<IntegrationSource, unknown>
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
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      // The tariff card reads the list with suspense.
      queryClient.ensureQueryData(orpc.tariff.list.queryOptions()),
      // Everything else is prefetched, not ensured: a failed read shows on its
      // tile (or in its history overlay, with a retry) and never takes the page down.
      ...Object.values(healthQueries).map((q) => queryClient.prefetchQuery(q)),
      ...Object.values(runsQueries).map((q) => queryClient.prefetchQuery(q)),
      queryClient.prefetchQuery(vehicleCoverageQuery),
      queryClient.prefetchQuery(vehicleLatestQuery),
    ])
  },
  component: ChargingSettingsPage,
})

function ChargingSettingsPage() {
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
  const { data: tariffs } = useSuspenseQuery(orpc.tariff.list.queryOptions())
  const selectedTariff = tariffs.find((t) => t.id === tariffId)
  // A dialog that can't show (a tariffId that no longer exists; a sync history
  // without a valid source) is cleared from the URL instead of lingering there.
  const dialogUnavailable =
    dialog !== undefined &&
    (dialog === 'syncRuns'
      ? runsSource === undefined
      : dialog !== 'tariffNew' && dialog !== 'vehicleImport' && !selectedTariff)
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

  // Polled, so a tile's "running" state (a cron run seen mid-flight) clears on
  // its own instead of waiting for a focus refetch (ADR-0018: polled).
  const { data: zaptecHealth } = useQuery({
    ...healthQueries.zaptec,
    refetchInterval: healthPoll(syncNow.isPendingFor('zaptec')),
  })
  const { data: pricesHealth } = useQuery({
    ...healthQueries.elpris,
    refetchInterval: healthPoll(syncNow.isPendingFor('elpris')),
  })
  const { data: skodaHealth } = useQuery({
    ...healthQueries.skoda,
    refetchInterval: healthPoll(syncNow.isPendingFor('skoda')),
  })
  const { data: emaldoHealth } = useQuery({
    ...healthQueries.emaldo,
    refetchInterval: healthPoll(syncNow.isPendingFor('emaldo')),
  })
  const zaptecRuns = useQuery(runsQueries.zaptec)
  const pricesRuns = useQuery(runsQueries.elpris)
  const skodaRuns = useQuery(runsQueries.skoda)
  const emaldoRuns = useQuery(runsQueries.emaldo)
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

      <SyncSourcesPanel
        entries={[
          { source: 'zaptec', health: zaptecHealth, runs: zaptecRuns },
          { source: 'elpris', health: pricesHealth, runs: pricesRuns },
          {
            source: 'skoda',
            health: skodaHealth,
            runs: skodaRuns,
            // The car's log and live poll are one source to the admin: its last
            // contact, key expiry and log (+ import) live on its tile. A failed
            // read shows an error there, never "none".
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

      <TariffCard
        tariffs={tariffs}
        admin={{
          onNew: () => open('tariffNew'),
          onEdit: (id) => open('tariffEdit', { tariffId: id }),
          onDelete: (id) => open('tariffDelete', { tariffId: id }),
        }}
      />

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
    </PageContainer>
  )
}
