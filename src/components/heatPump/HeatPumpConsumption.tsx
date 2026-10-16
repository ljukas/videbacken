import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { HeatPumpConsumptionChart } from './HeatPumpConsumptionChart'
import { HeatPumpTiles } from './HeatPumpTiles'
import type { HeatPumpView } from './heatPumpView'

// The Förbrukning card's body (inside EnergySummaryCard): the tiles above the chart.
export function HeatPumpConsumption({
  view,
  onSelectMonth,
  events,
}: {
  view: HeatPumpView
  onSelectMonth: (month: { year: number; month: number }) => void
  /** The logged events, marked on the day chart (step 4a). */
  events?: readonly HeatPumpEventDto[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <HeatPumpTiles tiles={view.tiles} />
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} events={events} />
    </div>
  )
}
