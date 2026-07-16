import { ORPCError, os } from '@orpc/server'
import { auth } from '~/lib/auth'
import type { Logger } from '~/lib/logger'

type Session = Awaited<ReturnType<typeof auth.api.getSession>>
type SessionUser = NonNullable<Session>['user']
type SessionData = NonNullable<Session>['session']

export const base = os.$context<{ headers: Headers; log: Logger; requestId: string }>()

const sessionMiddleware = base.middleware(async ({ context, next }) => {
  const data = await auth.api.getSession({ headers: context.headers })
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
  .$context<{ session: SessionData | null; user: SessionUser | null }>()
  .middleware(async ({ context, next }) => {
    if (!context.session || !context.user) {
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
