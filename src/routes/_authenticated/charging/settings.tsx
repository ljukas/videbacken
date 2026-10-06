import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { z } from 'zod'
import { CredentialsDialog } from '~/components/evCharging/CredentialsDialog'
import { credentialsButtonId } from '~/components/evCharging/credentialLink'
import { DeleteTariffDialog } from '~/components/evCharging/DeleteTariffDialog'
import { GridTariffCard } from '~/components/evCharging/GridTariffCard'
import { healthPoll } from '~/components/evCharging/healthPoll'
import {
  SkodaSourceDetails,
  VehicleLogImportButton,
} from '~/components/evCharging/SkodaSourceDetails'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { TariffDialog } from '~/components/evCharging/TariffDialog'
import { VehicleImportDialog } from '~/components/evCharging/VehicleImportDialog'
import { firstLoadPending, LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import {
  CREDENTIAL_SOURCES,
  type CredentialSource,
  isCredentialSource,
} from '~/lib/integrationCredentials'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// The charging section's admin page: every data source's state, sync and
// history (Datakällor), the car's log import, and the tariff periods the cost
// is priced with, and each source's credentials (ADR-0026). Moved off the
// overview, which keeps only the alerts.
const searchSchema = z.object({
  // Dialogs (ADR-0013): tariff new (pre-filled from the newest period), edit,
  // delete; the car's log import; one data source's sync history or credentials.
  dialog: z
    .enum(['tariffNew', 'tariffEdit', 'tariffDelete', 'vehicleImport', 'syncRuns', 'credentials'])
    .optional()
    .catch(undefined),
  tariffId: z.string().optional().catch(undefined),
  // The source whose sync history (`dialog=syncRuns`, an integration source) or
  // credentials (`dialog=credentials`, a credential source) are open.
  source: z
    .union([z.enum(INTEGRATION_SOURCES), z.enum(CREDENTIAL_SOURCES)])
    .optional()
    .catch(undefined),
})
type SettingsSearch = z.infer<typeof searchSchema>
type SettingsDialog = NonNullable<SettingsSearch['dialog']>

const RECENT_RUNS = 20

const runsQuery = orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } })
const vehicleCoverageQuery = orpc.evCharging.vehicleRecordCoverage.queryOptions()
const vehicleLatestQuery = orpc.evCharging.vehicleStateLatest.queryOptions()
const credentialsStatusQuery = orpc.credentials.status.queryOptions()

const isIntegrationSource = (s: string | undefined): s is IntegrationSource =>
  s !== undefined && (INTEGRATION_SOURCES as readonly string[]).includes(s)

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
  // tiles at the top), the tariff periods (the card, and a tariff dialog's
  // deep link) and the credentials' origins (the grid card, and a credentials
  // dialog's deep link). Deferred: the diagnostics inside the tiles, the sync
  // histories, the car's latest state and the log coverage. A failed read never
  // throws here: it shows on its tile, in its history overlay or as the tariff
  // card's or the credentials' alert, each with a retry.
  loader: async ({ context: { queryClient } }) => {
    await loadRouteData(queryClient, {
      critical: [syncHealthQuery, orpc.tariff.list.queryOptions(), credentialsStatusQuery],
      deferred: [runsQuery, vehicleCoverageQuery, vehicleLatestQuery],
    })
  },
  component: ChargingSettingsPage,
})

function ChargingSettingsPage() {
  const navigate = Route.useNavigate()
  const syncNow = useSyncNow()
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const tariffId = Route.useSearch({ select: (s) => s.tariffId })
  // The source of the open history or credentials dialog.
  const source = Route.useSearch({ select: (s) => s.source })
  const { isOpen, open, close } = useUrlDialog<SettingsDialog, SettingsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['tariffId', 'source'],
  })
  const tariffsResult = useQuery(orpc.tariff.list.queryOptions())
  const tariffs = tariffsResult.data
  const selectedTariff = tariffs?.find((t) => t.id === tariffId)
  // A dialog that can't show (a tariffId that no longer exists; a sync history
  // or credentials dialog without a source that has one) is cleared from the URL
  // instead of lingering there. A tariff dialog is only judged once the tariffs
  // are known.
  const dialogUnavailable =
    dialog !== undefined &&
    (dialog === 'syncRuns'
      ? !isIntegrationSource(source)
      : dialog === 'credentials'
        ? !(source && isCredentialSource(source))
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
  const credentialsResult = useQuery(credentialsStatusQuery)
  const credentialsSource =
    isOpen('credentials') && source && isCredentialSource(source) ? source : undefined
  // Opens once the origins are known, or their read failed (the dialog then has
  // no origin lines): never with origins that are still loading.
  const credentialsReady = credentialsResult.data !== undefined || credentialsResult.isError
  // The key button that opened the dialog, for focus on close: the URL (and so
  // `credentialsSource`) clears before Radix asks where focus goes. Both refs
  // are read by onCloseAutoFocus, which can fire from a stale render's closure.
  const lastCredentialsSource = useRef<CredentialSource | undefined>(undefined)
  const openCredentialsSource = useRef(credentialsSource)
  useEffect(() => {
    openCredentialsSource.current = credentialsSource
    if (credentialsSource) lastCredentialsSource.current = credentialsSource
  }, [credentialsSource])

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
          openSource={isOpen('syncRuns') && isIntegrationSource(source) ? source : undefined}
          onOpenHistory={(s: IntegrationSource) => open('syncRuns', { source: s })}
          onCloseHistory={close}
          onOpenCredentials={(s) => open('credentials', { source: s })}
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

      <LoadErrorAlert title={m.charging_credentials_error_title()} query={credentialsResult} />
      {/* A skeleton until the credentials' origins are known; a failed read
          leaves the card without a status line (the alert above says why). */}
      <SectionSkeleton
        name="charging-grid"
        loading={firstLoadPending(credentialsResult)}
        fallbackHeight="9rem"
      >
        <GridTariffCard
          facility={credentialsResult.data?.sources.gridTariff.fields.facilityId}
          unreadable={credentialsResult.data?.sources.gridTariff.unreadable ?? false}
          onOpenCredentials={() => open('credentials', { source: 'gridTariff' })}
        />
      </SectionSkeleton>

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
      <CredentialsDialog
        source={credentialsSource}
        open={credentialsSource !== undefined && credentialsReady}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        status={credentialsResult.data}
        suspectFields={
          credentialsSource && isIntegrationSource(credentialsSource)
            ? sourcesHealth?.[credentialsSource]?.adminDetail?.suspectFields
            : null
        }
        // The grid facility has no sync to run: the monthly catalogue check reads it.
        onChanged={(s) => {
          if (s !== 'gridTariff') syncNow.syncSource(s)
        }}
        // Opened by URL state: Radix has no trigger to return focus to.
        onCloseAutoFocus={(event) => {
          // Still open: the overlay only swapped dialog ↔ bottom sheet (a
          // rotation, or a phone deep link hydrating) — not a close.
          if (openCredentialsSource.current !== undefined) return
          const opener = lastCredentialsSource.current
          const el = opener ? document.getElementById(credentialsButtonId(opener)) : null
          if (!el) return
          event.preventDefault()
          el.focus()
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
