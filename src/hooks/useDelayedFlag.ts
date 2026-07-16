import { useEffect, useState } from 'react'

/**
 * Returns `true` only once `active` has stayed `true` for `delayMs`, and flips back
 * to `false` immediately when `active` becomes `false`.
 *
 * Use it to suppress a loading indicator for fast work: a spinner that appears for
 * under ~1s reads as a distracting flash rather than progress, so reveal it only
 * once the work is genuinely slow. For a fast operation the timer is cleared before
 * it fires, so the flag never flips and nothing renders.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (!active) {
      setOn(false)
      return
    }
    const id = setTimeout(() => setOn(true), delayMs)
    return () => clearTimeout(id)
  }, [active, delayMs])

  return on
}
