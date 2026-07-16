# Videbacken

A **starter template** for internal web apps: a batteries-included TanStack Start
stack with authentication, a database + data layer, effect adapters, i18n, a
design system, and tests already wired. Fork it and build your app's domain on top.

**Architecture lives in `docs/adr/`.** This file is a router: rules + commands + gotchas.
For *why* a pattern exists, follow the ADR link.

**Package manager is [bun](https://bun.sh).** All commands are `bun run <script>` / `bunx <cli>`.

---

## Stack

- **Framework:** TanStack Start (RC, locked) on Vite 8 + Nitro; file-based router in `src/routes/`.
- **UI:** Tailwind CSS v4 + shadcn/ui (`components.json`, style `radix-nova`, **Radix** primitives — not Base UI).
- **Auth:** Better Auth (self-hosted) — **Google OAuth + email magic-link**, both gated by an
  admin-managed email allowlist. See ADR-0017.
- **Database:** Neon Postgres (prod, via Vercel Marketplace) / plain `postgres:17-alpine` (local + CI) + Drizzle ORM; `postgres-js` driver; snake_case.
- **Data layer:** oRPC + TanStack Query; SSR via an in-process router client.
- **Effects:** email (Resend / Mailpit-SMTP / devLog), file storage (Vercel Blob / S3-RustFS / devLog),
  queue (Vercel Queue / BullMQ+Redis / devLog), realtime (SSE), presence — all in `src/lib/effects/`.
- **i18n:** Paraglide JS — Swedish (source of truth + default) + English; `videbacken-locale` cookie, no URL prefix.
- **Testing:** Vitest — a `node` project (per-test Postgres schema) + a `browser` project (Chromium via Playwright).
- **Tooling:** Biome (format/lint/organize-imports); docker compose dev stack; GitHub Actions CI.
- **Hosting:** Vercel; Stockholm region (`arn1`).

---

## Code map

```
messages/                       i18n source: sv.json (source of truth) + en.json; flat keys
project.inlang/                 Paraglide/inlang config (baseLocale sv)
src/
  router.tsx / routeTree.gen.ts createRouter (+ codegen — DO NOT hand-edit)
  server.ts                     custom entry; wraps each request in the Paraglide locale scope
  routes/
    __root.tsx                  root layout; session guard (public: /, /login, /api/auth/*)
    login.tsx                   Google button + magic-link form
    onboarding.tsx              full-screen 2-step wizard (name → avatar); guard while onboardedAt null
    signed-in.tsx               magic-link "continue here" confirmation
    api/{auth/$.ts, rpc/$.ts, log.ts}   Better Auth / oRPC catch-alls; browser log sink
    _authenticated.tsx          pathless guard → /login (also bounces soft-deleted users)
    _authenticated/             index (dashboard), users, account/{index,profile}, admin
  lib/
    auth.ts                     betterAuth(): drizzleAdapter + google + magicLink + admin; allowlist gate
    authClient.ts               createAuthClient() (signIn.social + signIn.magicLink)
    getSession.ts               server fn wrapping auth.api.getSession()
    seedApprovedEmails.ts       seeds INITIAL_ADMIN_EMAILS → approved_email (invoked by server/plugins/seedApprovedEmails.ts, a Nitro plugin registered in vite.config.ts)
    orpc/                       context (public/protected/admin procedures), router, client, procedures/
    db/                         drizzle(postgres(DATABASE_URL)); schema/{betterAuth,file,approvedEmail}.ts + index barrel
    services/                   approvedEmail, user, file — own all DB access + domain rules (see ADR-0002)
    effects/                    email, storage, queue, realtime, presence (see ADR-0001)
    logger/                     pino on server, console+POST /api/log in browser (see ADR-0003)
    i18n/, zodLocale.ts, theme.ts, browserSession.ts, utils.ts
  components/  {AppSidebar, command/, form/, layout/, login/, onboarding/, user/, ui/}
  emails/                       React Email templates (MagicLink, InviteUser); preview `bun run email:dev`
  styles/                       Tailwind v4 entry (+ the --brand token)
test/, drizzle/, compose.yaml, vite.config.ts, drizzle.config.ts, biome.json
```

**Path aliases:** `~/*` → `./src/*`; `~test/*` → `./test/*` (`tsconfig.json`).

---

## How we write code (architecture rules — read the ADR before adjusting a pattern)

- **Services own DB access + domain rules.** All `db` access through `src/lib/services/<entity>/`.
  Invariants surface as `<Entity>DomainError` with an English `code` union. See **ADR-0002**.
- **Cross-system effects in `src/lib/effects/`.** Services never import Better Auth / Blob / Resend;
  effect adapters run *after* a successful service call. See **ADR-0001**.
- **Logging via `~/lib/logger/`.** `context.log` in oRPC; `logger` singleton elsewhere. Never `console.*`. See **ADR-0003**.
- **Realtime via `realtime.publish(...)`.** Procedures publish `<ns>.changed`; `useRealtimeSync()` invalidates queries. See **ADR-0004**.
- **Forms via `useAppForm`.** Never `useState` for field values; canonical example `src/components/login/LoginFormCard.tsx`. See **ADR-0005**.

### Recipes
- **Add a schema:** `src/lib/db/schema/<x>.ts` → re-export in `schema/index.ts` → `bun run db:generate --name=<desc> && bun run db:migrate`.
- **Add a service:** copy `services/user/` shape (`<x>.ts`, `<x>.test.ts` with `setupDatabase()` first, `index.ts`; `errors.ts` when an invariant lands).
- **Add an effect:** copy `effects/email/` shape (`<domain>.ts` selector + `adapters/<name>.ts` + barrel + test; register in `effects/index.ts`).
- **Add a procedure:** edit `src/lib/orpc/procedures/<x>.ts`; pick `protectedProcedure` (reads) or `adminProcedure` (mutations); `.input(zodSchema)`; thin glue → service → run effects after success; register in `orpc/router.ts`.
- **Add a UI component:** `bunx shadcn@latest add <name>` (Radix variant per `components.json` — never `shadcn init --base`).
- **Regenerate Better Auth schema:** `bun run auth:schema` (runs the CLI + `scripts/patchBetterAuthSchema.mjs` for `timestamptz`). Never hand-edit `betterAuth.ts`.

### ADR index
| Concern | ADR |
|---|---|
| Side effects (email, storage, queue) | 0001 |
| Services, domain rules, error mapping | 0002 |
| Logging | 0003 |
| Realtime sync | 0004 |
| Forms | 0005 |
| File storage (avatars + private store) | 0006 |
| Background jobs / queue | 0007 |
| Email templates | 0008 |
| Presence (online status) | 0011 |
| Form presentation (dialogs vs pages) | 0013 |
| Command palette | 0014 |
| Visual identity / design language | 0015 |
| Empty states & feedback | 0016 |
| **Authentication** (Google + magic-link, allowlist, admin-only mutation, onboarding) | **0017** |

---

## Authentication & authorization (ADR-0017)

- **Two sign-in methods, both gated by the `approved_email` allowlist:** Google OAuth and email
  magic-link. Only approved emails can create an account / sign in. No pre-created user rows —
  the row is created on first sign-in; role comes from the `approved_email` row.
- **Seed:** `INITIAL_ADMIN_EMAILS` (CSV) → seeded as admin allowlist rows at startup by
  `src/lib/seedApprovedEmails.ts`, invoked from **`server/plugins/seedApprovedEmails.ts`**, the Nitro
  plugin **registered in `vite.config.ts`**.
- **Two roles:** `user`, `admin`.
- **Authorization — admins mutate, users are read-only:** reads use `protectedProcedure`; every
  mutation uses `adminProcedure`; the **sole exception** is a user managing their **own account**
  (`updateProfile`, `completeOnboarding`, own avatar) scoped to `context.user.id`.
- Admins manage access at `/admin` (invite = add an allowlist row + courtesy email to `/login`;
  revoke = remove approval + soft-delete + revoke sessions; re-invite restores a revoked user).

---

## Scripts

Local dev runs a plain `postgres:17-alpine` container (no Neon Local). Sign in with an
`INITIAL_ADMIN_EMAILS` address to bootstrap the first admin.

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server on :14600 |
| `bun run build` | Vite build + `tsc --noEmit` |
| `bun run dev:up` / `dev:down` | Whole dev stack: db + queue + mail + storage (`up` also migrates) |
| `bun run db:{up,down,generate,migrate,studio}` | Postgres on :14620; generate/apply migrations; Drizzle Studio |
| `bun run auth:schema` | Regenerate `betterAuth.ts` + patch `timestamptz`. Idempotent |
| `bun run queue:{up,down,studio}` / `storage:{up,down}` / `mail:{up,down}` | Local broker / S3 (RustFS) / Mailpit |
| `bun run email:dev` | React Email preview on :14601 |
| `bun run i18n:compile` | Compile `messages/{sv,en}.json` → `src/paraglide/` |
| `bun run test` / `test:node` / `test:components` | Vitest (both / node-DB / browser) |
| `bun run check` / `check:ci` | Biome format+lint+organize-imports (write / dry-run) |

**Ports (146xx, offset +100 so it coexists with sibling projects):** dev 14600, email:dev 14601,
mailpit UI 14602, storage console 14603, bull studio 14604; postgres 14620, redis 14621, smtp 14622, s3 14623.

---

## Environment variables

`.env.example` lists everything. Key vars:
- `DATABASE_URL` (auto-provisioned by Neon Marketplace in prod; local `postgres://neon:npg@localhost:14620/neondb`).
- `BETTER_AUTH_SECRET` (32+ chars; `openssl rand -base64 32`), `BETTER_AUTH_URL`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google OAuth client).
- `INITIAL_ADMIN_EMAILS` (CSV; seeds the first admin(s) into `approved_email`).
- Storage `BLOB_*` (prod) / `S3_*` (local RustFS); email `RESEND_API_KEY`+`EMAIL_FROM` (prod) / `SMTP_*` (local Mailpit); `REDIS_URL` (local queue); `LOG_LEVEL`.

**`vercel env pull` hazard:** it writes prod `DATABASE_URL` into `.env.local`, which Vite + Drizzle
prefer over `.env`. If you run it, delete the `DATABASE_URL*` lines from `.env.local` immediately —
otherwise `bun run db:migrate` migrates **production**.

---

## Non-negotiables

- **Auth: Google + magic-link only, both allowlist-gated.** No passwords, no passkeys.
- **Admins mutate; users are read-only** except their own account. Every mutating procedure is `adminProcedure`.
- **Two roles:** `user`, `admin`.
- **All `db` access through services.** No `db.select()` in routes/handlers/auth hooks. See ADR-0002.
- **File blobs out-of-process.** User file bytes never traverse a Vercel Function; all file access goes through `src/lib/effects/storage/`. See ADR-0006.
- **oRPC procedures are thin glue.** Gate with `protectedProcedure`/`adminProcedure` (never inline). Better Auth's own `/api/auth/*` routes stay on the Better Auth handler.
- **All logging through `~/lib/logger/`.** Never `console.*`. See ADR-0003.
- **Never hand-edit `src/lib/db/schema/betterAuth.ts`** — regenerate via `bun run auth:schema`.
- **All timestamp columns use `timestamp({ withTimezone: true })`** (timestamptz). When drizzle-kit emits an `ALTER ... SET DATA TYPE timestamp with time zone` on existing data, hand-add `USING "<col>" AT TIME ZONE 'UTC'`.
- **`server/plugins/seedApprovedEmails.ts`** (which invokes the seeding logic in `src/lib/seedApprovedEmails.ts`) **must stay registered in `vite.config.ts`'s Nitro `plugins`** — Nitro does not auto-discover `server/plugins/*`; unregistered, the first admin never seeds.
- **User-facing text is Paraglide-localized** (`messages/{sv,en}.json`, sv source-of-truth + default, en key-complete). "Videbacken" stays untranslated. **Route URL paths stay English** (`/users`, `/account`).
- **File naming:** routes lowercase + TanStack tokens; React components PascalCase in `src/components/<entity>/`; hooks `useX`; `src/components/ui/` kebab-case (shadcn-managed); everything else camelCase.
- **Every screen is responsive** (desktop + mobile + tablet; no fixed pixel widths).
- **Conventional Commits** (`<type>(<scope>): <subject>` ≤72 chars, imperative). PRs are **squash-merged** — PR title = the conventional-commit subject (GitHub appends `(#NN)`), description = the body; one concern per PR. PR-title format enforced by `.github/workflows/lint-pr-title.yml`.
- **Lock TanStack Start to its pinned RC version** in `package.json` until 1.0.

---

## Decisions made — don't relitigate

- **Framework:** TanStack Start (RC, locked) on Vite. **Hosting:** Vercel, Stockholm (`arn1`).
- **Package manager:** bun.
- **DB:** Neon Postgres (prod) / plain Postgres (local+CI); `postgres-js` driver; Drizzle ORM. All timestamps `timestamptz`.
- **Data layer:** oRPC + TanStack Query; SSR via in-process router client. Domain rules in services (ADR-0002); effects isolated (ADR-0001).
- **Auth:** Better Auth, **Google OAuth + email magic-link, both gated by the `approved_email` allowlist**; two roles; **admins mutate, users read-only except own account**; first admin seeded from `INITIAL_ADMIN_EMAILS`. No passwords/passkeys. See ADR-0017.
- **Ports:** offset **+100** (14600/14620…) so this template coexists with sibling projects on one machine.
- **Logging:** pino → stdout (Vercel Runtime Logs); browser warn/error POSTs `/api/log` (ADR-0003).
- **Realtime:** SSE + in-process pub/sub, single-instance (ADR-0004). **Presence:** in-process refcount on the SSE lifecycle (ADR-0011).
- **Forms:** `@tanstack/react-form` v1 `createFormHook` + bound shadcn `<Field>` (ADR-0005). **Form presentation:** responsive overlay (URL dialog state) for small CRUD; dedicated route for large forms (ADR-0013).
- **File storage:** Vercel Blob (prod) / RustFS S3 (dev) / devLog (test); public store (avatars) + private store; client-direct upload (ADR-0006). **Queue:** Vercel Queue (prod) / BullMQ+Redis (dev) / devLog (test) (ADR-0007). **Email:** Resend (prod) / Mailpit (dev) / devLog (test); React Email templates (ADR-0008).
- **UI:** shadcn/ui (style `radix-nova`, base `slate`) + Tailwind v4 — **Radix primitives, not Base UI**. **Design language:** self-hosted Cabinet Grotesk (headings) + Switzer (body); inset-sidebar shell + shared `PageContainer`; one `--brand` accent (muted indigo placeholder); reduced-motion-aware overlay motion (ADR-0015). **Empty states:** shared `Empty` component (ADR-0016). **Command palette:** global Cmd+K on cmdk (ADR-0014).
- **Dark mode:** cookie-based (`videbacken-theme`), applied to `<html>` during SSR; own `ThemeProvider` (no next-themes); manual + system; no FOUC.
- **i18n:** Paraglide JS, sv default + en, `videbacken-locale` cookie, no URL prefix; per-request server locale via ALS in `src/server.ts`.
- **Linter/formatter:** Biome; Tailwind class sort on; `check:ci` is a required CI gate.
- **Component tests** run in Vitest Browser Mode (real Chromium via Playwright), separate `vitest.browser.config.ts`; `*.browser.test.tsx`, cache-seed a fresh `QueryClient` via `renderWithProviders`.
- **Squash-merge only;** `main` PR-gated with `Check (Biome)`, `Build`, `Test`, and the PR-title check required.

---

## Agent skill loading (@tanstack/intent)

The block below is auto-managed by `bunx @tanstack/intent@latest install`. **Do not hand-edit between the markers.**

<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
