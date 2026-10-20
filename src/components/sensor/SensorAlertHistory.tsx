import { useInfiniteQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { orpc } from '~/lib/orpc/client'
import type { SensorAlertEventDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { alertEventPeriodParts, alertRuleDescription } from './alertRuleCopy'
import { nowrapMessage } from './nowrapMessage'

type Cursor = { startedAt: Date; id: string }

// "Senaste larm" (ADR-0028): the viewer's alerts on one sensor, newest first, ten at a time.
// Polled like the rules while the dialog is open. Nothing until an entry exists; a failed read is
// one muted line, the rules above stay usable.
export function SensorAlertHistory({ deviceId, open }: { deviceId: string; open: boolean }) {
  const headingId = useId()
  const history = useInfiniteQuery(
    orpc.sensor.alerts.history.infiniteOptions({
      input: (before: Cursor | undefined) => ({ deviceId, before }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.next ?? undefined,
      enabled: open,
      refetchInterval: 60_000,
    }),
  )
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? []
  const failed = history.isError ? (
    <p role="status" className="text-muted-foreground text-sm">
      {m.sensors_alert_history_failed()}
    </p>
  ) : null

  if (entries.length === 0) return failed

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={history.isFetching || undefined}
      className="flex flex-col gap-2"
    >
      <h3 id={headingId} className="font-medium text-sm">
        {m.sensors_alert_history_heading()}
      </h3>
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-col text-sm">
            <span>{alertRuleDescription(e)}</span>
            <span className="text-muted-foreground tabular-nums">
              <AlertPeriod event={e} />
            </span>
          </li>
        ))}
      </ul>
      {failed}
      {history.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? <Spinner aria-hidden /> : null}
          {m.sensors_alert_history_more()}
        </Button>
      ) : null}
    </section>
  )
}

/** The period with each date and the duration kept on one line; the line wraps between them. */
function AlertPeriod({ event }: { event: SensorAlertEventDto }) {
  const { start, end, duration, reason } = alertEventPeriodParts(event)
  if (end === null || duration === null) {
    return <>{nowrapMessage(m.sensors_alert_history_ongoing, { start })}</>
  }
  return (
    <>
      {nowrapMessage(m.sensors_alert_history_period, { start, end, duration })}
      {reason === null ? null : ` · ${reason}`}
    </>
  )
}
