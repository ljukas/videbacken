import { useEffect, useRef } from 'react'
import { getSession } from '~/lib/getSession'

const POLL_INTERVAL_MS = 2500

type Options = {
  /** Start watching for a re-freshened session (e.g. once the re-auth link has been sent). */
  enabled: boolean
  /** Called exactly once, the moment the session becomes fresh again. */
  onFresh: () => void
}

/**
 * Watches for the current session being *re-freshened* in another tab.
 *
 * Unlike {@link useAwaitSignIn} — which fires on any session — the user is already signed in
 * here, so we can't key off the session merely existing. Instead we capture the session's
 * `createdAt` on the first poll and fire `onFresh` once a later poll returns a newer one: the
 * magic link clicked in the other tab created a fresh session (shared cookie, same origin).
 *
 * This is cosmetic — it only drives the dialog's status copy. The actual passkey add is always
 * a user gesture, so a missing/late `createdAt` delays the "bekräftad" copy but never blocks.
 */
export function useAwaitFreshSession({ enabled, onFresh }: Options) {
  const onFreshRef = useRef(onFresh)
  onFreshRef.current = onFresh

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let firing = false
    let baseline: number | null = null

    async function check() {
      if (cancelled || firing) return
      firing = true
      try {
        const result = await getSession()
        const createdAt = result?.session?.createdAt
        if (!createdAt) return
        const ts = new Date(createdAt).getTime()
        if (baseline === null) {
          baseline = ts
        } else if (ts > baseline && !cancelled) {
          cancelled = true
          onFreshRef.current()
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
