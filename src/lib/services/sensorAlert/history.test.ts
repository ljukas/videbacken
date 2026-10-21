import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorDevice, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { ALERT_HISTORY_PAGE, listOwnHistory } from './index'

setupDatabase()

async function seed() {
  const [a, b] = await db
    .insert(user)
    .values([
      { name: 'A', email: 'a@test.videbacken.local' },
      { name: 'B', email: 'b@test.videbacken.local' },
    ])
    .returning({ id: user.id })
  const [d1, d2] = await db
    .insert(sensorDevice)
    .values([{ mac: 'aaaaaaaaaaaa' }, { mac: 'bbbbbbbbbbbb' }])
    .returning({ id: sensorDevice.id })
  return { a: a.id, b: b.id, d1: d1.id, d2: d2.id }
}

const BASE = new Date('2026-01-01T00:00:00Z').getTime()

function event(userId: string, deviceId: string, minute: number) {
  return {
    ruleId: null,
    userId,
    deviceId,
    kind: 'temperature' as const,
    direction: 'below' as const,
    threshold: 5,
    count: 2,
    startedAt: new Date(BASE + minute * 60_000),
    endedAt: new Date(BASE + minute * 60_000 + 1000),
    endReason: 'recovered' as const,
  }
}

test('pages newest first: 10, then the rest with no next', async () => {
  const { a, d1 } = await seed()
  await db.insert(sensorAlertEvent).values(Array.from({ length: 12 }, (_, i) => event(a, d1, i)))
  const first = await listOwnHistory(a, d1)
  expect(ALERT_HISTORY_PAGE).toBe(10)
  expect(first.entries.map((e) => e.startedAt.getTime())).toEqual(
    Array.from({ length: 10 }, (_, i) => BASE + (11 - i) * 60_000),
  )
  expect(first.next).not.toBeNull()
  const second = await listOwnHistory(a, d1, first.next ?? undefined)
  expect(second.entries.map((e) => e.startedAt.getTime())).toEqual([BASE + 60_000, BASE])
  expect(second.next).toBeNull()
})

test('equal started_at pages by id without a duplicate or a gap', async () => {
  const { a, d1 } = await seed()
  await db.insert(sensorAlertEvent).values(Array.from({ length: 25 }, () => event(a, d1, 0)))
  const seen: string[] = []
  let cursor: { startedAt: Date; id: string } | undefined
  do {
    const page = await listOwnHistory(a, d1, cursor)
    seen.push(...page.entries.map((e) => e.id))
    cursor = page.next ?? undefined
  } while (cursor)
  expect(seen).toHaveLength(25)
  expect(new Set(seen).size).toBe(25)
  expect(seen).toEqual([...seen].sort().reverse())
})

test("another user's and another device's events are left out", async () => {
  const { a, b, d1, d2 } = await seed()
  await db.insert(sensorAlertEvent).values([event(a, d1, 0), event(b, d1, 1), event(a, d2, 2)])
  const page = await listOwnHistory(a, d1)
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0].startedAt.getTime()).toBe(BASE)
  expect((await listOwnHistory(b, d2)).entries).toEqual([])
})
