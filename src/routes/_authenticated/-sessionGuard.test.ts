import { QueryClient } from '@tanstack/react-query'
import { isRedirect } from '@tanstack/react-router'
import { expect, test, vi } from 'vitest'

// The real getSession → sessionQueryOptions → beforeLoad chain, with Better
// Auth faked. The node suite has no Start plugin transform, so the server fn's
// handler is called directly. Each test sets the mock itself (no beforeEach).
const authGetSession = vi.fn()

vi.mock('@tanstack/react-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start')>()),
  createServerFn: () => {
    const chain = {
      handler: <T>(fn: T) => fn,
      middleware: () => chain,
      validator: () => chain,
      inputValidator: () => chain,
    }
    return chain
  },
}))
vi.mock('@tanstack/react-start/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start/server')>()),
  getRequest: () => ({ headers: new Headers() }),
}))
vi.mock('~/lib/auth', () => ({
  auth: { api: { getSession: (options: { headers: Headers }) => authGetSession(options) } },
}))

const { Route } = await import('../_authenticated')
const { sessionQueryOptions } = await import('~/lib/sessionQuery')

type BeforeLoad = (args: {
  location: { href: string }
  context: { queryClient: QueryClient }
}) => Promise<unknown>
const beforeLoad = (Route as unknown as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad

const load = (qc: QueryClient) =>
  beforeLoad({ location: { href: '/charging' }, context: { queryClient: qc } })

const testQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

// A failed session lookup must reach the route's error boundary (#150): a
// rejected query is not "no session", so the guard must not bounce the user.
test('a failed session lookup rejects beforeLoad: the error boundary, not a sign-out', async () => {
  const qc = testQueryClient()
  const dbError = new Error('Connection terminated unexpectedly')
  authGetSession.mockRejectedValue(dbError)
  await expect(load(qc)).rejects.toBe(dbError)
  // The error is never cached as a session.
  expect(qc.getQueryData(sessionQueryOptions.queryKey)).toBeUndefined()
})

test('no session still redirects to /login', async () => {
  const qc = testQueryClient()
  authGetSession.mockResolvedValue(null)
  const thrown = await load(qc).catch((error: unknown) => error)
  expect(isRedirect(thrown)).toBe(true)
  expect((thrown as unknown as { options?: { to?: string } }).options?.to).toBe('/login')
})
