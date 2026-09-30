import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { ChargingTabs } from '~/components/evCharging/ChargingTabs'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { PageContainer } from '~/components/layout/PageContainer'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  metric: z.enum(['kwh', 'plugged']).optional().catch(undefined),
  month: z.number().int().min(1).max(12).optional().catch(undefined),
})

const patternsQuery = (year?: number) => orpc.evCharging.patterns.queryOptions({ input: { year } })
const timelineQuery = (year?: number, month?: number) =>
  orpc.evCharging.timeline.queryOptions({ input: { year, month } })

export const Route = createFileRoute('/_authenticated/charging/patterns')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_patterns_title(),
      description: m.meta_charging_patterns_description(),
    }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year, month: search.month }),
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(patternsQuery(deps.year)),
      queryClient.ensureQueryData(timelineQuery(deps.year, deps.month)),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
    ])
  },
  component: PatternsPage,
})

function PatternsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  return (
    <PageContainer>
      <ChargingHeading
        lastSuccessAt={health.lastSuccessAt}
        action={
          isAdmin ? <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} /> : null
        }
      />
      <ChargingTabs current="patterns" />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('zaptec')}
        retrying={syncNow.isPendingFor('zaptec')}
      />
    </PageContainer>
  )
}
