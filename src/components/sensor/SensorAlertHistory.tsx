import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef } from 'react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { orpc } from '~/lib/orpc/client'
import type { SensorAlertEventDto } from '~/lib/sensor/alerts'
import { cn } from '~/lib/utils'
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

  const listRef = useRef<HTMLUListElement>(null)
  // "Visa fler" keeps focus while its page loads (aria-disabled, not disabled, which would drop
  // it to <body>). When that was the last page the button goes: focus moves to the first entry
  // it brought, unless focus had moved to something else meanwhile.
  const moreFocused = useRef(false)
  const firstNew = useRef<number | null>(null)
  const loadingMore = history.isFetchingNextPage
  const hasMore = history.hasNextPage
  useEffect(() => {
    if (loadingMore || firstNew.current === null) return
    const index = firstNew.current
    firstNew.current = null
    if (hasMore || !moreFocused.current) return
    moreFocused.current = false
    const items = listRef.current?.querySelectorAll<HTMLElement>(':scope > li')
    if (items?.length) (items[index] ?? items[items.length - 1]).focus()
  }, [loadingMore, hasMore])

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
      <ul ref={listRef} className="flex flex-col gap-2">
        {entries.map((e) => (
          // Focusable only by script: where "Visa fler" hands focus when it goes.
          <li
            key={e.id}
            tabIndex={-1}
            className="flex flex-col rounded-sm text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span>{alertRuleDescription(e)}</span>
            <span className="text-muted-foreground tabular-nums">
              <AlertPeriod event={e} />
            </span>
          </li>
        ))}
      </ul>
      {failed}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          className={cn(
            'pointer-coarse:h-11 self-start',
            loadingMore && 'cursor-not-allowed opacity-50',
          )}
          aria-disabled={loadingMore || undefined}
          onFocus={() => {
            moreFocused.current = true
          }}
          // Only a move to another element counts: a removed button blurs to nothing.
          onBlur={(e) => {
            if (e.relatedTarget) moreFocused.current = false
          }}
          onClick={() => {
            if (loadingMore) return
            firstNew.current = entries.length
            void history.fetchNextPage()
          }}
        >
          {loadingMore ? <Spinner aria-hidden /> : null}
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
