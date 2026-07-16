import * as React from 'react'
import { isIOSUserAgent } from '~/utils/device'

/**
 * True on iPhone/iPod (iOS). SSR-safe: starts `false` during SSR and the first
 * client paint, then resolves after hydration — so a consumer that swaps a value
 * based on it (notably a file input's `accept`) never triggers a hydration
 * mismatch. Mirrors {@link useIsCoarsePointer}. The detection (and its
 * deliberate iPadOS-as-Mac caveat) lives in {@link isIOSUserAgent}.
 */
export function useIsIOS(): boolean {
  const [isIOS, setIsIOS] = React.useState(false)

  React.useEffect(() => {
    setIsIOS(isIOSUserAgent(navigator.userAgent))
  }, [])

  return isIOS
}
