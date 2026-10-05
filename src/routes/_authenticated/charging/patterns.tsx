import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CalendarXIcon } from 'lucide-react'
import { useCallback, useId, useMemo, useRef } from 'react'
import { z } from 'zod'
import { ChargingCalendar } from '~/components/evCharging/ChargingCalendar'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { HourOfDayChart } from '~/components/evCharging/HourOfDayChart'
import {
  firstLoadPending,
  LoadErrorAlert,
  loadFailed,
} from '~/components/evCharging/LoadErrorAlert'
import { MetricToggle } from '~/components/evCharging/MetricToggle'
import { PatternLegend } from '~/components/evCharging/PatternLegend'
import {
  calendarIntensity,
  hasPatternData,
  heatmapIntensity,
  type PatternMetric,
} from '~/components/evCharging/patternChart'
import { SessionTimeline } from '~/components/evCharging/SessionTimeline'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { VehicleScopeToggle } from '~/components/evCharging/VehicleScopeToggle'
import { WeekdayHourHeatmap } from '~/components/evCharging/WeekdayHourHeatmap'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import {
  DEFAULT_VEHICLE_SCOPE,
  type VehicleScope,
  vehicleScope,
  vehicleScopeParam,
} from '~/lib/evCharging/vehicle'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  metric: z.enum(['kwh', 'plugged']).optional().catch(undefined),
  month: z.number().int().min(1).max(12).optional().catch(undefined),
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
})

const patternsQuery = (year: number | undefined, vehicle: VehicleScope) =>
  orpc.evCharging.patterns.queryOptions({ input: { year, vehicle } })
const timelineQuery = (
  year: number | undefined,
  month: number | undefined,
  vehicle: VehicleScope,
) => orpc.evCharging.timeline.queryOptions({ input: { year, month, vehicle } })

export const Route = createFileRoute('/_authenticated/charging/patterns')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_patterns_title(),
      description: m.meta_charging_patterns_description(),
    }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    year: search.year,
    month: search.month,
    vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE,
  }),
  // ADR-0025: awaited on the server only; the client shows the skeletons. A
  // failed read shows its own alert with a retry instead of taking down the page.
  loader: ({ context: { queryClient }, deps }) =>
    loadRouteData(queryClient, {
      critical: [
        patternsQuery(deps.year, deps.vehicle),
        timelineQuery(deps.year, deps.month, deps.vehicle),
        orpc.evCharging.syncStatus.queryOptions(),
      ],
    }),
  component: PatternsPage,
})

function PatternsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const metric: PatternMetric = search.metric ?? 'kwh'
  const vehicle: VehicleScope = search.vehicle ?? DEFAULT_VEHICLE_SCOPE
  const timelineRef = useRef<HTMLDivElement>(null)
  const patternsResult = useQuery({
    ...patternsQuery(search.year, vehicle),
    placeholderData: keepPreviousData, // keep the old page while another year loads
  })
  const timelineResult = useQuery({
    ...timelineQuery(search.year, search.month, vehicle),
    placeholderData: keepPreviousData,
  })
  const { data: patterns, isPlaceholderData: patternsStale } = patternsResult
  const { data: timeline } = timelineResult
  // A failed month's alert isn't a stale timeline: don't dim it or mark it busy.
  const timelineStale = timelineResult.isPlaceholderData && !loadFailed(timelineResult)
  const set = useCallback(
    (next: { year?: number; metric?: PatternMetric; month?: number; vehicle?: VehicleScope }) =>
      navigate({ to: '.', search: (s) => ({ ...s, ...next }), replace: true, resetScroll: false }),
    [navigate],
  )
  const pickMonth = useCallback(
    (mo: number) => {
      set({ month: mo })
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      timelineRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: reduce ? 'auto' : 'smooth',
      })
    },
    [set],
  )
  const stepMonth = useCallback((mo: number) => set({ month: mo }), [set])
  const ids = [useId(), useId(), useId(), useId()]
  const hasData = patterns ? hasPatternData(patterns) : false
  // The same scales the heatmap and calendar derive for their cells.
  const heatmapScale = useMemo(
    () => (patterns ? heatmapIntensity(patterns.weekdayHour, metric) : undefined),
    [patterns, metric],
  )
  const calendarScale = useMemo(
    () => (patterns ? calendarIntensity(patterns.daily) : undefined),
    [patterns],
  )
  const today = stockholmDayOf(Date.now())
  const dim = (stale: boolean) => cn('transition-opacity', stale && 'opacity-60')
  return (
    <PageContainer>
      <ChargingHeading
        title={m.charging_patterns_title()}
        lastSuccessAt={health?.lastSuccessAt}
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
          retrying={syncNow.isPendingFor('zaptec')}
        />
      ) : null}

      {/* Outside the load branches: a failed read for one scope must not take
          the control away, or the user can't switch back. */}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <VehicleScopeToggle
          value={vehicle}
          // A scope change clears the month, like a year change does.
          onChange={(v) => set({ vehicle: vehicleScopeParam(v), month: undefined })}
        />
        {patterns && !loadFailed(patternsResult) ? (
          <YearSelector
            years={patterns.years}
            value={patterns.year}
            onChange={(y) => set({ year: y, month: undefined })}
          />
        ) : null}
      </div>

      <SectionSkeleton
        name="charging-patterns"
        loading={firstLoadPending(patternsResult)}
        fallbackHeight="48rem"
      >
        {patterns && !loadFailed(patternsResult) ? (
          <>
            {hasData ? (
              <div className="flex flex-col gap-4">
                <section
                  aria-labelledby={ids[0]}
                  aria-busy={patternsStale}
                  className={dim(patternsStale)}
                >
                  <Card>
                    <CardHeader className="gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 id={ids[0]} className="font-medium text-sm">
                          {metric === 'kwh'
                            ? m.charging_patterns_heatmap_title_kwh()
                            : m.charging_patterns_heatmap_title_plugged()}
                        </h2>
                        <MetricToggle
                          value={metric}
                          options={[
                            { value: 'kwh', label: m.charging_patterns_metric_kwh() },
                            { value: 'plugged', label: m.charging_patterns_metric_plugged() },
                          ]}
                          onChange={(v) => set({ metric: v })}
                          aria-label={m.charging_patterns_metric_label()}
                        />
                      </div>
                      {heatmapScale ? <PatternLegend scale={heatmapScale} metric={metric} /> : null}
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <WeekdayHourHeatmap grid={patterns.weekdayHour} metric={metric} />
                      {/* Interval-less sessions do count in the plugged-in view. */}
                      {metric === 'kwh' && patterns.unhourlySessions > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          {m.charging_patterns_unhourly_note({ count: patterns.unhourlySessions })}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                </section>

                <section
                  aria-labelledby={ids[1]}
                  aria-busy={patternsStale}
                  className={dim(patternsStale)}
                >
                  <Card>
                    <CardHeader>
                      <h2 id={ids[1]} className="font-medium text-sm">
                        {metric === 'kwh'
                          ? m.charging_patterns_hour_title_kwh()
                          : m.charging_patterns_hour_title_plugged()}
                      </h2>
                    </CardHeader>
                    <CardContent>
                      <HourOfDayChart hours={patterns.hourOfDay} metric={metric} />
                    </CardContent>
                  </Card>
                </section>

                <section
                  aria-labelledby={ids[2]}
                  aria-busy={patternsStale}
                  className={dim(patternsStale)}
                >
                  <Card>
                    <CardHeader className="gap-2">
                      <h2 id={ids[2]} className="font-medium text-sm">
                        {m.charging_patterns_calendar_title()}
                      </h2>
                      {calendarScale ? <PatternLegend scale={calendarScale} metric="kwh" /> : null}
                    </CardHeader>
                    <CardContent>
                      <ChargingCalendar
                        year={patterns.year}
                        daily={patterns.daily}
                        months={patterns.months}
                        today={today}
                        onPickMonth={pickMonth}
                      />
                    </CardContent>
                  </Card>
                </section>

                <section
                  ref={timelineRef}
                  aria-labelledby={ids[3]}
                  aria-busy={timelineStale}
                  className={dim(timelineStale)}
                >
                  <Card>
                    <CardHeader>
                      <h2 id={ids[3]} className="font-medium text-sm">
                        {m.charging_patterns_timeline_title()}
                      </h2>
                    </CardHeader>
                    <CardContent>
                      <SectionSkeleton
                        name="charging-timeline"
                        loading={firstLoadPending(timelineResult)}
                        fallbackHeight="16rem"
                      >
                        {timeline && !loadFailed(timelineResult) ? (
                          <SessionTimeline
                            sessions={timeline.sessions}
                            year={timeline.year}
                            month={timeline.month}
                            months={timeline.months}
                            onMonth={stepMonth}
                          />
                        ) : (
                          <LoadErrorAlert
                            title={m.charging_patterns_timeline_error_title()}
                            query={timelineResult}
                          />
                        )}
                      </SectionSkeleton>
                    </CardContent>
                  </Card>
                </section>
              </div>
            ) : (
              <Empty
                className={cn('brand-wash rounded-lg border', dim(patternsStale))}
                aria-busy={patternsStale}
              >
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarXIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {vehicle === 'other'
                      ? m.charging_vehicle_empty_other_title({ year: patterns.year })
                      : m.charging_patterns_empty_title({ year: patterns.year })}
                  </EmptyTitle>
                  <EmptyDescription>
                    {vehicle === 'other'
                      ? m.charging_vehicle_empty_other_description()
                      : m.charging_patterns_empty_description()}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </>
        ) : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_patterns_error_title()} query={patternsResult} />
    </PageContainer>
  )
}
