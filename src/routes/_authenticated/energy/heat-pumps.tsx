import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { lazy, useCallback, useEffect } from 'react'
import { z } from 'zod'
import heatPumpConsumptionBones from '~/bones/heat-pump-consumption.bones.json'
import heatPumpsEventsBones from '~/bones/heat-pumps-events.bones.json'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import type { EnergySearchWrite } from '~/components/energy/useEnergyPeriod'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { EnergySignatureSection } from '~/components/heatPump/EnergySignatureSection'
import { HeatPumpConsumption } from '~/components/heatPump/HeatPumpConsumption'
import { HeatPumpEmpty } from '~/components/heatPump/HeatPumpEmpty'
import { HeatPumpEvents } from '~/components/heatPump/HeatPumpEvents'
import {
  heatPumpDaysQueryFor,
  heatPumpEventsQuery,
  heatPumpMonthsQuery,
  heatPumpMonthsQueryFor,
} from '~/components/heatPump/heatPumpQueries'
import { useHeatPumpPeriod } from '~/components/heatPump/useHeatPumpPeriod'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending, LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { type EnergyPeriod, resolvePeriod } from '~/lib/houseEnergy/period'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// This route's search: the shared period params plus the event dialogs (ADR-0013; admins only). Extended here,
// never in energySearchSchema, so /energy and /energy/battery never carry dialog keys.
const heatPumpsSearchSchema = energySearchSchema.extend({
  dialog: z.enum(['eventNew', 'eventEdit', 'eventDelete']).optional().catch(undefined),
  eventId: z.string().optional().catch(undefined),
})
type HeatPumpsSearch = z.infer<typeof heatPumpsSearchSchema>
type HeatPumpsDialog = NonNullable<HeatPumpsSearch['dialog']>

// Admin-only: loads on first open (LazyDialogMount), so a member never fetches the form code;
// an admin warms the chunks once the browser is idle (useIdlePreload).
const loadEventDialog = () => import('~/components/heatPump/HeatPumpEventDialog')
const HeatPumpEventDialog = lazy(() =>
  loadEventDialog().then((mod) => ({ default: mod.HeatPumpEventDialog })),
)
const loadDeleteEventDialog = () => import('~/components/heatPump/DeleteHeatPumpEventDialog')
const DeleteHeatPumpEventDialog = lazy(() =>
  loadDeleteEventDialog().then((mod) => ({ default: mod.DeleteHeatPumpEventDialog })),
)
const ADMIN_DIALOG_LOADERS = [loadEventDialog, loadDeleteEventDialog]

export const Route = createFileRoute('/_authenticated/energy/heat-pumps')({
  head: () => ({
    meta: seo({
      title: m.meta_energy_heat_pumps_title(),
      description: m.meta_energy_heat_pumps_description(),
    }),
  }),
  validateSearch: heatPumpsSearchSchema,
  // ADR-0025: the card is above the fold, so its reads are critical on the server; a client navigation awaits
  // nothing. The period is read here, not a loader dep (see energy/index.tsx). The days (or, for a default that
  // resolves to Totalt, the history) are those of the period the page will show, resolved from the months read as
  // useHeatPumpPeriod does: the server awaits that read first (one more round trip, server only); the client uses
  // what the cache holds, else the period asked for or the current month. The events (step 4a) are deferred: the
  // card is below the fold and the chart's markers aren't first paint. Read with the days, so a page the cache
  // already knows is empty (no card) doesn't ask for them; the page's own read waits on the same check.
  loader: async ({ context: { queryClient }, location }) => {
    const requested = periodOfSearch(energySearchSchema.parse(location.search))
    const now = stockholmYearMonth(Date.now())
    const monthsQuery = heatPumpMonthsQueryFor(requested)
    await loadRouteData(queryClient, { critical: [monthsQuery, syncHealthQuery] })
    const months = queryClient.getQueryData(monthsQuery.queryKey)
    if (months?.firstReadingDay === null) return // the empty state: nothing more to read
    const shown: EnergyPeriod = months
      ? resolvePeriod(requested, months.monthsWithReadings, now)
      : (requested ?? { kind: 'month', year: now.year, month: now.month })
    await loadRouteData(queryClient, {
      critical: [
        heatPumpDaysQueryFor(shown),
        requested === null && shown.kind === 'all' && heatPumpMonthsQuery(undefined),
      ],
      deferred: [heatPumpEventsQuery],
    })
  },
  component: HeatPumpsPage,
})

// Cleared with the dialog (a module const: useUrlDialog's close depends on its identity).
const EVENT_DIALOG_KEYS = ['eventId'] as const

function HeatPumpsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Every source's health (one read); this page shows Comfort Cloud's: its alert and its "senast synkad", rendered
  // here with SyncHealthAlert (EnergySyncAlerts shows Emaldo's too, which this page doesn't read).
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.comfortCloud
  const navigate = Route.useNavigate()
  // Merges into the current search, so the page's other keys (step 4a's `dialog` / `eventId`) survive a period
  // change. Writing a period drops a legacy ?year=; `{}` (nothing valid asked for) drops both.
  const writeSearch = useCallback<EnergySearchWrite>(
    (next) =>
      void navigate({
        to: '.',
        search: (prev) => ({ ...prev, period: next.period, year: undefined }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  const h = useHeatPumpPeriod(Route.useSearch(), writeSearch)
  useIdlePreload(isAdmin, ADMIN_DIALOG_LOADERS)
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const eventId = Route.useSearch({ select: (s) => s.eventId })
  const { isOpen, open, close } = useUrlDialog<HeatPumpsDialog, HeatPumpsSearch>({
    current: dialog,
    navigate,
    clearKeys: EVENT_DIALOG_KEYS,
  })
  // The units in name order (= colour order): the months payload's, present in every period view.
  const units = h.shown?.units
  // No readings: the empty state, no card, no chart, no dialogs (`units` is then `[]`, still truthy).
  const empty = h.months?.firstReadingDay === null
  // Not on the empty page; while the months load, read alongside them.
  const eventsResult = useQuery({ ...heatPumpEventsQuery, enabled: !empty })
  const events = eventsResult.data
  const selectedEvent = eventId === undefined ? undefined : events?.find((e) => e.id === eventId)
  // A dialog that can't show (a member's admin link; any link on the empty page; an event that no longer exists,
  // judged once the events are known and not refetching, so a stale cached list doesn't clean a valid link) is
  // cleared from the URL instead of lingering there.
  const dialogUnavailable =
    dialog !== undefined &&
    (!isAdmin ||
      empty ||
      (dialog !== 'eventNew' &&
        events !== undefined &&
        !eventsResult.isFetching &&
        selectedEvent === undefined))
  useEffect(() => {
    // `replace`, so Back doesn't return to the bad URL (and bounce again).
    if (dialogUnavailable) {
      void navigate({
        to: '.',
        replace: true,
        resetScroll: false,
        search: (prev) => ({ ...prev, dialog: undefined, eventId: undefined }),
      })
    }
  }, [dialogUnavailable, navigate])
  const dialogsMounted = isAdmin && units !== undefined && !empty
  const eventDialogOpen =
    dialogsMounted && (isOpen('eventNew') || (isOpen('eventEdit') && selectedEvent !== undefined))
  const deleteEventOpen = dialogsMounted && isOpen('eventDelete') && selectedEvent !== undefined
  const closeDialog = (o: boolean) => {
    if (!o) void close()
  }
  return (
    <PageContainer>
      <EnergyHeading
        title={m.heat_pump_title()}
        description={m.heat_pump_description()}
        lastSuccessAt={health?.lastSuccessAt}
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('comfortCloud')}
          retrying={syncNow.isPendingFor('comfortCloud')}
        />
      ) : null}
      {/* A skeleton is not an empty state (ADR-0016): only data says there are no readings. */}
      {empty ? (
        <HeatPumpEmpty />
      ) : (
        // The same element whatever the state, so the server HTML and the first client render agree.
        <div className="flex flex-col gap-4">
          <SectionSkeleton
            bones={heatPumpConsumptionBones}
            loading={h.pending}
            fallbackHeight="30rem"
          >
            {h.shown && h.period ? (
              <EnergySummaryCard
                title={m.heat_pump_consumption_heading()}
                period={h.period}
                monthsWithReadings={h.shown.monthsWithReadings}
                now={h.now}
                onChange={h.setPeriod}
                dimmed={h.dimmed}
                busy={h.busy}
              >
                {h.view ? (
                  <HeatPumpConsumption
                    view={h.view}
                    onSelectMonth={(month) => h.setPeriod({ kind: 'month', ...month })}
                    events={events}
                  />
                ) : null}
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <LoadErrorAlert title={m.heat_pump_error_title()} query={h.monthsResult} />
          {h.period?.kind === 'month' ? (
            <LoadErrorAlert title={m.heat_pump_error_title()} query={h.daysResult} />
          ) : null}
          {/* Below the fold: its events are deferred in the loader (ADR-0025); its days follow the chosen event. */}
          <EnergySignatureSection />
          <LoadErrorAlert title={m.heat_pump_events_error_title()} query={eventsResult} />
          {/* The card needs the units too: a skeleton while the months load; nothing under their alert. */}
          <SectionSkeleton
            bones={heatPumpsEventsBones}
            loading={
              firstLoadPending(eventsResult) ||
              (units === undefined && firstLoadPending(h.monthsResult))
            }
            fallbackHeight="12rem"
            excludeSelectors={['[data-no-skeleton]']}
          >
            {events && units ? (
              <HeatPumpEvents
                events={events}
                units={units}
                admin={
                  isAdmin
                    ? {
                        onNew: () => open('eventNew'),
                        onEdit: (id) => open('eventEdit', { eventId: id }),
                        onDelete: (id) => open('eventDelete', { eventId: id }),
                      }
                    : undefined
                }
              />
            ) : null}
          </SectionSkeleton>
        </div>
      )}
      {dialogsMounted ? (
        <>
          <LazyDialogMount open={eventDialogOpen}>
            <HeatPumpEventDialog
              open={eventDialogOpen}
              mode={
                isOpen('eventEdit') && selectedEvent
                  ? { kind: 'edit', event: selectedEvent }
                  : isOpen('eventNew')
                    ? { kind: 'new' }
                    : undefined
              }
              units={units}
              onOpenChange={closeDialog}
            />
          </LazyDialogMount>
          <LazyDialogMount open={deleteEventOpen}>
            <DeleteHeatPumpEventDialog
              open={deleteEventOpen}
              event={selectedEvent}
              units={units}
              onOpenChange={closeDialog}
            />
          </LazyDialogMount>
        </>
      ) : null}
    </PageContainer>
  )
}
