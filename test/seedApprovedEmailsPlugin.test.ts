import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __testClient } from '~/lib/db'
import { logger } from '~/lib/logger/server'
import { isApproved } from '~/lib/services/approvedEmail'
import { setupDatabase } from '~test/setup'
import seedApprovedEmailsPlugin from '../server/plugins/seedApprovedEmails'

// Vercel's `waitUntil` (a no-op off Vercel), replaced by a spy so the tests can
// see what the plugin hands it.
const { waitUntil } = vi.hoisted(() => ({
  waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
}))
vi.mock('@vercel/functions', () => ({ waitUntil }))

setupDatabase()

type NitroApp = Parameters<typeof seedApprovedEmailsPlugin>[0]

// The pool behind `db` (test mode pins it to one connection).
function testPool() {
  if (!__testClient) throw new Error('TEST_SCHEMA must be set — see vite.config.ts')
  return __testClient
}

type RequestHook = (event: unknown) => unknown

// Just enough of Nitro's app for the plugin: a hooks registry we can fire by hand.
function fakeNitroApp() {
  const requestHooks: RequestHook[] = []
  const app = {
    hooks: {
      hook: (name: string, fn: RequestHook) => {
        if (name === 'request') requestHooks.push(fn)
        return () => {}
      },
    },
  } as unknown as NitroApp
  return { app, requestHooks }
}

function fireRequestHooks(requestHooks: RequestHook[]) {
  for (const hook of requestHooks) hook({})
}

// Simulates one request on the instance: fires the request hooks, then waits
// for whatever they handed to `waitUntil` — Vercel keeps the instance up until
// those settle.
async function simulateRequest(requestHooks: RequestHook[]) {
  const before = waitUntil.mock.calls.length
  fireRequestHooks(requestHooks)
  const handed = waitUntil.mock.calls.slice(before).map(([promise]) => promise)
  await Promise.allSettled(handed)
  return handed.length
}

// pg-pool's error when its connect timer fires — what prod logs showed for the
// init-time seed during an instance's first requests.
const connectTimeout = () => new Error('Connection terminated due to connection timeout')

describe('seedApprovedEmails plugin', () => {
  const originalEmails = process.env.INITIAL_ADMIN_EMAILS

  beforeEach(() => {
    process.env.INITIAL_ADMIN_EMAILS = 'first-admin@example.se'
  })

  afterEach(() => {
    process.env.INITIAL_ADMIN_EMAILS = originalEmails
    vi.restoreAllMocks()
    waitUntil.mockReset()
  })

  it('does no DB work at init — outside a request, waitUntil does not cover it', async () => {
    const query = vi.spyOn(testPool(), 'query')
    seedApprovedEmailsPlugin(fakeNitroApp().app)
    // Let any fire-and-forget work reach the driver before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(query).not.toHaveBeenCalled()
  })

  it('seeds inside the first request, handed to waitUntil', async () => {
    const { app, requestHooks } = fakeNitroApp()
    seedApprovedEmailsPlugin(app)

    expect(await simulateRequest(requestHooks)).toBe(1)
    expect(await isApproved('first-admin@example.se')).toEqual({ role: 'admin' })
  })

  it('retries on a later request when a connect times out, then stops seeding', async () => {
    const { app, requestHooks } = fakeNitroApp()
    seedApprovedEmailsPlugin(app)
    const error = vi.spyOn(logger, 'error')
    const query = vi.spyOn(testPool(), 'query').mockRejectedValueOnce(connectTimeout())

    await simulateRequest(requestHooks)
    expect(error).toHaveBeenCalledWith('approved-email seed failed', expect.anything())
    expect(await isApproved('first-admin@example.se')).toBeNull()

    await simulateRequest(requestHooks)
    expect(await isApproved('first-admin@example.se')).toEqual({ role: 'admin' })

    // Seeded: later requests on this instance don't touch the DB for it.
    query.mockClear()
    expect(await simulateRequest(requestHooks)).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('does not start a second seed while the first is still running', async () => {
    const { app, requestHooks } = fakeNitroApp()
    seedApprovedEmailsPlugin(app)
    const error = vi.spyOn(logger, 'error')

    // Two requests land before the first seed settles.
    fireRequestHooks(requestHooks)
    fireRequestHooks(requestHooks)
    expect(waitUntil).toHaveBeenCalledTimes(1)

    await Promise.allSettled(waitUntil.mock.calls.map(([promise]) => promise))
    expect(error).not.toHaveBeenCalled()
    expect(await isApproved('first-admin@example.se')).toEqual({ role: 'admin' })
  })

  it('still seeds where waitUntil is a no-op (dev, node-server)', async () => {
    const { app, requestHooks } = fakeNitroApp()
    seedApprovedEmailsPlugin(app)

    // Nobody awaits what the plugin hands to (the no-op) waitUntil.
    fireRequestHooks(requestHooks)
    await vi.waitFor(async () => {
      expect(await isApproved('first-admin@example.se')).toEqual({ role: 'admin' })
    })
  })
})
