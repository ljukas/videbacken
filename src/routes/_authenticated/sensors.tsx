import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ThermometerIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { PageContainer } from '~/components/layout/PageContainer'
import { ClimateChart } from '~/components/sensor/ClimateChart'
import { CurrentReadingTiles } from '~/components/sensor/CurrentReadingTiles'
import { DeviceToggles } from '~/components/sensor/DeviceToggles'
import { EditDeviceDialog } from '~/components/sensor/EditDeviceDialog'
import { RangeSelector } from '~/components/sensor/RangeSelector'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { getIntlLocale } from '~/lib/i18n/format'
import { orpc } from '~/lib/orpc/client'
import { colorForIndex, type DeviceSeries, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS, SERIES_RANGES, type SeriesRange } from '~/lib/sensor/range'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  range: z.enum(SERIES_RANGES).default('24h'),
  dialog: z.enum(['edit']).optional(),
  deviceId: z.string().optional(),
})
type SensorsSearch = z.infer<typeof searchSchema>
type SensorsDialog = NonNullable<SensorsSearch['dialog']>

// Only the shorter ranges poll — a new reading won't visibly move a 1-year daily
// chart, so longer ranges just refetch on focus/mount.
const POLLED_RANGES: SeriesRange[] = ['24h', '1m']

export const Route = createFileRoute('/_authenticated/sensors')({
  head: () => ({
    meta: seo({ title: m.meta_sensors_title(), description: m.meta_sensors_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(orpc.sensor.listDevices.queryOptions()),
      queryClient.ensureQueryData(
        orpc.sensor.series.queryOptions({ input: { range: deps.range } }),
      ),
    ])
  },
  component: SensorsPage,
})

function SensorsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const navigate = Route.useNavigate()
  const range = Route.useSearch({ select: (s) => s.range })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const deviceId = Route.useSearch({ select: (s) => s.deviceId })
  const { isOpen, open, close } = useUrlDialog<SensorsDialog, SensorsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['deviceId'],
  })

  const { data: devices } = useSuspenseQuery({
    ...orpc.sensor.listDevices.queryOptions(),
    // The tiles show live latest/battery/last-seen, so poll on the same cadence
    // as the short-range charts (spec §7).
    refetchInterval: 60_000,
  })
  const { data: series } = useQuery({
    ...orpc.sensor.series.queryOptions({ input: { range } }),
    refetchInterval: POLLED_RANGES.includes(range) ? 60_000 : false,
    placeholderData: keepPreviousData, // keep the old chart while a new range loads
  })

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
  const formatTick = useMemo(() => makeTickFormatter(range), [range])

  // Each metric gets its own per-device series (with outage breaks inserted by
  // toDeviceSeries). Colors derive from the FULL roster position (stable order
  // from the service), so a device keeps its color regardless of which siblings
  // are toggled off; hidden devices stay in the list (their line is `hide`-d).
  const tempDevices = useMemo(
    () =>
      toChartDevices(
        devices,
        hidden,
        toDeviceSeries(buckets, 'temp', {
          bucketSec,
          maxGapBuckets: MAX_GAP_BUCKETS,
          cadenceSec: CADENCE_SEC,
        }),
      ),
    [devices, hidden, buckets, bucketSec],
  )
  const humDevices = useMemo(
    () =>
      toChartDevices(
        devices,
        hidden,
        toDeviceSeries(buckets, 'hum', {
          bucketSec,
          maxGapBuckets: MAX_GAP_BUCKETS,
          cadenceSec: CADENCE_SEC,
        }),
      ),
    [devices, hidden, buckets, bucketSec],
  )

  const toggleDevices = devices.map((d, i) => ({
    id: d.id,
    displayName: d.displayName,
    color: colorForIndex(i),
  }))
  const editingDevice = deviceId ? devices.find((d) => d.id === deviceId) : undefined

  if (devices.length === 0) {
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
        <DeviceToggles devices={toggleDevices} hidden={hidden} onToggle={toggle} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="sr-only">{m.sensors_current_heading()}</h2>
        <CurrentReadingTiles
          devices={devices}
          isAdmin={isAdmin}
          onEdit={(id) => open('edit', { deviceId: id })}
        />
      </section>

      <ChartSection title={m.sensors_temp_chart_title()} hasData={hasData}>
        <ClimateChart devices={tempDevices} unit="°C" formatTick={formatTick} />
      </ChartSection>

      <ChartSection title={m.sensors_humidity_chart_title()} hasData={hasData}>
        <ClimateChart devices={humDevices} unit="%" formatTick={formatTick} />
      </ChartSection>

      {isAdmin ? (
        <EditDeviceDialog
          open={isOpen('edit') && editingDevice !== undefined}
          device={editingDevice}
          onOpenChange={(o) => {
            if (!o) close()
          }}
        />
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

function ChartSection({
  title,
  hasData,
  children,
}: {
  title: string
  hasData: boolean
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">{title}</h2>
      {hasData ? (
        children
      ) : (
        <div className="flex h-[260px] items-center justify-center rounded-lg border text-muted-foreground text-sm">
          {m.sensors_chart_empty()}
        </div>
      )}
    </section>
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

// Range-aware x-axis label in the active UI locale: time-of-day for the 24h
// view, else a short date.
function makeTickFormatter(range: SeriesRange): (t: number) => string {
  const locale = getIntlLocale()
  const fmt =
    range === '24h'
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  return (t: number) => fmt.format(new Date(t))
}
