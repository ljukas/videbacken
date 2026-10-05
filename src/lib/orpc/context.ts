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

type ActiveUser = Awaited<ReturnType<typeof userService.findActiveById>>

// The auth lookups of one HTTP request, shared by every procedure call it
// makes (an SSR render's loader calls run in-process, several per request).
// It never outlives the request, so a revoked user is still rejected on the
// next one (ADR-0017); a cross-request cache would delay that (ADR-0025 §5).
// A failed lookup stays failed for the rest of its request.
// Bound to the credentials the session came from, so a memo can never answer
// for a caller carrying other ones (both call sites pass one request's headers;
// this keeps a future caller honest).
export type AuthMemo = {
  session?: { credentials: string; lookup: Promise<Session> }
  activeUsers: Map<string, Promise<ActiveUser>>
}

export const createAuthMemo = (): AuthMemo => ({ activeUsers: new Map() })

const credentialsOf = (headers: Headers) =>
  `${headers.get('cookie') ?? ''}\n${headers.get('authorization') ?? ''}`

// SSR's in-process client builds a context per call; the incoming Request
// is what one render's calls share. Weak, so a memo goes with its request.
const ssrMemos = new WeakMap<Request, AuthMemo>()
export function authMemoFor(request: Request): AuthMemo {
  let memo = ssrMemos.get(request)
  if (!memo) {
    memo = createAuthMemo()
    ssrMemos.set(request, memo)
  }
  return memo
}

export const base = os.$context<{
  headers: Headers
  log: Logger
  requestId: string
  timings?: RequestTimings
  authMemo?: AuthMemo
}>()

const sessionMiddleware = base.middleware(async ({ context, next }) => {
  const memo = context.authMemo
  const credentials = credentialsOf(context.headers)
  const cached = memo?.session?.credentials === credentials ? memo.session.lookup : undefined
  const startedAt = performance.now()
  const pending = cached ?? auth.api.getSession({ headers: context.headers })
  if (memo && !memo.session) memo.session = { credentials, lookup: pending }
  const data = await pending
  // Timed only by the call that ran it: a reused lookup cost nothing.
  if (context.timings && !cached)
    context.timings.getSessionMs = Math.round(performance.now() - startedAt)
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
  .$context<{
    session: SessionData | null
    user: SessionUser | null
    timings?: RequestTimings
    authMemo?: AuthMemo
  }>()
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
    // Memoized per HTTP request (`authMemo`), never across requests.
    const memo = context.authMemo
    const cached = memo?.activeUsers.get(context.user.id)
    const startedAt = performance.now()
    const pending = cached ?? userService.findActiveById(context.user.id)
    if (memo && !cached) memo.activeUsers.set(context.user.id, pending)
    const activeUser = await pending
    if (context.timings && !cached)
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
