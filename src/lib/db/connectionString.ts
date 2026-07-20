// Resolves the Postgres connection string, bridging the env var names that the
// Supabase↔Vercel Marketplace integration provisions (`POSTGRES_URL` /
// `POSTGRES_URL_NON_POOLING`) to the app's canonical names (`DATABASE_URL` /
// `DATABASE_URL_UNPOOLED`).
//
// We read the `POSTGRES_*` names directly rather than copying their values into
// `DATABASE_URL` on Vercel, so the app keeps working when the integration
// rotates the database password (Vercel env vars can't reference one another,
// so a hand-copied `DATABASE_URL` would silently go stale on rotation).
//
// Precedence puts the app's own names first: if someone sets an explicit
// `DATABASE_URL` (local dev, CI, an override) it always wins over the
// integration-provided value.

/** Pooled connection (Supabase transaction pooler, :6543) — used by the app runtime. */
export function resolvePooledUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalize(env.DATABASE_URL ?? env.POSTGRES_URL)
}

/**
 * Unpooled connection (Supabase direct / session pooler, :5432) — used by
 * drizzle-kit for migrations, where a transaction-pooled connection can't run
 * DDL reliably. Falls back to the pooled URL as a last resort.
 */
export function resolveUnpooledUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalize(
    env.DATABASE_URL_UNPOOLED ??
      env.POSTGRES_URL_NON_POOLING ??
      env.DATABASE_URL ??
      env.POSTGRES_URL,
  )
}

// Supabase's Vercel integration appends `?workaround=supabase-pooler.vercel` to
// the pooled URL. It's a Vercel-only marker, not a Postgres parameter — but
// postgres-js forwards unrecognised query params to the server as startup
// options, which Postgres then rejects. Strip it (and only it). Splitting on the
// first `?` leaves the authority section — including any special characters in
// the password — untouched, since a literal `?` there would be percent-encoded.
function normalize(url: string | undefined): string | undefined {
  if (!url) return url
  const [base, query] = url.split(/\?(.*)/s)
  if (!query) return url
  const kept = query.split('&').filter((param) => !param.startsWith('workaround='))
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base
}
