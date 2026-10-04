// Client-safe, pure (ADR-0023, spec "Derivation" 2). Where the house's own
// consumption came from in one 5-minute bucket. Energy that went into the
// battery or out to the grid is not house supply. The car gets the same mix
// as the house (proportional split, ADR-0023 decision 4).
import type { HouseReading } from '~/lib/services/houseEnergy'

/** Fractions of the house's supply in one bucket; they sum to 1. */
export type SupplyFractions = { grid: number; solar: number; battery: number }

/**
 * grid → house = import − battery charging from the grid (charge_grid and
 * charge_ac, both grid-origin); solar → house = solar − export − battery
 * charging from solar; battery → house = discharge minus whatever of it was
 * exported (export beyond solar). Each clamps at 0. Null = no house data:
 * zero load, or nothing supplied the house.
 */
export function houseSupply(r: HouseReading): SupplyFractions | null {
  const grid = Math.max(0, r.gridImportKwh - r.batteryChargeGridKwh - r.batteryChargeAcKwh)
  const solar = Math.max(0, r.solarKwh - r.gridExportKwh - r.batteryChargeSolarKwh)
  const battery = Math.max(0, r.batteryDischargeKwh - Math.max(0, r.gridExportKwh - r.solarKwh))
  const sum = grid + solar + battery
  if (!(r.loadKwh > 0) || !(sum > 0)) return null
  return { grid: grid / sum, solar: solar / sum, battery: battery / sum }
}
