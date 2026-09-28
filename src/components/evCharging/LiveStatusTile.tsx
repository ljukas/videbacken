import { useQuery } from '@tanstack/react-query'
import { PlugZapIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
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

// The polled live status for `LiveStatusTile`. Client-only (not in the route
// loader) so a live Zaptec call never blocks SSR. A failed request (network,
// 5xx) reads as `null` — "unavailable" — rather than leaving the tile on its
// loading skeleton forever.
export function useLiveStatus(): LiveStatus | undefined {
  const query = useQuery({
    ...orpc.evCharging.liveStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  return query.isError ? null : query.data
}

// The charger's live mode + power. `undefined` = still loading (the query is
// client-only, so SSR always renders the skeleton); `null` = no charger or
// Zaptec unavailable — just "no live tile", never a health problem.
export function LiveStatusTile({ live }: { live: LiveStatus | undefined }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <PlugZapIcon className="size-4 text-muted-foreground" aria-hidden />
          {m.charging_live_title()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {live === undefined ? (
          <Skeleton className="h-8 w-40" />
        ) : live === null ? (
          <p className="text-muted-foreground text-sm">{m.charging_live_unavailable()}</p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="flex items-center gap-2 font-semibold text-lg">
              <span
                aria-hidden
                className={cn(
                  'inline-block size-2 rounded-full',
                  live.mode === 'charging' ? 'bg-chart-1' : 'bg-muted-foreground/40',
                )}
              />
              {MODE_LABEL[live.mode]()}
            </span>
            {live.mode === 'charging' && live.powerKw != null ? (
              <span className="font-semibold text-2xl tabular-nums">
                {formatOneDecimal(live.powerKw)} kW
              </span>
            ) : null}
            {live.sessionKwh != null && live.mode !== 'disconnected' ? (
              <span className="text-muted-foreground text-sm tabular-nums">
                {m.charging_live_session_kwh({ kwh: formatOneDecimal(live.sessionKwh) })}
              </span>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
