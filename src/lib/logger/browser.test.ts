import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type FetchMock = ReturnType<typeof vi.fn>

let fetchMock: FetchMock
let originalFetch: typeof globalThis.fetch | undefined

async function importFreshBrowserLogger() {
  vi.resetModules()
  return await import('./browser')
}

describe('browser logger', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  test('warn POSTs to /api/log with the merged fields', async () => {
    const { logger } = await importFreshBrowserLogger()
    logger.warn('boom', { route: '/x' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/log')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ level: 'warn', msg: 'boom', fields: { route: '/x' } })
  })

  test('error POSTs to /api/log', async () => {
    const { logger } = await importFreshBrowserLogger()
    logger.error('oops')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.level).toBe('error')
    expect(body.msg).toBe('oops')
  })

  test('info and debug do not forward to /api/log', async () => {
    const { logger } = await importFreshBrowserLogger()
    logger.info('just info')
    logger.debug('just debug')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a rejected fetch does not throw out of the logger', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const { logger } = await importFreshBrowserLogger()
    expect(() => logger.error('oops')).not.toThrow()
    // wait a tick for the rejected promise to settle without an unhandled rejection
    await new Promise((r) => setTimeout(r, 0))
  })

  test('child logger merges its scope into the forwarded body', async () => {
    const { logger } = await importFreshBrowserLogger()
    const scoped = logger.child({ userId: 'u-1' })
    scoped.error('scoped error', { route: '/admin' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.fields).toEqual({ userId: 'u-1', route: '/admin' })
  })
})
