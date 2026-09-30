import { waitUntil } from '@vercel/functions'
import { definePlugin } from 'nitro'
import { logger } from '~/lib/logger/server'
import { seedApprovedEmails } from '~/lib/seedApprovedEmails'

/**
 * Seeds the approved_email allowlist from INITIAL_ADMIN_EMAILS once per server
 * instance, on its first request (migrations already ran in the deploy step
 * via `drizzle-kit migrate`).
 *
 * Not at init: Nitro runs plugins when the function module loads, outside any
 * request, so the work isn't covered by `waitUntil` and Vercel may suspend the
 * instance with it in flight. Prod logs showed exactly that shape: the seed's
 * connect timing out a few ms into the instance's first requests, far short of
 * the connect timeout. Inside a request, handed to `waitUntil`, the instance
 * stays up until the seed settles.
 *
 * A failure logs and lets the request proceed; the next request retries. The
 * allowlist can also be managed at runtime once an admin is in.
 */
export default definePlugin((nitro) => {
  let state: 'pending' | 'running' | 'done' = 'pending'

  nitro.hooks.hook('request', () => {
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
    // Not returned: the request doesn't wait for the seed. `waitUntil` reads
    // Vercel's request context itself and is a no-op off Vercel (dev, tests),
    // where the seed simply runs on.
    waitUntil(run)
  })
})
