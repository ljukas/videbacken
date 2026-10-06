import { useEffect } from 'react'

/**
 * Warms lazy chunks once the browser is idle, so an admin's first click on a
 * lazily loaded dialog finds its code already fetched (ADR-0025 §6). Members
 * pass `enabled: false` and never fetch it. Keep `loaders` stable (module-level):
 * it is an effect dependency. A rejection is swallowed: the dialog's own lazy
 * load surfaces the error if the user opens it.
 */
export function useIdlePreload(enabled: boolean, loaders: ReadonlyArray<() => Promise<unknown>>) {
  useEffect(() => {
    if (!enabled) return
    const run = () => {
      for (const load of loaders) load().catch(() => {})
    }
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run)
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(run, 1)
    return () => clearTimeout(id)
  }, [enabled, loaders])
}
