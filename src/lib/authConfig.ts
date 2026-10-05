// Better Auth's session cookie cache lifetime (auth.ts `session.cookieCache`).
// The client guard caches the session for as long again (ADR-0025 §2). The
// server's getSession() can itself answer from a cookie snapshot up to this
// old, so the guard can hold a session for up to about twice this; returning
// to the tab re-checks it. Client-safe: no auth/db imports.
export const SESSION_COOKIE_CACHE_MAX_AGE_S = 5 * 60
