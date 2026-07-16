# Videbacken

An internal-web-app **starter template** — a TanStack Start stack with auth, database,
data layer, effects, i18n, a design system, and tests already wired. Fork it and build on top.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start/latest) (RC) on Vite + Nitro — file-based router in `src/routes/`
- **UI:** [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) (Radix primitives)
- **Auth:** [Better Auth](https://www.better-auth.com) — Google OAuth + email magic-link, gated by an admin-managed email allowlist
- **Database:** [Neon Postgres](https://neon.tech) (prod) / plain Postgres (local + CI) + [Drizzle ORM](https://orm.drizzle.team)
- **File storage:** [Vercel Blob](https://vercel.com/docs/vercel-blob) (prod) / S3-compatible RustFS (local)
- **Email:** [Resend](https://resend.com) (prod) / Mailpit (local)
- **i18n:** [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) — Swedish (default) + English
- **Hosting:** [Vercel](https://vercel.com)
- **Package manager:** [bun](https://bun.sh)

## Develop

```bash
bun install
cp .env.example .env
# Generate a secret:  openssl rand -base64 32  → BETTER_AUTH_SECRET
# Set INITIAL_ADMIN_EMAILS to your address so you become the first admin.

bun run dev:up       # start the docker stack (Postgres :14620, redis, mailpit, storage) + migrate
bun run dev          # http://localhost:14600

bun run db:studio    # browse the DB at https://local.drizzle.studio
bun run dev:down     # stop the docker stack
```

`bun run build` produces the Nitro output in `.output/`. `bun run test` runs the Vitest
node + Chromium browser suites. `bun run check` runs Biome (format + lint + organize-imports).

**Ports** are offset **+100** from the usual dev range so this template can run alongside a
sibling project: dev `14600`, Postgres `14620`, redis `14621`, smtp `14622`, s3 `14623`
(email preview `14601`, mailpit UI `14602`, storage console `14603`, bull studio `14604`).

## Setup (production / real sign-in)

Local magic-link sign-in works out of the box against Mailpit (inbox at http://localhost:14602).
**Google sign-in and production** need real credentials:

1. **Google OAuth client** — in the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth 2.0 Client ID (Web application). Authorized redirect URIs:
   - dev: `http://localhost:14600/api/auth/callback/google`
   - prod: `https://<your-domain>/api/auth/callback/google`

   Put the client id/secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. **Database** — either create a [Neon](https://neon.tech) project (recommended for Vercel; connect it
   via the Vercel ↔ Neon Marketplace integration so `DATABASE_URL` is auto-provisioned), or keep the
   local Postgres container for development.
3. **Vercel project** — import the repo, set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `INITIAL_ADMIN_EMAILS` in the project env.
4. **First admin** — `INITIAL_ADMIN_EMAILS` (CSV) is seeded into the `approved_email` allowlist at
   server startup. That address can then sign in (Google or magic-link) and invite others from `/admin`.

> Google sign-in cannot be exercised end-to-end without a real OAuth client; everything else
> (build, types, tests, local magic-link) runs without external credentials.

## Documentation

See [CLAUDE.md](./CLAUDE.md) for the stack rationale, architectural decisions, and conventions,
and [`docs/adr/`](./docs/adr) for the architecture decision records (auth is ADR-0017).
