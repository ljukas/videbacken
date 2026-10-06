// Pure: the Batteri month chart's rows (battery page design, "The month chart"). Each bar is what passed through
// the battery (in − ändrat lager): out at the bottom, the loss on top, so the green share is the efficiency.
import { formatShare } from '~/components/evCharging/format'
import { energyFigures, type PeriodSums, WINTER_LOSS_SHARE } from '~/lib/houseEnergy/figures'
import { lossLabel } from '~/lib/houseEnergy/flowLayout'

export type BatteryChartRow = {
  month: number
  sums: PeriodSums | null
  out: number | null
  /** The loss; null when it is zero or negative (nothing to draw). */
  loss: number | null
  /** The loss share above a winter month's bar, else null. */
  label: string | null
}

export function batteryChartRows(months: (PeriodSums | null)[]): BatteryChartRow[] {
  return months.map((sums, i) => {
    if (!sums) return { month: i + 1, sums, out: null, loss: null, label: null }
    const f = energyFigures(sums)
    return {
      month: i + 1,
      sums,
      out: f.batteryOut,
      loss: f.loss > 0 ? f.loss : null,
      label:
        lossLabel(f.loss) === 'value' && f.lossShare !== null && f.lossShare > WINTER_LOSS_SHARE
          ? formatShare(f.lossShare)
          : null,
    }
  })
}
