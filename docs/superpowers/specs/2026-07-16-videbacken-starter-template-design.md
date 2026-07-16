# Videbacken — Starter Template Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)

## Summary

Videbacken is a **stack + design copy of Oceanview** (`~/prog/priv/oceanview`), reduced
to a **reusable starter template**. It keeps everything app-agnostic — framework,
design system, database, data layer, effects architecture, i18n, testing — strips all
of Oceanview's sailboat-specific domain features, replaces the auth model with
**Google-only sign-in gated by an email allowlist**, switches the package manager from
**pnpm to bun**, and re-brands with **placeholders** (keeping the visual design language
intact).

The result is a polished, batteries-included foundation to build new internal apps on.

## Goals

- Faithful copy of Oceanview's stack and design language.
- Google sign-in only; access gated by an admin-managed email allowlist.
- Global authorization rule: **admins mutate, users are read-only** (except own account).
- Package manager is **bun**.
- Placeholder branding (name `Videbacken`, neutral accent, placeholder logo).
- Runs **alongside** the Oceanview dev environment (no port/bucket/cookie collisions).
- No live infrastructure provisioned — code + env placeholders + setup docs only.

## Non-goals

- No sailboat domain features (shares, seasons, booking, documents, recommendations, maps).
- No passkeys, no magic-link.
- No live Neon / Vercel / Google OAuth provisioning in this pass.
- No production-ready visual brand (placeholders only).

---

## 1. Stack (carried over verbatim, then rebranded)

- **Framework:** TanStack Start (RC, locked) on Vite 8 + Nitro; file-based router.
- **UI:** Tailwind CSS v4 + shadcn/ui (`radix-nova` style, Radix primitives), `components.json`.
- **Design language:** self-hosted Cabinet Grotesk (headings) + Switzer (body); inset-sidebar
  app shell; shared `PageContainer`; reduced-motion-aware overlay motion; empty-state conventions.
- **Auth:** Better Auth (self-hosted) — **reconfigured** (see §4).
- **Database:** Neon Postgres + Drizzle ORM; `postgres-js` driver; snake_case.
- **Data layer:** oRPC + TanStack Query; SSR via in-process router client.
- **Architecture:** services own DB access + domain rules; cross-system effects isolated;
  pino logging; realtime SSE pub/sub; forms via `useAppForm`.
- **Effects (all kept):** email (Resend/SMTP-Mailpit/devLog), storage (Vercel Blob/S3-RustFS/devLog),
  queue (Vercel Queue/BullMQ+Redis/devLog), realtime (in-memory SSE), presence (in-memory).
- **i18n:** Paraglide JS, **Swedish source-of-truth + default**, English alternative, cookie-based.
- **Testing:** Vitest two-project (node DB suite + Chromium browser component suite via Playwright).
- **Tooling:** Biome (format/lint/organize-imports); docker compose dev stack; GitHub Actions CI.
- **Package manager:** **bun** (was pnpm).

---

## 2. Execution strategy: copy-then-transform, staged with verification gates

Copy the entire Oceanview tree into `/Users/lukas/prog/videbacken`, then transform in
phases, verifying after each. Rejected alternative: greenfield re-scaffold — it would
diverge from the "same setup" goal by hand-reconstructing vite/nitro/drizzle/biome/
paraglide/vitest/docker config.

**Copy excludes:** `.git`, `node_modules`, `.output`, `.tanstack`, `.vercel`, `.neon_local`,
`.vitest-attachments`, `dist`, any build artifacts, and secrets (`.env`, `.env.local`).
Copy `.env.example` (to be rewritten), `.github`, `.vscode`, `.claude`, `.superpowers`, `.agents`.

**Phases:**
1. Copy tree + `git init` (fresh history) + first commit.
2. pnpm → bun migration (§5).
3. Strip boat domains (§3).
4. Auth rebuild: Google + allowlist + global authz rule (§4).
5. Onboarding trim: name + avatar only, drop phone step (§4).
6. Branding / identity swap (§6).
7. Docs / ADR cleanup (§7).
8. Full verification (§8).

---

## 3. What is kept, reworked, and stripped

### Kept (app-agnostic infrastructure)
TanStack Start/Vite/Nitro config, Drizzle+Neon setup and migration infra, oRPC + TanStack
Query layer, services/effects architecture (all five effects), pino logging, Paraglide i18n,
full design system, shadcn/ui + `components.json`, `useAppForm`, command palette, **avatars**
(public store + blurhash worker + HEIC transcode), Vitest node+browser harness, Biome, docker
dev stack, CI workflows.

### Kept + reworked
- `user` service/schema/procedures, account settings, admin area.
- `/owners` route → **`/users`** (directory of active users + pending invites).
- Invitation flow → **allowlist management** (§4). Keep the "Invite user" framing, the
  `InviteUser` email template (rebranded), and the `email_user_invited` queue topic; adapt
  semantics from magic-link-invite to Google-pre-approval.
- Onboarding wizard → **name + avatar only** (drop phone step; §4).

### Stripped entirely
- **Domains:** shares/ownership, seasons/eras/booking/disponeringslista, document management
  (documents, folders, bin, search, their event tables), recommendations + MapLibre maps + tags.
  - Schema files: `booking.ts`, `document.ts`, `documentEvent.ts`, `folder.ts`, `folderEvent.ts`,
    `ownership.ts`, `recommendation.ts` (+ related).
  - Services: `booking`, `document`, `documentEvent`, `documentSearch`, `folder`,
    `recommendation`, `share`, `season`, `tag`.
  - oRPC procedures: `booking`, `document`, `documentBin`, `documentSearch`, `folder`,
    `recommendation`, `season`, `share`, `tag`.
  - Routes: all `documents.*`, `recommendations.*`, `admin/shares.*`, `admin/documents.bin`,
    `owners` (→ replaced by `users`).
  - Components: `src/components/{booking,document,recommendation,season,share}/`.
- **Auth methods:** passkeys (`@better-auth/passkey`, passkey schema table, `passkey` service,
  `src/components/passkey/`, `usePasskeys` hook, `passkeyProviders.ts`, `passkeyPrompt.ts`,
  `data/passkeyAaguids.json`, `account/security` passkey UI) and magic-link.
- **Dependencies** consequently removed from `package.json`: `maplibre-gl`,
  `@vis.gl/react-maplibre`, `exifreader`, `@dnd-kit/*`, `embla-carousel-react`,
  `react-phone-number-input`, `@better-auth/passkey`, `cmdk`-adjacent doc-search bits (keep
  `cmdk` for the command palette), `react-day-picker` (unless still used), and any other
  dependency that ends up import-orphaned after stripping. Final list confirmed by a
  dead-dependency sweep during implementation.

Migration history: since local dev DB starts empty and no data exists, the drizzle migration
folder will be **regenerated from the reduced schema** as a clean initial migration (rather than
carrying Oceanview's boat-feature migration history). Better Auth tables regenerated via the CLI.

---

## 4. Auth: Google-only + email allowlist + global authorization

### Sign-in
- Better Auth: **remove** `magicLink` and `passkey` plugins; **add** `socialProviders.google`
  (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). Keep `admin()` plugin (roles `user`/`admin`)
  and `tanstackStartCookies()`.
- Regenerate `betterAuth.ts` via the Better Auth CLI: adds the OAuth `account` table, drops the
  passkey table. Keep the `timestamptz` patch script.
- `/login` becomes a single **"Sign in with Google"** button, keeping the branded login-wash design.
- Exact Better Auth hook/config APIs (social provider config, sign-in denial, session revoke)
  **verified against current Better Auth docs during implementation** — APIs change.

### Allowlist (the access gate)
- New DB table **`approved_email`**: `id`, `email` (unique, normalized lowercase),
  `role` (`'user'|'admin'`, default `'user'`), `addedByUserId` (nullable FK), `createdAt`.
- On first Google sign-in, a `databaseHooks.user.create.before` hook (plus a sign-in guard)
  **denies** any email absent from `approved_email`, surfacing a friendly localized message on
  `/login`. Approved emails create a user with the `role` recorded on their `approved_email` row.
- **Seeding:** env `INITIAL_ADMIN_EMAILS` (CSV) seeds `mail@lukaslindqvist.se` as an admin
  `approved_email` on startup/migration bootstrap. The table is the runtime source of truth
  thereafter; editing the env later does not retroactively change existing rows.

### Invite / revoke (admin-only)
- **Invite user** dialog (admin only): enter email + choose role (default read-only `user`) →
  inserts an `approved_email` row → enqueues an **optional** invite-notification email
  ("you've been granted access; sign in with Google at <url>"), reusing the email effect +
  `email_user_invited` topic + rebranded `InviteUser` template. The email is a courtesy, not
  part of the auth flow (Google is the auth); it can be disabled.
- **Resend invite:** re-enqueues the notification email for a pending entry.
- `/users` directory shows **active users** (signed in at least once) and **pending invites**
  (`approved_email` rows with no matching user yet), mirroring Oceanview's owners+pending UX.
- **Revoke user** (admin only): remove the `approved_email` row, soft-delete the matching user
  (if any), and **invalidate all their sessions** so access is cut immediately.

### Global authorization rule (template-wide invariant)
- **Reads:** any authenticated, approved user → `protectedProcedure`.
- **Mutations:** **admin only** → every mutating oRPC procedure uses `adminProcedure`.
- **Sole exception — own account:** a `user` may complete their own onboarding (set name +
  avatar) and edit their own account profile (name, avatar, phone) via self-scoped procedures
  (`updateOwnProfile`, `completeOnboarding`). They cannot mutate any other/shared data.
- Documented as a non-negotiable in `CLAUDE.md`.
  - **⚠ Review point:** confirm the "own account" carve-out is acceptable given "users are
    read-only." Without it, the kept onboarding wizard and account settings cannot function.

### Onboarding wizard (kept, trimmed)
- Full-screen flow at `/onboarding`: **name** step + **avatar** step, both pre-filled from the
  Google profile so the user confirms/adjusts. **Phone step removed.** `phone` remains a user
  field, editable later only in account settings.
- `_authenticated` loader still redirects to `/onboarding` while `onboardedAt` is null; wizard
  stamps `onboardedAt` on completion. Reuses `AvatarUpload`.

### User schema fields (Better Auth additionalFields)
Keep: `phone`, `deletedAt`, `imageBlurhash`, `onboardedAt`. Drop `lastInvitedAt` (invite timing
now lives on `approved_email`, or keep a `lastInvitedAt` on `approved_email` for the resend
countdown — decided during implementation).

---

## 5. pnpm → bun migration

- Delete `pnpm-lock.yaml` and `pnpm-workspace.yaml`; `bun install` produces `bun.lock`.
- Translate `pnpm-workspace.yaml` into `package.json`:
  - `overrides: { "kysely": "^0.28.17" }` — kept; same unresolved upstream better-auth/kysely bug.
  - `trustedDependencies: ["sharp", "esbuild", "@tailwindcss/oxide", "@biomejs/biome",
    "msgpackr-extract", ...]` — bun's equivalent of pnpm `allowBuilds`, so native/postinstall
    deps compile. Exact list confirmed by watching `bun install` output during implementation.
  - Drop `minimumReleaseAgeExclude` (pnpm-specific supply-chain delay; no bun equivalent needed).
- Remove the `packageManager: "pnpm@..."` field (optionally set `"packageManager": "bun@<ver>"`).
- Scripts: `pnpm` → `bun run`, `pnpm dlx` → `bunx` throughout `package.json` (incl. `prepare`,
  `pretest`, `auth:schema`, `email:dev`).
- `.github/workflows`: swap `pnpm/action-setup` → `oven-sh/setup-bun`; `pnpm install` →
  `bun install --frozen-lockfile`; `pnpm run X` → `bun run X`. Drop `neon-branch-sweep.yml`
  (Neon Local branch sweeping is paused/not relevant to the template). Keep `ci.yml`
  (Biome/Build/Test) and `lint-pr-title.yml`.
- Update the auto-managed `@tanstack/intent` blocks in `CLAUDE.md` / `AGENTS.md` to `bunx`.
- Update README / CLAUDE.md / `.env.example` command references to bun.
- **Risk:** native deps (`sharp`, `heic-convert`) and CLIs (`drizzle-kit`, `@better-auth/cli`,
  `react-email`, `playwright`) under bun — generally compatible (app still runs via Vite/node),
  verified in Phase 8. `bunx playwright install` for browser tests.

---

## 6. Branding & identity (placeholders; design preserved)

- **Design language kept intact** — fonts, shell, motion, empty-states unchanged.
- Name `Oceanview` → `Videbacken` everywhere (stays untranslated per i18n rule): `package.json`
  name, README, CLAUDE.md, UI strings, `Logo`/wordmark, email layout, SEO.
- `--brand` token: nautical-blue → **neutral placeholder accent** (obvious-to-replace value).
  `--primary` stays neutral as today. Trivially re-themed later.
- Placeholder **logo/wordmark** (lettermark "V") + regenerated favicons.
- Identity tokens (avoid collisions with a running Oceanview):
  - Cookies: `oceanview-locale`/`oceanview-theme`/welcome-back → `videbacken-*`.
  - Storage buckets: `oceanview-public`/`oceanview-private` → `videbacken-public`/`videbacken-private`;
    S3 dev creds `oceanview-dev*` → `videbacken-dev*`.
  - Dev log path `/tmp/oceanview-dev.log` → `/tmp/videbacken-dev.log`.
  - `EMAIL_FROM` placeholder: `Videbacken <no-reply@videbacken.local>`.
- **Ports remapped +100** so Videbacken runs alongside Oceanview:

  | Service            | Oceanview | Videbacken |
  |--------------------|-----------|------------|
  | dev server         | 14500     | 14600      |
  | email:dev preview  | 14501     | 14601      |
  | mailpit UI         | 14502     | 14602      |
  | storage console    | 14503     | 14603      |
  | bull studio        | 14504     | 14604      |
  | postgres (db)      | 14520     | 14620      |
  | redis (queue)      | 14521     | 14621      |
  | smtp (mailpit)     | 14522     | 14622      |
  | s3 (storage API)   | 14523     | 14623      |

  Also catch the stray `14327` reference found in the sweep.

---

## 7. Docs & ADRs

- **Keep** (prune boat references): ADRs for side-effects, service-domain, logging, realtime,
  forms, file-storage, background-queue, email, presence, form-presentation, command-palette,
  visual-identity, empty-states.
- **Drop:** organization-rules, document-management, recommended-places, indivisible-shares,
  season-eras, season-booking.
- **Rewrite:** the user-invitation ADR → a new **"Authentication: Google + email allowlist +
  admin-only mutation"** ADR (covers sign-in, allowlist, invite/revoke, the global authz rule,
  onboarding).
- **`CLAUDE.md`** rewritten as a router for the trimmed ADR set and updated for bun + the new
  auth/authz model + Videbacken branding. README rewritten for bun + Google setup.

---

## 8. Verification plan

After transformation:
1. `bun install` (clean).
2. `bun run i18n:compile` (Paraglide).
3. `bun run check:ci` (Biome — format/lint/organize-imports dry run).
4. `bun run build` (Vite build + `tsc --noEmit`) — must be clean, no orphaned imports.
5. `bun run test` (node DB suite + Chromium browser suite).
6. `bun run dev:up` (docker db/queue/mail/storage + migrate) + dev-server smoke test on :14600.

**Honest gap:** the actual Google sign-in round-trip requires a real OAuth client, which is not
provisioned in this pass. Verification covers everything up to the Google redirect; the final
end-to-end login is validated when credentials are wired (documented in README). All non-auth
flows (build, types, tests, dev stack, reads/mutations behind role gates via test fixtures) are
fully verified.

---

## 9. Provisioning (placeholders + setup docs)

No live infra created. `.env.example` rewritten with: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:14600`,
`INITIAL_ADMIN_EMAILS=mail@lukaslindqvist.se`, rebranded DB/blob/S3/SMTP vars. README "Setup"
section documents: creating a Neon project, a Vercel project, and a Google OAuth client
(authorized redirect URIs for dev `http://localhost:14600/api/auth/callback/google` and prod).

---

## 10. Open questions / review points

1. **Own-account carve-out** (§4): confirm `user`s may manage their own name/avatar/phone despite
   the "users are read-only" rule (required for the kept onboarding wizard + account settings).
2. **Invite notification email** (§4): keep the optional courtesy email on invite, or omit it
   entirely (Google is the real auth path)?
3. **Neutral accent color** (§6): any preferred placeholder hue, or a generic neutral is fine?
