import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { ThermometerIcon } from 'lucide-react'
import { lazy, useMemo, useState } from 'react'
import { z } from 'zod'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { ClimateChart } from '~/components/sensor/ClimateChart'
import { CurrentReadingTiles } from '~/components/sensor/CurrentReadingTiles'
import { DeviceToggles } from '~/components/sensor/DeviceToggles'
import { RangeSelector } from '~/components/sensor/RangeSelector'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { getIntlLocale } from '~/lib/i18n/format'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { colorForIndex, type DeviceSeries, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS, SERIES_RANGES, type SeriesRange } from '~/lib/sensor/range'
import { makeTickFormatter } from '~/lib/sensor/tickFormat'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  range: z.enum(SERIES_RANGES).default('24h'),
  dialog: z.enum(['edit']).optional(),
  deviceId: z.string().optional(),
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

// Only the shorter ranges poll — a new reading won't visibly move a 1-year daily
// chart, so longer ranges just refetch on focus/mount.
const POLLED_RANGES: SeriesRange[] = ['24h', '1w', '1m']

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
    }),
  component: SensorsPage,
})

function SensorsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  useIdlePreload(isAdmin, ADMIN_DIALOG_LOADERS)
  const navigate = Route.useNavigate()
  const range = Route.useSearch({ select: (s) => s.range })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const deviceId = Route.useSearch({ select: (s) => s.deviceId })
  const { isOpen, open, close } = useUrlDialog<SensorsDialog, SensorsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['deviceId'],
  })

  const devicesResult = useQuery({
    ...orpc.sensor.listDevices.queryOptions(),
    // The tiles show live latest/battery/last-seen, so poll on the same cadence
    // as the short-range charts (spec §7).
    refetchInterval: 60_000,
  })
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

  // Each metric gets its own per-device series (with outage breaks inserted by
  // toDeviceSeries). Colors derive from the FULL roster position (stable order
  // from the service), so a device keeps its color regardless of which siblings
  // are toggled off; hidden devices stay in the list (their line is `hide`-d).
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
  const editingDevice = deviceId ? roster.find((d) => d.id === deviceId) : undefined
  const editDeviceOpen = isOpen('edit') && editingDevice !== undefined

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

      <div className="flex flex-col gap-3">
        <RangeSelector value={range} onChange={setRange} />
        <SectionSkeleton name="sensors-tiles" loading={devicesPending} fallbackHeight="13rem">
          {devices ? (
            <div className="flex flex-col gap-6">
              <DeviceToggles devices={toggleDevices} hidden={hidden} onToggle={toggle} />
              <section className="flex flex-col gap-2">
                <h2 className="sr-only">{m.sensors_current_heading()}</h2>
                <CurrentReadingTiles
                  devices={roster}
                  isAdmin={isAdmin}
                  onEdit={(id) => open('edit', { deviceId: id })}
                />
              </section>
            </div>
          ) : null}
        </SectionSkeleton>
      </div>

      <LoadErrorAlert title={m.sensors_series_error_title()} query={seriesResult} />
      {seriesFailed ? null : (
        <>
          <ChartSection title={m.sensors_temp_chart_title()}>
            <SectionSkeleton
              name="sensors-temp-chart"
              loading={chartsPending}
              fallbackHeight="260px"
            >
              <ChartBody ready={chartsReady} stale={seriesStale} hasData={hasData}>
                <ClimateChart devices={tempDevices} unit="°C" formatTick={formatTick} />
              </ChartBody>
            </SectionSkeleton>
          </ChartSection>

          <ChartSection title={m.sensors_humidity_chart_title()}>
            <SectionSkeleton
              name="sensors-hum-chart"
              loading={chartsPending}
              fallbackHeight="260px"
            >
              <ChartBody ready={chartsReady} stale={seriesStale} hasData={hasData}>
                <ClimateChart devices={humDevices} unit="%" formatTick={formatTick} />
              </ChartBody>
            </SectionSkeleton>
          </ChartSection>
        </>
      )}

      {isAdmin ? (
        <LazyDialogMount open={editDeviceOpen}>
          <EditDeviceDialog
            open={editDeviceOpen}
            device={editingDevice}
            onOpenChange={(o) => {
              if (!o) close()
            }}
          />
        </LazyDialogMount>
      ) : null}
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
// while loading.
function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">{title}</h2>
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
