import { HeatPumpConsumptionChart } from './HeatPumpConsumptionChart'
import { HeatPumpTiles } from './HeatPumpTiles'
import type { HeatPumpView } from './heatPumpView'

// The Förbrukning card's body (inside EnergySummaryCard): the tiles above the chart.
export function HeatPumpConsumption({
  view,
  onSelectMonth,
}: {
  view: HeatPumpView
  onSelectMonth: (month: { year: number; month: number }) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <HeatPumpTiles tiles={view.tiles} />
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} />
    </div>
  )
}
