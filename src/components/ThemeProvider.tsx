import { useRouter } from '@tanstack/react-router'
import { createContext, type PropsWithChildren, use, useEffect } from 'react'
import type { Theme } from '~/lib/theme'
import { setThemeServerFn } from '~/lib/themeFns'

type ThemeContextValue = { theme: Theme; setTheme: (theme: Theme) => void }

const ThemeContext = createContext<ThemeContextValue | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

// Resolve a preference to the concrete `.dark` class on <html>. `system` is the
// one case the server can't decide, so it's resolved here against the OS setting.
function applyTheme(theme: Theme): void {
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia(DARK_QUERY).matches)
  document.documentElement.classList.toggle('dark', isDark)
}

export function ThemeProvider({ theme, children }: PropsWithChildren<{ theme: Theme }>) {
  const router = useRouter()

  function setTheme(next: Theme) {
    // Apply immediately so the toggle feels instant, then persist the cookie and
    // re-run the root loader so the next SSR render agrees with the client.
    applyTheme(next)
    setThemeServerFn({ data: next }).then(() => router.invalidate())
  }

  // Keep `system` in sync if the OS appearance changes while the page is open.
  useEffect(() => {
    if (theme !== 'system') return
    const media = window.matchMedia(DARK_QUERY)
    const onChange = () => applyTheme('system')
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext)
  if (!value) throw new Error('useTheme must be used within a ThemeProvider')
  return value
}
