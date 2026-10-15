import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { HEAT_PUMP_DAYS_MAX } from '~/lib/heatPump/period'
import { protectedProcedure } from '~/lib/orpc/context'
import { getHeatPumpDays, getHeatPumpMonths } from '~/lib/services/heatPump'
import { daysBetween, isStockholmDay } from '~/lib/time/stockholm'

const day = z.string().refine(isStockholmDay, { message: 'Expected a YYYY-MM-DD day' })
// isStockholmDay again inside: an object refinement must never reach daysBetween with a bad day (it throws).
const dayRange = z
  .object({ from: day, to: day })
  .refine(
    ({ from, to }) =>
      isStockholmDay(from) &&
      isStockholmDay(to) &&
      from <= to &&
      daysBetween(from, to) < HEAT_PUMP_DAYS_MAX,
    { message: `Expected from ≤ to and at most ${HEAT_PUMP_DAYS_MAX} days` },
  )

export const heatPumpRouter = {
  // The Värmepumpar page's month read (heat pumps step 3, ADR-0027): a year and the year before, or the whole
  // history without a year (Totalt). Any signed-in member: read-only. Sums only.
  months: protectedProcedure
    .input(
      z.object({ year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional() }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const out = await getHeatPumpMonths({ year: input.year })
      if (context.timings)
        context.timings.heatPumpMonthsMs = Math.round(performance.now() - startedAt)
      return out
    }),
  // Per unit per Stockholm day of a range (a month on the page; step 4b's signature reads longer ones). Sums only.
  days: protectedProcedure.input(dayRange).handler(async ({ input, context }) => {
    const startedAt = performance.now()
    const out = await getHeatPumpDays({ from: input.from, to: input.to })
    if (context.timings) context.timings.heatPumpDaysMs = Math.round(performance.now() - startedAt)
    return out
  }),
}
