import { asc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { seasonEra } from '~/lib/db/schema'
import type { SeasonEra } from './logic'

// The append-only era rows (ADR-0019), oldest first. Never written from app
// code — convention changes are data migrations (see the ADR runbook).
export async function listEras(): Promise<Array<SeasonEra>> {
  return db
    .select({
      fromYear: seasonEra.fromYear,
      startWeek: seasonEra.startWeek,
      startShare: seasonEra.startShare,
    })
    .from(seasonEra)
    .orderBy(asc(seasonEra.fromYear))
}
