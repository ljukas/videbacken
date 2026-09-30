import { ORPCError } from '@orpc/client'
import type { QueryClient } from '@tanstack/react-query'
import { isNotFound } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { logger } from '~/lib/logger/browser'
import { Route } from './$sessionId'

// The route's own loader, not a copy: an unknown, voided or malformed id must
// reach the app's NotFound (never a 500 or the generic alert), while any other
// failure resolves so the page's LoadErrorAlert shows. The `-` prefix keeps
// this file out of the route tree.
type LoaderArgs = {
  context: { queryClient: Pick<QueryClient, 'ensureQueryData'> }
  params: { sessionId: string }
}
const loader = Route.options.loader as unknown as (args: LoaderArgs) => Promise<unknown>

const SESSION_ID = '00000000-0000-4000-8000-000000000001'

function run(sessionId: string, ensureQueryData: () => Promise<unknown>) {
  const ensure = vi.fn(ensureQueryData)
  const queryClient = { ensureQueryData: ensure } as unknown as LoaderArgs['context']['queryClient']
  return { ensure, result: loader({ context: { queryClient }, params: { sessionId } }) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('an unknown or voided session throws a router notFound', async () => {
  const { result } = run(SESSION_ID, () =>
    Promise.reject(new ORPCError('EV_SESSION_NOT_FOUND', { status: 404, defined: true })),
  )
  const thrown = await result.then(
    () => null,
    (err: unknown) => err,
  )
  expect(isNotFound(thrown)).toBe(true)
})

test('a malformed id throws notFound without fetching', async () => {
  const { ensure, result } = run('nope', () => Promise.resolve(null))
  const thrown = await result.then(
    () => null,
    (err: unknown) => err,
  )
  expect(isNotFound(thrown)).toBe(true)
  expect(ensure).not.toHaveBeenCalled()
})

test('any other failure resolves (the page shows its load-error alert) and is logged', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const { ensure, result } = run(SESSION_ID, () =>
    Promise.reject(new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 })),
  )
  await expect(result).resolves.toBeUndefined()
  expect(ensure).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    'session prefetch failed',
    expect.objectContaining({ sessionId: SESSION_ID }),
  )
})

test('a found session resolves', async () => {
  const { ensure, result } = run(SESSION_ID, () => Promise.resolve({}))
  await expect(result).resolves.toBeUndefined()
  expect(ensure).toHaveBeenCalledOnce()
})
