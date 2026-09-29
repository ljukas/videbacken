import { definePlugin } from 'nitro'
import { logger } from '~/lib/logger/server'
import { seedApprovedEmails } from '~/lib/seedApprovedEmails'

/**
 * Seeds the approved_email allowlist from INITIAL_ADMIN_EMAILS once per server
 * instance, on its first request (migrations already ran in the deploy step
 * via `drizzle-kit migrate`).
 *
 * Not at init: Nitro runs plugins when the function module loads, and Vercel
 * can load it (pre-warm) and then freeze the instance until its first request.
 * A seed started at init froze mid-connect, and on thaw the driver's overdue
 * connect timer fired at once — "connection timeout" a few ms into whatever
 * request woke the instance. Inside a request, handed to `waitUntil`, the
 * instance stays running until the seed settles.
 *
 * A failure logs and lets the request proceed; the next request retries. The
 * allowlist can also be managed at runtime once an admin is in.
 */
export default definePlugin((nitro) => {
  let state: 'pending' | 'running' | 'done' = 'pending'

  nitro.hooks.hook('request', (event) => {
    if (state !== 'pending') return
    state = 'running'
    const run = seedApprovedEmails().then(
      () => {
        state = 'done'
      },
      (error: unknown) => {
        state = 'pending'
        logger.error('approved-email seed failed', { error })
      },
    )
    // Not returned: the request doesn't wait for the seed.
    event.req.waitUntil?.(run)
  })
})
