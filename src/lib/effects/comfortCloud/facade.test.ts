import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type ComfortCloudClient,
  ComfortCloudError,
  comfortCloud as comfortCloudSingleton,
  newCallStats,
  selectComfortCloudAdapter,
} from '.'
import { notConfigured, unavailable } from './adapters/notConfigured'

// Synthetic credentials: never a real account.
const USER = 'heat-owner@example.com'
const PASSWORD = 'synthetic-password-1'

const calls = (client: ComfortCloudClient) => [
  () => client.units(),
  () => client.dayHours('CS-HZ25ZKE+0000000001', '2026-04-01'),
  () => client.monthDays('CS-HZ25ZKE+0000000001', '2026-03'),
]

describe('adapter selection', () => {
  test('http only with both fields', () => {
    expect(selectComfortCloudAdapter({ user: USER, password: PASSWORD })).toBe('http')
    expect(selectComfortCloudAdapter({ user: USER, password: '' })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({ user: '', password: PASSWORD })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({ user: USER })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({})).toBe('notConfigured')
  })

  test('unavailable(code) fails every call with an admin message naming no value', async () => {
    const cases = [
      [
        'not_configured',
        'Comfort Cloud client is not configured (set it under Charging → Settings or as PANASONIC_USER / PANASONIC_PASSWORD)',
      ],
      [
        'credentials_unreadable',
        'Stored Comfort Cloud credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Charging → Settings',
      ],
    ] as const
    for (const [code, message] of cases) {
      for (const call of calls(unavailable(code))) {
        const err = await call().catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ComfortCloudError)
        expect(err).toMatchObject({ name: 'ComfortCloudError', code, op: 'login', message })
      }
    }
    await expect(notConfigured.units()).rejects.toMatchObject({ code: 'not_configured' })
  })

  test('the exported singleton fails closed as not_configured under VITEST', async () => {
    for (const call of calls(comfortCloudSingleton)) {
      await expect(call()).rejects.toMatchObject({
        name: 'ComfortCloudError',
        code: 'not_configured',
      })
    }
  })
})

describe('the singleton with resolved credentials', () => {
  type Resolved = { values: Record<string, string>; fingerprint: string }
  let resolved: () => Promise<Resolved>
  const built: { user: string; password: string; fetch: unknown }[] = []
  /** The call options each fake method received. */
  const forwarded: unknown[] = []
  const fakeClient: ComfortCloudClient = {
    units: async (o) => {
      forwarded.push(o)
      return [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }]
    },
    dayHours: async (_guid, _day, o) => {
      forwarded.push(o)
      return { registeredOn: '2026-03-01', rows: [] }
    },
    monthDays: async (_guid, _month, o) => {
      forwarded.push(o)
      return { registeredOn: '2026-03-01', rows: [] }
    },
  }

  async function freshFacade() {
    vi.resetModules()
    vi.stubEnv('VITEST', '')
    vi.doMock('~/lib/credentials/resolve', () => ({ resolveCredentials: () => resolved() }))
    // The facade imports the client lazily from ./client: capture the options instead of logging in.
    vi.doMock('./client', () => ({
      createComfortCloudClient: (opts: { user: string; password: string; fetch: unknown }) => {
        built.push(opts)
        return fakeClient
      },
    }))
    return (await import('./comfortCloud')).comfortCloud
  }

  beforeEach(() => {
    built.length = 0
    forwarded.length = 0
    resolved = async () => ({ values: { user: USER, password: PASSWORD }, fingerprint: 'f' })
  })
  afterEach(() => {
    vi.doUnmock('~/lib/credentials/resolve')
    vi.doUnmock('./client')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('builds the client from the resolved fields and the global fetch, and forwards each call with its options', async () => {
    const facade = await freshFacade()
    const o = { signal: new AbortController().signal, stats: newCallStats() }
    expect(await facade.units(o)).toEqual([
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
    ])
    expect(await facade.dayHours('g', '2026-04-01', o)).toEqual({
      registeredOn: '2026-03-01',
      rows: [],
    })
    expect(await facade.monthDays('g', '2026-03', o)).toEqual({
      registeredOn: '2026-03-01',
      rows: [],
    })
    expect(forwarded).toEqual([o, o, o])
    expect(built).toEqual([{ user: USER, password: PASSWORD, fetch: globalThis.fetch }])
  })

  test('an unchanged fingerprint keeps the client (and its token); a changed one rebuilds it', async () => {
    const facade = await freshFacade()
    await facade.units()
    await facade.units()
    expect(built).toHaveLength(1)
    resolved = async () => ({ values: { user: USER, password: 'changed' }, fingerprint: 'g' })
    await facade.units()
    expect(built).toHaveLength(2)
    expect(built[1]).toMatchObject({ password: 'changed' })
  })

  test('a missing field fails closed as not_configured without building a client', async () => {
    resolved = async () => ({ values: { user: USER }, fingerprint: 'h' })
    const facade = await freshFacade()
    await expect(facade.units()).rejects.toMatchObject({ code: 'not_configured' })
    expect(built).toHaveLength(0)
  })

  test('unreadable stored credentials fail closed as credentials_unreadable, without a client', async () => {
    const facade = await freshFacade()
    // After resetModules: the class keyedAdapter's instanceof sees.
    const { CredentialsUnreadableError } = await import('~/lib/credentials/crypto')
    resolved = async () => {
      throw new CredentialsUnreadableError('comfortCloud', 'invalid')
    }
    await expect(facade.units()).rejects.toMatchObject({
      name: 'ComfortCloudError',
      code: 'credentials_unreadable',
    })
    expect(built).toHaveLength(0)
  })
})
