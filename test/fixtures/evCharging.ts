import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'

export async function insertCharger(id = 'charger-1') {
  await db
    .insert(evCharger)
    .values({ id, name: 'Charger', installationId: 'install-1' })
    .onConflictDoNothing()
  return id
}

let sessionCounter = 0

export async function insertSession(
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
): Promise<string> {
  sessionCounter += 1
  const chargerId = overrides.chargerId ?? (await insertCharger())
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: `zap-${sessionCounter}`,
      chargerId,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T11:00:00Z'),
      energyKwh: 5,
      ...overrides,
    })
    .returning({ id: evChargeSession.id })
  return row.id
}

export async function insertInterval(
  sessionId: string,
  startAt: Date,
  endAt: Date,
  energyKwh: number,
) {
  await db.insert(evChargeInterval).values({ sessionId, startAt, endAt, energyKwh })
}
