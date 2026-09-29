import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { getSession } from '~/lib/getSession'

const POLL_INTERVAL_MS = 2500

type Options = {
  /** Start watching for a session (e.g. once the magic-link email has been sent). */
  enabled: boolean
  /** Called exactly once, the moment a session is detected. */
  onSignedIn: () => void
}

/**
 * Watches for the browser becoming authenticated in *another* tab.
 *
 * The Better Auth session cookie is shared across all same-origin tabs, so when
 * the user follows the magic link (which authenticates in a new tab), this tab's
 * `getSession()` starts returning a session. We poll on an interval while the tab
 * is visible, and re-check immediately when the tab regains visibility — so
 * returning to this tab after clicking the link advances it at once.
 */
export function useAwaitSignIn({ enabled, onSignedIn }: Options) {
  const onSignedInRef = useRef(onSignedIn)
  onSignedInRef.current = onSignedIn

  const { data: session } = useQuery({
    queryKey: ['awaitSignIn'],
    queryFn: () => getSession(),
    // Once a session is seen there is nothing left to watch for.
    enabled: (query) => enabled && !query.state.data,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // TanStack's focus event is `visibilitychange`: re-check on becoming visible.
    refetchOnWindowFocus: 'always',
    // A failed check is simply retried on the next tick.
    retry: false,
    gcTime: 0,
  })

  useEffect(() => {
    if (enabled && session) onSignedInRef.current()
  }, [enabled, session])
}
