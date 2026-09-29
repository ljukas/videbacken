// Dependency-free, client-safe cost math (no db import). The composer that
// feeds it lives server-side; Phase 4 counterfactuals reuse it over
// hypothetical intervals.
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
} from './priceIntervals'
export { SlotIndex } from './slotIndex'
