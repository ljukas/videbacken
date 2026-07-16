import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { passkey } from '@better-auth/passkey'
import { waitUntil } from '@vercel/functions'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { admin, magicLink } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { m } from '~/paraglide/messages'
import { baseLocale, getLocale } from '~/paraglide/runtime'
import { isAllowlistedAdmin, normalizeEmail } from './adminAllowlist'
import { rememberUser } from './browserSession'
import { db } from './db'
import * as schema from './db/schema'
import { devBaseUrl, devTrustedOrigins } from './devHost'
import { email as emailEffect, queue as queueEffect } from './effects'
import { logger } from './logger/server'
import * as userService from './services/user'

// On Vercel previews each deployment has its own hostname, so BETTER_AUTH_URL
// (pinned to prod) would fail Better Auth's origin check AND send magic links
// back to prod instead of the preview being tested. Prefer VERCEL_BRANCH_URL
// (the stable branch alias) so magic links + sessions survive re-pushes to the
// same PR; fall back to VERCEL_URL (the per-deployment hash) if the alias is
// somehow absent.
const resolveBaseURL = () => {
  if (process.env.VERCEL_ENV === 'preview') {
    if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  }
  // `pnpm dev --host`: use the LAN IP so magic links + the origin check work
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
  // `pnpm dev --host`: trust localhost AND the LAN IP so the app works from both
  // the dev machine and a phone at once (dev-only; empty otherwise).
  origins.push(...devTrustedOrigins())
  return origins
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: resolveBaseURL(),
  trustedOrigins: resolveTrustedOrigins(),
  secret: process.env.BETTER_AUTH_SECRET,
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
      // When the most recent invitation email was sent. Written by the invite
      // service (inviteUser/markInvited); read-only to clients. Drives the
      // owners-list "Inbjuden — går ut om …" countdown (expiry =
      // lastInvitedAt + INVITE_EXPIRY_SECONDS). Null for self-signed-up users.
      lastInvitedAt: {
        type: 'date',
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
  emailVerification: {
    // Invitations ARE Better Auth email-verification: an admin invite sends a
    // verify-email link; clicking it (or any first magic-link login) flips
    // `emailVerified` true = "accepted". 7-day link, decoupled from the 5-min
    // login magic-link. Single source of truth: INVITE_EXPIRY_SECONDS.
    expiresIn: userService.INVITE_EXPIRY_SECONDS,
    // One click verifies AND signs the invitee in (internalAdapter.createSession
    // + cookie) then redirects to callbackURL — no custom accept route needed.
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Render in the app default (baseLocale = 'sv') by design: the invitee is
      // new, so their own locale is unknown, and Swedish is the club's
      // source-of-truth language — they switch after signing in. (The hook's
      // synchronous prefix could read the inviting admin's getLocale(), but the
      // admin's UI language isn't the invitee's, so the club default is safer.)
      // Tier-3: this enqueues; the worker renders + sends with retry/backoff.
      // The enqueue runs fire-and-forget via the configured backgroundTasks
      // handler (waitUntil), so a failure is logged, not surfaced to the caller.
      // See ADR-0008 / ADR-0017.
      await queueEffect.publish('email_user_invited', {
        to: user.email,
        inviteUrl: url,
        locale: baseLocale,
      })
    },
  },
  rateLimit: {
    storage: 'database',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/magic-link': { window: 60, max: 5 },
      // Caps the PUBLIC POST /api/auth/send-verification-email endpoint — the
      // real spam vector, since its no-session branch will send an invite to any
      // registered unverified email (anti-enumeration: unknown/verified silently
      // no-op). The admin invite/resend procedures call auth.api.* server-side,
      // which bypasses this HTTP rate limiter (they're already adminProcedure).
      '/send-verification-email': { window: 60, max: 5 },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const normalized = normalizeEmail(email)
        const existingId = await userService.findIdByEmail(normalized)
        if (!existingId && !isAllowlistedAdmin(normalized)) {
          logger.info('magic-link denied (unknown email)', { email: normalized })
          throw new APIError('BAD_REQUEST', {
            message: m.login_unknown_email_error(),
          })
        }
        // sendMagicLink runs inside the request's Paraglide scope (the
        // /api/auth/* route goes through src/server.ts), so getLocale()
        // reflects the requester's cookie.
        await emailEffect.sendMagicLink({ to: email, url, locale: getLocale() })
        logger.info('magic-link sent', { email: normalized, userId: existingId ?? null })
      },
    }),
    admin(),
    passkey({
      rpID: new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:14500').hostname,
      rpName: 'Oceanview',
      origin: process.env.BETTER_AUTH_URL ?? 'http://localhost:14500',
    }),
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
          if (isAllowlistedAdmin(user.email)) {
            return { data: { ...user, role: 'admin' } }
          }
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
          // Stamp the welcome-back cookie at the moment of sign-in — both
          // magic-link and passkey flows continue with client-side navigation,
          // so the _authenticated beforeLoad write would otherwise not run
          // until the next full-page load. tanstackStartCookies() guarantees
          // this request runs inside TanStack Start's request context, which
          // is what writeBrowserSession's setCookie needs.
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
