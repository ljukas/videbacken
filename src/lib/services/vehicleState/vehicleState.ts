import { desc } from 'drizzle-orm'
import { db } from '~/lib/db'
import { vehicleStateSnapshot } from '~/lib/db/schema'

/** One poll of the car's state, already reduced (the position is only `atHome`). */
export type SnapshotInput = {
  polledAt: Date
  capturedAt: Date | null
  chargingState: string | null
  chargeType: string | null
  plugState: string | null
  chargePowerKw: number | null
  parkingState: string | null
  atHome: boolean | null
  socPercent: number | null
  odometerKm: number | null
  odometerCapturedAt: Date | null
}

/** Appends one poll (ADR-0022): the live rule needs every poll, not only state changes. */
export async function recordSnapshot(input: SnapshotInput): Promise<void> {
  await db.insert(vehicleStateSnapshot).values(input)
}

/** Times only — the card needs no presence data (ADR-0022, Privacy). */
export type LatestSnapshot = { polledAt: Date; capturedAt: Date | null }

/** The newest poll, for the admin card's "last contact with the car". */
export async function latestSnapshot(): Promise<LatestSnapshot | null> {
  const [row] = await db
    .select({
      polledAt: vehicleStateSnapshot.polledAt,
      capturedAt: vehicleStateSnapshot.capturedAt,
    })
    .from(vehicleStateSnapshot)
    .orderBy(desc(vehicleStateSnapshot.polledAt))
    .limit(1)
  return row ?? null
}
