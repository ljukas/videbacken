// The economy session table's row: only what EconomySessionTable renders
// (server latency step 5). Client-safe: the procedure returns it and the
// table types against it.
import type { Vehicle } from '~/lib/evCharging/vehicle'
import type { EconomyExclusion, SessionEconomy } from './types'

export type EconomyListRow = {
  sessionId: string
  startAt: Date
  endAt: Date
  vehicle: Vehicle
  /** The session's `energyKwh`, as SessionList shows it. */
  kwh: number
  /** The actual cost, SEK; null unless every kWh is priced (ADR-0020: never partial kronor). */
  actualSek: number | null
  excluded: EconomyExclusion | null
  counterfactual: {
    savedVsImmediateSek: number
    leftOnTableSek: number
    score: number | null
    /** dearest − optimal total, SEK: the "no spread" label's figure when `score` is null. */
    spreadSek: number
  } | null
}

/** The fields of a counted session the row needs (structural: no service import). */
export type ListRowSession = {
  sessionId: string
  startAt: Date
  endAt: Date
  energyKwh: number
  vehicle: Vehicle
}

export function toEconomyListRow(s: ListRowSession, economy: SessionEconomy): EconomyListRow {
  const cf = economy.counterfactual
  return {
    sessionId: s.sessionId,
    startAt: s.startAt,
    endAt: s.endAt,
    vehicle: s.vehicle,
    kwh: s.energyKwh,
    actualSek: economy.actualComplete ? economy.actual.totalSek : null,
    excluded: economy.excluded,
    counterfactual: cf && {
      savedVsImmediateSek: cf.savedVsImmediateSek,
      leftOnTableSek: cf.leftOnTableSek,
      score: cf.score,
      spreadSek: cf.dearest.totalSek - cf.optimal.totalSek,
    },
  }
}
