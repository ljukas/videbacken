import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatCount, formatOneDecimal } from './format'

type Tiles = RouterOutputs['evCharging']['overview']['tiles']
type Totals = Tiles['thisMonth']

// This month / this year / all time. "This month/year" are always the CURRENT
// Stockholm month/year (the service computes them independently of the year
// the chart is showing).
export function TotalsTiles({ tiles }: { tiles: Tiles }) {
  const items: { key: keyof Tiles; label: string; totals: Totals }[] = [
    { key: 'thisMonth', label: m.charging_tile_this_month(), totals: tiles.thisMonth },
    { key: 'thisYear', label: m.charging_tile_this_year(), totals: tiles.thisYear },
    { key: 'allTime', label: m.charging_tile_all_time(), totals: tiles.allTime },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              {m.charging_tile_sessions({ count: formatCount(totals.sessions) })}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
