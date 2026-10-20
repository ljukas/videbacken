import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, user } from '~/lib/db/schema'
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
  expect(await listOwnRules(a)).toEqual([rule])
  expect(await listOwnRules(b)).toEqual([])
})

test("another user's id behaves like a missing id and changes nothing", async () => {
  const { a, b, d1 } = await seed()
  const rule = await createRule(a, temp(d1))
  expect(await codeOf(updateRule(b, rule.id, { ...temp(d1), count: 5 }))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(setRuleEnabled(b, rule.id, false))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(deleteRule(b, rule.id))).toBe('RULE_NOT_FOUND')
  expect(await codeOf(updateRule(a, MISSING, temp(d1)))).toBe('RULE_NOT_FOUND')
  expect(await listOwnRules(a)).toEqual([rule])
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
  await deleteRule(a, rule.id)
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
