import type { EnergyInterval, TariffPeriod } from '~/lib/evCharging/cost'
import type { SessionEnergy } from '~/lib/services/evCharging'
import * as tariffService from '~/lib/services/tariff'

// Server-only. Inputs shared by the cost read models (`costing.ts`,
// `chargingEconomy.ts`): each loaded through its own service, as the cost math wants it.

/** Runs `fn`, recording its duration under `key` when a timings sink is given. */
export async function timed<K extends string, T>(
  timings: { [P in K]?: number } | undefined,
  key: K,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    if (timings) timings[key] = Math.round(performance.now() - start)
  }
}

/** All tariff periods, oldest first. */
export async function loadTariffs(): Promise<TariffPeriod[]> {
  const tariffs = await tariffService.list()
  return tariffs.map((t) => ({
    validFrom: t.validFrom,
    retailMarkupOre: t.retailMarkupOre,
    gridTransferOre: t.gridTransferOre,
    energyTaxOre: t.energyTaxOre,
    vatPercent: t.vatPercent,
  }))
}

// Every counted session is bought from the grid for now (gridShare 1) — the
// seam where a solar/battery source (Emaldo) would supply a real share.
export function toIntervals(session: SessionEnergy): EnergyInterval[] {
  return session.stretches.map((s) => ({ ...s, gridShare: 1 }))
}
