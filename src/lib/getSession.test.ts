import { beforeEach, expect, test, vi } from 'vitest'

// In the app build the Start plugin rewrites the server fn; here the node suite
// calls the raw handler with the request and Better Auth faked.
const authGetSession = vi.fn()
const logged: Array<{ msg: string; error: unknown }> = []

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({ handler: <T>(fn: T) => fn }),
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => ({ headers: new Headers() }),
}))
vi.mock('./auth', () => ({
  auth: { api: { getSession: (options: { headers: Headers }) => authGetSession(options) } },
}))
vi.mock('~/lib/logger/server', () => ({
  logger: {
    warn: (msg: string, fields?: { error?: unknown }) => logged.push({ msg, error: fields?.error }),
  },
}))

const { getSession } = await import('./getSession')

beforeEach(() => {
  authGetSession.mockReset()
  logged.length = 0
})

// Better Auth returns `null` only for a genuinely missing, expired or revoked
// session; a failed lookup throws (#150). The two must not be conflated: `null`
// sends the signed-in user to /login, an error shows the error boundary.
test('a failed lookup rejects: a database error is not read as a sign-out', async () => {
  const dbError = new Error('Connection terminated unexpectedly')
  authGetSession.mockRejectedValue(dbError)
  await expect(getSession()).rejects.toBe(dbError)
  expect(logged).toEqual([{ msg: 'getSession failed', error: dbError }])
})

test('no session still resolves to null', async () => {
  authGetSession.mockResolvedValue(null)
  await expect(getSession()).resolves.toBeNull()
})

test('a session passes through untouched, with the request headers', async () => {
  const session = { session: { token: 't', id: 's1' }, user: { id: 'u1' } }
  authGetSession.mockResolvedValue(session)
  await expect(getSession()).resolves.toBe(session)
  expect(authGetSession).toHaveBeenCalledWith({ headers: expect.any(Headers) })
})
