# Videbacken

A **starter template** for internal web apps: a batteries-included TanStack Start
stack with authentication, a database + data layer, effect adapters, i18n, a
design system, and tests already wired. Fork it and build your app's domain on top.

**Architecture lives in `docs/adr/`.** This file is a router: rules + commands + gotchas.
For *why* a pattern exists, follow the ADR link.

**Process lives in `docs/{feature,refactor,bugfix}-workflow.md`**, runnable as `/feature-workflow <idea>`,
`/refactor-workflow <target>` and `/bugfix-workflow <symptom>` (thin skills in `.claude/skills/` that load the doc).

**Package manager is [bun](https://bun.sh).** All commands are `bun run <script>` / `bunx <cli>`.

---

## Stack (decided — don't relitigate)

- **Framework:** TanStack Start (RC, **locked** to its pinned version until 1.0) on Vite 8 + Nitro; file-based router in `src/routes/`.
- **Hosting:** Vercel Pro, function region pinned to Stockholm `arn1` (see Non-negotiables).
- **Database:** Supabase Postgres (prod, via Vercel Marketplace) / plain `postgres:17-alpine` (local + CI); Drizzle ORM, `node-postgres` (`pg`) driver — not postgres.js, which pipelines queries that Supabase's transaction pooler drops — snake_case, all timestamps `timestamptz`.
- **Data layer:** oRPC + TanStack Query; SSR via an in-process router client. Domain rules in services (ADR-0002), effects isolated (ADR-0001).
- **Auth:** Better Auth, Google OAuth + email magic-link, allowlist-gated — see [Authentication](#authentication--authorization-adr-0017).
- **Sync:** polled, never pushed (ADR-0018 supersedes 0004 + 0011). No realtime, no presence.
- **Effects** (`src/lib/effects/`, each prod / dev / test): email Resend / Mailpit-SMTP / devLog + React Email templates (ADR-0008); storage Vercel Blob / RustFS-S3 / devLog, public (avatars) + private stores, client-direct upload (ADR-0006); queue Vercel Queue / BullMQ+Redis / devLog (ADR-0007). Pulled integrations (Zaptec, elpris, Škoda, Emaldo) have **no** devLog adapter — they fail closed (ADR-0019).
- **Logging:** pino → stdout (Vercel Runtime Logs); browser warn/error POSTs `/api/log` (ADR-0003).
- **UI:** shadcn/ui (style `radix-nova`, base `slate`, **Radix primitives — not Base UI**) + Tailwind v4 (class sort on). Design language: self-hosted Cabinet Grotesk (headings) + Switzer (body), inset-sidebar shell + shared `PageContainer`, one `--brand` accent, reduced-motion-aware overlays (ADR-0015). Shared `Empty` component (ADR-0016); global Cmd+K palette on cmdk (ADR-0014).
- **Forms:** `@tanstack/react-form` v1 `createFormHook` + bound shadcn `<Field>` (ADR-0005). Small CRUD → responsive overlay with URL dialog state; large forms → dedicated route (ADR-0013). Admin-only dialogs load via `React.lazy` + `LazyDialogMount` + `useIdlePreload(isAdmin, …)`; heavy field components (the phone field) are imported directly, not registered in `fieldComponents` (ADR-0025 §6, ADR-0005).
- **Dark mode:** cookie `videbacken-theme`, applied to `<html>` during SSR; own `ThemeProvider` (no next-themes); manual + system; no FOUC.
- **i18n:** Paraglide JS — Swedish (source of truth + default) + English; `videbacken-locale` cookie, no URL prefix; per-request locale via ALS in `src/server.ts`.
- **Testing:** Vitest — `node` project (per-test Postgres schema) + `browser` project (Vitest Browser Mode, real Chromium via Playwright, `vitest.browser.config.ts`).
- **Tooling:** Biome (format/lint/organize-imports); docker compose dev stack; GitHub Actions CI; squash-merge only.
- **Ports** offset **+100** (146xx) so the template coexists with sibling projects on one machine.

---

## Code map

```
messages/                       i18n source: sv.json (source of truth) + en.json; flat keys
project.inlang/                 Paraglide/inlang config (baseLocale sv)
server/plugins/                 Nitro plugins, registered in vite.config.ts (not auto-discovered):
                                seedApprovedEmails.ts (first admin), queueConsumer.ts (Vercel Queues → lib/queue)
scripts/                        patchBetterAuthSchema.mjs (auth:schema), devQueueWorker.ts (dev:worker), loadEnv.ts, LAN-IP helpers,
                                chunkGraph.ts (client chunk import graph + cycle finder), checkChunkCycles.ts (run by `build`),
                                deriveEnergyMix.ts (one-off energy-mix re-derive; bun --no-env-file + explicit DATABASE_URL)
src/
  router.tsx / routeTree.gen.ts createRouter (+ codegen — DO NOT hand-edit)
  server.ts                     custom entry; wraps each request in the Paraglide locale scope
  routes/
    __root.tsx                  root layout; session guard (public: /, /login, /api/auth/*)
    login.tsx                   Google button + magic-link form
    onboarding.tsx              full-screen 2-step wizard (name → avatar); guard while onboardedAt null
    signed-in.tsx               magic-link "continue here" confirmation
    api/{auth/$.ts, rpc/$.ts, log.ts}   Better Auth / oRPC catch-alls; browser log sink
    api/cron/                   secret-gated cron entrypoints (zaptec-sync.ts hourly, skoda-sync.ts every 15 min (:07 offset), emaldo-sync.ts hourly at :45, elpris-sync.ts 12:30+15:30 UTC, grid-tariff-catalogue.ts monthly)
    api/webhooks/shelly.ts      public Shelly H&T sensor webhook (GET, `token` query param = SHELLY_WEBHOOK_TOKEN)
    _authenticated.tsx          pathless guard → /login (also bounces soft-deleted users)
    _authenticated/             index (dashboard), users, account/{index,profile}, admin, charging/{index,patterns,economy,settings (admin-only: Datakällor + tariffs + credentials (key button per source, Elnätsavtal card; the Škoda home position has a map picker))}, sensors
  lib/
    auth.ts / authClient.ts     betterAuth() (drizzleAdapter + google + magicLink + admin; allowlist gate) / createAuthClient()
    getSession.ts               server fn wrapping auth.api.getSession()
    seedApprovedEmails.ts       seeds INITIAL_ADMIN_EMAILS → approved_email (called by server/plugins/seedApprovedEmails.ts)
    orpc/                       context (public/protected/admin procedures + timings), router, client, procedures/
    db/                         drizzle(postgres(DATABASE_URL)); schema/{betterAuth,file,approvedEmail,sensor,evCharging,vehicleCharge,vehicleState,houseEnergy,integrationSync,integrationCredential,spotPrice,electricityTariff}.ts + index barrel; pgError (unique-violation mapping); connectionString (Supabase env bridge)
    services/                   approvedEmail, user, file, sensor, evCharging, vehicleCharge, integrationSync, integrationCredential, spotPrice, tariff, vehicleState, houseEnergy, energyMix, dbPool (pool gauges for the rpc timing line) — own all DB access + domain rules (ADR-0002)
    effects/                    email, storage, queue (lazy.ts selects the adapter once), zaptec, elpris, skoda, emaldo (pulled, fail closed — ADR-0019; emaldo = house energy flows, RC4 + Snappy wire, ADR-0023; keyedAdapter.ts rebuilds their client only when the resolved credentials change, ADR-0026), eltariff (keyless catalogue client for the gridTariff watcher), geocoder (keyless Nominatim address search for the home-position picker: proxied, 1 req/s, 10-min cache, no retries, ADR-0026); http.ts + testing/fakeFetch shared by the pulled clients
    credentials/                server-only (ADR-0026): crypto (AES-256-GCM envelope, CREDENTIALS_ENCRYPTION_KEY), env (reads env values; the names live in `integrationCredentials.ts`), cache (60 s stored read), resolve (`resolveCredentials`: stored → env per field)
    queue/                      index.ts: the typed `queueHandlers` table + dispatcher (dispatch.ts), shared by the prod consumer and the dev worker (ADR-0007)
    logger/                     pino on server, console + POST /api/log in browser (ADR-0003)
    sensor/                     Shelly webhook handler, climate chart data/ticks, range vocab (client-safe)
    evCharging/                 Zaptec sync (sync.ts) + cron; cost read model (costing.ts: prices each session's stored solar/battery mix, ADR-0023) over the pure cost/ math; client-safe types, `vehicle.ts` vehicle vocabulary, `paging.ts` session-list paging vocabulary (page sizes, URL params, page links, `pageSlice`), `skodaExport.ts` client-safe MySkoda CSV parser (papaparse lazy-loaded), tariff limits + energy tax (ADR-0019, ADR-0020, ADR-0021)
    vehicleState/               Škoda live-state poll: geofence (home point → boolean), sync + cron (ADR-0022)
    houseEnergy/                Emaldo house-energy readings sync (sync.ts: recent days + backfill, day watermark) + cron (ADR-0019, ADR-0023) — no index barrel;
                                energy-mix derivation (ADR-0023): pure client-safe mix/ (supply, shape, pool + SoC cap, carMix, houseTimeline),
                                derive.ts (deriveFrom: one locked transaction) + deriveAfterSync.ts (queue + best-effort derive after the Emaldo, Zaptec, elpris syncs);
                                client-safe figures.ts (period figures, ADR-0024) + flowLayout.ts (the Summering flow diagram's geometry)
    integrations/               runPulledSync (shared sync lifecycle) + cron helper (ADR-0019)
    spotPrice/                  elpris sync + cron (server); client-safe zones.ts, slots.ts — no index barrel
    gridTariff/                 monthly Eltariff catalogue watcher: emails admins once our grid company covers the facility (not a health-tracked source — ADR-0019 amendment); client-safe coverage.ts
    time/stockholm.ts           client-safe Stockholm calendar helpers (DST-aware day bounds)
    integrationHealth.ts        client-safe integration-health vocabulary (sources, error codes, states — ADR-0019)
    integrationCredentials.ts   client-safe credential vocabulary (sources, fields, field kinds, origins, env var names (`CREDENTIAL_ENV_VARS`), optional fields — ADR-0026);
                                integrationCredentialsMessage.ts: client-safe credential copy
    files/, image/              upload helpers: EXIF / blurhash, HEIC transcode, sizes
    query/                      routeData.ts: `loadRouteData` — the server awaits `critical` and skips `deferred`; the client starts everything and awaits nothing (ADR-0025)
    i18n/, zodLocale.ts, theme.ts, browserSession.ts, devHost.ts (dev:host LAN URLs), fonts.ts (BODY_FONT_URL, the preloaded body font), utils.ts
  components/                   <entity>/ folders: account, chart (visx `BarChart` + pure `barLayout`), command, energy, evCharging, form, layout (`LazyDialogMount`), login, onboarding, sensor, user; ui/ (shadcn);
                                root: AppSidebar, ThemeProvider, ModeToggle, LocaleSwitcher, Logo, NotFound, DefaultCatchBoundary
  hooks/                        useUrlDialog (URL dialog state, ADR-0013), useSessionPaging + useListTop (session-list paging), useAwaitSignIn, useIdlePreload (admin idle prefetch), useLocalStorageFlag (a boolean preference per browser), useMobile, …
  bones/                        boneyard section skeletons: `*.bones.json`, imported per route as `<SectionSkeleton bones={…}>` — generated by `bun run bones:capture`, committed (ADR-0025)
  emails/                       React Email: MagicLink, InviteUser, IntegrationSyncAlert, GridTariffAvailable, CredentialExpiry (+ BrandEmailLayout); preview `bun run email:dev`
  styles/                       Tailwind v4 entry (+ the --brand token)
test/                           setup.ts (setupDatabase: per-test schema, local-only guard), rls.test.ts, fixtures/, browser/
config/ (client chunk groups, ADR-0025 §6), drizzle/, compose.yaml, vite.config.ts (Nitro: plugins, region, crons, queue triggers), drizzle.config.ts, biome.json
```

**Path aliases:** `~/*` → `./src/*`; `~test/*` → `./test/*` (`tsconfig.json`).

---

## How we write code (architecture rules — read the ADR before adjusting a pattern)

- **Services own DB access + domain rules.** All `db` access through `src/lib/services/<entity>/`.
  Invariants surface as `<Entity>DomainError` with an English `code` union. See **ADR-0002**.
- **Cross-system effects in `src/lib/effects/`.** Services never import Better Auth / Blob / Resend;
  effect adapters run *after* a successful service call. See **ADR-0001**.
- **Logging via `~/lib/logger/`.** `context.log` in oRPC; `logger` singleton elsewhere. Never `console.*`. See **ADR-0003**.
- **Timing: every RPC is auto-timed — instrument new work.** `/api/rpc` logs one `rpc timing` line per request (`region`, `totalMs`, sub-timings) to Vercel Runtime Logs. For anything heavier than a single query (multiple queries, external calls, expensive compute), record named sub-timings: `if (context.timings) context.timings.<label>Ms = …`. Pattern: `getSessionMs`/`findActiveByIdMs` in `src/lib/orpc/context.ts`.
- **Never hold a connection open on a Vercel Function** — no SSE, WebSockets or long-polling. Fluid Compute bills provisioned memory for a request's whole lifetime; one open stream exhausted the Hobby allowance in ~7 days and blocked prod (2026-08-05). Freshness comes from TanStack Query `refetchInterval` + focus refetch. See **ADR-0018**.
- **Forms via `useAppForm`.** Never `useState` for field values; canonical example `src/components/login/LoginFormCard.tsx`. See **ADR-0005**.
- **Reuse before you hand-roll (non-trivial work only).** Before writing anything non-trivial
  (date/time math, parsing, validation, retries, concurrency, crypto, formatting, UI primitives…):
  1. **Check what's already installed** (`package.json`) and use it — e.g. date-fns, Zod, TanStack Query/Form,
     Drizzle, Better Auth, Radix/shadcn. Read the library's current docs (Context7) before assuming it can't.
  2. **Nothing installed fits → look for a well-maintained library** before building your own. Weigh
     maintenance, bundle size (client code), and license; add it with `bun add`.
  3. **Hand-roll only when** no good fit exists or the dependency costs more than the code, and say
     why in the PR. Trivial helpers (a few lines, obvious) don't need this ceremony.

### Recipes
- **Add a schema:** `src/lib/db/schema/<x>.ts` (end every `pgTable(...)` with `.enableRLS()` — `test/rls.test.ts` enforces it) → re-export in `schema/index.ts` → `bun run db:generate --name=<desc> && bun run db:migrate`. Then get the **schema-design review** (Non-negotiables) before building on it.
- **Add a service:** copy `services/user/` shape (`<x>.ts`, `<x>.test.ts` with `setupDatabase()` first, `index.ts`; `errors.ts` when an invariant lands).
- **Add an effect:** copy `effects/email/` shape (`<domain>.ts` selector + `adapters/<name>.ts` + barrel + test; register in `effects/index.ts`).
- **Add a procedure:** edit `src/lib/orpc/procedures/<x>.ts`; pick `protectedProcedure` (reads) or `adminProcedure` (mutations); `.errors(<x>Errors)` + `.input(zodSchema)`; thin glue → service → rethrow `errors[err.code]()` → run effects after success; register in `orpc/router.ts`. Add `context.timings` sub-timings for heavier work.
- **Add a queue topic:** extend the `QueueTopic` / `QueuePayloadMap` union in `src/lib/effects/queue/queue.ts` → a handler in `src/lib/queue/handlers/` → an entry in the typed `queueHandlers` table in `src/lib/queue/index.ts` (a topic without a handler fails to compile) → a trigger in `vite.config.ts` (ADR-0007).
- **Add a route loader:** `loadRouteData(queryClient, { critical, deferred })` (never `await prefetchQuery` directly); read deferred data with `useQuery` and wrap the section in `<SectionSkeleton name="x" loading={firstLoadPending(query)}>`, then `bun run bones:capture`, then switch to `bones={xBones}` (`import xBones from '~/bones/x.bones.json'`). See **ADR-0025** (the `/sensors` and `/users` loaders migrate in perf step 2).
- **Add a UI component:** `bunx shadcn@latest add <name>` (Radix variant per `components.json` — never `shadcn init --base`).
- **Regenerate Better Auth schema:** `bun run auth:schema` (runs the CLI + `scripts/patchBetterAuthSchema.mjs` for `timestamptz` + RLS). Never hand-edit `betterAuth.ts`.

### ADR index
| Concern | ADR |
|---|---|
| Side effects (email, storage, queue) | 0001 |
| Services, domain rules, error mapping | 0002 |
| Logging | 0003 |
| ~~Realtime sync (SSE)~~ — superseded | ~~0004~~ → 0018 |
| Forms | 0005 |
| File storage (avatars + private store) | 0006 |
| Background jobs / queue | 0007 |
| Email templates | 0008 |
| ~~Presence (online status)~~ — superseded | ~~0011~~ → 0018 |
| Form presentation (dialogs vs pages) | 0013 |
| Command palette | 0014 |
| Visual identity / design language | 0015 |
| Empty states & feedback | 0016 |
| **Authentication** (Google + magic-link, allowlist, admin-only mutation, onboarding) | **0017** |
| Polled sync replaces realtime SSE | 0018 |
| External data integrations (fail-closed sync, health tracking, lease) | **0019** |
| Spot prices & charging cost model (on-read, missing ≠ 0 kr, gridShare seam) | **0020** |
| Charging-session vehicle attribution (sessions ours by default, views show all, Škoda log re-match, admin wins) | **0021** |
| Live vehicle-state attribution (Škoda poll, majority of known time, geofence) | **0022** |
| Solar-aware charging cost (Emaldo energy mix, battery pool, cash + solar value) | **0023** |
| House energy pages (on-read monthly aggregates, loss + self-sufficiency definitions) | **0024** |
| Deferred route loading (loaders await on server only, cached session guard, boneyard-js section skeletons, per-page bundle (§6)) | **0025** |
| Integration credential store (GUI-set, encrypted in Postgres, per-field over env; charging settings page) | **0026** |

---

## Authentication & authorization (ADR-0017)

- **Two sign-in methods, both gated by the `approved_email` allowlist:** Google OAuth and email
  magic-link. **No passwords, no passkeys.** Only approved emails can sign in; the user row is created
  on first sign-in and its role comes from the `approved_email` row.
- **Two roles:** `user`, `admin`. **Admins mutate, users are read-only:** reads use `protectedProcedure`;
  every mutation uses `adminProcedure`; the **sole exception** is a user managing their **own account**
  (`updateProfile`, `completeOnboarding`, own avatar) scoped to `context.user.id`.
- **Seed:** `INITIAL_ADMIN_EMAILS` (CSV) → admin allowlist rows on each instance's first request (see Non-negotiables for the plugin rule).
  Sign in locally with one of those addresses to bootstrap the first admin.
- Admins manage access at `/admin` (invite = add an allowlist row + courtesy email to `/login`;
  revoke = remove approval + soft-delete + revoke sessions; re-invite restores a revoked user).

---

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server on :14600 |
| `bun run dev:host` | Same, on your LAN IP so a phone on the Wi-Fi can reach auth + storage |
| `bun run dev:up` / `dev:down` | Whole dev stack: db + queue + mail + storage (`up` also migrates) |
| `bun run dev:worker` | Local BullMQ consumer — **run it, or queued jobs (blurhash, alert emails) never process in dev** |
| `bun run build` / `typecheck` | Vite build + the client chunk check (`scripts/checkChunkCycles.ts`) + `tsc --noEmit` / types only |
| `bun run db:{up,down,generate,migrate,studio}` | Postgres on :14620; generate/apply migrations; Drizzle Studio |
| `bun run auth:schema` | Regenerate `betterAuth.ts` + patch `timestamptz`/RLS. Idempotent |
| `bun run queue:{up,down,studio}` / `storage:{up,down}` / `mail:{up,down}` | Local broker / S3 (RustFS) / Mailpit |
| `bun run email:dev` | React Email preview on :14601 |
| `bun run bundle:measure` | Prod build with source maps, then per page: KB gz beyond entry + shell, watched packages, bones (client-performance checkpoints; ADR-0025 §6) |
| `bun run bones:capture` | Capture section skeletons from the signed-in dev app (ADR-0025); re-run after changing a skeleton-wrapped section's layout |
| `bun run i18n:compile` | Compile `messages/{sv,en}.json` → `src/paraglide/` (also runs on install and before `test`) |
| `bun run test` / `test:node` / `test:components` | Vitest: both / node-DB / browser (**`test:components` watches**; one-shot: `bunx vitest run --project browser`) |
| `bunx vitest run <path>` | One test file |
| `bun run check` / `check:ci` | Biome format+lint+organize-imports: write / dry-run (= CI's `Check (lint)`) |

**Tests need the local DB:** `bun run db:up && bun run db:migrate` first. `setupDatabase()` refuses any
non-local `DATABASE_URL` outside CI, because tests create and drop schemas.

**Ports:** dev 14600, email:dev 14601, mailpit UI 14602, storage console 14603, bull studio 14604;
postgres 14620, redis 14621, smtp 14622, s3 14623.

**CI:** `main` is PR-gated by the `protect-main` ruleset — required checks are **`CI Success`** (aggregates
`Check (lint)`, `Check (types)`, `Check (build)`, `Test (node 1/2)`, `Test (node 2/2)`, `Test (browser)`) and **`Validate Conventional Commit title`**.

---

## Environment variables

`.env.example` lists everything. Key vars:
- `DATABASE_URL` (prod: auto-provisioned as `POSTGRES_URL` by the Supabase Vercel integration, bridged in `src/lib/db/connectionString.ts`; local `postgres://videbacken:videbacken@localhost:14620/videbacken`).
- `BETTER_AUTH_SECRET` (32+ chars; `openssl rand -base64 32`), `BETTER_AUTH_URL`; `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- `INITIAL_ADMIN_EMAILS` (CSV; seeds the first admin(s) into `approved_email`).
- Storage `BLOB_*` (prod) / `S3_*` (local RustFS); email `RESEND_API_KEY`+`EMAIL_FROM` (prod) / `SMTP_*` (local Mailpit); `REDIS_URL` (local queue); `LOG_LEVEL`.
  `STORAGE_ADAPTER=devLog` / `EMAIL_ADAPTER=devLog` force the no-op adapters (offline dev without docker).
- `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`, exactly 32 bytes; one per Vercel environment; ADR-0026): enables GUI-set credentials. **A stored value overrides its env var field by field** for every credential var below (`ZAPTEC_USERNAME`/`ZAPTEC_PASSWORD`, `SKODA_API_KEY`/`SKODA_VIN`/`SKODA_HOME_COORDINATES`, the four `EMALDO_*`, `GRID_FACILITY_ID`; not `ZAPTEC_ADAPTER`); env is the fallback. A stored row that can't be decrypted (key lost or changed) fails that source closed as `credentials_unreadable`, never falling back to env.
- `ZAPTEC_USERNAME`/`ZAPTEC_PASSWORD` (unset → fails closed as `not_configured`, ADR-0019); `ZAPTEC_ADAPTER=fake` (dev-only synthetic data).
- `SKODA_API_KEY`/`SKODA_VIN` (either unset → `not_configured`; Vercel Production only — Preview has its own DB but shares the VIN's 20/h quota) and `SKODA_HOME_COORDINATES` (never committed/logged; unset or invalid → geofence off: attribution falls back to plug state and whether the car is moving). Renewing the key: `docs/runbooks/skoda-api-key.md`.
- `EMALDO_USER`/`EMALDO_PASSWORD`/`EMALDO_APP_ID`/`EMALDO_APP_SECRET` (any unset → `not_configured`; a dedicated Emaldo account — a login ends its other sessions; app id/secret come from the Emaldo Android app and can rotate; Vercel Production only, never Preview; ADR-0023); synced hourly at :45 by `/api/cron/emaldo-sync`.
- `GRID_FACILITY_ID` (18-digit metering-point ID, prod only, never committed/logged; unset → the monthly catalogue check is skipped).
- `CRON_SECRET` (Bearer token gating `/api/cron/*`); `SHELLY_WEBHOOK_TOKEN` (query-param token for `/api/webhooks/shelly`).

---

## Gotchas

- **`vercel env pull` writes prod `DATABASE_URL` into `.env.local`**, which Vite + Drizzle prefer over `.env`.
  If you run it, delete the `DATABASE_URL*` lines from `.env.local` immediately — otherwise `bun run db:migrate` migrates **production**.
  One-off scripts against prod (`scripts/deriveEnergyMix.ts`) run with `bun --no-env-file` and an inline `DATABASE_URL`, never from env files.
- **Every Vercel deploy migrates its database:** the `vercel-build` script runs `drizzle-kit migrate` before the build.
  A merged migration hits prod on the next production deploy — it can't be "held back".
- **Client code may only `import type` from services.** A value import pulls `db` → `postgres` → `Buffer` into the
  browser bundle and crashes the page. Put shared constants/vocab in a client-safe module (e.g. `integrationHealth.ts`, `spotPrice/zones.ts`); the `clientSafe.browser.test.tsx` tests guard this.
- **No DB or network I/O at module init or in a Nitro plugin's body.** Work started outside a request isn't
  covered by `waitUntil`; Vercel may suspend the instance with it in flight (logs showed the approved-email
  seed's connect timing out during the instance's first requests). Do it inside a request: a `request` hook
  that hands the work to `waitUntil` from `@vercel/functions`.
- **`src/routeTree.gen.ts`, `src/paraglide/`, `drizzle/meta/` and `betterAuth.ts` are generated** — regenerate, never edit.
- **Client chunk groups (`config/clientChunkGroups.ts`) have two rules.** Never group a module the entry reaches: the entry then imports the whole group and every page, `/login` included, loads it (check `bun run bundle:measure`'s `entry:` line against the reference numbers in ADR-0025 §6). And never let a group and a chunk outside it import each other: a `button`↔`ui` cycle crashed `/login`'s hydration at module init, and any cycle is the same trap; sizes and tests don't show it. Both `build` and `vercel-build` fail on a cycle or on the entry reaching a group (`scripts/checkChunkCycles.ts`).
- **`src/bones/` is generated by `bun run bones:capture`** — re-capture, never hand-edit. It needs the dev server on :14610 (see `scripts/captureBones.ts`) and takes ~1–2 min per page. The CLI skips a skeleton whose DOM is unchanged: after changing the breakpoints or CSS-only layout, pass `--force`. A path subset (`bun run bones:capture /charging/economy`) is safe. Pages import their own bones, so the script deletes the registry the CLI writes; `test/sectionSkeletonBones.test.ts` fails if a captured section isn't passed its bones.
- **Every side-effect-only import (`import '~/x'`) must be listed in `package.json`'s `sideEffects`**, or the production build drops it. Dev doesn't tree-shake, so it only breaks in prod. Today only `src/lib/zodLocale.ts` (Swedish Zod messages).

---

## Non-negotiables

- **Auth rules** in [Authentication](#authentication--authorization-adr-0017) are fixed: Google + magic-link only, allowlist-gated, two roles, every mutating procedure `adminProcedure` except own-account.
- **All `db` access through services.** No `db.select()` in routes/handlers/auth hooks. See ADR-0002.
- **File blobs out-of-process.** User file bytes never traverse a Vercel Function; all file access goes through `src/lib/effects/storage/`. See ADR-0006.
- **oRPC procedures are thin glue.** Gate with `protectedProcedure`/`adminProcedure` (never inline). Better Auth's own `/api/auth/*` routes stay on the Better Auth handler.
- **All logging through `~/lib/logger/`.** Never `console.*`. See ADR-0003.
- **Never hand-edit `src/lib/db/schema/betterAuth.ts`** — regenerate via `bun run auth:schema`.
- **Every database change gets a Postgres schema-design review before it merges** — new/altered tables, columns, constraints, indexes, or migrations under `src/lib/db/schema/` / `drizzle/`. The reviewer (a subagent) must load the `supabase-postgres-best-practices` skill and judge the change against the queries that will actually run (indexes, constraints vs. every valid write, types, FK/cascade, evolvability). Run it alongside `migration-guard` (which checks the mechanical migration gotchas); fix or explicitly rule on every finding before code builds on the schema.
- **All timestamp columns use `timestamp({ withTimezone: true })`** (timestamptz). When drizzle-kit emits an `ALTER ... SET DATA TYPE timestamp with time zone` on existing data, hand-add `USING "<col>" AT TIME ZONE 'UTC'`.
- **`server/plugins/seedApprovedEmails.ts` must stay registered in `vite.config.ts`'s Nitro `plugins`** — Nitro doesn't auto-discover `server/plugins/*`; unregistered, the first admin never seeds.
- **Never remove the `arn1` region pin in `vite.config.ts`** (Nitro `vercel.functions.regions`, co-located with the Supabase DB in `eu-north-1`). Without it the region silently falls back to US `iad1`: ~610 ms/RPC instead of ~60 ms. If the DB region moves, change the pin to match.
- **User-facing text is Paraglide-localized** (`messages/{sv,en}.json`, sv source of truth + default, en key-complete). "Videbacken" stays untranslated. **Route URL paths stay English** (`/users`, `/account`).
- **File naming:** routes lowercase + TanStack tokens; React components PascalCase in `src/components/<entity>/`; hooks `useX`; `src/components/ui/` kebab-case (shadcn-managed); everything else camelCase.
- **Every screen is responsive** (desktop + mobile + tablet; no fixed pixel widths).
- **Conventional Commits** (`<type>(<scope>): <subject>` ≤72 chars, imperative). PRs are **squash-merged** — PR title = the conventional-commit subject (GitHub appends `(#NN)`), description = the body (`.github/PULL_REQUEST_TEMPLATE.md`); one concern per PR.

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
