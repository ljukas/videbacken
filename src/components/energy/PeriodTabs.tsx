import { CalendarDaysIcon, CalendarRangeIcon, InfinityIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'

type Period = 'thisMonth' | 'thisYear' | 'allTime'
export type EnergyTilesData = Record<Period, PeriodSums | null>

const PERIODS: { key: Period; icon: LucideIcon; label: () => string }[] = [
  { key: 'thisMonth', icon: CalendarDaysIcon, label: m.charging_tile_this_month },
  { key: 'thisYear', icon: CalendarRangeIcon, label: m.charging_tile_this_year },
  { key: 'allTime', icon: InfinityIcon, label: m.charging_tile_all_time },
]

// This month / this year / all time, one period at a time (five readouts don't
// fit three side-by-side cards). Opens on the first period with data; the choice isn't
// persisted, as on /charging. A period without data says so; `children` only
// ever gets a period's sums. Shared by the Översikt and Batteri tiles.
export function PeriodTabs({
  tiles,
  children,
}: {
  tiles: EnergyTilesData
  children: (sums: PeriodSums) => ReactNode
}) {
  // The first period with data: the new month's first hour has none yet.
  const initial = PERIODS.find(({ key }) => tiles[key])?.key ?? 'thisMonth'
  return (
    <Tabs defaultValue={initial}>
      <Card>
        <CardHeader className="pb-2">
          <TabsList
            className="w-full group-data-horizontal/tabs:h-10 sm:w-auto"
            aria-label={m.energy_tiles_heading()}
          >
            {PERIODS.map(({ key, icon: Icon, label }) => (
              <TabsTrigger key={key} value={key} className="min-w-0 flex-auto">
                <Icon aria-hidden className="size-3.5 max-[360px]:hidden" />
                <span className="truncate">{label()}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        <CardContent>
          {PERIODS.map(({ key }) => {
            const sums = tiles[key]
            return (
              <TabsContent
                key={key}
                value={key}
                className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {sums ? (
                  children(sums)
                ) : (
                  <p className="text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
                )}
              </TabsContent>
            )
          })}
        </CardContent>
      </Card>
    </Tabs>
  )
}
