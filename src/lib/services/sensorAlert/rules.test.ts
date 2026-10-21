import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorDevice, user } from '~/lib/db/schema'
import { ALERT_RULES_PER_SENSOR_MAX } from '~/lib/sensor/alerts'
import { deleteDevice } from '~/lib/services/sensor'
import { setupDatabase } from '~test/setup'
import {
  createRule,
  deleteRule,
  listOwnRules,
  SensorAlertDomainError,
  setRuleEnabled,
  updateRule,
} from './index'

setupDatabase()

const MISSING = '00000000-0000-4000-8000-000000000000'

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

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof SensorAlertDomainError ? e.code : e),
  )

const temp = (deviceId: string) => ({
  kind: 'temperature' as const,
  deviceId,
  direction: 'below' as const,
  threshold: 17.5,
  count: 3,
})

test('create returns the rule; only its owner lists it', async () => {
  const { a, b, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect(rule).toEqual({
    id: expect.any(String),
    deviceId: d1,
    kind: 'temperature',
    enabled: true,
    direction: 'below',
    threshold: 17.5,
    count: 3,
    silenceHours: null,
  })
  expect(await listOwnRules(a)).toEqual([{ ...rule, firingSince: null }])
  expect(await listOwnRules(b)).toEqual([])
})

test("another user's id behaves like a missing id and changes nothing", async () => {
  const { a, b, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect(await codeOf(updateRule(b, rule.id, { ...temp(d1), count: 5 }))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(setRuleEnabled(b, rule.id, false))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(deleteRule(b, rule.id))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(updateRule(a, MISSING, temp(d1)))).toBe('RULE_NOT_FOUND')
  // Not-found wins over the device FK: a stranger learns nothing about the device id.
  expect(await codeOf(updateRule(b, rule.id, temp(MISSING)))).toBe('RULE_NOT_FOUND')
  expect(await listOwnRules(a)).toEqual([{ ...rule, firingSince: null }])
})

test('update changes the kind and nulls the fields it no longer uses', async () => {
  const { a, d1, d2 } = await seed()
  const rule = await createRule(a, temp(d1))
  const silence = await updateRule(a, rule.id, { kind: 'silence', deviceId: d2, silenceHours: 6 })
  expect(silence).toMatchObject({
    id: rule.id,
    deviceId: d2,
    kind: 'silence',
    direction: null,
    threshold: null,
    count: null,
    silenceHours: 6,
  })
  const battery = await updateRule(a, rule.id, {
    kind: 'battery',
    deviceId: d2,
    threshold: 20,
    count: 2,
  })
  expect(battery).toMatchObject({
    kind: 'battery',
    direction: 'below',
    threshold: 20,
    count: 2,
    silenceHours: null,
  })
})

test('setRuleEnabled toggles and update keeps enabled', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect((await setRuleEnabled(a, rule.id, false)).enabled).toBe(false)
  const updated = await updateRule(a, rule.id, { ...temp(d1), count: 4 })
  expect(updated).toMatchObject({ enabled: false, count: 4 })
})

test('deleteRule removes the rule', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect(await deleteRule(a, rule.id)).toEqual({ deviceId: d1, kind: 'temperature' })
  expect(await listOwnRules(a)).toEqual([])
})

test('listOwnRules orders by creation', async () => {
  const { a, d1, d2 } = await seed()
  const first = await createRule(a, temp(d1))
  const second = await createRule(a, temp(d2))
  expect((await listOwnRules(a)).map((r) => r.id)).toEqual([first.id, second.id])
})

test('an unknown device is UNKNOWN_SENSOR on create and update', async () => {
  const { a, d1 } = await seed()
  expect(await codeOf(createRule(a, temp(MISSING)))).toBe('UNKNOWN_SENSOR')
  const rule = await createRule(a, temp(d1))
  expect(await codeOf(updateRule(a, rule.id, temp(MISSING)))).toBe('UNKNOWN_SENSOR')
})

test('deleting the device removes its rules', async () => {
  const { a, d1 } = await seed()
  await createRule(a, temp(d1))
  await deleteDevice(d1)
  expect(await listOwnRules(a)).toEqual([])
})

const STARTED = new Date(Date.now() - 3_600_000)

async function fire(userId: string, rule: { id: string; deviceId: string }) {
  await db.insert(sensorAlertEvent).values({
    ruleId: rule.id,
    userId,
    deviceId: rule.deviceId,
    kind: 'temperature',
    direction: 'below',
    threshold: 17.5,
    count: 3,
    startedAt: STARTED,
  })
}

const events = () => db.select().from(sensorAlertEvent)

test('listOwnRules shows firingSince of the open event only', async () => {
  const { a, b, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect((await listOwnRules(a))[0].firingSince).toBeNull()
  await fire(a, rule)
  expect((await listOwnRules(a))[0].firingSince).toEqual(STARTED)
  await db.update(sensorAlertEvent).set({ endedAt: new Date(), endReason: 'recovered' })
  expect((await listOwnRules(a))[0].firingSince).toBeNull()
  // Another user's open event on the same device doesn't show.
  await db.insert(sensorAlertEvent).values({
    ruleId: null,
    userId: b,
    deviceId: d1,
    kind: 'temperature',
    direction: 'below',
    threshold: 1,
    count: 2,
    startedAt: STARTED,
  })
  expect((await listOwnRules(a))[0].firingSince).toBeNull()
})

test('pausing ends the open event; resuming starts nothing', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  await fire(a, rule)
  await setRuleEnabled(a, rule.id, false)
  const [ev] = await events()
  expect(ev.endReason).toBe('paused')
  expect(ev.endedAt).toBeInstanceOf(Date)
  await setRuleEnabled(a, rule.id, true)
  expect(await events()).toHaveLength(1)
  expect((await listOwnRules(a))[0].firingSince).toBeNull()
})

test('editing a defining value ends the event; identical values leave it open', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  await fire(a, rule)
  await updateRule(a, rule.id, temp(d1))
  expect((await events())[0].endedAt).toBeNull()
  await updateRule(a, rule.id, { ...temp(d1), threshold: 15 })
  const [ev] = await events()
  expect(ev.endReason).toBe('edited')
  expect(ev.endedAt).toBeInstanceOf(Date)
})

test('deleting a firing rule keeps the event as deleted with no rule; a stranger changes nothing', async () => {
  const { a, b, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  await fire(a, rule)
  expect(await codeOf(deleteRule(b, rule.id))).toBe('RULE_NOT_FOUND')
  expect((await events())[0].endedAt).toBeNull()
  await deleteRule(a, rule.id)
  const [ev] = await events()
  expect(ev.endReason).toBe('deleted')
  expect(ev.ruleId).toBeNull()
  expect(
    await db.select().from(sensorAlertEvent).where(eq(sensorAlertEvent.id, ev.id)),
  ).toHaveLength(1)
})

test('the 21st rule on a sensor is refused, on another sensor it is fine', async () => {
  const { a, d1, d2 } = await seed()
  for (let i = 0; i < ALERT_RULES_PER_SENSOR_MAX; i++) await createRule(a, temp(d1))
  expect(await codeOf(createRule(a, temp(d1)))).toBe('TOO_MANY_RULES')
  await createRule(a, temp(d2))
  const moving = await createRule(a, temp(d2))
  expect(await codeOf(updateRule(a, moving.id, temp(d1)))).toBe('TOO_MANY_RULES')
  expect((await listOwnRules(a)).find((r) => r.id === moving.id)?.deviceId).toBe(d2)
})
