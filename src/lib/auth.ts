import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { waitUntil } from '@vercel/functions'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { admin, lastLoginMethod, magicLink } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { m } from '~/paraglide/messages'
import { getLocale } from '~/paraglide/runtime'
import { rememberUser } from './browserSession'
import { db } from './db'
import * as schema from './db/schema'
import { devBaseUrl, devTrustedOrigins } from './devHost'
import { email as emailEffect } from './effects'
import { logger } from './logger/server'
import { isApproved, normalizeEmail, resolveSignInDecision } from './services/approvedEmail'
import * as userService from './services/user'

// On Vercel previews each deployment has its own hostname, so BETTER_AUTH_URL
// (pinned to prod) would fail Better Auth's origin check AND send magic links
// back to prod instead of the preview being tested. Prefer VERCEL_BRANCH_URL
// (the stable branch alias) so magic links + sessions survive re-pushes to the
// same PR; fall back to VERCEL_URL (the per-deployment hash) if the alias is
// somehow absent.
// Exported so the user procedures can build absolute app links (e.g. the
// invite email's /login link — see procedures/user.ts) without duplicating
// this resolution logic.
export const resolveBaseURL = () => {
  if (process.env.VERCEL_ENV === 'preview') {
    if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  }
  // `bun run dev --host`: use the LAN IP so magic links + the origin check work
  // from a phone (dev-only; null otherwise). See devHost.ts.
  return devBaseUrl() ?? process.env.BETTER_AUTH_URL
}

// VERCEL_BRANCH_URL is the stable branch alias; VERCEL_URL is the unique
// deployment hash hostname. Trust both so a preview opened via either entry
// point passes the origin check (baseURL is auto-trusted, but list both
// explicitly so it's obvious).
const resolveTrustedOrigins = () => {
  const origins: string[] = []
  if (process.env.VERCEL_BRANCH_URL) {
    origins.push(`https://${process.env.VERCEL_BRANCH_URL}`)
  }
  if (process.env.VERCEL_URL) {
    origins.push(`https://${process.env.VERCEL_URL}`)
  }
  // `bun run dev --host`: trust localhost AND the LAN IP so the app works from both
  // the dev machine and a phone at once (dev-only; empty otherwise).
  origins.push(...devTrustedOrigins())
  return origins
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: resolveBaseURL(),
  trustedOrigins: resolveTrustedOrigins(),
  secret: process.env.BETTER_AUTH_SECRET,
  // Google OAuth. Sign-in is still gated by the approved_email allowlist: the
  // databaseHooks.user.create.before hook denies account creation for any email
  // not on the list, so completing Google's consent for a non-approved address
  // creates no user. Credentials are empty placeholders in local dev (we don't
  // exercise real Google login here) — Task 7 documents provisioning them.
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24 * 7,
    freshAge: 60 * 60,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  user: {
    additionalFields: {
      phone: {
        type: 'string',
        required: false,
      },
      deletedAt: {
        type: 'date',
        required: false,
        input: false,
      },
      // Blurhash of the user's avatar — written by the queue consumer
      // after avatar upload (see server/plugins/queueConsumer.ts). The
      // client only reads it (input: false) to paint a placeholder
      // gradient under <AvatarImage>.
      imageBlurhash: {
        type: 'string',
        required: false,
        input: false,
      },
      // When the invitee finished (or skipped through) the onboarding wizard.
      // Null = never onboarded → the _authenticated loader routes them to
      // /onboarding. Written only by the user service (completeOnboarding);
      // read-only to clients (input: false). See ADR-0017.
      onboardedAt: {
        type: 'date',
        required: false,
        input: false,
      },
    },
  },
  // No `emailVerification` block: invitations are no longer a Better Auth
  // email-verification flow (see ADR-0017 amendment — the allowlist-based
  // model). An invite is just an `approved_email` row; the invitee signs in
  // through the normal Google / magic-link paths below, both already gated by
  // the allowlist. Nothing in the app calls `auth.api.sendVerificationEmail`
  // anymore, so leaving this configured would be vestigial.
  rateLimit: {
    storage: 'database',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/magic-link': { window: 60, max: 5 },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const normalized = normalizeEmail(email)
        // Allowlist gate: never send a link to an email that isn't approved.
        // This is the magic-link half of the two-entry-point gate (the other is
        // databaseHooks.user.create.before, which covers Google + first-sign-in
        // account creation). Approved-but-account-less emails still get a link —
        // Better Auth creates the user on first click, re-checked by that hook.
        if (!(await isApproved(normalized))) {
          logger.info('magic-link denied (not approved)', { email: normalized })
          throw new APIError('BAD_REQUEST', {
            message: m.login_unknown_email_error(),
          })
        }
        // sendMagicLink runs inside the request's Paraglide scope (the
        // /api/auth/* route goes through src/server.ts), so getLocale()
        // reflects the requester's cookie.
        await emailEffect.sendMagicLink({ to: email, url, locale: getLocale() })
        logger.info('magic-link sent', { email: normalized })
      },
    }),
    admin(),
    // Records the last successful sign-in method in a plain, client-readable
    // cookie (better-auth.last_used_login_method). The /login loader reads it
    // (see src/lib/lastLoginMethodFns.ts) to promote that method on the
    // welcome-back card. storeInDatabase stays false → no schema change.
    // maxAge matches the 1-year welcome-back email cookie so the two agree.
    lastLoginMethod({ maxAge: 60 * 60 * 24 * 365 }),
    tanstackStartCookies(),
  ],
  advanced: {
    database: {
      generateId: 'uuid',
    },
    backgroundTasks: {
      handler: (promise) => waitUntil(promise),
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // The single gate for account creation, covering BOTH sign-in methods:
          // Google OAuth first sign-in and magic-link first sign-in both land
          // here before any `user` row is written. Deny (throw APIError → no row
          // created, clean error surfaced) unless the email is on the allowlist;
          // otherwise stamp the role recorded on its approved_email entry.
          const { allowed, role } = await resolveSignInDecision(user.email)
          if (!allowed) {
            logger.info('account creation denied (not approved)', {
              email: normalizeEmail(user.email),
            })
            throw new APIError('BAD_REQUEST', {
              message: m.login_unknown_email_error(),
            })
          }
          return { data: { ...user, role } }
        },
        after: async (user) => {
          logger.info('auth user created', { userId: user.id, role: user.role })
        },
      },
      update: {
        after: async (user) => {
          logger.info('auth user updated', { userId: user.id })
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          logger.info('auth session created', {
            userId: session.userId,
            ip: session.ipAddress ?? null,
            userAgent: session.userAgent ?? null,
          })
          // Stamp the welcome-back cookie at the moment of sign-in — both the
          // magic-link and Google OAuth flows continue with client-side
          // navigation, so the _authenticated beforeLoad write would otherwise
          // not run until the next full-page load. tanstackStartCookies()
          // guarantees this request runs inside TanStack Start's request
          // context, which is what writeBrowserSession's setCookie needs.
          try {
            const row = await userService.findRowById(session.userId)
            if (row) await rememberUser(session.userId, row.email)
          } catch (error) {
            logger.warn('welcome-back cookie write failed', { error })
          }
        },
      },
    },
  },
})
