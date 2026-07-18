import { describe, expect, test } from 'vitest'
import { db } from '~/lib/db'
import { sensorDevice, sensorReading } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { handleShellyWebhook, parseShellyQuery, verifyWebhookToken } from './shellyWebhook'

const TOKEN = 'test-webhook-secret'
process.env.SHELLY_WEBHOOK_TOKEN = TOKEN

const q = (s: string) => new URLSearchParams(s)
const shellyUrl = (search: string) => `http://localhost/api/webhooks/shelly?${search}`

describe('parseShellyQuery', () => {
  test('parses mac + temp + humidity + battery', () => {
    expect(parseShellyQuery(q('mac=AABBCCDDEEFF&t=21.4&h=48.2&batt=90'))).toEqual({
      ok: true,
      value: { mac: 'AABBCCDDEEFF', temperatureC: 21.4, humidityPct: 48.2, batteryPct: 90 },
    })
  })

  test('accepts a reading with only temperature (humidity/battery absent → null)', () => {
    expect(parseShellyQuery(q('mac=AABBCCDDEEFF&t=21.4'))).toEqual({
      ok: true,
      value: { mac: 'AABBCCDDEEFF', temperatureC: 21.4, humidityPct: null, batteryPct: null },
    })
  })

  test('accepts a bare wake with only a mac', () => {
    expect(parseShellyQuery(q('mac=AABBCCDDEEFF'))).toEqual({
      ok: true,
      value: { mac: 'AABBCCDDEEFF', temperatureC: null, humidityPct: null, batteryPct: null },
    })
  })

  test('rejects a missing mac', () => {
    expect(parseShellyQuery(q('t=21.4')).ok).toBe(false)
  })

  test('rejects a non-numeric temperature', () => {
    expect(parseShellyQuery(q('mac=AA&t=notanumber')).ok).toBe(false)
  })

  test('rejects an out-of-range humidity', () => {
    expect(parseShellyQuery(q('mac=AA&h=150')).ok).toBe(false)
  })

  test('rejects an out-of-range temperature', () => {
    expect(parseShellyQuery(q('mac=AA&t=999')).ok).toBe(false)
  })
})

describe('verifyWebhookToken', () => {
  test('accepts a matching token', () => {
    expect(verifyWebhookToken('s3cret', 's3cret')).toBe(true)
  })
  test('rejects a wrong or missing token', () => {
    expect(verifyWebhookToken('nope', 's3cret')).toBe(false)
    expect(verifyWebhookToken(null, 's3cret')).toBe(false)
  })
  test('rejects when no server secret is configured (fail closed)', () => {
    expect(verifyWebhookToken('anything', undefined)).toBe(false)
    expect(verifyWebhookToken('anything', '')).toBe(false)
  })
  test('rejects a token of a different length without throwing', () => {
    expect(verifyWebhookToken('short', 'a-much-longer-secret')).toBe(false)
  })
})

describe('handleShellyWebhook', () => {
  setupDatabase()

  test('rejects a bad token with 401 and stores nothing', async () => {
    const res = await handleShellyWebhook(
      new Request(shellyUrl('token=wrong&mac=aabbccddeeff&t=20')),
    )
    expect(res.status).toBe(401)
    expect(await db.select().from(sensorReading)).toHaveLength(0)
  })

  test('rejects a missing token with 401', async () => {
    const res = await handleShellyWebhook(new Request(shellyUrl('mac=aabbccddeeff&t=20')))
    expect(res.status).toBe(401)
  })

  test('rejects bad params with 400', async () => {
    const res = await handleShellyWebhook(new Request(shellyUrl(`token=${TOKEN}&t=20`))) // no mac
    expect(res.status).toBe(400)
    expect(await db.select().from(sensorReading)).toHaveLength(0)
  })

  test('rejects a malformed (non-12-hex) mac with 400 and creates no device', async () => {
    const res = await handleShellyWebhook(new Request(shellyUrl(`token=${TOKEN}&mac=zz&t=20`)))
    expect(res.status).toBe(400)
    expect(await db.select().from(sensorDevice)).toHaveLength(0)
  })

  test('stores a reading and auto-registers the device on the happy path (204)', async () => {
    const res = await handleShellyWebhook(
      new Request(shellyUrl(`token=${TOKEN}&mac=AABBCCDDEEFF&t=21.4&h=48&batt=90`)),
    )
    expect(res.status).toBe(204)
    const devices = await db.select().from(sensorDevice)
    expect(devices).toHaveLength(1)
    expect(devices[0].mac).toBe('aabbccddeeff')
    const readings = await db.select().from(sensorReading)
    expect(readings).toHaveLength(1)
    expect(readings[0].temperatureC).toBe(21.4)
    expect(readings[0].humidityPct).toBe(48)
    expect(readings[0].batteryPct).toBe(90)
  })
})
