import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPumpEvent, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import {
  createEvent,
  deleteEvent,
  HeatPumpDomainError,
  type HeatPumpEventInput,
  listEvents,
  updateEvent,
  upsertUnits,
} from './index'

setupDatabase()

// 12:00 in Stockholm on 2026-10-08 (CEST): "today" is 2026-10-08.
const NOW = new Date('2026-10-08T10:00:00Z')
const MISSING = '00000000-0000-4000-8000-000000000000'
const SERVICE: HeatPumpEventInput = {
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: 'Årlig service',
}

async function admin() {
  const [row] = await db
    .insert(user)
    .values({ name: 'Admin', email: 'admin@test.videbacken.local', role: 'admin' })
    .returning({ id: user.id })
  return row.id
}
// Synthetic units, fake guids.
async function units() {
  const rows = await upsertUnits(
    [
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
      { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' },
    ],
    NOW,
  )
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  return { matsal: byName.get('Matsal') as string, upstairs: byName.get('Övervåning') as string }
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof HeatPumpDomainError ? e.code : e),
  )

test('create stores the event, returns its DTO and records the author', async () => {
  const author = await admin()
  const { matsal } = await units()
  const event = await createEvent({ ...SERVICE, heatPumpId: matsal }, author, NOW)
  expect(event).toEqual({
    id: expect.any(String),
    occurredOn: '2026-10-08',
    heatPumpId: matsal,
    kind: 'service',
    note: 'Årlig service',
  })
  const [row] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(row.createdBy).toBe(author)
})

test('list is newest first: by day, then the later entry first', async () => {
  const author = await admin()
  const a = await createEvent({ ...SERVICE, occurredOn: '2026-09-01', kind: 'filter' }, author, NOW)
  const b = await createEvent(SERVICE, author, NOW)
  const c = await createEvent({ ...SERVICE, kind: 'setting' }, author, NOW)
  expect((await listEvents()).map((e) => e.id)).toEqual([c.id, b.id, a.id])
})

// Review Focus 1.
test('Stockholm today, not UTC today', async () => {
  const author = await admin()
  // 00:30 in Stockholm on 2026-10-09 is still 2026-10-08 in UTC.
  const justAfterMidnight = new Date('2026-10-08T22:30:00Z')
  await expect(
    createEvent({ ...SERVICE, occurredOn: '2026-10-09' }, author, justAfterMidnight),
  ).resolves.toMatchObject({ occurredOn: '2026-10-09' })
  expect(
    await codeOf(createEvent({ ...SERVICE, occurredOn: '2026-10-10' }, author, justAfterMidnight)),
  ).toBe('FUTURE_DATE')
})

test('a future day is FUTURE_DATE, on create and on update', async () => {
  const author = await admin()
  expect(await codeOf(createEvent({ ...SERVICE, occurredOn: '2026-10-09' }, author, NOW))).toBe(
    'FUTURE_DATE',
  )
  const event = await createEvent(SERVICE, author, NOW)
  expect(await codeOf(updateEvent(event.id, { ...SERVICE, occurredOn: '2027-01-01' }, NOW))).toBe(
    'FUTURE_DATE',
  )
  expect(await listEvents()).toHaveLength(1)
})

// Review Focus 2.
test('a note is counted in characters, trimmed, and blank is none', async () => {
  const author = await admin()
  const fits = `${'å'.repeat(499)}🙂` // 500 characters, 501 UTF-16 units
  expect((await createEvent({ ...SERVICE, note: fits }, author, NOW)).note).toBe(fits)
  expect(await codeOf(createEvent({ ...SERVICE, note: 'x'.repeat(501) }, author, NOW))).toBe(
    'NOTE_TOO_LONG',
  )
  // Trimmed before counting: 500 characters plus padding fits.
  expect(
    (await createEvent({ ...SERVICE, note: `  ${'x'.repeat(500)}  ` }, author, NOW)).note,
  ).toBe('x'.repeat(500))
  expect((await createEvent({ ...SERVICE, note: '   ' }, author, NOW)).note).toBeNull()
  expect((await createEvent({ ...SERVICE, note: '  Filter rengjort ' }, author, NOW)).note).toBe(
    'Filter rengjort',
  )
})

test('an unknown heat pump is UNKNOWN_HEAT_PUMP, on create and on update', async () => {
  const author = await admin()
  expect(await codeOf(createEvent({ ...SERVICE, heatPumpId: MISSING }, author, NOW))).toBe(
    'UNKNOWN_HEAT_PUMP',
  )
  const event = await createEvent(SERVICE, author, NOW)
  expect(await codeOf(updateEvent(event.id, { ...SERVICE, heatPumpId: MISSING }, NOW))).toBe(
    'UNKNOWN_HEAT_PUMP',
  )
  expect((await listEvents()).map((e) => e.heatPumpId)).toEqual([null])
})

test('update replaces the fields and keeps the author', async () => {
  const author = await admin()
  const { upstairs } = await units()
  const event = await createEvent(SERVICE, author, NOW)
  const [before] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  const updated = await updateEvent(
    event.id,
    { occurredOn: '2026-10-07', heatPumpId: upstairs, kind: 'filter', note: null },
    NOW,
  )
  expect(updated).toEqual({
    id: event.id,
    occurredOn: '2026-10-07',
    heatPumpId: upstairs,
    kind: 'filter',
    note: null,
  })
  const [after] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(after.createdBy).toBe(author)
  expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime())
})

test('update and delete of a missing event are EVENT_NOT_FOUND', async () => {
  expect(await codeOf(updateEvent(MISSING, SERVICE, NOW))).toBe('EVENT_NOT_FOUND')
  expect(await codeOf(deleteEvent(MISSING))).toBe('EVENT_NOT_FOUND')
})

test('delete removes the event', async () => {
  const author = await admin()
  const event = await createEvent(SERVICE, author, NOW)
  await deleteEvent(event.id)
  expect(await listEvents()).toEqual([])
})

test('a day that is not a calendar day is a programming error, not a domain error', async () => {
  const author = await admin()
  const error = await createEvent({ ...SERVICE, occurredOn: '2026-02-30' }, author, NOW).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(HeatPumpDomainError)
  expect(await listEvents()).toEqual([])
})
