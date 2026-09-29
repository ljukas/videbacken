// Dependency-free, client-safe. Validation for one Stockholm day of spot price
// slots as the elpris API publishes it — the sync stores a day all-or-nothing,
// so a day that fails here is rejected whole (`unexpected_response`), never
// stored with holes or overlaps that would mis-price charging.
import { stockholmDayBounds } from '~/lib/time/stockholm'

export type PriceSlot = { startMs: number; endMs: number; sekPerKwh: number }

const MINUTE_MS = 60 * 1000
/** 15-min slots since 2025-10-01, hourly before. */
const SLOT_LENGTHS_MS = new Set([15 * MINUTE_MS, 60 * MINUTE_MS])
/**
 * Absurd-value bounds in SEK/kWh (ex VAT), matching the `spot_price` CHECK. The
 * day-ahead market's price cap steps up automatically in extreme conditions, so
 * this deliberately leaves headroom; the elpris parser's EUR × EXR cross-check
 * is what catches a unit mix-up.
 */
export const MIN_SEK_PER_KWH = -100
export const MAX_SEK_PER_KWH = 100
/** Problems reported per day; the rest are summarised in one extra line. */
const MAX_PROBLEMS = 5

/**
 * Problems with `slots` as the complete price list for Stockholm `day`, as
 * admin-readable messages without any price values (at most `MAX_PROBLEMS`
 * plus a summary line). Empty means valid: in order and contiguous, covering
 * exactly the day (23/24/25 h), every slot the same 15 or 60 minutes, every
 * price finite and within bounds.
 */
export function validateDaySlots(day: string, slots: readonly PriceSlot[]): string[] {
  if (slots.length === 0) return ['no slots']
  const problems: string[] = []
  const { startMs, endMs } = stockholmDayBounds(day)
  if (slots[0].startMs !== startMs) problems.push('first slot does not start at local midnight')
  if (slots[slots.length - 1].endMs !== endMs) {
    problems.push('last slot does not end at the next local midnight')
  }
  const lengthMs = slots[0].endMs - slots[0].startMs
  if (!SLOT_LENGTHS_MS.has(lengthMs)) problems.push('slots are not 15 or 60 minutes long')
  for (const [i, slot] of slots.entries()) {
    if (i > 0 && slot.endMs - slot.startMs !== lengthMs) {
      problems.push(`slot ${i} differs in length from slot 0`)
    }
    if (i > 0 && slot.startMs !== slots[i - 1].endMs) {
      problems.push(`slot ${i} does not start where slot ${i - 1} ends`)
    }
    if (
      !Number.isFinite(slot.sekPerKwh) ||
      slot.sekPerKwh < MIN_SEK_PER_KWH ||
      slot.sekPerKwh > MAX_SEK_PER_KWH
    ) {
      problems.push(`slot ${i} has an implausible price`)
    }
  }
  if (problems.length <= MAX_PROBLEMS) return problems
  return [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`]
}
