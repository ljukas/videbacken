# Videbacken

Internal web app for a sailboat co-ownership group (10–20 users: owners + a couple of admins). Not a commercial product — it coordinates one boat among its owners.

**State**: scaffold + auth + DB + services + file storage + email all wired. Resend is live in prod (sender domain `mail.lukaslindqvist.se`, verified 2026-06-11; see ADR-0008).

**Architecture lives in `docs/adr/`** (ADRs 0001–0020). This file is a router: rules + commands + gotchas. For *why* a pattern exists, follow the ADR link.

**How we work lives in `docs/*-workflow.md`** — [feature-workflow.md](docs/feature-workflow.md) (new features) and [refactor-workflow.md](docs/refactor-workflow.md) (behavior-preserving change): the phase-by-phase process from spark to merge, and which skills/agents to reach for at each phase.

---

## Skill loading — when to load which

Load on demand, not eagerly. The `pnpm dlx @tanstack/intent` block at the bottom is auto-managed; everything below is hand-curated.

| Task | Skill / Doc |
|---|---|
| Routes, `beforeLoad`, loaders, search/path params, navigation, errors | `@tanstack/router-core#*` (see intent list) |
| Server functions, SSR hydration | `@tanstack/react-start#react-start`, `#server-components` |
| DB schema, migration, SQL | project-local `neon-postgres` (`.claude/skills/neon-postgres/`) for Neon-specific work; `supabase-postgres-best-practices` for general Postgres design / query / index best practices |
| Build/deploy, Nitro tuning | `nitro#nitro`, `vercel:deployments-cicd`, `vercel:vercel-cli` |
| Vercel env management | `vercel:env`, `vercel:env-vars` |
| Vercel function runtime/timeout/region | `vercel:vercel-functions` |
| shadcn/ui components + theming | `vercel:shadcn` + project-local `shadcn` (`.claude/skills/shadcn/`) |
| Forms (composition, bound fields, validation) | `docs/adr/0005-form-architecture.md` |
| Form presentation: dialog vs page, responsive overlays, URL dialog state | `docs/adr/0013-form-presentation-and-dialog-architecture.md` |
| Visual identity: app-shell layout, typography, brand accent, overlay motion | `docs/adr/0015-visual-identity-and-design-language.md` |
| Command palette (global Cmd+K: navigate + actions + search) | `docs/adr/0014-command-palette-architecture.md` |
| Empty states & list zero-state CTAs | `docs/adr/0016-empty-state-and-feedback-conventions.md` |
| Services, domain rules, error mapping | `docs/adr/0002-service-domain-architecture.md` |
| Side effects (email, storage, audit) | `docs/adr/0001-side-effects-architecture.md` |
| Email templates | `docs/adr/0008-email-architecture.md` + https://react.email/docs |
| Background jobs, queue topics | `docs/adr/0007-background-job-queue-architecture.md` |
| Realtime sync (publish events, SSE) | `docs/adr/0004-realtime-sync-architecture.md` |
| Presence (online status) | `docs/adr/0011-presence-online-status-architecture.md` |
| Documents (folders, search, bin, thumbnails) | `docs/adr/0010-document-management.md` |
| Recommended places (map, orbs, EXIF location, tags) | `docs/adr/0012-recommended-places.md` |
| Logging | `docs/adr/0003-logging-architecture.md` |
| File storage (avatars, documents) | `docs/adr/0006-file-storage.md` |
| Organization rules (social invariants the schema can't express) | `docs/adr/0009-organization-rules.md` |
| Shares & ownership (indivisible shares, assignment history) | `docs/adr/0018-indivisible-shares.md` |
| Seasons & Disponeringslista (era table, computed schedules) | `docs/adr/0019-season-eras.md` |
| Season booking, trade wishes, locking | `docs/adr/0020-season-booking-and-trades.md` |
| User invitations + invitee onboarding wizard (invite/accept, resend, expiry countdown, 3-step `/onboarding`) | `docs/adr/0017-user-invitation-flow.md` |
| Reviewing React components | `vercel:react-best-practices` |
| React component tests (browser-mode, render helpers, cache-seeding) | `test/browser/README.md` |
| End-to-end verification | `vercel:verification` |
| oRPC: core / Better Auth / TanStack Query / SSR | https://orpc.dev/docs (+ `/integrations/*`, `/best-practices/optimize-ssr`) |
| Biome | `biome.json` + https://biomejs.dev/reference/configuration/ |

**Discovery**: `pnpm dlx @tanstack/intent@latest list` → all intent skills; `… load <pkg>#<skill>` to fetch one.

**Do NOT load** (wrong stack): `vercel:auth` (we use Better Auth), `vercel:nextjs`, `vercel:next-cache-components`, `vercel:turbopack` (we use TanStack Start on Vite).

---

## Code map

```
messages/                       i18n source: sv.json (source of truth) + en.json; flat keys
project.inlang/                 Paraglide/inlang project config (baseLocale sv)
src/
  router.tsx                    createRouter + devtools + error/notFound bindings
  routeTree.gen.ts              codegen — DO NOT hand-edit
  server.ts                     custom server entry; wraps every request in the
                                Paraglide ALS locale scope (getLocale() per request)
  paraglide/                    compiled messages — generated, gitignored; DO NOT hand-edit
  routes/
    __root.tsx                  root layout; session guard (public: /, /api/auth/*)
    login.tsx                   magic-link + passkey sign-in
    onboarding.tsx              full-screen 3-step invitee wizard (ADR-0017); guard → /onboarding while onboardedAt null
    api/auth/$.ts               Better Auth catch-all
    api/rpc/$.ts                oRPC catch-all
    api/files/download.$id.ts   auth-gated 302 → signed storage URL
    _authenticated.tsx          pathless guard → /login
    _authenticated/             index, owners, documents.{index,$}, account, admin/{shares,documents.bin}
  lib/
    auth.ts                     betterAuth(): drizzleAdapter + passkey + magicLink + admin
    authClient.ts               createAuthClient() for the browser
    getSession.ts               server fn wrapping auth.api.getSession()
    adminAllowlist.ts           isAllowlistedAdmin() reading ADMIN_EMAILS
    zodLocale.ts                locale-delegating Zod error map (sv/en via getLocale())
    i18n/format.ts              formatDate()/getDateFnsLocale() — per-call locale resolution
    passkeyProviders.ts         AAGUID → provider lookup
    utils.ts                    cn() + tiny helpers
    orpc/
      context.ts                base / public / protected / admin procedures
      router.ts                 appRouter; SERVER-ONLY
      client.ts                 isomorphic client + TanStack Query utils
      procedures/               health, user, image, share, season, booking, document,
                                documentBin, documentSearch, folder, presence, realtime
    db/
      index.ts                  drizzle(postgres(DATABASE_URL)), snake_case
      schema/
        betterAuth.ts           CLI-regenerated; DO NOT hand-edit
        index.ts                barrel
    services/                   per-entity folders (user, season, share, booking, file,
                                document, folder, documentSearch, documentEvent)
                                each: <entity>.ts, errors.ts (when invariants), .test.ts, index.ts barrel
                                see ADR-0002
    effects/                    cross-system adapters; see ADR-0001
      email/                    adapters: smtp (dev), resend (prod), devLog (test); see ADR-0008
      storage/                  adapters: vercelBlob (prod), s3 (dev RustFS), devLog;
                                clientUpload.ts dispatches on upload.kind; see ADR-0006
      index.ts                  barrel
    logger/                     pino on server, console+POST /api/log in browser
                                use context.log in oRPC; logger singleton elsewhere
                                see ADR-0003
  hooks/                        useMobile, usePasskeys, useSavedLogin, form
  components/
    {DefaultCatchBoundary,NotFound,AppSidebar,ModeToggle,ThemeProvider}.tsx
    user/  passkey/  document/  contact/  share/  season/  booking/  form/  onboarding/  ui/
  emails/                       React Email templates (MagicLink, InviteUser); preview with `pnpm email:dev`
  data/passkeyAaguids.json      static AAGUID registry
  utils/seo.ts                  meta-tag helper
  styles/                       Tailwind v4 entry
test/
  setup.ts                      schema-per-test (CREATE/migrate/DROP) + inline fixtures; localhost guard
  browser/                      component-test harness (Vitest Browser Mode)
    setup.ts                    registers vitest-browser-react
    render.tsx                  makeTestQueryClient() + renderWithProviders() (cache-seeding)
    README.md                   how to write a component test (*.browser.test.tsx)
drizzle/                        generated SQL migrations
drizzle.config.ts               Neon Local SSL workaround
compose.yaml                    db, queue, mail, storage services
vite.config.ts                  TanStack Start + Nitro; vitest config
```

**Path alias**: `~/*` → `./src/*` (`tsconfig.json`).

---

## How we write code

Five architectural rules (full rationale in each ADR — read it before adjusting the pattern):

- **Services own DB access and domain rules.** All `db` access through `src/lib/services/<entity>/`. Invariants live in guarded ops (`updateAsAdmin`, …) and surface as `<Entity>DomainError` with discriminating English `code` union. Procedures map to Swedish `ORPCError`. See **ADR-0002**.
- **Cross-system effects in `src/lib/effects/`.** Services never import Better Auth / Vercel Blob / Resend. Effect adapters run *after* a successful service call. See **ADR-0001**.
- **Logging via `~/lib/logger/`.** `context.log` in oRPC procedures; `logger` singleton elsewhere. Never `console.*`. See **ADR-0003**.
- **Realtime sync via `realtime.publish(...)`.** Procedures publish `<namespace>.changed`; one `useRealtimeSync()` per tab invalidates `orpc.<namespace>` queries. See **ADR-0004**.
- **Forms via `useAppForm`.** Never `useState` for field values. Field errors via bound `<FieldError>`; async errors via `toast.error()`. Canonical example: `src/components/login/LoginFormCard.tsx`. See **ADR-0005**.

### Workflow recipes

> For the *process* around these recipes — how to approach a whole feature or refactor, and which skills/agents to use at each phase — see [feature-workflow.md](docs/feature-workflow.md) and [refactor-workflow.md](docs/refactor-workflow.md). The recipes below are the mechanical steps; the workflow docs are the arc they sit in.

**Adding a feature schema**: create `src/lib/db/schema/<feature>.ts` → add re-export to `schema/index.ts` → `pnpm db:generate --name=<descriptive_name> && pnpm db:migrate`. Test setup runs all migrations per-test, so nothing in `test/setup.ts` needs touching.

**Name migrations descriptively.** Always pass `--name=` to `pnpm db:generate` — without it drizzle-kit emits `0003_small_jetstream.sql`. For data-only migrations: `pnpm drizzle-kit generate --custom --name=<name>`. To rename pre-prod: update both the filename and `tag` in `drizzle/meta/_journal.json` together.

**Adding a service**: copy `services/user/` shape — `<entity>.ts`, `<entity>.test.ts` (`setupDatabase()` first), `index.ts` barrel. Add `errors.ts` only when an invariant lands. See ADR-0002.

**Adding an effect**: copy `effects/email/` shape — `<domain>.ts` (interface + adapter selector), `adapters/<name>.ts` (one per implementation), `index.ts` barrel, `<domain>.test.ts`. Register in `effects/index.ts`. See ADR-0001.

**Adding an oRPC procedure**: edit `src/lib/orpc/procedures/<entity>.ts`. Pick `publicProcedure` / `protectedProcedure` / `adminProcedure` (never inline auth). `.input(zodSchema)`. **Handlers are thin glue**: parse → service → catch `<Entity>DomainError` → rethrow as Swedish `ORPCError` → run side effects after success. Export and register in `orpc/router.ts`.

**Loaders + mutations**: `loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(orpc.x.y.queryOptions())`, read with `useSuspenseQuery`. Mutations via `orpc.x.create.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.x.list.queryKey() }) })`. Use `.key()` for bulk invalidation. Narrow errors with `isDefinedError(err)`.

**Mutation callback placement & optimistic close**: callbacks in `mutationOptions`/`useMutation` fire **even if the component unmounts mid-flight**; callbacks passed to `mutate(vars, {…})` are **dropped on unmount** (docs: https://tanstack.com/query/latest/docs/framework/react/guides/mutations#consecutive-mutations; TkDodo "Mastering Mutations" → https://tkdodo.eu/blog/mastering-mutations-in-react-query, section on callbacks/unmount). So keep invalidation, optimistic rollback, and any toast that must survive a dialog close in `mutationOptions` — not in the `mutate` call. This enables **optimistic instant-close**: in the form's `onSubmit`, fire `renameMutation.mutate(...)` then `onOpenChange(false)`; keep `onMutate`/`onError`/`onSettled` in `mutationOptions`; drop the success toast (the optimistic change is the confirmation) and toast only on error. Use it when a mutation has **no user-fixable failure** (canonical: `RenameDocumentDialog`); keep the pessimistic close (wait for success) when it does, e.g. `RenameFolderDialog`'s inline `NAME_TAKEN_IN_PARENT`. Don't drop to an imperative `client.*`/`safe()` flow just to "survive unmount" — `mutationOptions` already do; reserve imperative `client.*` for `Promise.allSettled` fan-out with one aggregate toast (`DeleteDocumentsDialog`, `MoveDialog` bulk).

**Regenerating Better Auth schema**: `pnpm auth:schema`. Idempotent; runs the CLI then `scripts/patchBetterAuthSchema.mjs` to add `{ withTimezone: true }` to every `timestamp(...)` (CLI doesn't support `timestamptz`). Never hand-edit `betterAuth.ts`.

**Adding a guarded route**: file under `src/routes/_authenticated/`. Login route stays at `src/routes/login.tsx` (public).

**Component placement**: feature components in `src/components/<entity>/<Component>.tsx` (entity-singular: `user/`, `passkey/`). Top-level `src/components/*.tsx` reserved for app-wide chrome. Skip TanStack's `-components/` convention.

**Adding a UI component**: `pnpm dlx shadcn@latest add <name>` (writes into `src/components/ui/`). **We use Radix primitives, not Base UI.** shadcn 4.13+ defaults *new* projects to Base UI, but `add` follows the existing `components.json` (`"style": "radix-nova"`) and pulls the matching (Radix) variant — so keep that file as-is, never re-run `shadcn init`/`create` in a way that flips primitives (`shadcn init --base` selects them), and after adding, verify the component imports from `radix-ui`/`@radix-ui/*`, never `@base-ui-components/*`. Follow `.claude/skills/shadcn/SKILL.md` — semantic colors only, `gap-*` not `space-y-*`, `size-*` for equal dimensions.

**Input validation**: Zod v4 at the boundary (`.input(...)`, server function args, route loaders). Localized error messages come from the locale-delegating error map in `src/lib/zodLocale.ts` (resolves `getLocale()` per parse). Per-field overrides must be lazy message callbacks — `{ error: () => m.validation_email_invalid() }`, never a string literal.

**i18n (Paraglide)**: user-facing strings live in `messages/{sv,en}.json` (sv is source of truth; en must stay key-complete). Components call `m.<key>()` from `~/paraglide/messages`; never hardcode UI strings. Module-level constants store the message *function* (`label: m.nav_owners`) and call it at render — module scope outlives the request's locale. Locale = `videbacken-locale` cookie only (no URL prefix); switching reloads the page. Server code inside a request gets the right locale via ALS (`src/server.ts`); emails take an explicit `locale` prop instead. After editing `messages/*.json` outside `pnpm dev`: `pnpm i18n:compile`.

---

## Scripts

> **Local DB: Neon Local is PAUSED.** Local dev + tests run a plain `postgres:17-alpine` container on `:14520` (same `neon`/`npg`/`neondb` creds, no SSL) instead of Neon Local — Neon Local created one ~32 MB cloud branch per git branch and was filling the free tier. The dev DB no longer branches prod, so it starts **empty** (sign in with an `ADMIN_EMAILS` address to bootstrap an admin). CI and prod are unchanged. Re-enable per the comment on the `db` service in `compose.yaml`.

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server on :14500 |
| `pnpm dev:log` | `dev` with stdout+stderr teed to `/tmp/videbacken-dev.log` |
| `pnpm build` | Vite build + `tsc --noEmit` |
| `pnpm vercel-build` | Migrate then build (CI/deploy only) |
| `pnpm preview` / `pnpm start` | Preview built bundle / run prod server |
| `pnpm dev:up` / `dev:down` | Whole dev stack: db + queue + mail + storage; `up` also runs migrations |
| `pnpm db:{up,down,generate,migrate,studio}` | Neon Local on :14520; generate / apply migrations; Drizzle Studio |
| `pnpm auth:schema` | Regenerate `betterAuth.ts` + patch `timestamptz`. Idempotent |
| `pnpm neon:prune` | **PAUSED** while Neon Local is paused (see the callout above): the `.neon_local/.branches` mappings it prunes are no longer produced, so it no-ops with a message. Was: delete Neon Local's cloud branches for merged/deleted git branches (free-tier storage hygiene), dev stack down |
| `pnpm queue:{up,down,studio}` | Redis broker :14521; Bull Studio :14504 (needs `queue:up`) |
| `pnpm storage:{up,down}` | RustFS S3 on :14523 + console :14503 + bucket bootstrap |
| `pnpm storage:sync` | Mirror prod Vercel Blob bytes into local RustFS for prod rows surfaced via the Neon branch (idempotent; auto-run by `dev:up`). Skips without `S3_ENDPOINT` + `BLOB_*` read tokens. See ADR-0006 |
| `pnpm mail:{up,down}` | Mailpit SMTP :14522 + UI :14502 |
| `pnpm email:dev` | React Email preview server on :14501 |
| `pnpm i18n:compile` | Compile `messages/{sv,en}.json` → `src/paraglide/` (auto via `prepare`/`pretest`/vite) |
| `pnpm dev:worker` | Local BullMQ worker (consumes `blurhash` + `image_thumbnail` + `email_user_invited` + `heic_transcode` topics) |
| `pnpm test` / `test:watch` | Vitest, **both projects**: `node` (per-test schema CREATE/migrate/DROP) + `browser` (Chromium component tests) |
| `pnpm test:components` | Watch only the `browser` project (Vitest Browser Mode + Chromium); the component-TDD loop. See `test/browser/README.md` |
| `pnpm test:node` | Run only the `node`/DB project (services, effects, logic, email-string tests) |
| `pnpm check` | Biome format + lint + organize imports (writes). Daily driver |
| `pnpm check:unsafe` / `check:ci` | Unsafe fixes (Tailwind sort); dry-run for CI |
| `pnpm {format,lint,lint:fix}` | Biome subsets |

---

## Environment variables

`.env.example` lists everything. Categories:

- **Auto-provisioned by Vercel ↔ Neon Marketplace** (do not add manually): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_PROJECT_ID`, plus `POSTGRES_*` / `PG*` aliases.
- **Local-only for Neon Local** (`.env`, gitignored): `NEON_API_KEY`, `PARENT_BRANCH_ID`.
- **Set in Vercel + `.env`**: `BETTER_AUTH_SECRET` (32+ chars; `openssl rand -base64 32`), `BETTER_AUTH_URL`, `ADMIN_EMAILS` (CSV allowlist). `ADMIN_EMAILS` is consulted only at **self-signup** — Better Auth's `user.create.before` hook in `auth.ts` (when a row is created through the adapter). It does **not** apply to **invited** users: `inviteUser` inserts the row directly via the service, bypassing that hook, so every invitee is `role:'user'` regardless of the allowlist (admins promote afterward via the Edit dialog — see ADR-0017). Editing `ADMIN_EMAILS` later does **not** change existing users either way. To promote/demote an existing user, update their `role` via the admin UI at `/admin` (or the Better Auth admin API); to revoke access immediately, also revoke their sessions (role is cookie-cached up to 5 min, sessions live 30 days).
- **Vercel Blob (auto-provisioned via Marketplace)**: `BLOB_PUBLIC_READ_WRITE_TOKEN` (avatars), `BLOB_PRIVATE_READ_WRITE_TOKEN` (documents). Leave blank locally; use `S3_*` instead. Override: `STORAGE_ADAPTER=devLog` (tests).
- **Local S3** (backs `pnpm storage:up`): `S3_ENDPOINT` (default `http://localhost:14523`), `S3_REGION=eu-north-1`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (default `videbacken-dev`/`videbacken-dev-secret-key`), `S3_BUCKET_PUBLIC=videbacken-public`, `S3_BUCKET_PRIVATE=videbacken-private`. When `S3_ENDPOINT` is set, the storage adapter picks `s3` over `BLOB_*`. See ADR-0006.
- **Resend (live in prod)**: `RESEND_API_KEY`, `EMAIL_FROM` (`Videbacken <no-reply@mail.lukaslindqvist.se>`) set in Vercel production. Selected when both are set and `SMTP_HOST` is unset. See ADR-0008. **Also set both on the Vercel Preview env** if you want magic-link sign-in to work on PR previews — otherwise the adapter falls back to `devLog` and no email is sent. On previews sign-in is **magic-link only** (passkey `rpID`/`origin` derive from `BETTER_AUTH_URL`, so passkeys are prod-only); `auth.ts` uses `VERCEL_BRANCH_URL` as the preview base URL so links survive re-pushes.
- **Local SMTP (Mailpit)**: `SMTP_HOST=localhost`, `SMTP_PORT=14522`, `EMAIL_FROM`. When set, takes precedence over `RESEND_API_KEY` so `vercel env pull` accidents don't send real mail. Override: `EMAIL_ADAPTER=devLog`. See ADR-0008.
- **Optional**: `LOG_LEVEL` (pino; defaults: `debug` dev, `info` prod). `REDIS_URL` enables BullMQ locally.

`vercel env pull` hazard — see [Non-negotiables](#non-negotiables).

---

## Documentation index

WebFetch before guessing APIs.

- TanStack Start / Router / Form / Query — `tanstack.com/{start,router,form,query}/latest`
- Better Auth — `better-auth.com/docs` (+ `/plugins/{magic-link,admin,passkey}`, `/integrations/tanstack`, `/adapters/drizzle`)
- Drizzle / Drizzle Kit — `orm.drizzle.team/docs/overview`, `/kit-overview`
- postgres-js — `github.com/porsager/postgres`
- Neon / Neon Local — `neon.tech/docs`, `/local/neon-local`
- Vitest — `vitest.dev`
- Zod v4 — `zod.dev`
- Tailwind v4 — `tailwindcss.com/docs`
- shadcn/ui (+ theming + TanStack Form integration) — `ui.shadcn.com`
- oRPC — `orpc.dev/docs` (+ `/adapters/tanstack-start`, `/integrations/{better-auth,tanstack-query}`, `/best-practices/optimize-ssr`)
- Vite — `vite.dev`
- Vercel + TanStack Start — `vercel.com/docs/frameworks/tanstack-start`
- Vercel Blob — `vercel.com/docs/vercel-blob`
- Cloudflare R2 (documented fallback per ADR-0006) — `developers.cloudflare.com/r2`
- React Email + Resend + Nodemailer + Mailpit — `react.email/docs`, `resend.com/docs`, `nodemailer.com/about/`, `mailpit.axllent.org/docs/`

---

## Non-negotiables

- **Magic-link only.** No passwords without revisiting auth design.
- **Two roles**: `user` and `admin`. Don't introduce more without a real reason.
- **All `db` access through services.** No `db.select()` in routes/handlers/auth hooks. See ADR-0002.
- **oRPC procedures are thin glue.** Gate with `protectedProcedure`/`adminProcedure` (never inline). Better Auth's own routes (`/api/auth/*`) stay on the Better Auth handler.
- **All logging through `~/lib/logger/`.** Never `console.*` directly. See ADR-0003.
- **Never hand-edit `src/lib/db/schema/betterAuth.ts`** — re-run `pnpm auth:schema`.
- **All timestamp columns use `timestamp({ withTimezone: true })`.** Better Auth's schema is patched by `pnpm auth:schema`. When drizzle-kit emits `SET DATA TYPE timestamp with time zone`, hand-add `USING "<col>" AT TIME ZONE 'UTC'` to each ALTER before applying (existing values would otherwise be reinterpreted in the session TZ). Reference: `drizzle/0006_use_timestamptz.sql`.
- **File blobs out-of-process.** Browser → storage directly; user file bytes never traverse a Vercel Function (derived-asset workers — thumbnails, blurhash — are the sanctioned exception). `videbacken-public` (avatars) + `videbacken-private` (documents). All file code goes through `src/lib/effects/storage/`. See ADR-0006.
- **`vercel env pull` is dangerous**: writes prod `DATABASE_URL` into `.env.local`, which Vite + Drizzle prefer over `.env`. If you must run it, immediately delete the `DATABASE_URL*` lines from `.env.local` — otherwise `pnpm db:migrate` migrates **production**.
- **Migrations are explicit locally outside `pnpm dev:up`.** `dev:up` auto-runs `db:migrate`; `db:up`, `build`, ad-hoc flows do not. `vercel-build` migrates on deploy.
- **File naming.**
  - Routes (`src/routes/`) follow [TanStack file-naming](https://tanstack.com/router/latest/docs/routing/file-naming-conventions): lowercase + tokens (`__root`, `_authenticated`, `$id`, `index`). **URL paths are English** — name route files (and thus URL segments) in English even though the page renders Swedish: `/owners` not `/delagare`, `/account` not `/konto`. The Swedish label lives in the heading/nav, never the URL.
  - React components: **PascalCase** matching the export. Feature components in `src/components/<entity>/`; top-level reserved for app-wide chrome.
  - Hooks: **camelCase** with `use` prefix.
  - Everything else (lib / utils / data / config): **camelCase**.
  - `src/components/ui/` is **kebab-case**, CLI-managed by shadcn — don't normalize.
  - Directory roles: `lib/` = wired/stateful; `hooks/` = React hooks; `utils/` = pure helpers; `data/` = static.
- **Conventional Commits**: `<type>(<scope>): <subject>` ≤ 72 chars, imperative, *why* in body. Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `style`, `revert`.
- **PRs are squash-merged** — each PR collapses to a single commit on `main`, so write the PR *as* that commit:
  - **PR title = the squash commit subject** → must be a Conventional Commit (same `<type>(<scope>): <subject>` rule above, ≤ 72 chars, imperative). GitHub appends `(#NN)` on merge — don't type it yourself; never ship a branch name or a bare "Update …" as the title. Validated in CI by `.github/workflows/lint-pr-title.yml`.
  - **PR description = the commit body** → the *why*, plus ADR/issue links. This is what lands in `git log`; the branch's own commit messages are discarded on squash, so they can stay scrappy while the PR title + description must be clean.
  - **One concern per PR** — the whole PR becomes one commit, so keep it atomic; split unrelated changes into separate PRs.
- **Lock TanStack Start to a specific RC version** in `package.json` until 1.0.
- **Free tier first.** Confirm any third-party service covers ~20 users on a free tier.
- **Every screen must be responsive.** Desktop + mobile + tablet; use Tailwind responsive utilities + shadcn primitives; no fixed pixel widths.
- **User-facing text is localized via Paraglide** — never hardcoded. Strings live in `messages/{sv,en}.json`; Swedish (informal "du") is the source of truth and the default locale, English is the alternative. "Videbacken" stays untranslated. Code identifiers, comments, logs, commits, DB enum values, and **route URL paths** stay English (`/owners`, `/account` — not `/delagare`, `/konto`). `<html lang={getLocale()}>` in `__root.tsx`.

---

## Decisions made — don't relitigate

One line each. Reasoning in `git log CLAUDE.md` and in the linked ADR.

- **Framework**: TanStack Start (RC, locked) on Vite.
- **Hosting**: Vercel Hobby (non-commercial). Stockholm region (`arn1` / `eu-north-1`).
- **Auth**: Better Auth (self-hosted), magic-link only, two roles.
- **DB**: Neon Postgres + Neon Local; `postgres-js` driver (Better Auth needs multi-statement tx).
- **ORM**: Drizzle.
- **Data layer**: oRPC + TanStack Query; SSR via `createRouterClient` in-process. See ADR-0002.
- **Domain rules in services**; procedures map `<Entity>DomainError` → Swedish `ORPCError`. See ADR-0002.
- **Side effects in `src/lib/effects/`** with three-tier execution model. See ADR-0001.
- **Logging**: pino → stdout → Vercel Runtime Logs; browser warn/error POSTs `/api/log`. See ADR-0003.
- **Realtime sync**: SSE + in-process pub/sub; single-instance assumption. See ADR-0004.
- **Presence**: online status via an in-process refcounted `presence` effect on the SSE connection lifecycle; `presence.changed` (no ids) → `listOnline()` refetch; away/idle deliberately out of scope. Single-instance assumption shared with ADR-0004. See ADR-0011.
- **Forms**: `@tanstack/react-form` v1 `createFormHook` + bound shadcn `<Field>`. See ADR-0005.
- **Form presentation** (2026-06-15): small CRUD forms (≈1–5 fields) use a responsive overlay (`ResponsiveDialog`: centered `Dialog` desktop / bottom `Sheet` mobile) with **open/close state in the URL** (`?dialog=…`) for single-entity flows; transient multi-selection (bulk) stays ephemeral; complex/large/growing forms get a **dedicated route** (e.g. `/admin/shares/assign/$shareCode`, the future ADR-0012 places editor); confirmations stay centered `AlertDialog`; mutating overlays use optimistic instant-close + invalidate-on-settle. See ADR-0013.
- **Visual identity / design language** (2026-06-17; foundation/plan 01 built 2026-06-17, login + empty washes pending plans 02/05). "Quiet nautical confidence": deploy the sidebar `variant="inset"` (rounded content panel, sidebar bg wraps) + a shared centered `PageContainer`; self-hosted **Cabinet Grotesk** headings over **Switzer** body (both Fontshare ITF-FFL variable woff2; Geist dropped) with Linear-style tuning (tight tracking, optical sizing, tabular numerals); one `--brand` nautical-blue token applied to login/empty washes, a logo mark, + form-field focus borders (`--primary` stays neutral; 2026-06-18 amendment added the focus-border placement); slower, `prefers-reduced-motion`-aware overlay motion. Table/content width split (2026-06-23 amendment): data-table screens (Calendar, Owners, Documents) use `PageContainer width="full"` (full-bleed); card grids/lists stay `default` (max-w-5xl); forms/settings stay `prose` (max-w-2xl). Plans in `docs/plans/redesign-2026-06/`. See ADR-0015.
- **Command palette** (2026-06-17, design only — not yet built). One global Cmd+K mounted in the authenticated shell, built on the existing cmdk `Command` + a static typed registry; generalizes today's documents-only `DocumentSearch` into navigate + actions + async doc search; actions reuse ADR-0013 URL-dialogs/routes (never re-implement forms); admin commands hidden by role; single `Mod+K` owner. See ADR-0014.
- **Empty states** (2026-06-17, design only — not yet built). Every list zero-state uses the shared `Empty` (icon + title + description) with at most one role-gated primary CTA where an obvious next action exists; filtered/sub-scope/terminal empties (deleted filter, empty subfolder, bin) stay CTA-less. See ADR-0016.
- **File storage**: Vercel Blob (prod) / RustFS (dev) / devLog (test); two stores, two oRPC routers, discriminated `upload.kind`. R2 documented as swap-in. See ADR-0006.
- **Prod-origin files in the Neon-branched dev DB** (2026-06-13). Dev's DB is a branch of prod, so prod `file`/`document` rows appear in dev but their bytes are only in prod Vercel Blob. `isRemoteOriginPathname` (storage.ts) flags them via the `prod/`/`preview/` prefix; `pnpm storage:sync` (in `dev:up`) mirrors the bytes into RustFS; a dev-only "PROD" badge + a friendly `/api/files/*` fallback explain unsynced ones. Deleting them in dev is prod-safe (branch-isolated DB; `storage.delete` hits local RustFS only). See ADR-0006 (2026-06-13 amendment).
- **Background jobs**: Vercel Queues (prod) / BullMQ + Redis (dev) / devLog (test); shared handler. See ADR-0007.
- **Email**: Resend (prod) / Mailpit SMTP (dev) / devLog (test); magic-link is tier-1 sync; React Email templates. See ADR-0008.
- **All timestamps `timestamptz`** (2026-05-26). Migration `0006_use_timestamptz.sql`; Better Auth patched via `pnpm auth:schema`.
- **DB-enforced invariants via CHECK constraints** (2026-05-26). Physical truths only (sizes, week numbers, part numbers, range bounds); domain rules still in services.
- **Shares are indivisible** (2026-07-05). One owner per share (or unassigned); the split path, `share_part`, and `src/lib/shares/collapse.ts` are gone; assignments reference the `share_code` enum directly and carry `actor_user_id`; per-share history is the flat assignment rows; ADR-0009 Rule 1 retired. Migration `0018` is destructive by design (pre-launch). See ADR-0018.
- **Assignment events are first-class** (2026-05-27, superseded 2026-07-05 by ADR-0018): with indivisible shares each admin decision is exactly one assignment row, so the `ownership_assignment_event` parent table was dropped — the row itself is the decision record.
- **Organization rules live in ADR-0009** (2026-05-27). Social rules the schema can't express (e.g. "every owner holds at least one whole share") are documented there and enforced as typed `<Entity>DomainError` raised pre-commit by services. New rules append to that ADR.
- **Document management per ADR-0010** (2026-06-04, amended 2026-06-10). 1:1 `document`/`file` split; folders as adjacency list + denormalized path; sibling event tables with `correlation_id`; pg_trgm one-input search (deliberate seq scan at this scale); sequential Pacer upload queue; bin under `/admin/documents/bin`; thumbnails as separate public-store WebP assets.
- **Domain invariants are check-first** (2026-06-10). Explicit read → `<Entity>DomainError` inside the guarded op's tx; never SQLSTATE/message parsing; DB constraints stay as silent backstops; check-then-write races accepted at this scale. See ADR-0002 "Check first".
- **Recommended places per ADR-0012** (2026-06-14, design only — not yet built). MapLibre GL (open engine) + MapTiler tiles (provider is a swappable adapter, like R2); photo via `fileId` FK on the row (avatar pattern, public store — no `document` wrapper, no thumbnail worker), three sizes from one original via the `unpic` transformer; EXIF GPS guessed client-side (`exifr`, editable, manual fallback); location as `double precision` lat/lng + client-side Haversine (no PostGIS); multi-tag via a shared normalized `tag` table (~10 localized system tags + deduped custom tags); likes & comments designed as future phases. See ADR-0012.
- **Folder, document & user errors are code-only; client localizes** (2026-06-13; document + user routers added 2026-06-14; the season router lost its errors entirely with ADR-0019). The `folder`, `document`/`bin`, and `user` routers throw oRPC typed errors (`.errors()`, status only) instead of mapping to Swedish `ORPCError`; the client maps code → message via `src/lib/orpc/{folder,document,user}ErrorMessage.ts` (type-only import, exhaustive switch), so `isDefinedError(err)` narrows `err.code` (lets `RenameFolderDialog` show `NAME_TAKEN_IN_PARENT` inline; discriminates folder vs document errors in mixed dialogs). Context-dependent messages stay client-side: `userErrorMessage(code, selfAction)` picks delete-vs-demote for `CANNOT_ACT_ON_SELF`. Alternative to `rethrowAsORPC`, not a replacement — `share` is the lone remaining message-based router; `user.create` stays message-based (Better Auth errors). See ADR-0002 amendment.
- **User invitation = Better Auth email-verification** (2026-06-24). Admin invites by email only; the row is created `emailVerified:false`, `role:'user'`, `name=email` placeholder, `lastInvitedAt=now`. Better Auth's `sendVerificationEmail` (7-day `expiresIn` = `INVITE_EXPIRY_SECONDS`, `autoSignInAfterVerification`) sends a verify-email link whose click verifies + auto-signs-in — **no custom accept route**. "Invited/pending" is **derived** from `emailVerified===false`; accept = first sign-in (invite link or magic-link both flip it). Only new state is one nullable `lastInvitedAt timestamptz` driving the owners-list countdown. Email is tier-3 (queue topic `email_user_invited`). `invite`/`resendInvite` procedures; `inviteUser`/`markInvited`/`assertInviteResendable` service ops; code-only errors `ALREADY_ACCEPTED`/`EMAIL_TAKEN`. Call `sendVerificationEmail` **without** session headers (else `EMAIL_MISMATCH`); rate-limited `/send-verification-email` 5/min. Onboarding (collect real name/phone/avatar) is **implemented** — see the next bullet. **Email is immutable after invite** (it's the magic-link identity; a typo would silently lock the user out) — removed from the admin update path (schema/`UpdateUserInput`/`updateAsAdmin`), shown read-only in `EditUserDialog`; only name/phone/role are editable; change of address = delete + re-invite (2026-06-24 amendment). See ADR-0017.
- **Invitee onboarding wizard** (2026-06-24). 3-screen full-screen flow at top-level `/onboarding` (login-style `brand-wash` shell, not under `_authenticated`): name (required) → phone (skippable) → avatar (skippable, reuses `AvatarUpload`); step in URL `?step=name|phone|avatar`. New nullable `onboardedAt timestamptz` (Better Auth additionalField, `input:false`; migration `0014` backfills existing verified users so only invitees onboard). The `_authenticated` **loader** redirects to `/onboarding` while `me.onboardedAt` is null — gate reads **fresh `me`** (`disableCookieCache`), never the cookie-cached `session.user`, or completion would loop for the 5-min cache TTL; the wizard `refetchQueries(user.me)` before navigating to `/`. Saved per-step via self-scoped `updateProfile` ({name?,phone?}); final `completeOnboarding` stamps `onboardedAt`. Chose an explicit column over a `name===email` heuristic (decoupled from a mutable display value). `updateOwnProfile`/`completeOnboarding` service ops; no new error codes. See ADR-0017 (onboarding amendment).
- **i18n: Paraglide JS, sv default + en, cookie-only** (2026-06-10). Compile-time typed `m.*()` messages from `messages/{sv,en}.json`; `videbacken-locale` cookie, no URL prefix; per-request server locale via ALS in `src/server.ts`; switching reloads the page. Rejected: i18next (40 kB runtime, weak typing), Lingui (TanStack Start SSR issues), typesafe-i18n (unmaintained).
- **UI**: shadcn/ui (style `radix-nova`, base `slate`) + Tailwind v4 — **Radix primitives, not Base UI** (shadcn 4.13+ made Base UI the default for *new* projects; `add` keys off `components.json`, which we keep on `radix-nova`, and new components must import `radix-ui`/`@radix-ui/*`). CSS vars in `src/styles/app.css`; `components.json` source of truth.
- **Dark mode**: cookie-based (`videbacken-theme`), read in the root loader and applied to `<html>` during SSR; light/dark scriptless, `system` resolved by a small owned inline script + a `matchMedia` listener. Own `ThemeProvider`/`useTheme` (no next-themes). Manual toggle + system; no FOUC.
- **Package manager**: pnpm.
- **Linter/formatter**: Biome (editor-only, no CI gate); Tailwind class sorting on; CSS skipped (Tailwind v4 directives unsupported).
- **Squash-merge only** (2026-06-27). Every PR lands on `main` as one squashed commit; PR title = the conventional-commit subject (GitHub appends `(#NN)`), PR description = the commit body. PR-title format is enforced by `.github/workflows/lint-pr-title.yml` (`amannn/action-semantic-pull-request@v6`, pinned + Dependabot-updated). `main` is guarded by a repository **ruleset** ("Protect main", not classic branch protection): requires a PR (0 approvals, squash-only) + the `Check (Biome)`, `Build`, `Test`, and `Validate Conventional Commit title` checks to pass (strict; admin-bypassable); force-push and deletion blocked. `Audit` (in `ci.yml`) runs but is **not** required (currently red — pre-existing advisories). See Non-negotiables → Conventional Commits / squash-merge.
- **Component tests run in Vitest Browser Mode** (2026-06-27). Real Chromium via Playwright (`@vitest/browser-playwright` + `vitest-browser-react`), not jsdom — the Radix surface (dialogs, dropdowns, cmdk, tooltips) needs real pointer/portal behaviour and jsdom would mean a permanent polyfill pile. Two-project Vitest config (`test.projects` in `vite.config.ts`): the `node` project (`extends: true`, distinct `sequence.groupOrder`) keeps the DB suite unchanged; a standalone `vitest.browser.config.ts` carries its own plugins — Paraglide + the **TanStack Start** plugin (rewrites `createServerFn` so server-fn-coupled components and the isomorphic oRPC client bundle) + React; Nitro/Tailwind/devtools omitted. Tests are `*.browser.test.tsx`, `render` is async, assert via retry-able `expect.element`, and get data by cache-seeding a fresh `QueryClient` (`renderWithProviders` in `test/browser/render.tsx`). Components using `useRouter`/route hooks need the hook mocked (no `RouterProvider` yet); MSW + route/loader-level tests deferred. See `test/browser/README.md`.
- **Sidebar breakpoints**: drawer <768px (`md`); persistent icon rail (expandable inline) from `md` (768px) up. `MOBILE_BREAKPOINT` (768) in `src/hooks/useMobile.ts` aligns with the sidebar primitive's own `md:` show/hide. Pages step at `md:`. Icon-rail tooltips are the canonical exception to the "skip tooltips on self-evident icons" rule.
- **Seasons are computed from eras** (2026-07-05). The per-year `season` table and its CRUD (dialogs, mutations, domain errors, `season.changed`) are gone; an append-only `season_era` table (seeded 2024/21/J) fixes start week + rotation anchor per era, and `season.listSchedules` computes min(from_year)..currentYear+1 on read. Convention changes are one-row data migrations (runbook in the ADR). Supersedes ADR-0009 Rule 2 (now structural). See ADR-0019.
- **Season booking per ADR-0020** (2026-07-06). A per-season booking round above the nominal Disponeringslista ("convention below, reality above"): consent-based trade wishes + extra-period marks per share (`season_wish`), a pure max-coverage cycle-solver suggestion, a persisted admin-only 12-slot draft with concrete weeks (`season_slot`, ADR-0019's revisit trigger consumed), reversible lock (`season_booking.locked_at`) publishing the final schedule. Active round = next season, flipping at ISO week 43; year always server-derived. `booking.changed` realtime kind; code-only `BookingDomainError` codes mapped in `bookingErrorMessage.ts`. See ADR-0020.

---

## Agent skill loading (@tanstack/intent)

The block below is auto-managed by `pnpm dlx @tanstack/intent@latest install`. **Do not hand-edit between the markers.**

<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `pnpm dlx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
