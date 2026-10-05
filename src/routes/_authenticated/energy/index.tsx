import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SunIcon } from 'lucide-react'
import { z } from 'zod'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { emaldoHealthQuery, energyOverviewQuery } from '~/components/energy/energyQueries'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { PageContainer } from '~/components/layout/PageContainer'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/energy/')({
  head: () => ({
    meta: seo({ title: m.meta_energy_title(), description: m.meta_energy_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year }),
  // Prefetched, not ensured: a failed read shows its own alert under a
  // working heading and health alert (like /charging/economy).
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.prefetchQuery(energyOverviewQuery(deps.year)),
      queryClient.ensureQueryData(emaldoHealthQuery),
    ])
  },
  component: EnergyOverviewPage,
})

function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({ ...emaldoHealthQuery, refetchInterval: 60_000 })
  const year = Route.useSearch({ select: (s) => s.year })
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({ ...energyOverviewQuery(year), placeholderData: keepPreviousData })
  const { data: overview } = result

  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health.lastSuccessAt} />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('emaldo')}
        retrying={syncNow.isPendingFor('emaldo')}
      />
      {overview && !loadFailed(result) ? (
        overview.firstReadingDay === null ? (
          <Empty className="brand-wash rounded-lg border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SunIcon />
              </EmptyMedia>
              <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null
      ) : (
        <LoadErrorAlert title={m.energy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
