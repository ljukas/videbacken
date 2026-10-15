// Where a heat pump's expected hours end (ADR-0027, heat pumps step 2's rule, shared by Översikt and Värmepumpar so
// the two pages count the same missing hours). Pure.
import { millisecondsInHour } from 'date-fns/constants'
import { STALE_AFTER_MS } from '~/lib/services/integrationSync/policy'

/** A unit with readings: its newest stored hour's start and when Comfort Cloud last listed it. */
export type UnitListing = { lastMs: number; lastSeenMs: number }

/**
 * The unit end rule over `units` (the units with readings) and a coverage end. A unit ends at the coverage end, but a
 * trailing gap after its newest stored hour counts as missing only from the source's stale threshold (13 h, two
 * missed 6-hourly runs): shorter, it is the sync's normal lag, so the unit ends at its newest stored hour's end. A unit
 * Comfort Cloud stopped listing (`removed`: its `lastSeenMs` is older than the newest of `units`, since one sync run
 * lists every unit with one timestamp) ends at the later of its newest stored hour's end and its last listing, never
 * past the coverage end, so a removed unit isn't missing forever; when the whole source fails every unit's last
 * listing freezes together and the gap counts. Gaps inside the stored hours aren't this rule's concern: they always
 * count.
 */
export function unitEndRule(
  units: readonly UnitListing[],
  coverageEndMs: number,
): { removed: (u: UnitListing) => boolean; endMs: (u: UnitListing) => number } {
  const newestSeenMs = Math.max(...units.map((u) => u.lastSeenMs))
  const removed = (u: UnitListing) => u.lastSeenMs < newestSeenMs
  const endMs = (u: UnitListing) => {
    const storedEndMs = u.lastMs + millisecondsInHour
    if (coverageEndMs - storedEndMs < STALE_AFTER_MS.comfortCloud) {
      return Math.min(coverageEndMs, storedEndMs)
    }
    return removed(u) ? Math.min(coverageEndMs, Math.max(storedEndMs, u.lastSeenMs)) : coverageEndMs
  }
  return { removed, endMs }
}
