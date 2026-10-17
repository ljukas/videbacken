import { logger } from './logger/server'
import { addApprovedIfMissing, hasApprovedAdmin, normalizeEmail } from './services/approvedEmail'

// Bootstraps the first admin(s) into the approved_email allowlist from the
// INITIAL_ADMIN_EMAILS env var (comma-separated). Without this, a fresh
// deployment would have an empty allowlist and nobody — not even the intended
// admin — could sign in (both Google and magic-link are gated on the table).
// Runs once per deploy, after migrations: `bun run db:seed`
// (scripts/seedApprovedEmails.ts) in `vercel-build` and `dev:up` (ADR-0017).
//
// Bootstrap only: while the allowlist approves any admin it seeds nothing, so
// admins add admins at /admin and a revoked seed email stays revoked. An
// allowlist left with no admin (a lockout) is seeded again on the next deploy.
// An email that is already approved keeps its row and role.
export async function seedApprovedEmails(): Promise<{
  listed: number
  seeded: number
  skipped: boolean
}> {
  const emails = (process.env.INITIAL_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean)
  if (!emails.length) return { listed: 0, seeded: 0, skipped: false }
  if (await hasApprovedAdmin()) return { listed: emails.length, seeded: 0, skipped: true }
  let seeded = 0
  for (const email of emails) {
    if (!(await addApprovedIfMissing({ email, role: 'admin', addedByUserId: null }))) continue
    logger.info('seeded initial admin approved-email', { email })
    seeded += 1
  }
  return { listed: emails.length, seeded, skipped: false }
}
