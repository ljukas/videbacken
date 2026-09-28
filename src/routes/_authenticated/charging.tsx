import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { LiveStatusTile } from '~/components/evCharging/LiveStatusTile'
import { MonthlyChart } from '~/components/evCharging/MonthlyChart'
import { RecentRunsCard } from '~/components/evCharging/RecentRunsCard'
import { SessionList } from '~/components/evCharging/SessionList'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { TotalsTiles } from '~/components/evCharging/TotalsTiles'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// Same bounds as the `overview` procedure input; an out-of-range or garbage
// `?year=` falls back to the current year instead of erroring the loader.
const searchSchema = z.object({
  year: z.number().int().min(2020).max(2100).optional().catch(undefined),
})

const SESSIONS_PAGE = 20
const SESSIONS_MAX = 500 // the `sessions` procedure's `limit` cap
const RECENT_RUNS = 20

export const Route = createFileRoute('/_authenticated/charging')({
  head: () => ({
    meta: seo({ title: m.meta_charging_title(), description: m.meta_charging_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year }),
  loader: async ({ context: { queryClient, user }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(
        orpc.evCharging.overview.queryOptions({ input: { year: deps.year } }),
      ),
      queryClient.ensureQueryData(
        orpc.evCharging.sessions.queryOptions({ input: { limit: SESSIONS_PAGE } }),
      ),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
      user.role === 'admin'
        ? queryClient.ensureQueryData(
            orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
          )
        : null,
    ])
  },
  component: ChargingPage,
})

function ChargingPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const navigate = Route.useNavigate()
  const year = Route.useSearch({ select: (s) => s.year })
  const [sessionLimit, setSessionLimit] = useState(SESSIONS_PAGE)
  const syncNow = useSyncNow()

  // Hourly data: no polling on overview/sessions — the default focus refetch
  // plus `syncNow`'s invalidation keep them fresh (ADR-0018).
  const { data: overview } = useQuery({
    ...orpc.evCharging.overview.queryOptions({ input: { year } }),
    placeholderData: keepPreviousData, // keep the old chart while another year loads
  })
  const sessions = useQuery({
    ...orpc.evCharging.sessions.queryOptions({ input: { limit: sessionLimit } }),
    placeholderData: keepPreviousData, // keep the rows while "Visa fler" loads
  })
  const { data: health } = useSuspenseQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  // Client-only (not in the loader): a live Zaptec call shouldn't block SSR.
  const { data: live } = useQuery({
    ...orpc.evCharging.liveStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  const { data: runs } = useQuery({
    ...orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
    enabled: isAdmin,
  })

  function setYear(y: number) {
    navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false })
  }

  return (
    <PageContainer>
      <ChargingHeading
        lastSuccessAt={health.lastSuccessAt}
        action={
          isAdmin ? <SyncNowButton onSync={syncNow.sync} pending={syncNow.isPending} /> : null
        }
      />

      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={syncNow.sync}
        retrying={syncNow.isPending}
      />

      <LiveStatusTile live={live} />

      {overview ? (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="sr-only">{m.charging_totals_heading()}</h2>
            <TotalsTiles tiles={overview.tiles} />
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium text-sm">{m.charging_chart_title()}</h2>
              <YearSelector years={overview.years} value={overview.year} onChange={setYear} />
            </div>
            {overview.months.some((mo) => mo.kwh > 0) ? (
              <MonthlyChart months={overview.months} />
            ) : (
              <div className="flex h-[260px] items-center justify-center rounded-lg border text-muted-foreground text-sm">
                {m.charging_chart_empty({ year: overview.year })}
              </div>
            )}
          </section>
        </>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">{m.charging_sessions_heading()}</h2>
        <SessionList
          sessions={sessions.data?.sessions ?? []}
          hasMore={(sessions.data?.hasMore ?? false) && sessionLimit < SESSIONS_MAX}
          onShowMore={() => setSessionLimit((l) => Math.min(l + SESSIONS_PAGE, SESSIONS_MAX))}
          loadingMore={sessions.isPlaceholderData}
          onSync={isAdmin ? syncNow.sync : undefined}
          syncing={syncNow.isPending}
        />
      </section>

      {isAdmin && runs ? <RecentRunsCard runs={runs} /> : null}
    </PageContainer>
  )
}
