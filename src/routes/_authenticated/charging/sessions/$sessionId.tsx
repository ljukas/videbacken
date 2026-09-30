import { ORPCError } from '@orpc/client'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { z } from 'zod'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { formatOneDecimal, formatTime, formatWeekdayDay } from '~/components/evCharging/format'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SessionEconomyFigures } from '~/components/evCharging/SessionEconomyFigures'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
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
  // any other failure is left to the page's load-error alert.
  loader: async ({ context: { queryClient }, params }) => {
    if (!z.uuid().safeParse(params.sessionId).success) throw notFound()
    try {
      await queryClient.ensureQueryData(sessionQuery(params.sessionId))
    } catch (err) {
      if (err instanceof ORPCError && err.code === 'EV_SESSION_NOT_FOUND') throw notFound()
    }
  },
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const result = useQuery(sessionQuery(sessionId))
  const detail = result.data
  return (
    <PageContainer>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          {/* History back would leave the app on a deep link; the overview is the section's home. */}
          <Link to="/charging">
            <ArrowLeftIcon />
            {m.charging_session_back()}
          </Link>
        </Button>
      </div>
      {detail && !loadFailed(result) ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
              {formatWeekdayDay(detail.session.startAt)} · {formatTime(detail.session.startAt)}–
              {formatTime(detail.session.endAt)}
            </h1>
            <p className="text-muted-foreground text-sm">
              {m.charging_session_summary({
                kwh: formatOneDecimal(detail.session.kwh),
                peak:
                  detail.session.peakKw === null ? '—' : formatOneDecimal(detail.session.peakKw),
              })}
            </p>
          </header>
          <SessionEconomyFigures economy={detail.economy} />
          {/* C2: SessionPriceChart */}
          <EconomyFootnote excluded={{ noHourly: 0, noPrice: 0 }} />
        </>
      ) : (
        <LoadErrorAlert title={m.charging_session_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
