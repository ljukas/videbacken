import { Fragment } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOneDecimal, formatOre, formatSek, formatShare } from './format'

type Tiles = RouterOutputs['evCharging']['overview']['tiles']
type Totals = Tiles['thisMonth']
export type Cost = RouterOutputs['evCharging']['costOverview']['tiles']['thisMonth']
type CostTiles = Record<keyof Tiles, Cost>

// This month / this year / all time. "This month/year" are always the CURRENT
// Stockholm month/year (the service computes them independently of the year
// the chart is showing). With `cost` (the page passes it once something is
// priced), kronor is the headline and kWh the detail; without it — or for a
// tile whose energy has no price at all — kWh leads, and kWh never waits for
// (or breaks on) prices.
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
            <CardContent className="flex flex-col gap-0.5 tabular-nums">
              <TileFigures totals={totals} cost={cost?.[key]} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

const hero = 'font-semibold text-2xl'
const detail = 'text-muted-foreground text-sm'

// Missing data is said in words, never shown as 0 kr (a missing price or
// tariff is a state, ADR-0020): a partly priced total is "minst …" with the
// share that lacks a price; energy with no price at all keeps kWh as the
// headline and says the cost is missing. No energy is a true 0 kr.
function TileFigures({ totals, cost }: { totals: Totals; cost: Cost | undefined }) {
  const kwh = `${formatOneDecimal(totals.kwh)} kWh`
  const sessions = m.charging_tile_sessions({ count: totals.sessions })

  if (!cost || (cost.kwh > 0 && cost.avgOre === null)) {
    return (
      <>
        <div className={hero}>{kwh}</div>
        <div className={detail}>{sessions}</div>
        {cost ? (
          <div className="mt-1 text-muted-foreground text-xs">
            {m.charging_cost_unknown()}: {m.charging_cost_unknown_hint()}
          </div>
        ) : null}
      </>
    )
  }

  const total = formatSek(cost.totalSek)
  // Energy counted as missing a price or tariff. Zero here with an incomplete
  // total means an over-count (overlapping slots), so "at least" would be wrong.
  const missingKwh = cost.noPriceKwh + cost.noTariffKwh
  const short = !cost.complete && missingKwh > 0
  // The average covers priced energy only, so it's shown beside a complete
  // total — next to "minst …" it wouldn't match the kWh beside it.
  const facts = [kwh, sessions]
  if (cost.complete && cost.avgOre !== null) {
    facts.push(m.charging_cost_avg({ avg: formatOre(cost.avgOre) }))
  }
  return (
    <>
      <div className={hero}>{short ? m.charging_cost_min({ total }) : total}</div>
      {/* No charging: a bare 0 kr, without a "varav spotpris 0 kr" breakdown. */}
      {cost.kwh === 0 ? null : (
        <div className={detail}>{m.charging_cost_breakdown({ spot: formatSek(cost.spotSek) })}</div>
      )}
      <div className={`${detail} mt-1`}>
        {/* The "·" travels with the fact after it, so a wrap never leaves one dangling. */}
        {facts.map((fact, i) => (
          <Fragment key={fact}>
            {i > 0 ? ' ' : null}
            <span className="whitespace-nowrap">{i > 0 ? `· ${fact}` : fact}</span>
          </Fragment>
        ))}
      </div>
      {cost.complete ? null : (
        <div className="mt-1 text-muted-foreground text-xs">
          {short
            ? m.charging_cost_partial_hint({ share: formatShare(missingKwh / cost.gridKwh) })
            : m.charging_cost_partial_hint_generic()}
        </div>
      )}
    </>
  )
}
