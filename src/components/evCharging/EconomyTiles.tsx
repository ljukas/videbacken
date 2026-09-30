import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOre, formatScore, formatSignedSek } from './format'

type Totals = RouterOutputs['evCharging']['economy']['tiles']

// The selected year's four headline figures. Spot timing only — the caveat
// lives in EconomyFootnote under the page. Nothing comparable (every session
// excluded) is said in words, never shown as 0 kr / 0 % (ADR-0020).
export function EconomyTiles({ tiles }: { tiles: Totals }) {
  const none = tiles.included === 0
  const items = [
    {
      label: m.charging_economy_tile_saved(),
      value: none ? null : formatSignedSek(tiles.savedVsImmediateSek),
      hint: m.charging_economy_tile_saved_hint(),
      emptyReason: m.charging_economy_tile_none(),
    },
    {
      label: m.charging_economy_tile_left(),
      value: none ? null : formatSignedSek(tiles.leftOnTableSek),
      hint: m.charging_economy_tile_left_hint(),
      emptyReason: m.charging_economy_tile_none(),
    },
    {
      label: m.charging_economy_tile_score(),
      value: none || tiles.score === null ? null : formatScore(tiles.score),
      hint: m.charging_economy_tile_score_hint(),
      // Flat prices (no spread between cheapest and dearest) give no score
      // even though sessions were compared.
      emptyReason: none ? m.charging_economy_tile_none() : m.charging_economy_tile_no_spread(),
    },
    {
      label: m.charging_economy_tile_spot(),
      value:
        tiles.paidSpotOre === null
          ? null
          : m.charging_economy_ore({ value: formatOre(tiles.paidSpotOre) }),
      hint:
        tiles.avgSpotOre === null
          ? null
          : m.charging_economy_tile_spot_avg({ avg: formatOre(tiles.avgSpotOre) }),
      emptyReason: none ? m.charging_economy_tile_none() : null,
    },
  ]
  // Container query like TotalsTiles: 4 across only when the column is wide.
  return (
    <div className="@container">
      <div className="grid @3xl:grid-cols-4 @md:grid-cols-2 grid-cols-1 gap-3">
        {items.map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm">{item.label}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {item.value === null ? (
                <>
                  <span className="font-semibold text-2xl tabular-nums" aria-hidden>
                    —
                  </span>
                  {(item.emptyReason ?? item.hint) ? (
                    <span className="text-muted-foreground text-xs">
                      {item.emptyReason ?? item.hint}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="font-semibold text-2xl tabular-nums">{item.value}</span>
                  {item.hint ? (
                    <span className="text-muted-foreground text-xs">{item.hint}</span>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
