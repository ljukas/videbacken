import { InfoIcon } from 'lucide-react'
import type * as React from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { Estimated } from './Estimated'
import { formatScore, formatSek } from './format'
import { Unknown } from './Unknown'

type Economy = RouterOutputs['evCharging']['session']['economy']

// A session's kronor figures. An excluded session (no hourly data, or a price
// or tariff missing) keeps only its own cost — and only when that is complete —
// with the reason underneath. A partial cost is "—", never the partial kronor.
export function SessionEconomyFigures({
  economy,
  estimated = false,
}: {
  economy: Economy
  /** The session was priced from its total alone (no hourly values): mark its cost "≈", as the session list does. */
  estimated?: boolean
}) {
  const cf = economy.counterfactual
  const actual = economy.actualComplete ? (
    <Estimated estimated={estimated}>{formatSek(economy.actual.totalSek, 2)}</Estimated>
  ) : (
    <Unknown label={m.charging_sessions_cost_unknown()} />
  )
  // `hints` are visible lines under the value, as on the economy page's tiles.
  // A session with too little price spread has no score: its dash is hidden from screen readers
  // and the visible line gives the reason (with the price spread) instead of the hint.
  // A score shows the spread too.
  const spread = cf ? formatSek(cf.dearest.totalSek - cf.optimal.totalSek, 2) : ''
  const items: { label: string; value: React.ReactNode; hints?: string[] }[] = cf
    ? [
        { label: m.charging_session_fig_actual(), value: actual },
        { label: m.charging_session_fig_immediate(), value: formatSek(cf.immediate.totalSek, 2) },
        { label: m.charging_session_fig_optimal(), value: formatSek(cf.optimal.totalSek, 2) },
        cf.score === null
          ? {
              label: m.charging_session_fig_score(),
              value: <span aria-hidden="true">—</span>,
              hints: [m.charging_economy_tile_no_spread({ spread })],
            }
          : {
              label: m.charging_session_fig_score(),
              value: formatScore(cf.score),
              hints: [
                m.charging_economy_score_spread({ spread }),
                m.charging_economy_tile_score_hint(),
              ],
            },
      ]
    : [{ label: m.charging_session_fig_actual(), value: actual }]
  return (
    <div className="flex flex-col gap-3">
      <div className="@container">
        {/* One tile (an excluded session) takes the whole row, not half of it. */}
        <div
          className={cn(
            'grid gap-3',
            items.length > 1 ? '@2xl:grid-cols-4 @md:grid-cols-2 grid-cols-1' : 'grid-cols-1',
          )}
        >
          {items.map((item) => (
            <Card key={item.label} role="group" aria-label={item.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-sm">{item.label}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <span className="font-semibold text-2xl tabular-nums">{item.value}</span>
                {item.hints?.map((hint) => (
                  <span key={hint} className="text-muted-foreground text-xs">
                    {hint}
                  </span>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      {economy.excluded ? (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            {economy.excluded === 'no_hourly'
              ? m.charging_session_excluded_no_hourly()
              : m.charging_session_excluded_no_price()}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
