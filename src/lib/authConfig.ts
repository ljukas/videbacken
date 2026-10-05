// Better Auth's session cookie cache lifetime (auth.ts `session.cookieCache`).
// The client guard caches the session for exactly as long (ADR-0024 §2): the
// server-side getSession() could already answer from a cookie this old, so the
// guard is no staler than before. Client-safe: no auth/db imports.
export const SESSION_COOKIE_CACHE_MAX_AGE_S = 5 * 60
