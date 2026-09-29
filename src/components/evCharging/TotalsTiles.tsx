import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatKronor, formatOneDecimal, formatOre, formatSek, formatShare } from './format'

type Tiles = RouterOutputs['evCharging']['overview']['tiles']
type Totals = Tiles['thisMonth']
export type Cost = RouterOutputs['evCharging']['costOverview']['tiles']['thisMonth']
type CostTiles = Record<keyof Tiles, Cost>

// This month / this year / all time. "This month/year" are always the CURRENT
// Stockholm month/year (the service computes them independently of the year
// the chart is showing). Energy and cost are twin readouts of equal weight —
// neither is the headline — once the page passes `cost` (it does once
// something is priced); without it the tile is energy alone, and kWh never
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
              <TileReadouts totals={totals} cost={cost?.[key]} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// Two columns split by a hairline when the tile is wide enough, stacked when
// it isn't (a third-width tile at md–lg). The footer carries what qualifies
// both: the average price, or why the cost is incomplete or missing.
//
// Missing data is said in words, never shown as 0 kr (a missing price or
// tariff is a state, ADR-0020): a partly priced total is qualified "minst"
// with the share that lacks a price; energy with no price at all reads "—".
// No energy is a true 0 kr.
function TileReadouts({ totals, cost }: { totals: Totals; cost: Cost | undefined }) {
  const energy = (
    <Readout
      label={m.charging_tile_energy()}
      value={formatOneDecimal(totals.kwh)}
      unit="kWh"
      detail={m.charging_tile_sessions({ count: totals.sessions })}
    />
  )
  if (!cost) return energy

  const unpriced = cost.kwh > 0 && cost.avgOre === null
  // Energy counted as missing a price or tariff. Zero here with an incomplete
  // total means an over-count (overlapping slots), so "minst" would be wrong.
  const missingKwh = cost.noPriceKwh + cost.noTariffKwh
  const short = !unpriced && !cost.complete && missingKwh > 0
  const footer = tileFooter(cost, { unpriced, short, missingKwh })

  return (
    <div className="@container/tile flex flex-col gap-3">
      <div className="grid @[16rem]/tile:grid-cols-2 gap-3 @[16rem]/tile:gap-0">
        <div className="@[16rem]/tile:pr-4">{energy}</div>
        <div className="@[16rem]/tile:border-l @[16rem]/tile:pl-4">
          {unpriced ? (
            <Readout
              label={m.charging_tile_cost()}
              value="—"
              muted
              detail={m.charging_cost_unknown()}
            />
          ) : (
            <Readout
              label={m.charging_tile_cost()}
              qualifier={short ? m.charging_cost_min_prefix() : undefined}
              value={formatKronor(cost.totalSek)}
              unit="kr"
              detail={
                cost.kwh === 0
                  ? undefined
                  : m.charging_cost_spot_share({ spot: formatSek(cost.spotSek) })
              }
            />
          )}
        </div>
      </div>
      {footer ? <p className="border-t pt-3 text-muted-foreground text-xs">{footer}</p> : null}
    </div>
  )
}

function tileFooter(
  cost: Cost,
  { unpriced, short, missingKwh }: { unpriced: boolean; short: boolean; missingKwh: number },
): string | null {
  if (unpriced) return m.charging_cost_unknown_hint()
  if (cost.kwh === 0) return null
  if (short) return m.charging_cost_partial_hint({ share: formatShare(missingKwh / cost.gridKwh) })
  if (!cost.complete) return m.charging_cost_partial_hint_generic()
  // The average covers priced energy only, so it's shown beside a complete total only.
  return cost.avgOre === null ? null : m.charging_cost_avg({ avg: formatOre(cost.avgOre) })
}

// One figure: a small label, the number large with its unit set small beside
// it, and a detail line. The spaces between the parts are real text, so the
// figure reads (and copies) as "1 659,8 kWh".
function Readout({
  label,
  value,
  unit,
  qualifier,
  detail,
  muted = false,
}: {
  label: string
  value: string
  unit?: string
  qualifier?: string
  detail?: ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
        {qualifier ? (
          <>
            <span className="text-muted-foreground text-sm">{qualifier}</span>{' '}
          </>
        ) : null}
        <span
          className={cn('font-semibold text-2xl leading-tight', muted && 'text-muted-foreground')}
        >
          {value}
        </span>
        {unit ? (
          <>
            {' '}
            <span className="text-muted-foreground text-sm">{unit}</span>
          </>
        ) : null}
      </span>
      {detail ? <span className="text-muted-foreground text-sm">{detail}</span> : null}
    </div>
  )
}
