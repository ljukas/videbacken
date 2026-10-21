import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated, useRouter } from '@tanstack/react-router'
import { ThermometerIcon } from 'lucide-react'
import { lazy, useCallback, useId, useMemo, useState } from 'react'
import { z } from 'zod'
import sensorsChipsBones from '~/bones/sensors-chips.bones.json'
import sensorsHumChartBones from '~/bones/sensors-hum-chart.bones.json'
import sensorsTempChartBones from '~/bones/sensors-temp-chart.bones.json'
import sensorsTilesBones from '~/bones/sensors-tiles.bones.json'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { ClimateChart } from '~/components/sensor/ClimateChart'
import { CurrentReadingTiles } from '~/components/sensor/CurrentReadingTiles'
import { DeviceToggles } from '~/components/sensor/DeviceToggles'
import { RangeSelector } from '~/components/sensor/RangeSelector'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { getIntlLocale } from '~/lib/i18n/format'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { colorForIndex, type DeviceSeries, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS, SERIES_RANGES, type SeriesRange } from '~/lib/sensor/range'
import { makeTickFormatter, makeTimeAxis } from '~/lib/sensor/tickFormat'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  range: z.enum(SERIES_RANGES).default('24h'),
  dialog: z.enum(['edit', 'alerts']).optional(),
  deviceId: z.string().optional(),
  /** The alerts dialog's view: absent = the list, `new` = an empty form, else a rule's id. */
  alertId: z.string().optional(),
})
type SensorsSearch = z.infer<typeof searchSchema>
type SensorsDialog = NonNullable<SensorsSearch['dialog']>

// Admin-only: loads on first open (LazyDialogMount), so a member never fetches the form code;
// an admin warms the chunk once the browser is idle (useIdlePreload).
const loadEditDeviceDialog = () => import('~/components/sensor/EditDeviceDialog')
const EditDeviceDialog = lazy(() =>
  loadEditDeviceDialog().then((mod) => ({ default: mod.EditDeviceDialog })),
)
const ADMIN_DIALOG_LOADERS = [loadEditDeviceDialog]

// Every signed-in user's own alert rules (ADR-0028): loads on first open, warmed when idle.
const loadSensorAlertsDialog = () => import('~/components/sensor/SensorAlertsDialog')
const SensorAlertsDialog = lazy(() =>
  loadSensorAlertsDialog().then((mod) => ({ default: mod.SensorAlertsDialog })),
)
const ALERTS_DIALOG_LOADERS = [loadSensorAlertsDialog]

// Closing a dialog clears its sensor and the alerts dialog's view.
const CLEAR_KEYS = ['deviceId', 'alertId'] as const

// Only the shorter ranges poll — a new reading won't visibly move a 1-year daily
// chart, so longer ranges just refetch on focus/mount.
const POLLED_RANGES: SeriesRange[] = ['24h', '1w', '1m']

// The viewer's own rules (bell counts); polled like the tiles. Deferred in the loader:
// until it arrives, or if it fails, the bells are plain.
const sensorAlertsQuery = () => orpc.sensor.alerts.list.queryOptions({ refetchInterval: 60_000 })

// Through react-router's re-export of HistoryState (our direct dependency, not @tanstack/history).
declare module '@tanstack/react-router' {
  interface HistoryState {
    /** An alerts-dialog form entry pushed from its list: the way back steps back onto the list. */
    sensorAlertsForm?: true
  }
}

export const Route = createFileRoute('/_authenticated/sensors')({
  head: () => ({
    meta: seo({ title: m.meta_sensors_title(), description: m.meta_sensors_description() }),
  }),
  validateSearch: searchSchema,
  // The range is a dep so the server renders the linked range's series; on the
  // client nothing is awaited (loadRouteData), so a range switch never blocks.
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context: { queryClient }, deps }) =>
    loadRouteData(queryClient, {
      critical: [
        orpc.sensor.listDevices.queryOptions(),
        orpc.sensor.series.queryOptions({ input: { range: deps.range } }),
      ],
      deferred: [sensorAlertsQuery()],
    }),
  component: SensorsPage,
})

function SensorsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  useIdlePreload(isAdmin, ADMIN_DIALOG_LOADERS)
  useIdlePreload(true, ALERTS_DIALOG_LOADERS)
  const navigate = Route.useNavigate()
  const router = useRouter()
  const range = Route.useSearch({ select: (s) => s.range })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const deviceId = Route.useSearch({ select: (s) => s.deviceId })
  const alertId = Route.useSearch({ select: (s) => s.alertId })
  const currentHeadingId = useId()
  const historyHeadingId = useId()
  const { isOpen, open, close } = useUrlDialog<SensorsDialog, SensorsSearch>({
    current: dialog,
    navigate,
    clearKeys: CLEAR_KEYS,
  })

  const devicesResult = useQuery({
    ...orpc.sensor.listDevices.queryOptions(),
    // The tiles show live latest/battery/last-seen, so poll on the same cadence
    // as the short-range charts (spec §7).
    refetchInterval: 60_000,
  })
  const alertsResult = useQuery(sensorAlertsQuery())
  const seriesResult = useQuery({
    ...orpc.sensor.series.queryOptions({ input: { range } }),
    refetchInterval: POLLED_RANGES.includes(range) ? 60_000 : false,
    placeholderData: keepPreviousData, // keep the old chart while a new range loads
  })
  // Each section owns its loading state (ADR-0025 §3): nothing to show yet is a
  // skeleton, a failed read the alert (ADR-0016), never the empty state. A
  // failure reshapes the page only once hydrated: a read that failed on the
  // server isn't dehydrated, so the hydrating client sees it missing, and both
  // must render it alike (no content, no "no data").
  const hydrated = useHydrated()
  const devicesPending = firstLoadPending(devicesResult)
  const devices = loadFailed(devicesResult) ? undefined : devicesResult.data
  const devicesFailed = hydrated && loadFailed(devicesResult)
  const roster = useMemo(() => devices ?? [], [devices])
  const seriesPending = firstLoadPending(seriesResult)
  const series = loadFailed(seriesResult) ? undefined : seriesResult.data
  const seriesFailed = hydrated && loadFailed(seriesResult)
  // While a new range loads, the previous range's chart stays up (keepPreviousData):
  // dimmed, and labelled as the range it shows. Set during render: React's
  // pattern for state derived from a changing value.
  const seriesStale = series !== undefined && seriesResult.isPlaceholderData
  const [loadedRange, setLoadedRange] = useState(range)
  if (seriesResult.data && !seriesResult.isPlaceholderData && loadedRange !== range) {
    setLoadedRange(range)
  }
  const shownRange = seriesStale ? loadedRange : range
  const chartsPending = seriesPending || devicesPending
  const chartsReady = series !== undefined && devices !== undefined

  const [hidden, setHidden] = useState<Set<string>>(new Set())
  function toggle(id: string) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function setRange(r: SeriesRange) {
    navigate({ to: '.', search: (s) => ({ ...s, range: r }), replace: true, resetScroll: false })
  }

  const buckets = series?.buckets ?? []
  const bucketSec = series?.bucketSec ?? 0
  const formatTick = useMemo(() => makeTickFormatter(shownRange, getIntlLocale()), [shownRange])
  const timeAxis = useMemo(() => makeTimeAxis(shownRange, getIntlLocale()), [shownRange])

  // Each metric gets its own per-device series (with outage breaks inserted by
  // toDeviceSeries). Colors derive from the FULL roster position (stable order
  // from the service), so a device keeps its color regardless of which siblings
  // are toggled off; hidden devices stay in the list (the chart draws no line for
  // them, but they keep the time axis, and their chip stays to toggle them back).
  const tempDevices = useMemo(
    () =>
      toChartDevices(
        roster,
        hidden,
        toDeviceSeries(buckets, 'temp', {
          bucketSec,
          maxGapBuckets: MAX_GAP_BUCKETS,
          cadenceSec: CADENCE_SEC,
        }),
      ),
    [roster, hidden, buckets, bucketSec],
  )
  const humDevices = useMemo(
    () =>
      toChartDevices(
        roster,
        hidden,
        toDeviceSeries(buckets, 'hum', {
          bucketSec,
          maxGapBuckets: MAX_GAP_BUCKETS,
          cadenceSec: CADENCE_SEC,
        }),
      ),
    [roster, hidden, buckets, bucketSec],
  )

  const toggleDevices = roster.map((d, i) => ({
    id: d.id,
    displayName: d.displayName,
    color: colorForIndex(i),
  }))
  const dialogDevice = deviceId ? roster.find((d) => d.id === deviceId) : undefined
  const alertsData = alertsResult.data
  const alertsFailed = loadFailed(alertsResult)
  // Per sensor, the viewer's switched-on rules and those firing now (an open alert).
  const { alertCounts, firingCounts } = useMemo(() => {
    const active: Record<string, number> = {}
    const firing: Record<string, number> = {}
    for (const r of alertsFailed ? [] : (alertsData?.rules ?? [])) {
      if (r.enabled) active[r.deviceId] = (active[r.deviceId] ?? 0) + 1
      if (r.firingSince) firing[r.deviceId] = (firing[r.deviceId] ?? 0) + 1
    }
    return { alertCounts: active, firingCounts: firing }
  }, [alertsData, alertsFailed])
  const editDeviceOpen = isOpen('edit') && dialogDevice !== undefined
  const alertsOpen = isOpen('alerts') && dialogDevice !== undefined
  // List → form is pushed, so browser Back from the form returns to the list; that entry carries
  // a mark in its history state. The way back (Tillbaka, a save, a delete) must not leave the
  // form in the history, or Back from the list would reopen it: from a marked entry, step back
  // onto the list's own entry, so the next Back closes the dialog; from an unmarked one (a deep
  // link into the form) replace it. The mark lives on the entry, so Back and Forward elsewhere
  // can't make it stale. Read at call time from the router: a save or delete can land after the
  // dialog closed (X, the overlay), and must then change nothing.
  const setAlertView = useCallback(
    (view: string, options?: { replace: true }) => {
      const location = router.state.location
      if ((location.search as SensorsSearch).dialog !== 'alerts') return
      const replace = options?.replace === true
      if (replace && location.state.sensorAlertsForm) {
        router.history.back()
        return
      }
      const toForm = !replace && view !== 'list'
      navigate({
        to: '.',
        search: (s) => ({ ...s, alertId: view === 'list' ? undefined : view }),
        replace,
        resetScroll: false,
        state: toForm ? (prev) => ({ ...prev, sensorAlertsForm: true }) : undefined,
      })
    },
    [navigate, router],
  )

  // The toggles, the tiles and the charts' colours all need the roster.
  if (devicesFailed) {
    return (
      <PageContainer>
        <SensorsHeading />
        <LoadErrorAlert title={m.sensors_devices_error_title()} query={devicesResult} />
      </PageContainer>
    )
  }

  if (devices?.length === 0) {
    return (
      <PageContainer>
        <SensorsHeading />
        <Empty className="brand-wash rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ThermometerIcon />
            </EmptyMedia>
            <EmptyTitle>{m.sensors_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.sensors_empty_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageContainer>
    )
  }

  const hasData = buckets.length > 0

  return (
    <PageContainer>
      <SensorsHeading />

      <SectionSkeleton bones={sensorsTilesBones} loading={devicesPending} fallbackHeight="13rem">
        {devices ? (
          <section aria-labelledby={currentHeadingId}>
            <Card>
              <CardHeader>
                <h2 id={currentHeadingId} className="font-semibold text-lg">
                  {m.sensors_current_heading()}
                </h2>
              </CardHeader>
              <CardContent>
                <CurrentReadingTiles
                  devices={roster}
                  isAdmin={isAdmin}
                  onEdit={(id) => open('edit', { deviceId: id })}
                  alertCounts={alertCounts}
                  firingCounts={firingCounts}
                  // Always the list: a stale alertId in the URL never opens a form.
                  onOpenAlerts={(id) => open('alerts', { deviceId: id, alertId: undefined })}
                />
              </CardContent>
            </Card>
          </section>
        ) : null}
      </SectionSkeleton>

      {/* The header (title + range control) is always real text and stays live
          while a range loads; only the charts dim (ChartBody). */}
      <section aria-labelledby={historyHeadingId}>
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={historyHeadingId} className="font-semibold text-lg">
              {m.sensors_history_heading()}
            </h2>
            <RangeSelector value={range} onChange={setRange} />
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <SectionSkeleton
              bones={sensorsChipsBones}
              loading={devicesPending}
              fallbackHeight="2.5rem"
            >
              {devices ? (
                <DeviceToggles devices={toggleDevices} hidden={hidden} onToggle={toggle} />
              ) : null}
            </SectionSkeleton>
            <LoadErrorAlert title={m.sensors_series_error_title()} query={seriesResult} />
            {seriesFailed ? null : (
              <>
                <ChartSection title={m.sensors_temp_chart_title()}>
                  <SectionSkeleton
                    bones={sensorsTempChartBones}
                    loading={chartsPending}
                    fallbackHeight="260px"
                  >
                    <ChartBody ready={chartsReady} stale={seriesStale} hasData={hasData}>
                      <ClimateChart
                        devices={tempDevices}
                        unit="°C"
                        formatTick={formatTick}
                        timeAxis={timeAxis}
                        label={m.sensors_temp_chart_title()}
                      />
                    </ChartBody>
                  </SectionSkeleton>
                </ChartSection>

                <ChartSection title={m.sensors_humidity_chart_title()}>
                  <SectionSkeleton
                    bones={sensorsHumChartBones}
                    loading={chartsPending}
                    fallbackHeight="260px"
                  >
                    <ChartBody ready={chartsReady} stale={seriesStale} hasData={hasData}>
                      <ClimateChart
                        devices={humDevices}
                        unit="%"
                        formatTick={formatTick}
                        timeAxis={timeAxis}
                        label={m.sensors_humidity_chart_title()}
                      />
                    </ChartBody>
                  </SectionSkeleton>
                </ChartSection>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {isAdmin ? (
        <LazyDialogMount open={editDeviceOpen}>
          <EditDeviceDialog
            open={editDeviceOpen}
            device={dialogDevice}
            onOpenChange={(o) => {
              if (!o) close()
            }}
          />
        </LazyDialogMount>
      ) : null}

      <LazyDialogMount open={alertsOpen}>
        <SensorAlertsDialog
          open={alertsOpen}
          device={alertsOpen ? dialogDevice : undefined}
          rules={alertsFailed ? undefined : alertsData?.rules}
          rulesFailed={alertsFailed}
          onRetryRules={() => void alertsResult.refetch()}
          retryingRules={alertsResult.isFetching}
          typicalGapMinutes={alertsData?.typicalGapMinutes}
          view={alertId ?? 'list'}
          onView={setAlertView}
          onClose={close}
        />
      </LazyDialogMount>
    </PageContainer>
  )
}

function SensorsHeading() {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
        {m.sensors_title()}
      </h1>
      <p className="max-w-2xl text-muted-foreground text-sm">{m.sensors_description()}</p>
    </header>
  )
}

// The title stays real text; only the chart area (ChartBody) is a skeleton
// while loading. An h3: the Historik card's h2 heads it.
function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-base">{title}</h3>
      {children}
    </section>
  )
}

// Not `ready` (nothing to show, before the skeleton or the alert takes over): an
// empty 260 px area, never "no data". `stale`: the previous range's chart while
// the next one loads.
function ChartBody({
  ready,
  stale,
  hasData,
  children,
}: {
  ready: boolean
  stale: boolean
  hasData: boolean
  children: React.ReactNode
}) {
  if (!ready) return <div className="h-[260px]" />
  return (
    <div
      aria-busy={stale}
      className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'}
    >
      {hasData ? (
        children
      ) : stale ? (
        // The previous range was empty; that says nothing about the one loading.
        <div className="h-[260px] rounded-lg border" />
      ) : (
        <div className="flex h-[260px] items-center justify-center rounded-lg border text-muted-foreground text-sm">
          {m.sensors_chart_empty()}
        </div>
      )}
    </div>
  )
}

// Merge the per-metric device series onto the full roster (for stable colors +
// hidden toggling), so every device has a line and the ones absent from the data
// carry an empty series.
function toChartDevices(
  roster: { id: string; displayName: string }[],
  hidden: Set<string>,
  deviceSeries: DeviceSeries[],
) {
  const byId = new Map(deviceSeries.map((s) => [s.id, s.points]))
  return roster.map((d, i) => ({
    id: d.id,
    displayName: d.displayName,
    color: colorForIndex(i),
    hidden: hidden.has(d.id),
    points: byId.get(d.id) ?? [],
  }))
}
