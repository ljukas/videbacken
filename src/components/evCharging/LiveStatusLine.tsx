import { useQuery } from '@tanstack/react-query'
import { Fragment } from 'react'
import { Skeleton } from '~/components/ui/skeleton'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

type LiveStatus = RouterOutputs['evCharging']['liveStatus']
type LiveMode = NonNullable<LiveStatus>['mode']

const MODE_LABEL: Record<LiveMode, () => string> = {
  disconnected: m.charging_live_mode_disconnected,
  connected_requesting: m.charging_live_mode_connected_requesting,
  charging: m.charging_live_mode_charging,
  connected_finished: m.charging_live_mode_connected_finished,
  unknown: m.charging_live_mode_unknown,
}

// The polled live status for `LiveStatusLine`. Client-only (not in the route
// loader) so a live Zaptec call never blocks SSR. A failed request (network,
// 5xx) reads as `null` — "unavailable" — rather than leaving the line on its
// loading skeleton forever. It stays `null` while the next poll retries: with
// no data, a refetch resets the query to `pending` with `error: null`, so
// isError alone would flip the line back to the skeleton (errorUpdateCount
// survives that reset).
export function useLiveStatus(): LiveStatus | undefined {
  const query = useQuery({
    ...orpc.evCharging.liveStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  const failed = query.isError || (query.data === undefined && query.errorUpdateCount > 0)
  return failed ? null : query.data
}

// The charger right now, as one line in the page heading — outside the vehicle
// filter, which it doesn't depend on. `undefined` = still loading (the query is
// client-only, so SSR always renders the skeleton); `null` = no charger or Zaptec
// unavailable — never a health problem. Emphasised only while charging.
export function LiveStatusLine({ live }: { live: LiveStatus | undefined }) {
  const charging = live?.mode === 'charging'
  const parts: string[] = []
  if (live) {
    parts.push(MODE_LABEL[live.mode]())
    if (charging && live.powerKw != null) parts.push(`${formatOneDecimal(live.powerKw)} kW`)
    if (live.sessionKwh != null && live.mode !== 'disconnected') {
      parts.push(m.charging_live_session_kwh({ kwh: formatOneDecimal(live.sessionKwh) }))
    }
  }
  return (
    <div
      className={cn(
        'flex min-h-5 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm',
        charging ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="sr-only">{m.charging_live_title()}: </span>
      {live === undefined ? (
        <Skeleton className="h-4 w-48 max-w-full" />
      ) : live === null ? (
        <span>{m.charging_live_unavailable()}</span>
      ) : (
        <>
          <span
            aria-hidden
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              charging ? 'bg-chart-1' : 'bg-muted-foreground/40',
            )}
          />
          {parts.map((part, i) => (
            <Fragment key={part}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span className="tabular-nums">{part}</span>
            </Fragment>
          ))}
        </>
      )}
    </div>
  )
}
