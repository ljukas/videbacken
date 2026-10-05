import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { adminClient, magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { useCallback } from 'react'
import { sessionQueryOptions } from './sessionQuery'

// `signIn.social` (Google) is built in from the server's socialProviders config
// — no client plugin needed. `signIn.magicLink` comes from magicLinkClient().
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
})

export function useSignOut() {
  const router = useRouter()
  const queryClient = useQueryClient()

  return useCallback(async () => {
    await authClient.signOut()
    queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey })
    try {
      await router.navigate({ to: '/login' })
    } finally {
      queryClient.clear()
    }
  }, [router, queryClient])
}
