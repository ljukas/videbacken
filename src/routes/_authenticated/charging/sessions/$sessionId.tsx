import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  Link,
  notFound,
  useCanGoBack,
  useHydrated,
  useRouter,
} from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { z } from 'zod'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import {
  formatOneDecimal,
  formatSessionDay,
  formatSessionTimeRange,
} from '~/components/evCharging/format'
import { GuestBadge } from '~/components/evCharging/GuestBadge'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SessionPriceChart } from '~/components/evCharging/SessionPriceChart'
import { SessionSummary } from '~/components/evCharging/SessionSummary'
import { SessionVehicle } from '~/components/evCharging/SessionVehicle'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
import { isSessionNotFound } from '~/lib/evCharging/sessionNotFound'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const sessionQuery = (sessionId: string) =>
  orpc.evCharging.session.queryOptions({ input: { sessionId } })

export const Route = createFileRoute('/_authenticated/charging/sessions/$sessionId')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_session_title(),
      description: m.meta_charging_session_description(),
    }),
  }),
  // Unknown, uncounted or malformed ids are "not found" (the root NotFound);
  // any other failure is left to the page's load-error alert, but logged.
  loader: async ({ context: { queryClient }, params }) => {
    if (!z.uuid().safeParse(params.sessionId).success) throw notFound()
    try {
      await queryClient.ensureQueryData(sessionQuery(params.sessionId))
    } catch (err) {
      if (isSessionNotFound(err)) throw notFound()
      logger.warn('session prefetch failed', { error: err, sessionId: params.sessionId })
    }
  },
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const result = useQuery(sessionQuery(sessionId))
  const detail = result.data
  return (
    <PageContainer>
      <BackButton />
      {detail && !loadFailed(result) ? (
        <>
          <header className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
                {formatSessionDay(detail.session.startAt)} ·{' '}
                {formatSessionTimeRange(detail.session.startAt, detail.session.endAt)}
              </h1>
              {detail.session.vehicle === 'other' ? <GuestBadge /> : null}
            </div>
            <p className="text-muted-foreground text-sm">
              {detail.session.peakKw === null
                ? m.charging_session_summary_no_peak({ kwh: formatOneDecimal(detail.session.kwh) })
                : m.charging_session_summary({
                    kwh: formatOneDecimal(detail.session.kwh),
                    peak: formatOneDecimal(detail.session.peakKw),
                  })}
            </p>
          </header>
          <SessionVehicle
            sessionId={detail.session.id}
            vehicle={detail.session.vehicle}
            vehicleSource={detail.session.vehicleSource}
            isAdmin={user.role === 'admin'}
          />
          <SessionSummary detail={detail} />
          <SessionPriceChart detail={detail} />
          <EconomyFootnote excluded={{ noHourly: 0, noPrice: 0 }} bucketing={false} />
        </>
      ) : (
        // Without the session there's no date to title the page with, but the
        // page keeps its one h1.
        <>
          <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
            {m.meta_charging_session_title()}
          </h1>
          <LoadErrorAlert title={m.charging_session_error_title()} query={result} />
        </>
      )}
    </PageContainer>
  )
}

// Back to wherever the visitor came from (the overview, or /charging/economy
// with its year), which a fixed link would lose. A deep link has no app history
// to go back into, so it falls back to the overview, the section's home.
// The server can't know the history, so it always renders the link; the
// button waits for hydration, or a reload of an in-app-navigated page would
// hydrate a <button> over the server's <a>.
function BackButton() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const hydrated = useHydrated()
  return (
    <div>
      {hydrated && canGoBack ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => router.history.back()}>
          <ArrowLeftIcon />
          {m.charging_session_back()}
        </Button>
      ) : (
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/charging">
            <ArrowLeftIcon />
            {m.charging_session_back()}
          </Link>
        </Button>
      )}
    </div>
  )
}
