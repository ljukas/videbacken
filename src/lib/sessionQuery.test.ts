import { focusManager, QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const getSession = vi.fn()
vi.mock('~/lib/getSession', () => ({ getSession: () => getSession() }))

const { sessionQueryOptions } = await import('./sessionQuery')
const { SESSION_COOKIE_CACHE_MAX_AGE_S } = await import('./authConfig')

const user = { id: 'u1', email: 'a@example.se', role: 'admin', deletedAt: null }

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00Z') })
  getSession.mockReset()
})
afterEach(() => vi.useRealTimers())

test('keeps only the user, never the session or its token', async () => {
  getSession.mockResolvedValue({ session: { token: 'secret-token', id: 's1' }, user })
  const data = await new QueryClient().fetchQuery(sessionQueryOptions)
  expect(data).toEqual({ user })
  expect(JSON.stringify(data)).not.toContain('secret-token')
})

test('no session is null', async () => {
  getSession.mockResolvedValue(null)
  expect(await new QueryClient().fetchQuery(sessionQueryOptions)).toBeNull()
})

test('reuses the session for the cookie-cache lifetime, then asks the server again', async () => {
  getSession.mockResolvedValue({ session: { token: 't' }, user })
  const qc = new QueryClient()
  await qc.fetchQuery(sessionQueryOptions)
  vi.advanceTimersByTime(SESSION_COOKIE_CACHE_MAX_AGE_S * 1000 - 1)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(2)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('a null session is not reused: signing in is seen on the next read', async () => {
  const qc = new QueryClient()
  getSession.mockResolvedValueOnce(null)
  expect(await qc.fetchQuery(sessionQueryOptions)).toBeNull()
  getSession.mockResolvedValueOnce({ session: { token: 't' }, user })
  expect(await qc.fetchQuery(sessionQueryOptions)).toEqual({ user })
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('a deleted user is not reused', async () => {
  const deleted = { ...user, deletedAt: new Date('2026-10-01T00:00:00Z') }
  const qc = new QueryClient()
  getSession.mockResolvedValue({ session: { token: 't' }, user: deleted })
  await qc.fetchQuery(sessionQueryOptions)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('invalidating on tab focus makes the next read ask the server again', async () => {
  getSession.mockResolvedValue({ session: { token: 't' }, user })
  const qc = new QueryClient()
  // Same subscription the _authenticated layout sets up.
  const unsubscribe = focusManager.subscribe((focused) => {
    if (focused) void qc.invalidateQueries({ queryKey: sessionQueryOptions.queryKey })
  })
  await qc.fetchQuery(sessionQueryOptions)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(1)
  focusManager.setFocused(false)
  focusManager.setFocused(true)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(2)
  unsubscribe()
  focusManager.setFocused(undefined)
})
