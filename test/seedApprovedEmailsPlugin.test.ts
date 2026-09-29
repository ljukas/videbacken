import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __testClient } from '~/lib/db'
import { logger } from '~/lib/logger/server'
import { isApproved } from '~/lib/services/approvedEmail'
import { setupDatabase } from '~test/setup'
import seedApprovedEmailsPlugin from '../server/plugins/seedApprovedEmails'

setupDatabase()

type NitroApp = Parameters<typeof seedApprovedEmailsPlugin>[0]

// The pool behind `db` (test mode pins it to one connection).
function testPool() {
  if (!__testClient) throw new Error('TEST_SCHEMA must be set — see vite.config.ts')
  return __testClient
}

type RequestHook = (event: { req: { waitUntil?: (promise: Promise<unknown>) => void } }) => unknown

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

// Simulates one request on the instance: fires the request hooks with a
// Vercel-style `waitUntil`, then waits for everything handed to it — which is
// what Vercel does before it may freeze the instance again.
async function simulateRequest(requestHooks: RequestHook[]) {
  const pending: Promise<unknown>[] = []
  for (const hook of requestHooks) {
    await hook({ req: { waitUntil: (promise) => pending.push(promise) } })
  }
  await Promise.allSettled(pending)
  return pending.length
}

// pg-pool's error when its connect timer fires — what prod logs show when the
// instance was frozen mid-connect and thawed after connectionTimeoutMillis.
const connectTimeout = () => new Error('Connection terminated due to connection timeout')

describe('seedApprovedEmails plugin', () => {
  const originalEmails = process.env.INITIAL_ADMIN_EMAILS

  beforeEach(() => {
    process.env.INITIAL_ADMIN_EMAILS = 'first-admin@example.se'
  })

  afterEach(() => {
    process.env.INITIAL_ADMIN_EMAILS = originalEmails
    vi.restoreAllMocks()
  })

  it('does no DB work at init — Vercel may freeze the instance before its first request', async () => {
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
})
