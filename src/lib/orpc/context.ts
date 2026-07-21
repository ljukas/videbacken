import { ORPCError, os } from '@orpc/server'
import { auth } from '~/lib/auth'
import type { Logger } from '~/lib/logger'
import * as userService from '~/lib/services/user'

type Session = Awaited<ReturnType<typeof auth.api.getSession>>
type SessionUser = NonNullable<Session>['user']
type SessionData = NonNullable<Session>['session']

// A mutable per-request bag the RPC handler (src/routes/api/rpc/$.ts) passes in
// and reads back after the chain resolves, so it can log where a request's time
// went (auth round-trips vs. the procedure's own queries). Optional: in-process
// SSR calls and tests build a context without it, and the writes below no-op.
export type RequestTimings = Record<string, number>

export const base = os.$context<{
  headers: Headers
  log: Logger
  requestId: string
  timings?: RequestTimings
}>()

const sessionMiddleware = base.middleware(async ({ context, next }) => {
  const startedAt = performance.now()
  const data = await auth.api.getSession({ headers: context.headers })
  if (context.timings) context.timings.getSessionMs = Math.round(performance.now() - startedAt)
  const user = data?.user ?? null
  const log = user ? context.log.child({ userId: user.id }) : context.log
  return next({
    context: {
      session: data?.session ?? null,
      user,
      log,
    },
  })
})

const requireAuth = base
  .$context<{ session: SessionData | null; user: SessionUser | null; timings?: RequestTimings }>()
  .middleware(async ({ context, next }) => {
    if (!context.session || !context.user) {
      throw new ORPCError('UNAUTHORIZED')
    }
    // Fresh DB check on every authenticated request — do NOT trust the (up-to-5-
    // min cookieCache) session user. `revokeUser` soft-deletes the row but leaves
    // `role` and any minted/cached session intact, so a revoked user (esp. a
    // revoked admin re-authenticating via Google, where the create.before gate
    // never fires) would otherwise still pass here and reach admin mutations via
    // /api/rpc. findActiveById filters `deletedAt`, so a revoked/deleted user
    // reads back as null → reject. Closes both the Google-re-auth hole and the
    // cookieCache staleness window. One extra read per request is fine at this
    // scale; DB access stays in the service (context.ts owns no `db.`).
    const startedAt = performance.now()
    const activeUser = await userService.findActiveById(context.user.id)
    if (context.timings)
      context.timings.findActiveByIdMs = Math.round(performance.now() - startedAt)
    if (!activeUser) {
      throw new ORPCError('UNAUTHORIZED')
    }
    return next({
      context: {
        session: context.session,
        user: context.user,
      },
    })
  })

const requireAdmin = base
  .$context<{ user: SessionUser }>()
  .middleware(async ({ context, next }) => {
    if (context.user.role !== 'admin') {
      throw new ORPCError('FORBIDDEN')
    }
    return next()
  })

export const publicProcedure = base.use(sessionMiddleware)
export const protectedProcedure = publicProcedure.use(requireAuth)
export const adminProcedure = protectedProcedure.use(requireAdmin)
