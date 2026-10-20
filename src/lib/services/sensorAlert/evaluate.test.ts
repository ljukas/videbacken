import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorDevice, sensorReading, user } from '~/lib/db/schema'
import { ALERT_LOOKBACK_MS } from '~/lib/sensor/alerts'
import { setupDatabase } from '~test/setup'
import { createRule, evaluateValueRules, setRuleEnabled } from './index'

setupDatabase()

const NOW = new Date()
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

async function seed() {
  const [a, b] = await db
    .insert(user)
    .values([
      { name: 'A', email: 'a@test.videbacken.local' },
      { name: 'B', email: 'b@test.videbacken.local' },
    ])
    .returning({ id: user.id })
  const [d1] = await db
    .insert(sensorDevice)
    .values([{ mac: 'aaaaaaaaaaaa', name: 'Frysen' }])
    .returning({ id: sensorDevice.id })
  return { a: a.id, b: b.id, d1: d1.id }
}

// Temperatures at the given minutes ago, far enough apart that none merge.
async function readings(deviceId: string, values: [minutesAgo: number, temperatureC: number][]) {
  await db.insert(sensorReading).values(
    values.map(([m, temperatureC]) => ({
      deviceId,
      temperatureC,
      humidityPct: 50,
      batteryPct: 80,
      recordedAt: minutesAgo(m),
    })),
  )
}

const below5 = (deviceId: string) => ({
  kind: 'temperature' as const,
  deviceId,
  direction: 'below' as const,
  threshold: 5,
  count: 2,
})

const COLD: [number, number][] = [
  [180, 6],
  [150, 4.9],
  [120, 4.8],
]
const WARM: [number, number][] = [
  [60, 5.2],
  [30, 5.3],
]

const events = () => db.select().from(sensorAlertEvent)
const openEvents = () =>
  db.select().from(sensorAlertEvent).where(sql`${sensorAlertEvent.endedAt} IS NULL`)

// A second connection on this test's schema: the app pool is pinned to one connection in tests,
// so a lock held there could never block the evaluation.
async function secondConnection() {
  const { rows } = await db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`)
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${rows[0].schema},public`,
  })
  await client.connect()
  return client
}

// Waits until some other backend is blocked on a lock, in a query that names the table.
async function waitForBlockedEvaluation(client: Client, table = 'sensor_alert_rule') {
  for (let i = 0; i < 100; i += 1) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
         AND datname = current_database() AND query ILIKE $1`,
      [`%${table}%`],
    )
    if (rows[0].n > 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the evaluation never blocked on a ${table} lock`)
}

test('a breach fires once with the owner, the name and the snapshot; then recovers', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)

  const fired = await evaluateValueRules(d1, NOW)
  expect(fired).toEqual([
    {
      transition: 'fired',
      ruleId: rule.id,
      eventId: expect.any(String),
      to: 'a@test.videbacken.local',
      sensorName: 'Frysen',
      kind: 'temperature',
      direction: 'below',
      threshold: 5,
      count: 2,
      value: 4.8,
      since: minutesAgo(150),
      endedAt: null,
    },
  ])
  expect(await events()).toEqual([
    expect.objectContaining({
      id: fired[0].eventId,
      ruleId: rule.id,
      userId: a,
      deviceId: d1,
      kind: 'temperature',
      direction: 'below',
      threshold: 5,
      count: 2,
      silenceHours: null,
      startedAt: minutesAgo(150),
      endedAt: null,
      endReason: null,
    }),
  ])
  expect(await evaluateValueRules(d1, NOW)).toEqual([])

  await readings(d1, WARM)
  const recovered = await evaluateValueRules(d1, NOW)
  expect(recovered).toEqual([
    {
      transition: 'recovered',
      ruleId: rule.id,
      eventId: fired[0].eventId,
      to: 'a@test.videbacken.local',
      sensorName: 'Frysen',
      kind: 'temperature',
      direction: 'below',
      threshold: 5,
      count: 2,
      value: 5.3,
      since: minutesAgo(150),
      endedAt: minutesAgo(60),
    },
  ])
  const [ended] = await events()
  expect(ended.endedAt).toEqual(minutesAgo(60))
  expect(ended.endReason).toBe('recovered')
  expect(await evaluateValueRules(d1, NOW)).toEqual([])
})

test('two concurrent evaluations fire once', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  await readings(d1, COLD)
  const results = await Promise.all([evaluateValueRules(d1, NOW), evaluateValueRules(d1, NOW)])
  expect(results.flat()).toHaveLength(1)
  expect(await events()).toHaveLength(1)
})

test('an evaluation waiting on the lock sees the event a competing evaluation opened', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateValueRules(d1, NOW)
    await waitForBlockedEvaluation(client)
    // What the competing evaluation writes before it commits.
    await client.query(
      `INSERT INTO sensor_alert_event (rule_id, user_id, device_id, kind, direction, threshold, count, started_at)
       VALUES ($1, $2, $3, 'temperature', 'below', 5, 2, $4)`,
      [rule.id, a, d1, minutesAgo(150)],
    )
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toHaveLength(1)
})

test('an uncommitted event insert, lock or not, holds the evaluation back until it commits', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  const client = await secondConnection()
  try {
    // No explicit rule lock: the event's rule_id FK takes a KEY SHARE lock on the rule row, which
    // the evaluation's FOR UPDATE waits on, so it reads the open event once this commits.
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sensor_alert_event (rule_id, user_id, device_id, kind, direction, threshold, count, started_at)
       VALUES ($1, $2, $3, 'temperature', 'below', 5, 2, $4)`,
      [rule.id, a, d1, minutesAgo(150)],
    )
    const evaluation = evaluateValueRules(d1, NOW)
    await waitForBlockedEvaluation(client)
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toHaveLength(1)
})

test('paused, silence and soft-deleted owners do not fire; a deleted owner keeps its open event', async () => {
  const { a, b, d1 } = await seed()
  const paused = await createRule(a, below5(d1))
  await setRuleEnabled(a, paused.id, false)
  await createRule(a, { kind: 'silence', deviceId: d1, silenceHours: 3 })
  const ofB = await createRule(b, below5(d1))
  await readings(d1, COLD)
  const fired = await evaluateValueRules(d1, NOW)
  expect(fired.map((t) => t.ruleId)).toEqual([ofB.id])

  await db.update(user).set({ deletedAt: NOW }).where(eq(user.id, b))
  await readings(d1, WARM)
  expect(await evaluateValueRules(d1, NOW)).toEqual([])
  const all = await events()
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ ruleId: ofB.id, endedAt: null, endReason: null })
})

test('a pause committed while the evaluation waits on the lock wins', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateValueRules(d1, NOW)
    await waitForBlockedEvaluation(client)
    await client.query('UPDATE sensor_alert_rule SET enabled = false WHERE id = $1', [rule.id])
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toEqual([])
})

test('a pause after a fire ends the alert and a re-evaluation stays quiet', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  expect(await evaluateValueRules(d1, NOW)).toHaveLength(1)
  await setRuleEnabled(a, rule.id, false)
  const [ended] = await events()
  expect(ended.endReason).toBe('paused')
  expect(await evaluateValueRules(d1, NOW)).toEqual([])
  expect(await openEvents()).toEqual([])
})

test('a delete committed while the evaluation waits on the lock leaves no open event', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  expect(await evaluateValueRules(d1, NOW)).toHaveLength(1)
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateValueRules(d1, NOW)
    await waitForBlockedEvaluation(client)
    // What deleteRule does under the lock.
    await client.query(
      `UPDATE sensor_alert_event SET ended_at = now(), end_reason = 'deleted'
       WHERE rule_id = $1 AND ended_at IS NULL`,
      [rule.id],
    )
    await client.query('DELETE FROM sensor_alert_rule WHERE id = $1', [rule.id])
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await openEvents()).toEqual([])
  const [ended] = await events()
  expect(ended).toMatchObject({ ruleId: null, endReason: 'deleted' })
})

test('a rule created after the cold readings fires on the next evaluation', async () => {
  const { a, d1 } = await seed()
  await readings(d1, COLD)
  const rule = await createRule(a, below5(d1))
  const fired = await evaluateValueRules(d1, NOW)
  expect(fired).toEqual([expect.objectContaining({ transition: 'fired', ruleId: rule.id })])
})

test('readings older than the lookback do not count; no readings fire nothing', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  expect(await evaluateValueRules(d1, NOW)).toEqual([])
  const lookbackMinutes = ALERT_LOOKBACK_MS / 60_000
  await readings(d1, [
    [lookbackMinutes + 60, 4],
    [lookbackMinutes + 1, 4],
    [30, 4],
  ])
  expect(await evaluateValueRules(d1, NOW)).toEqual([])
  expect(await events()).toEqual([])
})
