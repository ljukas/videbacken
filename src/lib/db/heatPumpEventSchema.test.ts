import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPump, heatPumpEvent, user } from '~/lib/db/schema'
import { upsertUnits } from '~/lib/services/heatPump'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

setupDatabase()

type Insert = typeof heatPumpEvent.$inferInsert
const NOW = new Date('2026-10-08T10:00:00Z')

// Synthetic unit (fake guid), never the owner's real device ids.
async function matsal() {
  const [unit] = await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }],
    NOW,
  )
  return unit
}
const row = (over: Partial<Insert> = {}): Insert => ({
  occurredOn: '2026-10-08',
  kind: 'service',
  ...over,
})

test('an event for every unit has no heat pump', async () => {
  const [stored] = await db.insert(heatPumpEvent).values(row()).returning()
  expect(stored).toMatchObject({
    occurredOn: '2026-10-08',
    heatPumpId: null,
    kind: 'service',
    note: null,
  })
  expect(stored.createdAt).toBeInstanceOf(Date)
})

test('an unknown kind is rejected', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ kind: 'repair' as never })),
    'heat_pump_event_kind_check',
  )
})

test('a note is 1 to 500 characters, counted as Postgres counts them', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ note: '' })),
    'heat_pump_event_note_check',
  )
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ note: 'x'.repeat(501) })),
    'heat_pump_event_note_check',
  )
  // 500 code points, 501 UTF-16 units: allowed.
  await db.insert(heatPumpEvent).values(row({ note: `${'å'.repeat(499)}🙂` }))
})

test('a heat pump with events can not be deleted (restrict)', async () => {
  const unit = await matsal()
  await db.insert(heatPumpEvent).values(row({ heatPumpId: unit.id }))
  await expectConstraintViolation(
    db.delete(heatPump).where(eq(heatPump.id, unit.id)),
    'heat_pump_event_heat_pump_id_heat_pump_id_fk',
  )
})

test('an unknown heat pump is rejected', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ heatPumpId: '00000000-0000-4000-8000-000000000000' })),
    'heat_pump_event_heat_pump_id_heat_pump_id_fk',
  )
})

test('deleting the author keeps the event (set null)', async () => {
  const [author] = await db
    .insert(user)
    .values({ name: 'Admin', email: 'admin@test.videbacken.local', role: 'admin' })
    .returning({ id: user.id })
  const [event] = await db
    .insert(heatPumpEvent)
    .values(row({ createdBy: author.id }))
    .returning()
  await db.delete(user).where(eq(user.id, author.id))
  const [kept] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(kept.createdBy).toBeNull()
})
