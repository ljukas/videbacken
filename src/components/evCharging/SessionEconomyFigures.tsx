import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatScore, formatSek } from './format'
import { Unknown } from './Unknown'

type Economy = RouterOutputs['evCharging']['session']['economy']

// A session's kronor figures. An excluded session (no hourly data, or a price
// or tariff missing) keeps only its own cost — and only when that is complete —
// with the reason underneath. A partial cost is "—", never the partial kronor.
export function SessionEconomyFigures({ economy }: { economy: Economy }) {
  const cf = economy.counterfactual
  const actual = economy.actualComplete ? (
    formatSek(economy.actual.totalSek, 2)
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
        <div className="grid @2xl:grid-cols-4 grid-cols-2 gap-3">
          {items.map((item) => (
            <Card key={item.label}>
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
        <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
          {economy.excluded === 'no_hourly'
            ? m.charging_session_excluded_no_hourly()
            : m.charging_session_excluded_no_price()}
        </p>
      ) : null}
    </div>
  )
}
