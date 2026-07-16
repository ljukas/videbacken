import { logger } from './logger/server'
import { addApproved, isApproved, normalizeEmail } from './services/approvedEmail'

// Idempotently seed the first admin(s) into the approved_email allowlist from
// the INITIAL_ADMIN_EMAILS env var (comma-separated). Without this, a fresh
// deployment would have an empty allowlist and nobody — not even the intended
// admin — could sign in (both Google and magic-link are gated on the table).
// Runs once at server startup, after migrations (see server/plugins).
export async function seedApprovedEmails(): Promise<void> {
  const emails = (process.env.INITIAL_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean)
  for (const email of emails) {
    if (await isApproved(email)) continue
    await addApproved({ email, role: 'admin', addedByUserId: null })
    logger.info('seeded initial admin approved-email', { email })
  }
}
