import { definePlugin } from 'nitro'
import { logger } from '~/lib/logger/server'
import { seedApprovedEmails } from '~/lib/seedApprovedEmails'

/**
 * One-shot startup seed of the approved_email allowlist from
 * INITIAL_ADMIN_EMAILS. Runs at server init (after migrations, which run in the
 * build/deploy step via `drizzle-kit migrate`). Guarded so a seed failure logs
 * and lets the server come up rather than crashing the whole process — the
 * allowlist can also be managed at runtime once an admin is in.
 */
export default definePlugin(async () => {
  try {
    await seedApprovedEmails()
  } catch (error) {
    logger.error('approved-email seed failed', { error })
  }
})
