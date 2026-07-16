import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

// Per-browser memo of what we remember about this visitor — the email of the
// last user who signed in, so the login screen can show a "Welcome back" card.
// The avatar is resolved live from this email by the getBrowserSession server
// fn so it never goes stale. Not the auth session (that's Better Auth's own
// cookies); kept distinct to avoid confusion.
export const BROWSER_SESSION_COOKIE = 'oceanview-browser-session'

const COOKIE_OPTIONS = {
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  // Only server functions read this cookie — keep it out of document.cookie.
  httpOnly: true,
} as const

export const browserSessionSchema = z.object({
  email: z.email(),
})

export type BrowserSession = z.infer<typeof browserSessionSchema>

export function readBrowserSession(): BrowserSession | null {
  const value = getCookie(BROWSER_SESSION_COOKIE)
  if (!value) return null
  try {
    const parsed = browserSessionSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeBrowserSession(session: BrowserSession): void {
  setCookie(BROWSER_SESSION_COOKIE, JSON.stringify(session), COOKIE_OPTIONS)
}

export function clearBrowserSession(): void {
  deleteCookie(BROWSER_SESSION_COOKIE, { path: '/', sameSite: 'lax' })
}

// Single write point: refreshes the cookie when the remembered visitor changed.
// Called from the session.create auth hook (the moment of sign-in — the SPA
// never does a server-rendered authenticated load right after authenticating)
// and from the _authenticated beforeLoad on full-page loads.
export async function rememberUser(_userId: string, email: string): Promise<void> {
  const current = readBrowserSession()
  if (current?.email !== email) {
    writeBrowserSession({ email })
  }
}
