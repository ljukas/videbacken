import { protectedProcedure } from '~/lib/orpc/context'
import * as seasonService from '~/lib/services/season'

export const seasonRouter = {
  // The Disponeringslista read (ADR-0019): every season is computed from its
  // governing era — no per-year rows, no mutations, no errors. Skips
  // ownership data on purpose; the grid only needs the share letter per cell.
  listSchedules: protectedProcedure.handler(async () => {
    const eras = await seasonService.listEras()
    // One clock: the server owns currentYear and ships it to the client so the
    // current-year highlight can't disagree with the computed range (SSR runs
    // UTC, the browser runs Europe/Stockholm — they straddle New Year for ~1h).
    const currentYear = new Date().getFullYear()
    return { currentYear, schedules: seasonService.buildSchedules(eras, currentYear) }
  }),
}
