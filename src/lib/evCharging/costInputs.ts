import type { EnergyInterval, PieceMix, TariffPeriod } from '~/lib/evCharging/cost'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { logger } from '~/lib/logger/server'
import { listForSessions } from '~/lib/services/energyMix'
import type { SessionEnergy } from '~/lib/services/evCharging'
import * as tariffService from '~/lib/services/tariff'

// Server-only. Inputs shared by the cost read models: `costing.ts` uses all of
// them; `chargingEconomy.ts` uses `timed` and `loadTariffs` for its grid-only
// counterfactuals, and `loadMix` + `toIntervals` for a session's cash cost.

/** A stored mix slot's length: one UTC quarter-hour (ADR-0023). */
const MIX_SLOT_MS = 15 * 60_000

/** How far a session's stored mix may drift from its interval energy before it is ignored (spec "Read-time guard"). */
export const MIX_GUARD_KWH = 1e-6

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

/** The stored energy mix of these sessions, by session id; sessions without one are absent. */
export async function loadMix(
  sessions: readonly SessionEnergy[],
  timings?: { mixMs?: number },
): Promise<Map<string, MixSlot[]>> {
  return timed(timings, 'mixMs', async () =>
    sessions.length === 0 ? new Map() : listForSessions(sessions.map((s) => s.sessionId)),
  )
}

/**
 * A session's priced pieces (ADR-0023). With a stored mix whose kWh matches
 * the session's interval energy: one 15-min piece per mix slot, priced per
 * source. Otherwise every stretch is bought from the grid and labelled as
 * without house data — normal while there's no mix (Emaldo down, not derived
 * yet, before the first reading); a mix that no longer matches (a Zaptec
 * change the re-derive hasn't reached) is ignored with a warning, so energy is
 * never priced twice or lost. The economy counterfactuals don't use this:
 * they stay grid-only (spec "Cost and display").
 */
export function toIntervals(session: SessionEnergy, mix?: readonly MixSlot[]): EnergyInterval[] {
  if (mix && mix.length > 0) {
    const energyKwh = sum(session.stretches.map((s) => s.kwh))
    const mixKwh = sum(mix.map((slot) => slot.kwh))
    if (Math.abs(mixKwh - energyKwh) <= MIX_GUARD_KWH) {
      return mix.map((slot) => ({
        startMs: slot.slotStart.getTime(),
        endMs: slot.slotStart.getTime() + MIX_SLOT_MS,
        kwh: slot.kwh,
        gridShare: 1,
        mix: pieceMix(slot),
      }))
    }
    logger.warn('cost: energy mix ignored, kWh differs from the session', {
      sessionId: session.sessionId,
      mixKwh,
      energyKwh,
    })
  }
  return session.stretches.map((s) => ({ ...s, gridShare: 1, mix: withoutHouseData(s.kwh) }))
}

// Copied field by field: a stored row may carry more (e.g. its session id).
function pieceMix(slot: MixSlot): PieceMix {
  return {
    gridKwh: slot.gridKwh,
    solarKwh: slot.solarKwh,
    batteryGridKwh: slot.batteryGridKwh,
    batteryGridSpotSek: slot.batteryGridSpotSek,
    batterySolarKwh: slot.batterySolarKwh,
    batterySolarSpotSek: slot.batterySolarSpotSek,
    batteryUnpricedKwh: slot.batteryUnpricedKwh,
    noHouseDataKwh: slot.noHouseDataKwh,
  }
}

function withoutHouseData(kwh: number): PieceMix {
  return {
    gridKwh: 0,
    solarKwh: 0,
    batteryGridKwh: 0,
    batteryGridSpotSek: null,
    batterySolarKwh: 0,
    batterySolarSpotSek: null,
    batteryUnpricedKwh: 0,
    noHouseDataKwh: kwh,
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
