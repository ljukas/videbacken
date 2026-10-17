import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { logger } from '~/lib/logger/server'
import { auth } from './auth'

// Better Auth tells the two cases apart: `null` for a genuinely missing,
// expired or revoked session, a throw when the lookup itself fails (#150).
// Swallowing the throw turned a one-request database failure into a sign-out —
// `null` reads as "no session" and the `_authenticated` guard sends the user to
// /login. So `null` is the only sign-out signal; anything else is logged and
// rethrown, which rejects the session query and shows the error boundary.
export const getSession = createServerFn().handler(async () => {
  const request = getRequest()
  try {
    return await auth.api.getSession({ headers: request.headers })
  } catch (error) {
    logger.warn('getSession failed', { error })
    throw error
  }
})
