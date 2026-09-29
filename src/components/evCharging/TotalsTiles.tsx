import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { type Cost, CostSummary } from './CostSummary'
import { formatOneDecimal } from './format'

type Tiles = RouterOutputs['evCharging']['overview']['tiles']
type Totals = Tiles['thisMonth']

type CostTiles = Record<keyof Tiles, Cost>

// This month / this year / all time. "This month/year" are always the CURRENT
// Stockholm month/year (the service computes them independently of the year
// the chart is showing). Cost lines appear once `cost` has loaded — kWh never
// waits for (or breaks on) prices.
export function TotalsTiles({ tiles, cost }: { tiles: Tiles; cost?: CostTiles }) {
  const items: { key: keyof Tiles; label: string; totals: Totals }[] = [
    { key: 'thisMonth', label: m.charging_tile_this_month(), totals: tiles.thisMonth },
    { key: 'thisYear', label: m.charging_tile_this_year(), totals: tiles.thisYear },
    { key: 'allTime', label: m.charging_tile_all_time(), totals: tiles.allTime },
  ]
  // A container query, not a viewport breakpoint: with the sidebar open the
  // content column at md–lg is too narrow for three "12 345,0 kWh" tiles.
  return (
    <div className="@container">
      <div className="grid @3xl:grid-cols-3 grid-cols-1 gap-3">
        {items.map(({ key, label, totals }) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-semibold text-2xl tabular-nums">
                {formatOneDecimal(totals.kwh)} kWh
              </div>
              <div className="text-muted-foreground text-sm tabular-nums">
                {m.charging_tile_sessions({ count: totals.sessions })}
              </div>
              {cost ? (
                <div className="mt-3 border-t pt-3">
                  <CostSummary cost={cost[key]} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
