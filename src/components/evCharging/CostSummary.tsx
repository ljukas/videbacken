import { Badge } from '~/components/ui/badge'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOneDecimal, formatOre, formatSek } from './format'

export type Cost = RouterOutputs['evCharging']['costOverview']['tiles']['thisMonth']

// The cost lines under a tile's kWh: total incl VAT, average öre/kWh and the
// spot share. Missing data is said in words, never shown as 0 kr (spec: a
// missing price/tariff is a state): "Delvis" with how many kWh lack a price,
// or "Kostnad saknas" when nothing could be priced. No energy → no cost line.
export function CostSummary({ cost }: { cost: Cost }) {
  if (cost.kwh === 0) return null
  if (cost.avgOre === null) {
    return (
      <div className="text-muted-foreground text-sm">
        <div>{m.charging_cost_unknown()}</div>
        <div className="text-xs">{m.charging_cost_unknown_hint()}</div>
      </div>
    )
  }
  const missingKwh = cost.gridKwh - cost.fullKwh
  return (
    <div className="flex flex-col gap-0.5 text-sm tabular-nums">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {m.charging_cost_total({ total: formatSek(cost.totalSek) })}
        </span>
        {cost.complete ? null : <Badge variant="outline">{m.charging_cost_partial()}</Badge>}
      </div>
      <div className="text-muted-foreground">
        {m.charging_cost_avg({ avg: formatOre(cost.avgOre) })} ·{' '}
        {m.charging_cost_spot_part({ spot: formatSek(cost.spotSek) })}
      </div>
      {cost.complete ? null : (
        <div className="text-muted-foreground text-xs">
          {m.charging_cost_partial_hint({ kwh: formatOneDecimal(missingKwh) })}
        </div>
      )}
    </div>
  )
}
