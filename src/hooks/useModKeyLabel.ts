import { formatForDisplay } from '@tanstack/react-hotkeys'
import { useEffect, useState } from 'react'

/**
 * The platform `Mod+K` hint ("⌘K" on macOS, "Ctrl K" elsewhere), resolved after
 * mount. `formatForDisplay` reads `navigator`, so it returns '' on the server and
 * the first client render — render the kbd only once it's non-empty to avoid a
 * hydration mismatch.
 */
export function useModKeyLabel(): string {
  const [label, setLabel] = useState('')
  useEffect(() => {
    setLabel(formatForDisplay('Mod+K'))
  }, [])
  return label
}
