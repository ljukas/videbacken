import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorAlertEvent, sensorDevice, sensorReading, user } from '~/lib/db/schema'
import { ALERT_LOOKBACK_MS, ALERT_READINGS_MAX } from '~/lib/sensor/alerts'
import { setupDatabase } from '~test/setup'
import {
  createRule,
  evaluateDeviceSilence,
  evaluateReading,
  listSilenceDeviceIds,
  setRuleEnabled,
} from './index'

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

// The app pool's one connection in tests: the backend the evaluation runs on. Read before the
// evaluation starts, while the connection is free.
async function appPid() {
  const { rows } = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
  return rows[0].pid
}

// Waits until the app's connection (`appPid`) is blocked on a lock, in a query that names the
// table. Only that backend: other test workers share the database and block on their own locks.
async function waitForBlockedEvaluation(client: Client, pid: number, table = 'sensor_alert_rule') {
  for (let i = 0; i < 100; i += 1) {
    // Inside the caller's transaction pg_stat_activity is a snapshot taken on first read: drop it,
    // or the evaluation's first statement would be all this ever sees.
    await client.query('SELECT pg_stat_clear_snapshot()')
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE pid = $1 AND wait_event_type = 'Lock' AND query ILIKE $2`,
      [pid, `%${table}%`],
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

  const fired = await evaluateReading(d1, NOW)
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
  expect(await evaluateReading(d1, NOW)).toEqual([])

  await readings(d1, WARM)
  const recovered = await evaluateReading(d1, NOW)
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
  expect(await evaluateReading(d1, NOW)).toEqual([])
})

test('two concurrent evaluations fire once', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  await readings(d1, COLD)
  const results = await Promise.all([evaluateReading(d1, NOW), evaluateReading(d1, NOW)])
  expect(results.flat()).toHaveLength(1)
  expect(await events()).toHaveLength(1)
})

test('an evaluation waiting on the lock sees the event a competing evaluation opened', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateReading(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
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
  const pid = await appPid()
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
    const evaluation = evaluateReading(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toHaveLength(1)
})

test('paused rules, a recently heard silence rule and soft-deleted owners do not fire; a deleted owner keeps its open event', async () => {
  const { a, b, d1 } = await seed()
  const paused = await createRule(a, below5(d1))
  await setRuleEnabled(a, paused.id, false)
  await createRule(a, { kind: 'silence', deviceId: d1, silenceHours: 3 })
  const ofB = await createRule(b, below5(d1))
  await readings(d1, COLD)
  const fired = await evaluateReading(d1, NOW)
  expect(fired.map((t) => t.ruleId)).toEqual([ofB.id])

  await db.update(user).set({ deletedAt: NOW }).where(eq(user.id, b))
  await readings(d1, WARM)
  expect(await evaluateReading(d1, NOW)).toEqual([])
  const all = await events()
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ ruleId: ofB.id, endedAt: null, endReason: null })
})

test('a pause committed while the evaluation waits on the lock wins', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateReading(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
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
  expect(await evaluateReading(d1, NOW)).toHaveLength(1)
  await setRuleEnabled(a, rule.id, false)
  const [ended] = await events()
  expect(ended.endReason).toBe('paused')
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await openEvents()).toEqual([])
})

test('a delete committed while the evaluation waits on the lock leaves no open event', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, below5(d1))
  await readings(d1, COLD)
  expect(await evaluateReading(d1, NOW)).toHaveLength(1)
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateReading(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
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
  const fired = await evaluateReading(d1, NOW)
  expect(fired).toEqual([expect.objectContaining({ transition: 'fired', ruleId: rule.id })])
})

test('readings older than the lookback do not count; no readings fire nothing', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  expect(await evaluateReading(d1, NOW)).toEqual([])
  const lookbackMinutes = ALERT_LOOKBACK_MS / 60_000
  await readings(d1, [
    [lookbackMinutes + 60, 4],
    [lookbackMinutes + 1, 4],
    [30, 4],
  ])
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await events()).toEqual([])
})

test('only the newest readings are read: a flood on one sensor pushes older ones out', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  // A cold reading an hour ago, then a cold flood of ALERT_READINGS_MAX readings a second apart:
  // one merged burst. Read in full that is two cold groups (a fire); bounded, the hour-old
  // reading is never read and one group fires nothing.
  await readings(d1, [[60, 4]])
  await db.insert(sensorReading).values(
    Array.from({ length: ALERT_READINGS_MAX }, (_, i) => ({
      deviceId: d1,
      temperatureC: 4,
      humidityPct: 50,
      batteryPct: 80,
      recordedAt: new Date(minutesAgo(20).getTime() + i * 1000),
    })),
  )
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await events()).toEqual([])
})

test('the evaluation takes the sensor before its rules: a sensor delete in flight makes it wait', async () => {
  const { a, d1 } = await seed()
  await createRule(a, below5(d1))
  await readings(d1, COLD)
  const pid = await appPid()
  const client = await secondConnection()
  try {
    // A delete locks the device, then (the cascade) its rules. Waiting on the device, the
    // evaluation holds no rule lock the delete could need.
    await client.query('BEGIN')
    await client.query('DELETE FROM sensor_device WHERE id = $1', [d1])
    const evaluation = evaluateReading(d1, NOW)
    await waitForBlockedEvaluation(client, pid, 'key share')
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toEqual([])
})

// --- Silence rules -------------------------------------------------------------------------

const silent6 = (deviceId: string) => ({ kind: 'silence' as const, deviceId, silenceHours: 6 })
const MONTH_MINUTES = 30 * 24 * 60

test('a sensor silent past the rule fires once from its last reading, with the snapshot', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [
    [600, 20],
    [420, 20],
  ])

  const fired = await evaluateDeviceSilence(d1, NOW)
  expect(fired).toEqual([
    {
      transition: 'fired',
      ruleId: rule.id,
      eventId: expect.any(String),
      to: 'a@test.videbacken.local',
      sensorName: 'Frysen',
      kind: 'silence',
      silenceHours: 6,
      since: minutesAgo(420),
      endedAt: null,
    },
  ])
  expect(await events()).toEqual([
    expect.objectContaining({
      id: fired[0].eventId,
      ruleId: rule.id,
      userId: a,
      deviceId: d1,
      kind: 'silence',
      direction: null,
      threshold: null,
      count: null,
      silenceHours: 6,
      startedAt: minutesAgo(420),
      endedAt: null,
      endReason: null,
    }),
  ])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
  expect(await events()).toHaveLength(1)
})

test('a sensor heard within the hours, or never heard, does not fire', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
  await readings(d1, [[300, 20]])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
  expect(await events()).toEqual([])
})

test('a sensor silent beyond the value lookback fires from its real last reading', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  await readings(d1, [[MONTH_MINUTES, 20]])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([
    expect.objectContaining({
      transition: 'fired',
      kind: 'silence',
      since: minutesAgo(MONTH_MINUTES),
    }),
  ])
})

test('the next reading recovers the alert at the first reading after the gap', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [[MONTH_MINUTES, 20]])
  const [fired] = await evaluateDeviceSilence(d1, NOW)

  await readings(d1, [
    [2, 20],
    [1, 20],
  ])
  expect(await evaluateReading(d1, NOW)).toEqual([
    {
      transition: 'recovered',
      ruleId: rule.id,
      eventId: fired.eventId,
      to: 'a@test.videbacken.local',
      sensorName: 'Frysen',
      kind: 'silence',
      silenceHours: 6,
      since: minutesAgo(MONTH_MINUTES),
      endedAt: minutesAgo(2),
    },
  ])
  const [ended] = await events()
  expect(ended).toMatchObject({ endedAt: minutesAgo(2), endReason: 'recovered' })
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
})

test('a last reading stored at sub-millisecond precision does not recover its own alert', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  // As the webhook stores it: `recorded_at` defaults to now(), in microseconds, while the alert's
  // start comes back through a JS Date in milliseconds.
  await db.execute(sql`
    INSERT INTO sensor_reading (device_id, temperature_c, humidity_pct, battery_pct, recorded_at)
    VALUES (${d1}, 20, 50, 80, ${minutesAgo(510).toISOString()}::timestamptz + interval '467 microseconds')`)
  const { rows } = await db.execute<{ us: number }>(
    sql`SELECT (extract(microseconds FROM recorded_at)::int % 1000) AS us FROM sensor_reading`,
  )
  expect(rows[0].us).not.toBe(0)
  const [fired] = await evaluateDeviceSilence(d1, NOW)
  expect(fired).toMatchObject({ transition: 'fired', since: minutesAgo(510) })

  await readings(d1, [[1, 20]])
  expect(await evaluateReading(d1, NOW)).toEqual([
    expect.objectContaining({
      transition: 'recovered',
      eventId: fired.eventId,
      since: minutesAgo(510),
      endedAt: minutesAgo(1),
    }),
  ])
})

test('the cron recovers an alert a reading did not (the backstop)', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const [fired] = await evaluateDeviceSilence(d1, NOW)
  // The readings' own evaluation failed: only the cron sees them.
  await readings(d1, [
    [2, 20],
    [1, 20],
  ])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([
    expect.objectContaining({
      transition: 'recovered',
      eventId: fired.eventId,
      kind: 'silence',
      since: minutesAgo(420),
      endedAt: minutesAgo(2),
    }),
  ])
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await openEvents()).toEqual([])
})

test('a paused silence rule and a soft-deleted owner are skipped by both entry points', async () => {
  const { a, b, d1 } = await seed()
  const paused = await createRule(a, silent6(d1))
  await setRuleEnabled(a, paused.id, false)
  const ofB = await createRule(b, silent6(d1))
  await readings(d1, [[420, 20]])
  expect((await evaluateDeviceSilence(d1, NOW)).map((t) => t.ruleId)).toEqual([ofB.id])

  await db.update(user).set({ deletedAt: NOW }).where(eq(user.id, b))
  await readings(d1, [[1, 20]])
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
  const all = await events()
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ ruleId: ofB.id, endedAt: null, endReason: null })
})

test('the silence devices are those with an enabled silence rule of a non-deleted user', async () => {
  const { a, b, d1 } = await seed()
  const [d2, d3, d4] = await db
    .insert(sensorDevice)
    .values([{ mac: 'bbbbbbbbbbbb' }, { mac: 'cccccccccccc' }, { mac: 'dddddddddddd' }])
    .returning({ id: sensorDevice.id })
  await createRule(a, silent6(d1))
  await createRule(b, silent6(d1))
  const paused = await createRule(a, silent6(d2.id))
  await setRuleEnabled(a, paused.id, false)
  await createRule(a, below5(d3.id))
  await createRule(b, silent6(d4.id))
  await db.update(user).set({ deletedAt: NOW }).where(eq(user.id, b))
  expect(await listSilenceDeviceIds()).toEqual([d1])
})

test('a reading evaluation judges value and silence rules in one call', async () => {
  const { a, d1 } = await seed()
  const value = await createRule(a, below5(d1))
  const silence = await createRule(a, silent6(d1))
  await readings(d1, [
    [480, 4.9],
    [450, 4.8],
  ])
  const transitions = await evaluateReading(d1, NOW)
  expect(transitions).toHaveLength(2)
  expect(transitions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ transition: 'fired', ruleId: value.id, kind: 'temperature' }),
      expect.objectContaining({
        transition: 'fired',
        ruleId: silence.id,
        kind: 'silence',
        since: minutesAgo(450),
      }),
    ]),
  )
  expect(await events()).toHaveLength(2)
})

// The orders a competing writer can take against a cron that waits on the rule lock. The app pool
// has one connection in tests, so `Promise.all` would only run them one after the other.
test('a reading committed while the cron waits on the lock: the cron finds the sensor heard', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateDeviceSilence(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
    await client.query(
      `INSERT INTO sensor_reading (device_id, temperature_c, humidity_pct, battery_pct, recorded_at)
       VALUES ($1, 20, 50, 80, $2)`,
      [d1, minutesAgo(1)],
    )
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toEqual([])
})

test('an alert opened while the cron waits on the lock: the cron opens no second one', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateDeviceSilence(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
    // What a competing cron run writes before it commits.
    await client.query(
      `INSERT INTO sensor_alert_event (rule_id, user_id, device_id, kind, silence_hours, started_at)
       VALUES ($1, $2, $3, 'silence', 6, $4)`,
      [rule.id, a, d1, minutesAgo(420)],
    )
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await openEvents()).toHaveLength(1)
})

test('the cron fires first, then the returning reading recovers it', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const [fired] = await evaluateDeviceSilence(d1, NOW)
  expect(fired).toMatchObject({ transition: 'fired' })
  await readings(d1, [[1, 20]])
  expect(await evaluateReading(d1, NOW)).toEqual([
    expect.objectContaining({ transition: 'recovered', eventId: fired.eventId }),
  ])
  expect(await openEvents()).toEqual([])
})

test('a cron whose clock predates a reading already evaluated does not fire', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  // The reading arrives and is evaluated while the cron, started earlier, works on other devices.
  await readings(d1, [[1, 20]])
  expect(await evaluateReading(d1, NOW)).toEqual([])
  expect(await evaluateDeviceSilence(d1, minutesAgo(2))).toEqual([])
  expect(await events()).toEqual([])
})

test('a pause committed while the cron waits on the lock wins', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM sensor_alert_rule WHERE id = $1 FOR UPDATE', [rule.id])
    const evaluation = evaluateDeviceSilence(d1, NOW)
    await waitForBlockedEvaluation(client, pid)
    await client.query('UPDATE sensor_alert_rule SET enabled = false WHERE id = $1', [rule.id])
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toEqual([])
})

test('a pause after the cron fired ends the alert and the next cron stays quiet', async () => {
  const { a, d1 } = await seed()
  const rule = await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  expect(await evaluateDeviceSilence(d1, NOW)).toHaveLength(1)
  await setRuleEnabled(a, rule.id, false)
  const [ended] = await events()
  expect(ended.endReason).toBe('paused')
  expect(await openEvents()).toEqual([])
  expect(await evaluateDeviceSilence(d1, NOW)).toEqual([])
})

test('the cron takes the sensor before its rules: a sensor delete in flight makes it wait', async () => {
  const { a, d1 } = await seed()
  await createRule(a, silent6(d1))
  await readings(d1, [[420, 20]])
  const pid = await appPid()
  const client = await secondConnection()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM sensor_device WHERE id = $1', [d1])
    const evaluation = evaluateDeviceSilence(d1, NOW)
    await waitForBlockedEvaluation(client, pid, 'key share')
    await client.query('COMMIT')
    expect(await evaluation).toEqual([])
  } finally {
    await client.end()
  }
  expect(await events()).toEqual([])
})
