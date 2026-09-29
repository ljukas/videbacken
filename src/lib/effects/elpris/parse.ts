import { z } from 'zod'
import type { PriceSlot } from '~/lib/spotPrice/slots'
import { validateDaySlots } from '~/lib/spotPrice/slots'
import { ElprisError } from './errors'

/**
 * A strict ISO-8601 instant with an explicit offset, as elprisetjustnu.se
 * sends it. zod also rejects impossible dates and times (Feb 30, 24:00), which
 * Date.parse would silently roll over.
 */
const instant = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s))

const rowSchema = z.object({
  SEK_per_kWh: z.number(),
  EUR_per_kWh: z.number(),
  EXR: z.number().positive(),
  time_start: instant,
  time_end: instant,
})
const daySchema = z.array(rowSchema).min(1)

/**
 * SEK must equal EUR × EXR up to the API's 5-decimal rounding (observed
 * ≤ 5e-6 SEK). Anything further off means a field changed meaning — e.g. öre
 * in the SEK field (100×) or EUR there (≈ 11×).
 */
function sekMatchesEur(row: z.output<typeof rowSchema>): boolean {
  const expected = row.EUR_per_kWh * row.EXR
  return Math.abs(row.SEK_per_kWh - expected) <= Math.max(0.001, 0.01 * Math.abs(expected))
}

/**
 * Parses one published day into validated slots. Every failure is
 * `unexpected_response` with a message naming field paths or slot indices
 * only — never a price.
 */
export function parseDay(day: string, body: unknown): PriceSlot[] {
  const result = daySchema.safeParse(body)
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))]
    const shown = paths.slice(0, 10).join(', ')
    const more = paths.length > 10 ? ` (+${paths.length - 10} more)` : ''
    throw shapeError(`elpris ${day} response has an unexpected shape at: ${shown}${more}`)
  }
  const mismatched = result.data.findIndex((row) => !sekMatchesEur(row))
  if (mismatched !== -1) {
    throw shapeError(`elpris ${day} slot ${mismatched}: SEK price does not match EUR × EXR`)
  }
  // Each slot ends where the next begins; the last runs one slot length. The
  // API's own `time_end` is not used: on a fall-back day it is wrong for the
  // slot before the clocks go back (02:45+02:00 → "03:00+01:00", i.e. 75 min).
  // validateDaySlots still checks the day ends at the next local midnight.
  const rows = result.data
  const stepMs =
    rows.length > 1
      ? rows[1].time_start - rows[0].time_start
      : rows[0].time_end - rows[0].time_start
  const slots = rows.map((row, i) => ({
    startMs: row.time_start,
    endMs: i + 1 < rows.length ? rows[i + 1].time_start : row.time_start + stepMs,
    sekPerKwh: row.SEK_per_kWh,
  }))
  // `time_end` is otherwise unused, but still a drift signal: it must agree
  // with the derived end everywhere except the one known-bad fall-back slot.
  const disagreeing = rows.filter((row, i) => row.time_end !== slots[i].endMs).length
  if (disagreeing > 1) {
    throw shapeError(
      `elpris ${day}: time_end disagrees with the next slot's start on ${disagreeing} slots`,
    )
  }
  const problems = validateDaySlots(day, slots)
  if (problems.length > 0)
    throw shapeError(`elpris ${day} slots are invalid: ${problems.join('; ')}`)
  return slots
}

function shapeError(message: string): ElprisError {
  return new ElprisError('unexpected_response', 'prices', undefined, { message })
}
