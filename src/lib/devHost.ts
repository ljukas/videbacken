// Dev-only LAN hosting. `pnpm dev --host` (scripts/dev.ts) auto-detects the
// machine's LAN IP and injects it as the `DEV_HOST` env var so a phone on the
// same Wi-Fi can reach auth + storage at that IP instead of `localhost`.
//
// DEV_HOST is set ONLY by that launcher and appears in NO `.env` file, so the
// dev server's env loader has nothing to override it with (side-stepping the
// `.env.local`-precedence trap). It is unset for plain `pnpm dev` and always
// unset in production (there is no launcher) → every getter returns null/[] and
// callers fall back to their normal localhost / BETTER_AUTH_URL / S3_ENDPOINT
// configuration. Read fresh from `process.env` each call so it stays testable.

const APP_PORT = 14500
const STORAGE_PORT = 14523

const host = (): string | null => process.env.DEV_HOST || null

/** Better Auth base URL when hosting on the LAN, else null. */
export const devBaseUrl = (): string | null => {
  const h = host()
  return h ? `http://${h}:${APP_PORT}` : null
}

/**
 * Origins to trust when hosting on the LAN: the LAN IP (the phone) AND localhost
 * (the dev machine's own browser), so the app works from either at the same time.
 * Empty when not LAN-hosting.
 */
export const devTrustedOrigins = (): string[] => {
  const h = host()
  return h
    ? [`http://localhost:${APP_PORT}`, `http://127.0.0.1:${APP_PORT}`, `http://${h}:${APP_PORT}`]
    : []
}

/** S3-compatible storage endpoint reachable from the phone, else null. */
export const devS3Endpoint = (): string | null => {
  const h = host()
  return h ? `http://${h}:${STORAGE_PORT}` : null
}
