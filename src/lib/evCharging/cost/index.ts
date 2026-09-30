// Client-safe cost math (no db import). The composer that
// feeds it lives server-side; Phase 4 counterfactuals reuse it over
// hypothetical intervals.

export type { PriceSlot } from '~/lib/spotPrice/slots'
export {
  avgOre,
  type CostTotals,
  type EnergyInterval,
  emptyTotals,
  isComplete,
  mergeTotals,
  priceIntervals,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from './priceIntervals'
export { SlotIndex } from './slotIndex'
