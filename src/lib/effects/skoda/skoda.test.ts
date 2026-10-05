import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type FakeRoute, fakeFetch, jsonResponse } from '../testing/fakeFetch'
import {
  createSkodaClient,
  newCallStats,
  SkodaError,
  selectSkodaAdapter,
  skoda as skodaSingleton,
} from '.'
import { notConfigured, unavailable } from './adapters/notConfigured'
import {
  chargingAtHome,
  chargingUnavailable,
  EXPIRES_AT,
  TEST_KEY,
  TEST_VIN,
  unplugged,
} from './fixtures'

// The few fields the tests mutate, typed without `any`.
type Mutable = {
  vehicle: {
    parkingPosition: { gpsCoordinates: unknown }
    odometer: { mileageInKm: unknown }
    charging: {
      status: {
        battery: { stateOfChargeInPercent: unknown }
        chargeType: unknown
        state: unknown
        plugConnectionState: unknown
      }
    }
  }
  errors?: unknown
}
const mutable = () => structuredClone(chargingAtHome) as unknown as Mutable

// ky waits on real timers: fake them, jumping straight to the next one (as zaptec.test.ts).
beforeEach(() => {
  vi.useFakeTimers()
  vi.setTimerTickMode('nextTimerAsync')
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ROUTE = `GET /api/v1/vehicles/${TEST_VIN}`
const client = (route: FakeRoute) => {
  const f = fakeFetch({ [ROUTE]: route })
  return { f, skoda: createSkodaClient({ fetch: f.fetch, apiKey: TEST_KEY, vin: TEST_VIN }) }
}
const ok = (body: unknown) => () =>
  jsonResponse(body, { headers: { 'X-API-Key-Expires-At': EXPIRES_AT } })
const noVin = (thrown: unknown) => {
  const err = thrown as SkodaError
  expect(err.message).not.toContain(TEST_VIN)
  expect(JSON.stringify(err.cause ?? null)).not.toContain(TEST_VIN)
}

test('selects http only with both key and VIN', () => {
  expect(selectSkodaAdapter({ apiKey: 'k', vin: 'v' })).toBe('http')
  expect(selectSkodaAdapter({ apiKey: 'k', vin: 'v', homeCoordinates: '59,18' })).toBe('http')
  expect(selectSkodaAdapter({ apiKey: 'k' })).toBe('notConfigured')
  expect(selectSkodaAdapter({ vin: 'v' })).toBe('notConfigured')
  expect(selectSkodaAdapter({})).toBe('notConfigured')
})

test('unavailable(code) throws SkodaError op vehicle with an admin message naming no value', async () => {
  const cases = [
    [
      'not_configured',
      'Škoda client is not configured (set it under Inställningar or as SKODA_API_KEY / SKODA_VIN)',
    ],
    [
      'credentials_unreadable',
      'Stored Škoda credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Inställningar',
    ],
  ] as const
  for (const [code, message] of cases) {
    const err = await unavailable(code)
      .vehicleState()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SkodaError)
    expect(err).toMatchObject({ name: 'SkodaError', code, op: 'vehicle', message })
    noVin(err)
    expect((err as SkodaError).message).not.toContain(TEST_KEY)
  }
  await expect(notConfigured.vehicleState()).rejects.toMatchObject({ code: 'not_configured' })
})

test('outside Vitest, unreadable stored credentials fail the poll as credentials_unreadable', async () => {
  vi.resetModules()
  vi.stubEnv('VITEST', '')
  try {
    const { CredentialsUnreadableError } = await import('~/lib/credentials/crypto')
    vi.doMock('~/lib/credentials/resolve', () => ({
      resolveCredentials: async () => {
        throw new CredentialsUnreadableError('skoda', 'invalid')
      },
    }))
    const fresh = await import('./skoda')
    await expect(fresh.skoda.vehicleState()).rejects.toMatchObject({
      name: 'SkodaError',
      code: 'credentials_unreadable',
      op: 'vehicle',
    })
  } finally {
    vi.doUnmock('~/lib/credentials/resolve')
    vi.unstubAllEnvs()
    vi.resetModules()
  }
})

test('sends the key header and asks for charging, odometer and parking position', async () => {
  const { f, skoda } = client(ok(chargingAtHome))
  await skoda.vehicleState()
  const [req] = f.calls
  expect(req.headers.get('x-api-key')).toBe(TEST_KEY)
  expect(new URL(req.url).searchParams.get('include')).toBe('charging,odometer,parkingPosition')
})

test('parses a charging-at-home reading and the key expiry', async () => {
  const { skoda } = client(ok(chargingAtHome))
  const stats = newCallStats()
  expect(await skoda.vehicleState({ stats })).toEqual({
    keyExpiresAt: new Date(EXPIRES_AT),
    state: {
      chargingCapturedAt: new Date('2026-05-04T08:57:51Z'),
      chargingState: 'CHARGING',
      chargeType: 'AC',
      plugState: 'CONNECTED',
      chargePowerKw: 3.5,
      socPercent: 55,
      odometerKm: 12345,
      odometerCapturedAt: new Date('2026-05-04T08:55:01.847Z'),
      parking: { state: 'PARKED', position: { latitude: 59.3293, longitude: 18.0686 } },
      missingParts: [],
      invalidParts: [],
    },
  })
  expect(stats).toMatchObject({ requests: 1, retries: 0 })
})

test('an unplugged response omits chargeType; a moving car has no position', async () => {
  const { skoda } = client(ok(unplugged))
  expect((await skoda.vehicleState()).state).toMatchObject({
    chargeType: null,
    plugState: 'DISCONNECTED',
    parking: { state: 'IN_MOTION', position: null },
  })
})

test('a partial 200 without the charging part is a reading with nulls and the missing part', async () => {
  const { skoda } = client(ok(chargingUnavailable))
  expect((await skoda.vehicleState()).state).toMatchObject({
    chargingCapturedAt: null,
    plugState: null,
    odometerKm: 12349,
    parking: null,
    missingParts: ['CHARGING_UNAVAILABLE'],
    invalidParts: [],
  })
})

test('a malformed part is dropped, the rest kept; null leaves and fractions are tolerated', async () => {
  const body = mutable()
  body.vehicle.parkingPosition.gpsCoordinates = { latitude: 'north' }
  body.vehicle.charging.status.battery.stateOfChargeInPercent = 55.6
  body.vehicle.charging.status.chargeType = null
  const { skoda } = client(ok(body))
  const { state } = await skoda.vehicleState()
  expect(state).toMatchObject({
    plugState: 'CONNECTED',
    chargeType: null,
    socPercent: 56,
    parking: null,
    invalidParts: ['parkingPosition'],
  })
})

test('a label containing NUL drops its part (Postgres text rejects it), the rest kept', async () => {
  const body = mutable()
  body.vehicle.charging.status.plugConnectionState = 'CONNECTED\u0000'
  const { skoda } = client(ok(body))
  const { state } = await skoda.vehicleState()
  expect(state).toMatchObject({
    chargingState: null,
    plugState: null,
    odometerKm: 12345,
    parking: { state: 'PARKED' },
    invalidParts: ['charging'],
  })
})

test('out-of-bounds readings drop their part, the rest kept', async () => {
  const soc = mutable()
  soc.vehicle.charging.status.battery.stateOfChargeInPercent = 101
  const label = mutable()
  label.vehicle.charging.status.state = 'A'.repeat(65)
  for (const body of [soc, label]) {
    const { state } = await client(ok(body)).skoda.vehicleState()
    expect(state).toMatchObject({
      plugState: null,
      socPercent: null,
      odometerKm: 12345,
      parking: { state: 'PARKED' },
      invalidParts: ['charging'],
    })
  }
  const km = mutable()
  km.vehicle.odometer.mileageInKm = 3_000_000
  const { state } = await client(ok(km)).skoda.vehicleState()
  expect(state).toMatchObject({
    plugState: 'CONNECTED',
    socPercent: 55,
    odometerKm: null,
    odometerCapturedAt: null,
    parking: { state: 'PARKED' },
    invalidParts: ['odometer'],
  })
})

test('unknown enum values pass through; odd error types are not echoed', async () => {
  const body = mutable()
  body.vehicle.charging.status.state = 'SOMETHING_NEW'
  body.errors = [
    { type: 'ODOMETER_DISABLED' },
    { type: 'weird <b>type</b> with VIN TMBJB9NY5RF999999' },
  ]
  const { skoda } = client(ok(body))
  const { state } = await skoda.vehicleState()
  expect(state.chargingState).toBe('SOMETHING_NEW')
  expect(state.missingParts).toEqual(['ODOMETER_DISABLED'])
})

test('a missing or unparseable expiry header is null, not a failure', async () => {
  const { skoda } = client(() => jsonResponse(chargingAtHome))
  expect((await skoda.vehicleState()).keyExpiresAt).toBeNull()
  const { skoda: bad } = client(() =>
    jsonResponse(chargingAtHome, { headers: { 'X-API-Key-Expires-At': 'soon' } }),
  )
  expect((await bad.vehicleState()).keyExpiresAt).toBeNull()
})

test.each([
  [401, 'auth_failed'],
  [403, 'forbidden'],
  [404, 'forbidden'],
  [429, 'rate_limited'],
  [500, 'unreachable'],
  [400, 'unexpected_response'],
] as const)('HTTP %i → %s', async (status, code) => {
  const { skoda } = client(() => jsonResponse({ type: 'x', status }, { status }))
  await expect(skoda.vehicleState()).rejects.toMatchObject({ name: 'SkodaError', code, status })
})

test('a 403 problem body naming the VIN never reaches the error', async () => {
  const { skoda } = client(() =>
    jsonResponse(
      {
        type: 'https://public.api.connect.skoda-auto.cz/problems/api-key-not-authorized',
        status: 403,
        detail: `The API key is not authorized to access vehicle ${TEST_VIN}.`,
      },
      { status: 403 },
    ),
  )
  noVin(await skoda.vehicleState().catch((e: unknown) => e as SkodaError))
})

test('429 and 500 are not retried', async () => {
  const limited = client(() => jsonResponse({}, { status: 429 }))
  await expect(limited.skoda.vehicleState()).rejects.toBeInstanceOf(SkodaError)
  expect(limited.f.calls).toHaveLength(1)
  const broken = client(() => jsonResponse({}, { status: 500 }))
  await expect(broken.skoda.vehicleState()).rejects.toMatchObject({
    code: 'unreachable',
    status: 500,
  })
  expect(broken.f.calls).toHaveLength(1)
})

test.each([502, 503, 504])('%i is retried once, then fails as unreachable', async (status) => {
  const flaky = client((_req, call) =>
    call === 0 ? jsonResponse({}, { status }) : ok(chargingAtHome)(),
  )
  const stats = newCallStats()
  await expect(flaky.skoda.vehicleState({ stats })).resolves.toBeDefined()
  expect(stats).toMatchObject({ requests: 2, retries: 1 })

  const down = client(() => jsonResponse({}, { status, headers: { 'Retry-After': '1' } }))
  const err = await down.skoda.vehicleState().catch((e: unknown) => e)
  expect(err).toMatchObject({ code: 'unreachable', status })
  expect(down.f.calls).toHaveLength(2)
})

test('a body that is not JSON, or has the wrong top-level shape, is unexpected_response', async () => {
  const notJson = client(() => new Response('<html>', { status: 200 }))
  await expect(notJson.skoda.vehicleState()).rejects.toMatchObject({ code: 'unexpected_response' })
  for (const body of [{ vehicles: [] }, { vehicle: 'x' }]) {
    const wrong = client(ok(body))
    const err = (await wrong.skoda.vehicleState().catch((e: unknown) => e)) as SkodaError
    expect(err).toMatchObject({ code: 'unexpected_response' })
    expect(err.message).toContain('at: vehicle')
  }
})

test('network failures and timeouts are unreachable, retried once, and never echo the VIN or key', async () => {
  const net = client(() => {
    throw Object.assign(new TypeError(`fetch failed for ${TEST_VIN} ${TEST_KEY}`), {
      code: 'ECONNRESET',
    })
  })
  const netErr = (await net.skoda.vehicleState().catch((e: unknown) => e)) as SkodaError
  expect(netErr).toMatchObject({ code: 'unreachable' })
  expect(netErr.cause).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
  noVin(netErr)
  expect(netErr.message).not.toContain(TEST_KEY)
  expect(net.f.calls).toHaveLength(2)

  const hang = client(
    (req) =>
      new Promise<Response>((_res, rej) =>
        req.signal.addEventListener('abort', () => rej(req.signal.reason)),
      ),
  )
  const hangErr = (await hang.skoda.vehicleState().catch((e: unknown) => e)) as SkodaError
  expect(hangErr).toMatchObject({ code: 'unreachable' })
  expect(hangErr.cause).toEqual({ name: 'TimeoutError' })
  noVin(hangErr)
  expect(hangErr.message).not.toContain(TEST_KEY)
  expect(hang.f.calls).toHaveLength(2)
})

test('a caller abort is final: one call, unreachable, never retried', async () => {
  const ctl = new AbortController()
  const { f, skoda } = client(
    (req) =>
      new Promise<Response>((_res, rej) => {
        req.signal.addEventListener('abort', () => rej(req.signal.reason))
        ctl.abort() // aborted mid-flight, after the first request went out
      }),
  )
  const err = await skoda.vehicleState({ signal: ctl.signal }).catch((e: unknown) => e)
  expect(err).toMatchObject({ code: 'unreachable' })
  expect(f.calls).toHaveLength(1)

  const pre = client(ok(chargingAtHome)) // already aborted: never even sent
  await expect(pre.skoda.vehicleState({ signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: 'unreachable',
  })
  expect(pre.f.calls).toHaveLength(0)
})

test('requests refuse redirects so the key never follows one', async () => {
  const { f, skoda } = client(ok(chargingAtHome))
  await skoda.vehicleState()
  expect(f.calls[0].redirect).toBe('error')
})

test('the exported singleton is the fail-closed notConfigured adapter under VITEST', async () => {
  await expect(skodaSingleton.vehicleState()).rejects.toMatchObject({
    name: 'SkodaError',
    code: 'not_configured',
    op: 'vehicle',
  })
})

test('a malformed errors list never fails the poll', async () => {
  const body = mutable()
  body.errors = [{ type: 'ODOMETER_DISABLED' }, { nope: 1 }, 'x', { type: 'ODOMETER_DISABLED' }]
  const { skoda } = client(ok(body))
  expect((await skoda.vehicleState()).state.missingParts).toEqual(['ODOMETER_DISABLED'])
  body.errors = 'x'
  const { skoda: other } = client(ok(body))
  expect((await other.vehicleState()).state.missingParts).toEqual([])
  body.errors = Array.from({ length: 30 }, (_, i) => ({ type: `E_${'A'.repeat(i + 1)}` }))
  const { skoda: many } = client(ok(body))
  expect((await many.vehicleState()).state.missingParts).toHaveLength(20)
})
