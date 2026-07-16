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

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let firing = false

    async function check() {
      if (cancelled || firing) return
      firing = true
      try {
        const session = await getSession()
        if (!cancelled && session) {
          cancelled = true
          onSignedInRef.current()
        }
      } finally {
        firing = false
      }
    }

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, POLL_INTERVAL_MS)

    function onVisibility() {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibility)

    void check()

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
}
