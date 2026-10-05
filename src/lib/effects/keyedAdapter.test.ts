import { describe, expect, test, vi } from 'vitest'
import { CredentialsUnreadableError } from '~/lib/credentials/crypto'
import type { ResolvedCredentials } from '~/lib/credentials/resolve'
import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter, type UnavailableCode } from './keyedAdapter'

// No DB: the resolver and env are injected. The client is a plain tagged object
// so tests can check identity (same instance = no fresh login).
type Client = { id: number; values?: CredentialValues<'zaptec'>; unavailable?: UnavailableCode }

function harness(
  resolved: () => Promise<ResolvedCredentials<'zaptec'>> | ResolvedCredentials<'zaptec'>,
) {
  let built = 0
  const build = vi.fn(async (values: CredentialValues<'zaptec'>): Promise<Client> => {
    built += 1
    return { id: built, values }
  })
  const unavailable = vi.fn(
    async (code: UnavailableCode): Promise<Client> => ({ id: -1, unavailable: code }),
  )
  const resolve = vi.fn(async () => resolved())
  const env: Record<string, string | undefined> = {}
  const get = keyedAdapter({ source: 'zaptec', build, unavailable, resolve, env })
  return { get, build, unavailable, resolve, env }
}

const creds = (username: string, fingerprint: string): ResolvedCredentials<'zaptec'> => ({
  values: { username, password: 'p' },
  fingerprint,
})

describe('keyedAdapter', () => {
  test('the same fingerprint twice reuses one client; a changed one builds a new one', async () => {
    let current = creds('a', 'f1')
    const { get, build } = harness(() => current)

    const first = await get()
    const second = await get()
    expect(second).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledWith({ username: 'a', password: 'p' })

    current = creds('b', 'f2')
    const third = await get()
    expect(third).not.toBe(first)
    expect(third.values).toEqual({ username: 'b', password: 'p' })
    expect(build).toHaveBeenCalledTimes(2)

    expect(await get()).toBe(third)
    expect(build).toHaveBeenCalledTimes(2)
  })

  test('two concurrent first calls share one build', async () => {
    const { get, build } = harness(() => creds('a', 'f1'))
    const [a, b] = await Promise.all([get(), get()])
    expect(a).toBe(b)
    expect(build).toHaveBeenCalledTimes(1)
  })

  test('unreadable stored credentials → the credentials_unreadable client, no build', async () => {
    const { get, build, unavailable } = harness(() => {
      throw new CredentialsUnreadableError('zaptec', 'invalid')
    })
    expect(await get()).toEqual({ id: -1, unavailable: 'credentials_unreadable' })
    expect(unavailable).toHaveBeenCalledWith('credentials_unreadable')
    expect(build).not.toHaveBeenCalled()
  })

  test('any other resolver error propagates unchanged', async () => {
    const boom = new Error('db down')
    const { get, build, unavailable } = harness(() => {
      throw boom
    })
    await expect(get()).rejects.toBe(boom)
    expect(build).not.toHaveBeenCalled()
    expect(unavailable).not.toHaveBeenCalled()
  })

  test('under VITEST it is not_configured without resolving', async () => {
    const { get, env, resolve, build, unavailable } = harness(() => creds('a', 'f1'))
    env.VITEST = 'true'
    expect(await get()).toEqual({ id: -1, unavailable: 'not_configured' })
    expect(unavailable).toHaveBeenCalledWith('not_configured')
    expect(resolve).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()

    // env is read per call, not once at construction.
    env.VITEST = undefined
    expect((await get()).id).toBe(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('a rejected build is retried on the next call', async () => {
    const { get, build } = harness(() => creds('a', 'f1'))
    const boom = new Error('import failed')
    build.mockRejectedValueOnce(boom)

    await expect(get()).rejects.toBe(boom)
    const client = await get()
    expect(client.values).toEqual({ username: 'a', password: 'p' })
    expect(build).toHaveBeenCalledTimes(2)
    expect(await get()).toBe(client)
    expect(build).toHaveBeenCalledTimes(2)
  })

  test('a stale rejected build does not evict the newer client', async () => {
    let current = creds('a', 'f1')
    let rejectFirst: (e: Error) => void = () => {}
    const { get, build } = harness(() => current)
    build.mockImplementationOnce(
      () =>
        new Promise<Client>((_, reject) => {
          rejectFirst = reject
        }),
    )

    const stale = get()
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    current = creds('b', 'f2')
    const fresh = await get()
    rejectFirst(new Error('late'))
    await expect(stale).rejects.toThrow('late')

    expect(await get()).toBe(fresh)
    expect(build).toHaveBeenCalledTimes(2)
  })
})
