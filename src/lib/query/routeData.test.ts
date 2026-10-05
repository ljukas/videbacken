import { environmentManager, QueryClient } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { loadRouteData } from './routeData'

afterEach(() => environmentManager.setIsServer(() => typeof window === 'undefined'))

const never = () => new Promise<never>(() => {})
const q = (key: string, queryFn: () => Promise<unknown>) => ({ queryKey: [key], queryFn })

test('on the server it awaits critical queries', async () => {
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient()
  await loadRouteData(qc, { critical: [q('a', async () => 1)] })
  expect(qc.getQueryData(['a'])).toBe(1)
})

test('on the server deferred queries are not started', async () => {
  // Started, one could stream in before hydration and mismatch the server's
  // "pending" render; the section's useQuery fetches it after hydration.
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient()
  const deferredFn = vi.fn(async () => 1)
  await loadRouteData(qc, { critical: [q('a', async () => 1)], deferred: [q('d', deferredFn)] })
  expect(deferredFn).not.toHaveBeenCalled()
  expect(qc.getQueryState(['d'])).toBeUndefined()
})

test('on the client deferred queries start but are not awaited', async () => {
  environmentManager.setIsServer(() => false)
  const qc = new QueryClient()
  const deferredFn = vi.fn(never)
  await loadRouteData(qc, { deferred: [q('d', deferredFn)] }) // resolves despite a never-ending fetch
  expect(deferredFn).toHaveBeenCalledOnce()
  expect(qc.getQueryState(['d'])?.status).toBe('pending')
})

test('on the client it awaits nothing', async () => {
  environmentManager.setIsServer(() => false)
  const qc = new QueryClient()
  const criticalFn = vi.fn(never)
  await loadRouteData(qc, { critical: [q('a', criticalFn)] })
  expect(criticalFn).toHaveBeenCalledOnce()
  expect(qc.getQueryState(['a'])?.status).toBe('pending')
})

test('on the client stale cached data stays readable while it refreshes', async () => {
  environmentManager.setIsServer(() => false)
  const qc = new QueryClient()
  qc.setQueryData(['a'], 'old', { updatedAt: Date.now() - 60_000 })
  const refresh = vi.fn(async () => 'new')
  await loadRouteData(qc, { critical: [{ ...q('a', refresh), staleTime: 20_000 }] })
  expect(qc.getQueryData(['a'])).toBe('old') // the page renders this at once
  expect(refresh).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(qc.getQueryData(['a'])).toBe('new'))
})

test('a failing query never rejects the loader', async () => {
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await expect(
    loadRouteData(qc, { critical: [q('x', async () => Promise.reject(new Error('boom')))] }),
  ).resolves.toBeUndefined()
})

test('null and false entries are skipped', async () => {
  environmentManager.setIsServer(() => true)
  await expect(
    loadRouteData(new QueryClient(), { critical: [null, false] }),
  ).resolves.toBeUndefined()
})
