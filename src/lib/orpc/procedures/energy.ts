import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { protectedProcedure } from '~/lib/orpc/context'
import { getEnergyOverview } from '~/lib/services/houseEnergy'

export const energyRouter = {
  // The Energi pages' one read (ADR-0024): monthly sums for the chart's year
  // plus the chart year's total, all time and the months with readings. Any signed-in member: read-only.
  // One grouped scan + the charging overview's queries → its own timing, plus
  // the service's two sub-timings (houseScanMs, carMs).
  overview: protectedProcedure
    .input(
      z.object({ year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional() }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const timings: { houseScanMs?: number; carMs?: number } = {}
      const overview = await getEnergyOverview({ year: input.year, timings })
      if (context.timings) {
        context.timings.getEnergyOverviewMs = Math.round(performance.now() - startedAt)
        if (timings.houseScanMs !== undefined) context.timings.houseScanMs = timings.houseScanMs
        if (timings.carMs !== undefined) context.timings.carMs = timings.carMs
      }
      return overview
    }),
}
