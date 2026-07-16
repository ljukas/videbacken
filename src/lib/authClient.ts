import { passkeyClient } from '@better-auth/passkey/client'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { adminClient, magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { useCallback } from 'react'

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient(), passkeyClient()],
})

export function useSignOut() {
  const router = useRouter()
  const queryClient = useQueryClient()

  return useCallback(async () => {
    await authClient.signOut()
    await router.navigate({ to: '/login' })
    queryClient.clear()
  }, [router, queryClient])
}
