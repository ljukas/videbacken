import { queryOptions } from '@tanstack/react-query'
import { SESSION_COOKIE_CACHE_MAX_AGE_S } from './authConfig'
import { getSession } from './getSession'

// The `_authenticated` guard's session, cached so a client navigation doesn't
// call the server function every time (ADR-0024 §2). Holds only the user: the
// SSR query integration serializes the cache into the HTML, and the session
// token must never be in it. Sign-out clears it (useSignOut → queryClient.clear()).
export const sessionQueryOptions = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const session = await getSession()
    return session ? { user: session.user } : null
  },
  staleTime: SESSION_COOKIE_CACHE_MAX_AGE_S * 1000,
})
