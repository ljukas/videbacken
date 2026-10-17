// Seeds INITIAL_ADMIN_EMAILS into the approved_email allowlist once per deploy
// (ADR-0017), right after the migrations, against the same database:
//
//   vercel-build   # = drizzle-kit migrate && bun run db:seed && vite build && …
//   bun run dev:up # = … && bun run db:migrate && bun run db:seed
//
// Not on each instance's first request any more (server-latency roadmap row 9):
// a Nitro plugin doing it bundled a second copy of ~/lib/db, and with it a
// second pool, into every instance. Exits 1 on any failure, so a deploy whose
// first admin couldn't be seeded fails like one whose migration failed.
import { logger } from '~/lib/logger/server'

try {
  // Imported only now: ~/lib/db throws when it loads without a database URL.
  const { seedApprovedEmails } = await import('~/lib/seedApprovedEmails')
  const { listed, seeded } = await seedApprovedEmails()
  logger.info('approved-email seed done', { listed, seeded })
} catch (error) {
  logger.error('approved-email seed failed', { error })
  process.exit(1)
}
// The pool keeps idle connections open, which would keep the process alive.
process.exit(0)
