import { InfoIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
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
    <span title={estimated ? m.charging_sessions_cost_estimated() : undefined}>
      {estimated ? '≈ ' : null}
      {formatSek(economy.actual.totalSek, 2)}
      {estimated ? (
        <span className="sr-only"> ({m.charging_sessions_cost_estimated()})</span>
      ) : null}
    </span>
  ) : (
    <Unknown label={m.charging_sessions_cost_unknown()} />
  )
  const items = cf
    ? [
        { label: m.charging_session_fig_actual(), value: actual },
        { label: m.charging_session_fig_immediate(), value: formatSek(cf.immediate.totalSek, 2) },
        { label: m.charging_session_fig_optimal(), value: formatSek(cf.optimal.totalSek, 2) },
        {
          label: m.charging_session_fig_score(),
          value:
            cf.score === null ? (
              <Unknown label={m.charging_economy_tile_no_spread()} />
            ) : (
              formatScore(cf.score)
            ),
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
              <CardContent className="font-semibold text-2xl tabular-nums">
                {item.value}
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
