import { getCookie, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

// Per-browser theme preference. Read during SSR so the chosen theme is applied
// to <html> before paint (no flash). Kept in its own cookie — independent of the
// browser-session "welcome back" memo, which gets cleared on email switch and
// must never reset the theme. See src/lib/browserSession.ts for the sibling pattern.
export const THEME_COOKIE = 'oceanview-theme'

const COOKIE_OPTIONS = {
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  httpOnly: false,
} as const

export const themeSchema = z.enum(['light', 'dark', 'system'])

export type Theme = z.infer<typeof themeSchema>

export function readTheme(): Theme {
  const parsed = themeSchema.safeParse(getCookie(THEME_COOKIE))
  return parsed.success ? parsed.data : 'system'
}

export function writeTheme(theme: Theme): void {
  setCookie(THEME_COOKIE, theme, COOKIE_OPTIONS)
}
