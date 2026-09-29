import { z } from 'zod'
import type { PriceSlot } from '~/lib/spotPrice/slots'
import { validateDaySlots } from '~/lib/spotPrice/slots'
import { ElprisError } from './errors'

/** An ISO-8601 instant with an explicit offset, as elprisetjustnu.se sends it. */
const instant = z.string().transform((s, ctx) => {
  const ms = /(?:Z|[+-]\d{2}:\d{2})$/.test(s) ? Date.parse(s) : Number.NaN
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: 'custom', message: 'not an ISO instant with an offset' })
    return z.NEVER
  }
  return ms
})

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
  const slots = result.data.map((row) => ({
    startMs: row.time_start,
    endMs: row.time_end,
    sekPerKwh: row.SEK_per_kWh,
  }))
  const problems = validateDaySlots(day, slots)
  if (problems.length > 0)
    throw shapeError(`elpris ${day} slots are invalid: ${problems.join('; ')}`)
  return slots
}

function shapeError(message: string): ElprisError {
  return new ElprisError('unexpected_response', 'prices', undefined, { message })
}
