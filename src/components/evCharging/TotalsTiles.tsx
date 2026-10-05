import {
  BanknoteIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  CircleAlertIcon,
  GaugeIcon,
  InfinityIcon,
  InfoIcon,
  type LucideIcon,
  ZapIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { ownSolarShare } from '~/lib/evCharging/cost'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatKronor, formatOneDecimal, formatOrePrecise, formatSek, formatShare } from './format'
import { SolarValueLine } from './SolarValueLine'

type Tiles = RouterOutputs['evCharging']['overview']['tiles']
type Period = keyof Tiles
type Totals = Tiles['thisMonth']
export type Cost = RouterOutputs['evCharging']['costOverview']['tiles']['thisMonth']
type CostTiles = Record<Period, Cost>

const PERIOD_ICON: Record<Period, LucideIcon> = {
  thisMonth: CalendarDaysIcon,
  thisYear: CalendarRangeIcon,
  allTime: InfinityIcon,
}

// This month / this year / all time. "This month/year" are always the CURRENT
// Stockholm month/year (the service computes them independently of the year
// the chart is showing). Energy and cost are twin readouts of equal weight —
// neither is the headline — once the page passes `cost` (it does once
// something is priced); without it the tile is energy alone, and kWh never
// waits for (or breaks on) prices.
export function TotalsTiles({
  tiles,
  cost,
  houseData = false,
}: {
  tiles: Tiles
  cost?: CostTiles
  /** House data (Emaldo) exists at all, so energy without it is worth saying (ADR-0023). */
  houseData?: boolean
}) {
  const items: { key: Period; label: string; totals: Totals }[] = [
    { key: 'thisMonth', label: m.charging_tile_this_month(), totals: tiles.thisMonth },
    { key: 'thisYear', label: m.charging_tile_this_year(), totals: tiles.thisYear },
    { key: 'allTime', label: m.charging_tile_all_time(), totals: tiles.allTime },
  ]
  // A container query, not a viewport breakpoint: with the sidebar open the
  // content column at md–lg is too narrow for three "12 345,0 kWh" tiles.
  // Both layouts render and CSS shows one, so SSR needs no width and nothing
  // jumps on hydration; the hidden one (display: none) is out of the a11y tree.
  return (
    <div className="@container">
      {/* Narrow: one card, a segmented control in its title slot picks the period
          (not persisted: it opens on this month). */}
      <Tabs defaultValue="thisMonth" className="@3xl:hidden" data-testid="totals-tabs">
        <Card>
          <CardHeader className="pb-2">
            {/* h-10: a phone-sized touch target (the base is h-8, set via the same group
                variant). Triggers size to content, not equal thirds, so "Denna månad"
                fits; a label truncates only when even that doesn't. */}
            <TabsList
              className="w-full group-data-horizontal/tabs:h-10"
              aria-label={m.charging_totals_heading()}
            >
              {items.map(({ key, label }) => (
                <TabsTrigger key={key} value={key} className="min-w-0 flex-auto">
                  {/* Dropped on the narrowest phones, where "All time" would overflow. */}
                  <PeriodIcon period={key} className="@max-xs:hidden" />
                  <span className="truncate">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </CardHeader>
          <CardContent>
            {items.map(({ key, totals }) => (
              <TabsContent
                key={key}
                value={key}
                // Radix makes the panel focusable; show where focus went.
                className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <TileReadouts totals={totals} cost={cost?.[key]} houseData={houseData} />
              </TabsContent>
            ))}
          </CardContent>
        </Card>
      </Tabs>
      {/* Wide: the three periods side by side. */}
      <div className="hidden @3xl:grid grid-cols-3 gap-3" data-testid="totals-grid">
        {items.map(({ key, label, totals }) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-muted-foreground text-sm">
                <PeriodIcon period={key} />
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <TileReadouts totals={totals} cost={cost?.[key]} houseData={houseData} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function PeriodIcon({ period, className }: { period: Period; className?: string }) {
  const Icon = PERIOD_ICON[period]
  return <Icon aria-hidden className={cn('size-3.5', className)} />
}

// Two columns split by a hairline when the tile is wide enough, stacked when
// it isn't (a third-width tile at md–lg). The footer carries what qualifies
// both: the average price, or why the cost is incomplete or missing, and how
// much energy had no house data (so counts as bought from the grid).
//
// The cost is the cash cost (ADR-0023): own solar costs 0 kr, and the share
// that cost nothing (own solar, straight or via the battery — not battery
// energy bought from the grid) sits under it. Missing data is said in words,
// never shown as 0 kr (a missing price or tariff is a state, ADR-0020): a
// partly priced total is qualified "minst" with the share that lacks a price;
// bought energy with no price at all reads "—". No energy, or energy that was
// all own solar, is a true 0 kr — so "no price" is judged on the bought energy.
// Under both readouts, the value of own solar used when there was any (a
// separate figure, never part of the cost).
function TileReadouts({
  totals,
  cost,
  houseData,
}: {
  totals: Totals
  cost: Cost | undefined
  houseData: boolean
}) {
  const energy = (
    <Readout
      icon={ZapIcon}
      label={m.charging_tile_energy()}
      value={formatOneDecimal(totals.kwh)}
      unit="kWh"
      detail={m.charging_tile_sessions({ count: totals.sessions })}
    />
  )
  if (!cost) return energy

  const unpriced = cost.gridKwh > 0 && cost.fullKwh === 0
  // Energy counted as missing a price or tariff. Zero here with an incomplete
  // total means an over-count (overlapping slots), so "minst" would be wrong.
  const missingKwh = cost.noPriceKwh + cost.noTariffKwh
  const short = !unpriced && !cost.complete && missingKwh > 0
  const solarShare = ownSolarShare(cost)
  const footer = tileFooter(cost, { unpriced, short, missingKwh, houseData })

  return (
    // flex-1 + the footer's mt-auto: footers line up across the three cards.
    <div className="@container/tile flex flex-1 flex-col gap-3">
      <div className="grid @[16rem]/tile:grid-cols-2 gap-3 @[16rem]/tile:gap-0">
        <div className="@[16rem]/tile:pr-4">{energy}</div>
        <div className="@[16rem]/tile:border-l @[16rem]/tile:pl-4">
          {unpriced ? (
            <Readout
              icon={BanknoteIcon}
              label={m.charging_tile_cost()}
              value="—"
              muted
              detail={m.charging_cost_unknown()}
            />
          ) : (
            <Readout
              icon={BanknoteIcon}
              label={m.charging_tile_cost()}
              qualifier={short ? m.charging_cost_min_prefix() : undefined}
              value={formatKronor(cost.totalSek)}
              unit="kr"
              detail={
                cost.kwh === 0 ? undefined : (
                  <>
                    <span>{m.charging_cost_spot_share({ spot: formatSek(cost.spotSek) })}</span>
                    {solarShare ? (
                      <span>
                        {m.charging_cost_own_solar_share({ share: formatShare(solarShare) })}
                      </span>
                    ) : null}
                  </>
                )
              }
            />
          )}
        </div>
      </div>
      {/* Full width: in the cost column of a third-width tile it wrapped to five lines. */}
      <SolarValueLine cost={cost} />
      {footer.length > 0 ? (
        <div className="mt-auto flex flex-col gap-1.5 border-t pt-3 text-muted-foreground text-xs">
          {footer.map((line) => (
            <p key={line.text} className="flex items-start gap-1.5">
              <line.icon aria-hidden className="mt-0.5 size-3 shrink-0" />
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

type FooterLine = { icon: LucideIcon; text: string }

function tileFooter(
  cost: Cost,
  {
    unpriced,
    short,
    missingKwh,
    houseData,
  }: { unpriced: boolean; short: boolean; missingKwh: number; houseData: boolean },
): FooterLine[] {
  // A caveat (missing or partial price) gets the alert mark, the no-house-data
  // assumption an info mark, the average a gauge.
  const caveat = (text: string) => ({ icon: CircleAlertIcon, text })
  const lines: FooterLine[] = []
  if (unpriced) lines.push(caveat(m.charging_cost_unknown_hint()))
  else if (cost.kwh > 0) {
    // Shares are of all charged energy, as "av laddningen" says.
    if (short) {
      lines.push(
        caveat(m.charging_cost_partial_hint({ share: formatShare(missingKwh / cost.kwh) })),
      )
    } else if (!cost.complete) lines.push(caveat(m.charging_cost_partial_hint_generic()))
    // The average (cash per charged kWh) is shown beside a complete total only.
    else if (cost.avgOre !== null) {
      lines.push({
        icon: GaugeIcon,
        text: m.charging_cost_avg({ avg: formatOrePrecise(cost.avgOre) }),
      })
    }
  }
  // Said only once house data exists at all; before that the page's note covers it.
  if (houseData && cost.kwh > 0 && cost.noHouseDataKwh > 0) {
    lines.push({
      icon: InfoIcon,
      text: m.charging_cost_no_house_data_hint({
        share: formatShare(cost.noHouseDataKwh / cost.kwh),
      }),
    })
  }
  return lines
}

// One figure: a small label, the number large with its unit set small beside
// it, and a detail line. The spaces between the parts are real text, so the
// figure reads (and copies) as "1 659,8 kWh".
function Readout({
  icon: Icon,
  label,
  value,
  unit,
  qualifier,
  detail,
  muted = false,
}: {
  icon: LucideIcon
  label: string
  value: string
  unit?: string
  qualifier?: string
  detail?: ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1 text-muted-foreground text-xs">
        <Icon aria-hidden className="size-3 shrink-0" />
        {label}
      </span>
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
      {/* A two-line detail (spot share + own-supply share) stacks. */}
      {detail ? (
        <span className="flex flex-col text-muted-foreground text-sm">{detail}</span>
      ) : null}
    </div>
  )
}
