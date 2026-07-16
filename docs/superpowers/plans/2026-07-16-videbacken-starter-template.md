# Videbacken Starter Template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/Users/lukas/prog/videbacken` into a reusable starter template that is a stack + design copy of Oceanview (`~/prog/priv/oceanview`), with sailboat domains stripped, Google + magic-link auth gated by an admin-managed email allowlist, bun instead of pnpm, and placeholder branding.

**Architecture:** Copy the whole Oceanview tree, then transform in phases (bun migration → strip domains → auth rebuild → admin UI → onboarding trim → branding → docs/CI → verification), running a verification gate after each phase. New code (the `approved_email` allowlist: schema, service, procedures, admin UI) is built test-first mirroring the existing `user` service. Everything else is a faithful copy or a mechanical transform verified by `bun run build` + the existing test suites.

**Tech Stack:** TanStack Start (RC, locked) on Vite 8 + Nitro; React 19; Better Auth (Google OAuth + magic-link + admin plugin); Drizzle ORM + Neon/plain-Postgres + postgres-js; oRPC + TanStack Query; Tailwind v4 + shadcn/ui (radix-nova); Paraglide i18n (sv default + en); pino; Vitest (node + Chromium browser); Biome; docker compose dev stack; bun.

## Global Constraints

Copied verbatim from the spec — every task implicitly includes these.

- **Package manager is bun.** `bun install`, `bun run <script>`, `bunx <cli>`. No `pnpm`/`pnpm dlx` anywhere.
- **Ports remap +100 vs Oceanview** (so both run at once): dev **14600**, email:dev **14601**, mailpit UI **14602**, storage console **14603**, bull studio **14604**, postgres **14620**, redis **14621**, smtp **14622**, s3 API **14623**. Also replace the stray `14327`.
- **Two sign-in methods, both allowlist-gated:** Google OAuth **and** email magic-link. Passkeys removed. No pre-created user rows — `approved_email` is the gate; the user row is created on first sign-in via either method.
- **Authorization rule (template-wide invariant):** reads use `protectedProcedure`; **every mutation uses `adminProcedure`** (admins mutate, users are read-only). Sole exception: a `user` may manage **their own** account (name/avatar/phone + onboarding) via self-scoped procedures.
- **Two roles only:** `user` and `admin`.
- **All DB access through services** (`src/lib/services/<entity>/`); oRPC procedures are thin glue; no `db.select()` in routes/handlers/hooks.
- **All logging through `~/lib/logger/`;** never `console.*`.
- **All timestamp columns are `timestamptz`** (`timestamp({ withTimezone: true })`); Better Auth schema patched via `bun run auth:schema`.
- **User-facing text is Paraglide-localized** (`messages/{sv,en}.json`, sv source-of-truth + default, en key-complete); never hardcode UI strings. `Videbacken` stays untranslated. Route URL paths stay English.
- **Never hand-edit `src/lib/db/schema/betterAuth.ts`** — regenerate via `bun run auth:schema`.
- **Lock TanStack Start to its RC version** in `package.json` (keep Oceanview's pinned versions).
- **Design language preserved** (Cabinet Grotesk/Switzer fonts, inset-sidebar shell, motion, empty-states). Only identity swaps: name → `Videbacken`, `--brand` → muted indigo, placeholder logo.
- **Conventional Commits** (`<type>(<scope>): <subject>`, imperative, ≤72 chars). Commit at the end of each task.
- **No live provisioning** — code + `.env.example` placeholders + setup docs only. Google sign-in E2E is deferred to when real OAuth creds exist.
- **Verify against current Better Auth docs** (context7 `/org/project` or WebFetch better-auth.com) before writing any Better Auth config — social provider, magic-link, sign-in denial, session revoke APIs change.

**Reference source (read-only):** `~/prog/priv/oceanview`. When a task says "mirror the `user` service" or "follow the existing pattern", open the corresponding Oceanview file and copy its shape. The copied tree in `videbacken` is the working target.

**Cross-project safety:** never run `bun run db:*` / `dev:up` / `storage:sync` against Oceanview. Only operate inside `/Users/lukas/prog/videbacken`. `storage:sync` and any prod-token step stay unused (no prod exists).

---

## Task 0: Copy the Oceanview tree + fresh git

**Files:**
- Create: everything under `/Users/lukas/prog/videbacken` (copied), preserving the existing `.git/` and `docs/superpowers/` already present.

**Interfaces:**
- Produces: a working-tree copy of Oceanview's source, config, docs, scripts, tests — the substrate every later task transforms.

- [ ] **Step 1: Dry-run the copy** (verify excludes, don't clobber `.git`/spec/plan)

Run:
```bash
cd /Users/lukas/prog/videbacken
rsync -avn --exclude='.git/' --exclude='node_modules/' --exclude='.output/' \
  --exclude='.tanstack/' --exclude='.vercel/' --exclude='.neon_local/' \
  --exclude='.vitest-attachments/' --exclude='dist/' --exclude='.env' \
  --exclude='.env.local' --exclude='src/paraglide/' --exclude='docs/superpowers/' \
  /Users/lukas/prog/priv/oceanview/ /Users/lukas/prog/videbacken/ | head -60
```
Expected: a list including `src/`, `messages/`, `scripts/`, `test/`, `drizzle/`, `docs/adr/`, `.github/`, `.claude/`, config files. NOT `.git/`, `node_modules/`, `.env`, `docs/superpowers/`.

- [ ] **Step 2: Run the copy for real** (drop the `-n`)

Run the same command without `-n`.
Expected: files copied. `.env.example` present; `.env`/`.env.local` absent.

- [ ] **Step 3: Confirm the guardrails survived**

Run: `ls docs/superpowers/specs docs/superpowers/plans && git log --oneline -1 && ls .env* 2>/dev/null`
Expected: the spec + this plan exist; the two design commits are intact; only `.env.example` exists (no `.env`/`.env.local`).

- [ ] **Step 4: Commit the raw copy**

```bash
git add -A
git commit -m "chore: copy Oceanview tree as Videbacken starting point"
```

---

## Task 1: Migrate to bun + isolate the local dev environment

**Files:**
- Delete: `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Modify: `package.json`, `compose.yaml`, `vite.config.ts`, `drizzle.config.ts`, and any file with a `145xx`/`14327` port literal
- Create: `.env` (machine-local, gitignored — not committed)
- Test: `bun install` + `bun run build` (the gate — proves the full stack builds under bun before anything changes) + port-isolation grep

**Interfaces:**
- Produces: a `bun.lock`, a bun-native `package.json`; **all host ports remapped +100** so the local docker stack + DB never collide with a running Oceanview; a working local `.env`. Every later task runs commands as `bun run <script>` against the isolated stack.

**Why ports first:** the strip task (Task 2) runs `bun run test:node`, and Tasks 3–5 run `db:up`/`db:migrate`. Those hit the local Postgres on its host port. Oceanview binds `14520`; unless we remap **before** the first DB use, a running Oceanview stack collides and tests target the wrong container. So the port remap + local `.env` happen here, not at branding time.

- [ ] **Step 0a: Remap all host ports (+100) across the repo**

Replace every occurrence in `compose.yaml`, `vite.config.ts`, `drizzle.config.ts`, `package.json`, `.env.example`, and any `scripts/`/`test/` file: `14500→14600`, `14501→14601`, `14502→14602`, `14503→14603`, `14504→14604`, `14520→14620`, `14521→14621`, `14522→14622`, `14523→14623`. Find the stray `14327` (`grep -rn 14327 . --include='*.ts' --include='*.yaml' --include='*.json'`, excluding `node_modules`) and bump it to `14627`. Include `vite.config.ts`'s `server.port` (14600), its `TEST_DATABASE_URL` (`...localhost:14620/...`), and `compose.yaml`'s port mappings. Verify none remain:
```bash
grep -rnE '1450[0-9]|1452[0-9]|14327' src test scripts *.ts *.yaml *.json .env.example
```
Expected: empty. (Name/accent/logo/bucket/cookie identity swaps are Task 7 — this step is ports only.)

- [ ] **Step 0b: Create a machine-local `.env`**

`.env` was intentionally not copied (secrets). Create it (it is gitignored — never commit it) with local-dev values:
```
DATABASE_URL=postgres://neon:npg@localhost:14620/neondb
BETTER_AUTH_URL=http://localhost:14600
BETTER_AUTH_SECRET=<generate: openssl rand -base64 32>
INITIAL_ADMIN_EMAILS=mail@lukaslindqvist.se
S3_ENDPOINT=http://localhost:14623
S3_REGION=eu-north-1
S3_ACCESS_KEY_ID=videbacken-dev
S3_SECRET_ACCESS_KEY=videbacken-dev-secret-key
S3_BUCKET_PUBLIC=videbacken-public
S3_BUCKET_PRIVATE=videbacken-private
REDIS_URL=redis://localhost:14621
SMTP_HOST=localhost
SMTP_PORT=14622
EMAIL_FROM=Videbacken <no-reply@videbacken.local>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```
Run `openssl rand -base64 32` and paste the result into `BETTER_AUTH_SECRET`. Confirm `git status` does NOT show `.env` (the `.gitignore` excludes it).

- [ ] **Step 1: Read the current `package.json` and `pnpm-workspace.yaml`**

Note the scripts block, the `packageManager` field, and the workspace `overrides` (`kysely: ^0.28.17`) + `allowBuilds` (`esbuild: true`, `sharp: true`, `msgpackr-extract: true`; `false` for the rest).

- [ ] **Step 2: Rewrite `package.json` scripts to bun**

Replace every `pnpm ` → `bun run ` and every `pnpm dlx ` → `bunx ` in the `scripts` block. Specifically:
- `"prepare": "bun run i18n:compile"`
- `"pretest": "bun run i18n:compile"`
- `"auth:schema": "bunx @better-auth/cli@1.4.21 generate --yes --output src/lib/db/schema/betterAuth.ts && node scripts/patchBetterAuthSchema.mjs"`
- `"email:dev": "bunx react-email dev --dir src/emails --port 14601"` (note the new port)
- `"dev:up": "docker compose up -d --wait db queue mail && docker compose up -d storage storage-init && bun run db:migrate && bun run storage:sync"`
- Leave `node scripts/*.mjs` / `tsx scripts/*.ts` / `vite` / `drizzle-kit` / `biome` / `vitest` / `docker compose` invocations as-is (they are binaries, not pnpm).

- [ ] **Step 3: Replace `packageManager` + fold in workspace config**

In `package.json`:
- Remove the `"packageManager": "pnpm@..."` line.
- Add top-level:
```json
"overrides": {
  "kysely": "^0.28.17"
},
"trustedDependencies": [
  "sharp",
  "esbuild",
  "msgpackr-extract",
  "@tailwindcss/oxide",
  "@biomejs/biome"
]
```
(`overrides` = pnpm's workspace `overrides`; `trustedDependencies` = pnpm's `allowBuilds` — the list of packages allowed to run install scripts under bun. Confirm/extend from `bun install` output in Step 5.)

- [ ] **Step 4: Delete the pnpm files**

```bash
rm pnpm-lock.yaml pnpm-workspace.yaml
```

- [ ] **Step 5: Install with bun**

Run: `bun install`
Expected: resolves and writes `bun.lock`. Watch the "blocked postinstall" / "scripts" notices — if bun reports a package needing a build script that isn't in `trustedDependencies` (commonly `sharp`, `esbuild`, `@tailwindcss/oxide`), add it to `trustedDependencies` and re-run `bun install`. Confirm `node_modules/sharp` has its platform binary (`ls node_modules/sharp/build/Release 2>/dev/null || ls node_modules/@img 2>/dev/null`).

- [ ] **Step 6: Compile i18n + build (the gate)**

Run: `bun run i18n:compile && bun run build`
Expected: Paraglide compiles into `src/paraglide/`; `vite build` completes; `tsc --noEmit` reports no errors. This proves the untouched Oceanview stack builds under bun. If native-dep or CLI errors appear, resolve `trustedDependencies` / bun compatibility here before proceeding.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: switch package manager from pnpm to bun"
```

---

## Task 2: Strip sailboat domains (schema, services, procedures, routes, components, deps)

**Files:**
- Delete (schema): `src/lib/db/schema/{booking,document,documentEvent,folder,folderEvent,ownership,recommendation}.ts`
- Delete (services): `src/lib/services/{booking,document,documentEvent,documentSearch,folder,recommendation,share,season,tag}/`
- Delete (procedures): `src/lib/orpc/procedures/{booking,document,documentBin,documentSearch,folder,recommendation,season,share,tag}.ts`
- Delete (routes): `src/routes/_authenticated/{documents.$.tsx,documents.index.tsx,recommendations.$id.edit.tsx,recommendations.index.tsx,recommendations.new.tsx,owners.tsx}` and `src/routes/_authenticated/admin/{documents.bin.tsx,shares.assign.$shareCode.tsx,shares.index.tsx}`
- Delete (components): `src/components/{booking,document,recommendation,season,share}/`
- Modify: `src/lib/db/schema/index.ts`, `src/lib/orpc/router.ts`, `src/routes/_authenticated.tsx`, `src/components/command/*` (palette registry), `src/components/AppSidebar.tsx`, `package.json`, `vite.config.ts`, `messages/{sv,en}.json`
- Test: `bun run build` + `bun run test:node`

**Interfaces:**
- Produces: a codebase containing only auth + user + account + admin + avatars + all effects + design system + i18n + the example-free shell. `/users` does not exist yet (added in Task 4); `/owners` is removed here.

- [ ] **Step 1: Delete the domain schema, services, procedures, routes, components**

```bash
cd /Users/lukas/prog/videbacken
rm src/lib/db/schema/{booking,document,documentEvent,folder,folderEvent,ownership,recommendation}.ts
rm -rf src/lib/services/{booking,document,documentEvent,documentSearch,folder,recommendation,share,season,tag}
rm src/lib/orpc/procedures/{booking,document,documentBin,documentSearch,folder,recommendation,season,share,tag}.ts
rm src/routes/_authenticated/documents.$.tsx src/routes/_authenticated/documents.index.tsx
rm src/routes/_authenticated/recommendations.$id.edit.tsx src/routes/_authenticated/recommendations.index.tsx src/routes/_authenticated/recommendations.new.tsx
rm src/routes/_authenticated/owners.tsx
rm -rf src/routes/_authenticated/admin/documents.bin.tsx src/routes/_authenticated/admin/shares.assign.$shareCode.tsx src/routes/_authenticated/admin/shares.index.tsx
rm -rf src/components/booking src/components/document src/components/recommendation src/components/season src/components/share
```

- [ ] **Step 2: Prune the schema barrel**

Rewrite `src/lib/db/schema/index.ts` to keep only surviving tables:
```ts
export * from './betterAuth'
export * from './file'
```
(The `approved_email` export is added in Task 4.)

- [ ] **Step 3: Prune the oRPC router**

Read `src/lib/orpc/router.ts`. Remove every import and `appRouter` entry for the deleted procedures (`booking`, `document`, `documentBin`, `documentSearch`, `folder`, `recommendation`, `season`, `share`, `tag`). Keep `health`, `user`, `image`, `presence`, `realtime`. (`image` stays — it serves avatars.)

- [ ] **Step 4: Fix the authenticated layout**

In `src/routes/_authenticated.tsx`: remove the imports and JSX for `UploadQueueBox`, `UploadQueueProvider` (document-upload only). The layout keeps `CommandPaletteProvider`, `TooltipProvider`, `SidebarProvider`, `AppSidebar`, `HeaderUserMenu`, `CommandPalette`, `useRealtimeSync`.

- [ ] **Step 5: Prune the command palette + sidebar navigation**

Read `src/components/command/*` and `src/components/AppSidebar.tsx`. Remove navigate/action entries and nav links pointing at deleted routes (`/documents`, `/recommendations`, `/owners`, `/admin/shares`, `/admin/documents/bin`) and any document-search command. Leave: dashboard `/`, `/users` (add in Task 4 — a placeholder link is fine now, or add after Task 4), `/account`, `/admin`. Remove imports of deleted components (e.g. document search).

- [ ] **Step 6: Remove now-orphaned dependencies**

Read `package.json` dependencies. Remove: `maplibre-gl`, `@vis.gl/react-maplibre`, `exifreader`, `@dnd-kit/accessibility`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `embla-carousel-react`, `react-phone-number-input`, `react-day-picker`. Keep `cmdk` (command palette), `blurhash` (avatar placeholder), `heic-convert`, `sharp`, `@vercel/blob`, `@aws-sdk/*`, `@tanstack/react-table` (used by the users table in Task 4 — verify; if unused after Task 4, remove then).

- [ ] **Step 7: Reinstall + find every orphaned import**

Run: `bun install && bun run build`
Expected: **this will fail** the first time with `tsc`/vite errors for imports of deleted modules. Fix each reported orphan: delete the dead import/usage, or the file if it's wholly domain-specific and was missed. Repeat `bun run build` until clean. Common orphans: `src/utils/seo.ts` refs, hooks, `messages` keys referenced in TS (those resolve via `m.*` — unused keys are harmless in TS but pruned in Step 8), test files for deleted services (delete matching `*.test.ts`).

- [ ] **Step 8: Prune i18n keys + orphaned tests**

- Delete `*.test.ts`/`*.browser.test.tsx` files for removed services/components (booking, document, folder, recommendation, share, season, tag, documentSearch, documentEvent).
- In `messages/sv.json` + `messages/en.json`, remove keys used only by deleted UI (nav_documents, nav_recommendations, share/season/booking/document strings, etc.). Keep both files key-identical. When unsure, keep the key (dead strings are harmless); prioritize removing obvious feature clusters.
- Run: `bun run i18n:compile` — must succeed and keep `sv`/`en` in sync.

- [ ] **Step 9: Run the gate**

Ensure the isolated local Postgres is up first (Task 1 remapped it to :14620): `bun run db:up` (starts the `db` container; migrations from the still-present Oceanview `drizzle/` apply — extra boat tables are harmless, they're cleaned in Task 4). Then:
Run: `bun run build && bun run test:node`
Expected: build clean; the node suite passes for the surviving services (user, file, effects, logger). Effect tests short-circuit to devLog/in-memory under `VITEST` (no storage/queue/mail container needed). If a browser test references a deleted component, delete that test. Bring `bun run test` (both projects) green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: strip sailboat domain features, keep infrastructure"
```

---

## Task 3: Add the `approved_email` allowlist (schema + service, test-first)

**Files:**
- Create: `src/lib/db/schema/approvedEmail.ts`
- Create: `src/lib/services/approvedEmail/approvedEmail.ts`, `.../errors.ts`, `.../index.ts`, `.../approvedEmail.test.ts`
- Modify: `src/lib/db/schema/index.ts`
- Test: `src/lib/services/approvedEmail/approvedEmail.test.ts`

**Interfaces:**
- Produces:
  - table `approvedEmail` (`id` uuid pk, `email` text unique not-null, `role` text `'user'|'admin'` default `'user'`, `addedByUserId` uuid nullable, `createdAt` timestamptz default now).
  - `normalizeEmail(email: string): string`
  - `isApproved(email: string): Promise<{ role: 'user' | 'admin' } | null>`
  - `listApproved(): Promise<ApprovedEmailRow[]>`
  - `addApproved(input: { email: string; role: 'user'|'admin'; addedByUserId: string | null }): Promise<ApprovedEmailRow>` — throws `ApprovedEmailDomainError('EMAIL_ALREADY_APPROVED')` on duplicate.
  - `removeApproved(email: string): Promise<void>`
  - `ApprovedEmailDomainError` with `code: 'EMAIL_ALREADY_APPROVED'`.
- Consumed by: Task 4 (auth gate + seeding), Task 5 (admin UI procedures).

- [ ] **Step 1: Write the schema file**

Create `src/lib/db/schema/approvedEmail.ts` mirroring the column style of `src/lib/db/schema/file.ts` (snake_case via the drizzle config; `timestamptz`):
```ts
import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const approvedEmail = pgTable('approved_email', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  addedByUserId: uuid('added_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```
Add `export * from './approvedEmail'` to `src/lib/db/schema/index.ts`.

- [ ] **Step 2: Write the failing service test**

Create `src/lib/services/approvedEmail/approvedEmail.test.ts`, mirroring `~/prog/priv/oceanview/src/lib/services/user/user.test.ts` for `setupDatabase()` usage:
```ts
import { describe, expect, it } from 'vitest'
import { setupDatabase } from '../../../../test/setup'
import { ApprovedEmailDomainError } from './errors'
import { addApproved, isApproved, listApproved, normalizeEmail, removeApproved } from './approvedEmail'

setupDatabase()

describe('approvedEmail service', () => {
  it('normalizes email to lowercase', () => {
    expect(normalizeEmail('Mail@Example.SE')).toBe('mail@example.se')
  })

  it('addApproved then isApproved returns the role', async () => {
    await addApproved({ email: 'Person@Example.se', role: 'user', addedByUserId: null })
    expect(await isApproved('person@example.se')).toEqual({ role: 'user' })
  })

  it('isApproved returns null for an unknown email', async () => {
    expect(await isApproved('nobody@example.se')).toBeNull()
  })

  it('addApproved rejects a duplicate (case-insensitive)', async () => {
    await addApproved({ email: 'dup@example.se', role: 'admin', addedByUserId: null })
    await expect(addApproved({ email: 'DUP@example.se', role: 'user', addedByUserId: null }))
      .rejects.toMatchObject({ code: 'EMAIL_ALREADY_APPROVED' })
  })

  it('removeApproved deletes the row', async () => {
    await addApproved({ email: 'gone@example.se', role: 'user', addedByUserId: null })
    await removeApproved('gone@example.se')
    expect(await isApproved('gone@example.se')).toBeNull()
  })

  it('listApproved returns all rows', async () => {
    await addApproved({ email: 'a@example.se', role: 'user', addedByUserId: null })
    await addApproved({ email: 'b@example.se', role: 'admin', addedByUserId: null })
    const rows = await listApproved()
    expect(rows.map((r) => r.email).sort()).toEqual(['a@example.se', 'b@example.se'])
  })
})
```

- [ ] **Step 2b: Confirm the test setup import path**

Check the relative path to `test/setup` from a sibling service test (open `src/lib/services/user/user.test.ts` and copy its exact `setupDatabase` import). Adjust the import in the test to match.

- [ ] **Step 3: Run the test — expect failure**

Run: `bun run test:node -- approvedEmail`
Expected: FAIL — `errors.ts` / `approvedEmail.ts` don't exist yet.

- [ ] **Step 4: Write `errors.ts`**

Create `src/lib/services/approvedEmail/errors.ts` mirroring an existing service `errors.ts` (e.g. the old `user` errors shape — a class extending `Error` with a discriminating `code` union):
```ts
export type ApprovedEmailErrorCode = 'EMAIL_ALREADY_APPROVED'

export class ApprovedEmailDomainError extends Error {
  constructor(public readonly code: ApprovedEmailErrorCode) {
    super(code)
    this.name = 'ApprovedEmailDomainError'
  }
}
```

- [ ] **Step 5: Write the service**

Create `src/lib/services/approvedEmail/approvedEmail.ts`:
```ts
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { approvedEmail } from '../../db/schema'
import { ApprovedEmailDomainError } from './errors'

export type ApprovedEmailRow = typeof approvedEmail.$inferSelect

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export async function isApproved(email: string): Promise<{ role: 'user' | 'admin' } | null> {
  const [row] = await db
    .select({ role: approvedEmail.role })
    .from(approvedEmail)
    .where(eq(approvedEmail.email, normalizeEmail(email)))
    .limit(1)
  return row ?? null
}

export async function listApproved(): Promise<ApprovedEmailRow[]> {
  return db.select().from(approvedEmail).orderBy(approvedEmail.createdAt)
}

export async function addApproved(input: {
  email: string
  role: 'user' | 'admin'
  addedByUserId: string | null
}): Promise<ApprovedEmailRow> {
  const email = normalizeEmail(input.email)
  if (await isApproved(email)) throw new ApprovedEmailDomainError('EMAIL_ALREADY_APPROVED')
  const [row] = await db
    .insert(approvedEmail)
    .values({ email, role: input.role, addedByUserId: input.addedByUserId })
    .returning()
  return row
}

export async function removeApproved(email: string): Promise<void> {
  await db.delete(approvedEmail).where(eq(approvedEmail.email, normalizeEmail(email)))
}
```
Create `src/lib/services/approvedEmail/index.ts`:
```ts
export * from './approvedEmail'
export * from './errors'
```

- [ ] **Step 6: Generate the migration for the new table**

(Deferred to Task 4 Step 7, where the full schema — auth changes + this table — is regenerated as one clean initial migration. For now the test relies on `setupDatabase()` running migrations; if no migration exists yet, generate a scoped one so the test can run:)
Run: `bun run db:up` (starts local postgres on :14620 — ports were isolated in Task 1) then `bun run db:generate --name=approved_email && bun run db:migrate`
Expected: a migration adding `approved_email`.

- [ ] **Step 7: Run the test — expect pass**

Run: `bun run test:node -- approvedEmail`
Expected: PASS (all 6 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(auth): add approved_email allowlist schema and service"
```

---

## Task 4: Rebuild Better Auth — Google + magic-link, allowlist gate, seeding

**Files:**
- Modify: `src/lib/auth.ts`, `src/lib/adminAllowlist.ts` (→ becomes allowlist-table-backed or is removed), `src/lib/authClient.ts`
- Create: `src/lib/seedApprovedEmails.ts` (startup seed from `INITIAL_ADMIN_EMAILS`)
- Regenerate: `src/lib/db/schema/betterAuth.ts` (via `bun run auth:schema`), `drizzle/` (one clean initial migration)
- Modify: `.env.example` (Google + seed vars) — full rewrite lands in Task 6; add the auth keys here
- Test: `src/lib/services/approvedEmail/gate.test.ts` (unit-test the allowlist decision helper)

**Interfaces:**
- Consumes: `isApproved`, `addApproved`, `normalizeEmail` (Task 3).
- Produces:
  - Better Auth configured with `socialProviders.google`, the `magicLink` plugin (allowlist-gated `sendMagicLink`), the `admin` plugin, `tanstackStartCookies()`; passkey plugin removed.
  - `resolveSignInDecision(email): Promise<{ allowed: boolean; role: 'user'|'admin' }>` helper used by the create hook + magic-link.
  - `seedApprovedEmails(): Promise<void>` — idempotently inserts `INITIAL_ADMIN_EMAILS` as admin `approved_email` rows.

- [ ] **Step 1: Fetch current Better Auth docs**

Use context7 (`resolve-library-id` → `query-docs`) or WebFetch for: `socialProviders.google` config, the `magicLink` plugin, `databaseHooks.user.create.before`, denying sign-in / throwing `APIError`, and revoking a user's sessions via `auth.api` (`admin` plugin). Confirm signatures before editing — do not rely on memory.

- [ ] **Step 2: Write the gate decision + its test (TDD)**

Create `src/lib/services/approvedEmail/gate.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { setupDatabase } from '../../../../test/setup'
import { addApproved } from './approvedEmail'
import { resolveSignInDecision } from './gate'

setupDatabase()

describe('resolveSignInDecision', () => {
  it('denies an email not on the allowlist', async () => {
    expect(await resolveSignInDecision('stranger@example.se')).toEqual({ allowed: false, role: 'user' })
  })
  it('allows an approved user with its recorded role', async () => {
    await addApproved({ email: 'boss@example.se', role: 'admin', addedByUserId: null })
    expect(await resolveSignInDecision('BOSS@example.se')).toEqual({ allowed: true, role: 'admin' })
  })
})
```
Run: `bun run test:node -- gate` → expect FAIL (no `gate.ts`).

Create `src/lib/services/approvedEmail/gate.ts`:
```ts
import { isApproved } from './approvedEmail'

export async function resolveSignInDecision(
  email: string,
): Promise<{ allowed: boolean; role: 'user' | 'admin' }> {
  const match = await isApproved(email)
  return match ? { allowed: true, role: match.role } : { allowed: false, role: 'user' }
}
```
Add `export * from './gate'` to the service `index.ts`. Run the test → expect PASS.

- [ ] **Step 3: Rewrite `auth.ts`**

Read the copied `src/lib/auth.ts` first. Then:
- Remove the `passkey` plugin import + entry and the passkey `rpID`/`origin` block.
- Keep the `magicLink` plugin, but change its `sendMagicLink` allowlist check from `findIdByEmail || isAllowlistedAdmin` to the allowlist table: deny when `!(await isApproved(normalizeEmail(email)))`, keeping the existing localized `APIError` message.
- Add `socialProviders`:
```ts
socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID as string,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
  },
},
```
- In `databaseHooks.user.create.before`, replace the `isAllowlistedAdmin` admin-promotion logic with the allowlist gate: look up `resolveSignInDecision(user.email)`; if `!allowed`, throw the Better Auth denial (per Step-1 docs) so no account is created for a non-approved email; otherwise set `role` from the decision (`return { data: { ...user, role } }`). This covers **both** Google and magic-link first sign-ins.
- Keep `admin()`, `tanstackStartCookies()`, session config, `rateLimit`, `backgroundTasks`, the `emailVerification`/invite mechanism (retargeted in Task 5), and the `additionalFields` minus `lastInvitedAt` if you move invite timing to `approved_email` (else keep it).
- Update the passkey-driven `session.create.after` welcome-back comment (passkey path gone; magic-link + Google now).

- [ ] **Step 4: Update `adminAllowlist.ts` + `authClient.ts`**

- `src/lib/adminAllowlist.ts`: the env-CSV admin check is superseded by the table. Either delete it (and its imports) or repurpose it as the seed source used by `seedApprovedEmails.ts`. Prefer delete; keep `normalizeEmail` living in the approvedEmail service.
- `src/lib/authClient.ts`: remove the passkey client plugin; ensure the client exposes `signIn.social` (Google) and `signIn.magicLink`. Verify against the Step-1 docs.

- [ ] **Step 5: Write the seed helper**

Create `src/lib/seedApprovedEmails.ts`:
```ts
import { addApproved, isApproved, normalizeEmail } from './services/approvedEmail'
import { logger } from './logger/server'

export async function seedApprovedEmails(): Promise<void> {
  const emails = (process.env.INITIAL_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean)
  for (const email of emails) {
    if (await isApproved(email)) continue
    await addApproved({ email, role: 'admin', addedByUserId: null })
    logger.info('seeded initial admin approved-email', { email })
  }
}
```
Wire it into the server startup. Read `src/server.ts` and the Nitro server plugins (`server/plugins/`); add a one-shot call to `seedApprovedEmails()` at server init (a Nitro plugin is the idiomatic spot — mirror `server/plugins/queueConsumer.ts` registration). It must run after migrations. Guard it so a failure logs, not crashes.

- [ ] **Step 6: Regenerate the Better Auth schema**

Run: `bun run auth:schema`
Expected: `src/lib/db/schema/betterAuth.ts` regenerated — now includes the OAuth `account` table, **no** passkey table; timestamps patched to `timestamptz` by `scripts/patchBetterAuthSchema.mjs`. Do not hand-edit the output.

- [ ] **Step 7: Regenerate migrations as one clean initial migration**

Since the dev DB is empty and no data exists:
```bash
rm -rf drizzle/*.sql drizzle/meta
bun run db:generate --name=init
```
Expected: a single `0000_init.sql` creating: better-auth tables (user + additionalFields, session, account, verification), `file`, `approved_email`. All timestamp columns emitted as `timestamp with time zone` (fresh CREATE TABLE — no `USING` clause needed). Review the SQL for correctness.

- [ ] **Step 8: Apply + verify against a local DB**

Run: `bun run db:up && bun run db:migrate` (local postgres on :14620 — ports isolated in Task 1).
Then: `bun run test:node`
Expected: migration applies; all node tests (approvedEmail, gate, user, file, effects) pass with the fresh schema.

- [ ] **Step 9: Build gate**

Run: `bun run build`
Expected: clean — no passkey imports remain, auth compiles, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` referenced.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(auth): Google + magic-link sign-in gated by approved_email allowlist"
```

---

## Task 5: Rework user management UI — `/users`, invite, revoke, admin-only mutations

**Files:**
- Create: `src/routes/_authenticated/users.tsx` (renamed from `owners.tsx` shape)
- Modify: `src/lib/orpc/procedures/user.ts` (invite/revoke/list retargeted at `approved_email`; enforce authz rule)
- Modify: `src/lib/services/user/*` (invite/revoke ops → allowlist-backed; drop magic-link-invite-row-creation)
- Modify: user components (`src/components/user/*`) — invite dialog, edit dialog, list; drop passkey UI in `account/security`
- Modify: `src/emails/InviteUserEmail.tsx` (+ its test) — reword for Google+magic-link access grant
- Modify: `src/components/AppSidebar.tsx` + command palette (`/users` link)
- Delete: passkey pieces missed in Task 2 — `src/components/passkey/`, `src/hooks/usePasskeys.ts`, `src/hooks/useSignInPasskey` usage, `src/lib/passkeyProviders.ts`, `src/lib/passkeyPrompt.ts`, `src/data/passkeyAaguids.json`, `src/lib/services/passkey/`, `src/routes/_authenticated/account/security.tsx` (or strip passkey from it)
- Test: `src/lib/services/user/*.test.ts` (invite/revoke), browser tests for the users list where present

**Interfaces:**
- Consumes: `addApproved`, `removeApproved`, `listApproved`, `isApproved` (Task 3); `auth.api` session-revoke (Task 4).
- Produces:
  - `user.list` (protected read): active users **and** pending approved-emails, each tagged `status: 'active' | 'pending'`.
  - `user.invite` (admin): `{ email, role }` → `addApproved` + enqueue `email_user_invited` (courtesy email w/ magic sign-in link).
  - `user.resendInvite` (admin): re-enqueue for a pending entry.
  - `user.revoke` (admin): `removeApproved(email)` + soft-delete matching user + `auth.api` revoke-all-sessions.
  - `user.updateAsAdmin` (admin): edit name/phone/role of an existing user.
  - self-scoped `user.me` / `user.updateOwnProfile` / `user.completeOnboarding` stay (protected, own-account only).

- [ ] **Step 1: Finish removing passkeys**

Delete the passkey files listed above. For `account/security.tsx`: if it only managed passkeys, delete it and its route; if it also hosts other settings, strip the passkey section and its imports. Update `account.tsx` nav/tabs to drop the security→passkey entry. Run `bun run build` and fix orphaned imports (login components still reference passkey — handled in Task 6, but remove obvious dead imports now).

- [ ] **Step 2: Read the reference invite/owners implementation**

Open in Oceanview: `src/lib/services/user/user.ts` (invite/`markInvited`/`resendInvite`/`updateAsAdmin`/`updateOwnProfile`/`completeOnboarding`), `src/lib/orpc/procedures/user.ts`, `src/routes/_authenticated/owners.tsx`, and `src/components/user/*` (invite dialog, edit dialog, list). Understand the current "invited = emailVerified false, row pre-created" model — you are replacing row-pre-creation with `approved_email` rows.

- [ ] **Step 3: Retarget the user service invite/revoke ops (test-first)**

Update `src/lib/services/user/user.test.ts` (and add cases) to assert the new behavior, then implement:
- `inviteUser({ email, role, actorUserId })` → `addApproved(...)` (no user row). Returns the pending entry. Maps duplicate to a code (`EMAIL_ALREADY_APPROVED`).
- `revokeUser({ email, actorUserId })` → `removeApproved(email)`; if a user row exists, soft-delete (`deletedAt = now`). Session revocation happens in the procedure via `auth.api` (effects/auth boundary), not the service.
- `listUsersAndPending()` → join active `user` rows (not deleted) with `approved_email` rows lacking a user; return `{ ..., status }`.
- Keep `updateAsAdmin` (name/phone/role), `updateOwnProfile` (self name/phone/avatar), `completeOnboarding`.
Run: `bun run test:node -- services/user` → green.

- [ ] **Step 4: Retarget the user procedures + enforce the authz rule**

In `src/lib/orpc/procedures/user.ts`:
- Reads (`me`, `list`) → `protectedProcedure`.
- **All mutations** (`invite`, `resendInvite`, `revoke`, `updateAsAdmin`) → `adminProcedure`.
- Self-account (`updateOwnProfile`, `completeOnboarding`) → `protectedProcedure`, operating only on `context.user.id`.
- `revoke`: after `revokeUser(...)`, revoke the target's sessions via `auth.api` (per Task-4 Step-1 docs) as a post-success effect.
- `invite`/`resendInvite`: after success, `queue.publish('email_user_invited', { to, inviteUrl, locale })`. Generate `inviteUrl` as a magic sign-in link per the Better Auth docs (server-side `auth.api` magic-link generation) with an invite-appropriate expiry, or a link to `/login` if generating server-side isn't supported — decide from the docs.
- Grep the whole `src/lib/orpc/procedures/` tree to confirm **no surviving mutation** uses `protectedProcedure` except the two self-account ops. This is the enforcement checkpoint for the global authz rule.

- [ ] **Step 5: Rename the route + rework components**

- Create `src/routes/_authenticated/users.tsx` from the old `owners.tsx` shape: a `@tanstack/react-table` list reading `user.list`, showing active + pending, with role + status columns. Admin-only actions (Invite button, row edit/revoke) gated on `user.role === 'admin'` (read-only users see the list only).
- Update `src/components/user/*`: the invite dialog collects `{ email, role }` (default `user`); the edit dialog edits name/phone/role (email immutable). Remove any passkey references.
- Update `AppSidebar.tsx` + command palette: nav label "Users" → `/users` (Swedish label via `m.nav_users`, add the message key to `messages/{sv,en}.json`).

- [ ] **Step 6: Reword the invite email**

Update `src/emails/InviteUserEmail.tsx` copy (both locales via props) to: "You've been granted access to Videbacken — sign in with Google or the link below." Keep the branded layout. Update `src/emails/InviteUserEmail.test.tsx` assertions to the new copy. Run: `bun run test:node -- InviteUser`.

- [ ] **Step 7: Gate**

Run: `bun run build && bun run test`
Expected: build clean; node + browser suites green. Fix any browser test referencing removed passkey/owners UI.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(users): allowlist-backed invite/revoke, admin-only mutations, /users route"
```

---

## Task 6: Login page — Google button + magic-link; trim onboarding to name + avatar

**Files:**
- Modify: `src/routes/login.tsx`, `src/components/login/{LoginFormCard,WelcomeBackCard,MagicLinkSentCard}.tsx`
- Modify: `src/hooks/*` (remove `usePasskeys`/`useSignInPasskey`/`useSavedLogin` passkey bits), `src/lib/browserSession*.ts` (drop `hasPasskey`)
- Modify: `src/routes/onboarding.tsx`, `src/components/onboarding/*` (drop phone step)
- Test: browser tests `src/components/login/*.browser.test.tsx`, onboarding tests

**Interfaces:**
- Consumes: `authClient.signIn.social({ provider: 'google', callbackURL })`, `authClient.signIn.magicLink({ email, callbackURL })` (Task 4).
- Produces: a `/login` with a Google button + magic-link email form; a 2-step `/onboarding` (name → avatar).

- [ ] **Step 1: Strip passkey from login**

In `login.tsx`: remove `useSignInPasskey`, `passkeyPending`, `onPasskeySignIn`, and passkey props threaded into the cards. In `LoginFormCard`/`WelcomeBackCard`: remove passkey buttons/props; `WelcomeBackCard` keeps the saved-email quick magic-link. Remove `hasPasskey` from `browserSession`/`useSavedLogin`.

- [ ] **Step 2: Add the Google button**

In `LoginFormCard` (and `WelcomeBackCard` as a secondary option), add a "Sign in with Google" button calling `authClient.signIn.social({ provider: 'google', callbackURL })`. Add message keys `login_google_button` (sv/en). Keep the existing magic-link email form + submit (`authClient.signIn.magicLink`). Verify the client API names against Task-4 Step-1 docs.

- [ ] **Step 3: Trim onboarding to name → avatar**

In `onboarding.tsx` + `src/components/onboarding/*`: remove the phone step and its `?step=phone` branch; steps become `name` → `avatar`. Pre-fill name + avatar from the Google profile (`user.name`, `user.image`). `completeOnboarding` stamps `onboardedAt`. `phone` stays editable only in account settings. Update `validateSearch` step union and the wizard progress. Keep the `_authenticated` loader's `onboardedAt == null → /onboarding` redirect.

- [ ] **Step 4: Update login/onboarding tests**

Update `*.browser.test.tsx` for login (no passkey; Google button present; magic-link form present) and onboarding (2 steps; no phone). Run: `bun run test:components`.

- [ ] **Step 5: Gate**

Run: `bun run build && bun run test`
Expected: green. `grep -rn "passkey\|Passkey\|usePasskeys" src` returns nothing (case-insensitive) except possibly comments to clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): Google + magic-link login; trim onboarding to name and avatar"
```

---

## Task 7: Rebrand + swap identity tokens

> **Ports were already remapped in Task 1.** This task does name/accent/logo + non-port identity tokens (cookies, buckets, creds, dev-log) + the `.env.example` rewrite. It must NOT re-touch ports except to re-verify none regressed.

**Files:**
- Modify: `package.json` (name), `README.md`, `src/components/Logo.tsx`, `src/emails/{theme,BrandEmailLayout}.tsx`, `src/styles/app.css` (or wherever `--brand` lives), `vite.config.ts` (cookieName), `compose.yaml` (bucket/cred names), `.env.example`, all remaining `oceanview` string sites (~55 files), `scripts/generateFavicons.mjs`, `public/` favicons
- Test: `bun run build`, grep sweeps

**Interfaces:**
- Produces: a fully rebranded app (name, muted-indigo accent, placeholder logo) with all `oceanview` identity tokens swapped to `videbacken`. Coexistence (ports) already holds from Task 1.

- [ ] **Step 1: Swap the app name (code-safe sites first)**

Replace `Oceanview` → `Videbacken` and `oceanview` → `videbacken` across: `package.json` `name`, UI strings in `messages/{sv,en}.json` (the untranslated brand word), `src/components/Logo.tsx` wordmark, email layout/theme, SEO helper, README, CLAUDE.md title. Do NOT blindly replace inside `node_modules`/`bun.lock`. Use a reviewed sweep:
```bash
grep -rli 'oceanview' src messages scripts public README.md CLAUDE.md AGENTS.md *.ts *.json *.yaml .env.example
```
Fix each file. Cookie/bucket/log identifiers handled in Steps 2–4 (don't miss them).

- [ ] **Step 2: Identity tokens**

- `vite.config.ts`: `cookieName: 'oceanview-locale'` → `'videbacken-locale'`.
- Theme cookie: `src/lib/theme.ts` + `__root.tsx` — `oceanview-theme` → `videbacken-theme`.
- Welcome-back / browser-session cookie names in `src/lib/browserSession*.ts` → `videbacken-*`.
- Storage buckets + S3 creds in `compose.yaml`, `.env.example`, `src/lib/effects/storage/*`: `oceanview-public/private` → `videbacken-public/private`; `oceanview-dev`/`oceanview-dev-secret-key` → `videbacken-dev*`.
- Dev log path: `package.json` `dev:log` + any ref — `/tmp/oceanview-dev.log` → `/tmp/videbacken-dev.log`.

- [ ] **Step 3: Re-verify port isolation (regression check only)**

Ports were remapped in Task 1. Confirm nothing reintroduced a 145xx literal:
```bash
grep -rnE '1450[0-9]|1452[0-9]|14327' src test *.ts *.yaml *.json .env.example scripts
```
Expected: empty. If anything appears, remap it (+100) as in Task 1.

- [ ] **Step 4: Muted-indigo `--brand` + placeholder logo/favicons**

- In the CSS where `--brand` (+ dark variant) is defined (search `--brand`), set a muted indigo for light and dark (e.g. light `oklch(0.55 0.12 275)`, dark `oklch(0.70 0.11 275)` — tune to match the existing token format). Leave `--primary` neutral.
- `src/components/Logo.tsx`: replace the mark with a plain placeholder lettermark "V" (keep dimensions/props so layout is unaffected).
- Regenerate favicons: update the source in `scripts/generateFavicons.mjs` (or its input asset) to the placeholder mark and run `bun run favicons:generate`. If that script needs a source image not present, generate a simple placeholder and note it in the README.

- [ ] **Step 5: Rewrite `.env.example`**

Rewrite for Videbacken: `DATABASE_URL=postgres://neon:npg@localhost:14620/neondb`, `BETTER_AUTH_URL=http://localhost:14600`, `BETTER_AUTH_SECRET=`, `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `INITIAL_ADMIN_EMAILS=mail@lukaslindqvist.se`, rebranded `S3_*`/`BLOB_*`/`SMTP_*`/`EMAIL_FROM=Videbacken <no-reply@videbacken.local>`, `REDIS_URL=redis://localhost:14621`, ports updated. Remove `VITE_MAPTILER_API_KEY` (maps stripped) and `ADMIN_EMAILS` (replaced by `INITIAL_ADMIN_EMAILS`). Keep explanatory comments, rebranded.

- [ ] **Step 6: Gate**

Run: `bun run build`
Expected: clean. Then `grep -rli oceanview src messages scripts public *.ts *.json *.yaml .env.example` → empty (case-insensitive), except intentional references to the reference project in `docs/` (allowed) — verify none in shipping code.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(brand): rebrand to Videbacken, remap ports, swap identity tokens"
```

---

## Task 8: Docs, ADRs, CI

> **Reconciliation from Task 1 review:** Task 1 already did the *mechanical* pnpm→bun swap in `ci.yml`, `README.md`, and `.github/PULL_REQUEST_TEMPLATE.md` (accepted — correct direction). This task still owns their FINAL form: `ci.yml`'s **structural** rewrite below, and `README.md`'s content. Also do a **residual-pnpm sweep** (Step 0) — Task 1 left `pnpm <script>` mentions in comments in `compose.yaml`, `.env.example`, `vite.config.ts`, and `.claude/agents/migration-guard.md`.

**Files:**
- Delete (ADRs): `docs/adr/{0009,0010,0012,0017,0018,0019,0020}-*.md`
- Modify: remaining ADRs (prune boat references), `docs/adr/0017`→ rewrite as auth ADR (or new file), `CLAUDE.md`, `README.md`, `AGENTS.md`, `docs/feature-workflow.md`/`refactor-workflow.md` (prune boat examples), and residual-pnpm-comment files (`compose.yaml`, `.env.example`, `vite.config.ts`, `.claude/agents/migration-guard.md`)
- Modify: `.github/workflows/ci.yml`, `.github/workflows/lint-pr-title.yml`; delete `.github/workflows/neon-branch-sweep.yml`
- Test: `bun run check:ci`; CI file lint

**Interfaces:**
- Produces: a coherent doc set + green, self-contained CI (no Neon secrets required); zero `pnpm` references in shipping files (except the auto-managed `@tanstack/intent` blocks in CLAUDE.md/AGENTS.md, which are regenerated by their tool).

- [ ] **Step 0: Residual-pnpm sweep**

Replace `pnpm <script>` → `bun run <script>` and `pnpm dlx` → `bunx` in comments/text across `compose.yaml`, `.env.example`, `vite.config.ts`, `.claude/agents/migration-guard.md`, and anywhere else `git grep -n "pnpm"` finds it in shipping files. **Do NOT touch** the `<!-- intent-skills:start -->…<!-- intent-skills:end -->` blocks in CLAUDE.md/AGENTS.md (auto-managed by `bunx @tanstack/intent`; the tool rewrites them). Verify: `git grep -n "pnpm" -- ':(exclude).superpowers'` shows only the intent-skills blocks.

- [ ] **Step 1: Prune + rewrite ADRs**

Delete boat-only ADRs (org-rules 0009, document-management 0010, recommended-places 0012, indivisible-shares 0018, season-eras 0019, season-booking 0020). Rewrite the invitation ADR 0017 into **"Authentication: Google + magic-link, email allowlist, admin-only mutation"** covering: two sign-in methods, the `approved_email` gate + seeding, invite/revoke, the global authz rule, name+avatar onboarding. In the kept ADRs (0001–0008, 0011, 0013–0016), remove sentences that reference deleted features (documents, shares, seasons, recommendations, passkeys); keep the architecture guidance.

- [ ] **Step 2: Rewrite CLAUDE.md**

Rewrite as a router for the trimmed ADR set + the new stack facts: bun commands throughout; the auth/authz model (Google + magic-link, allowlist, admins-mutate/users-read-only); Videbacken branding; the remapped ports; drop the boat-domain code-map entries and "decisions made" bullets about shares/seasons/booking/documents/places. Update the `@tanstack/intent` blocks to `bunx`. Keep the architecture non-negotiables that still hold.

- [ ] **Step 3: Rewrite README**

bun-based Develop section (ports 146xx); a Setup section documenting: create a Neon project (or use the local Postgres container), create a Vercel project, create a Google OAuth client with redirect URIs `http://localhost:14600/api/auth/callback/google` (dev) + the prod URL, set `INITIAL_ADMIN_EMAILS`. State that Google sign-in E2E requires these creds.

- [ ] **Step 4: Convert CI to bun + self-contained Postgres**

Rewrite `.github/workflows/ci.yml`:
- All jobs: replace `pnpm/action-setup` + `actions/setup-node cache: pnpm` with `oven-sh/setup-bun@v2`; `pnpm install --frozen-lockfile` → `bun install --frozen-lockfile`; `pnpm <script>` → `bun run <script>`; `pnpm exec playwright` → `bunx playwright`.
- Drop the `audit` job (was pre-existing red; keep CI green for a template) — or keep it non-required; prefer drop.
- `test` job: replace the ephemeral-Neon-branch steps with a `services: postgres:17-alpine` container (env `POSTGRES_USER=neon`, `POSTGRES_PASSWORD=npg`, `POSTGRES_DB=neondb`, mapped to 14620), set `DATABASE_URL=postgres://neon:npg@localhost:14620/neondb`, and run migrations before `bun run test`. Remove the Neon secrets usage. Update `BETTER_AUTH_URL` to `http://localhost:14600`, drop `ADMIN_EMAILS`.
- Delete `.github/workflows/neon-branch-sweep.yml`.
- Keep `lint-pr-title.yml` as-is (no pnpm in it).

- [ ] **Step 5: Gate**

Run: `bun run check:ci`
Expected: Biome clean. Sanity-check the CI YAML parses (`grep -n` the job names; optional `actionlint` if available).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: trim ADRs to infrastructure, rewrite auth ADR, move CI to bun"
```

---

## Task 9: Full verification

**Files:** none (verification only). Fix-forward any failure in the owning task's spirit.

- [ ] **Step 1: Clean install + build + typecheck**

Run: `rm -rf node_modules && bun install && bun run i18n:compile && bun run build`
Expected: all clean from a cold start.

- [ ] **Step 2: Lint**

Run: `bun run check:ci`
Expected: Biome reports no changes needed.

- [ ] **Step 3: Full test suite**

Run: `bun run dev:up` (docker db/queue/mail/storage on 146xx + migrate), then `bun run test`
Expected: node + Chromium browser suites green.

- [ ] **Step 4: Dev-server smoke test**

Run: `bun run dev` and confirm it serves on `http://localhost:14600`. Load `/login` — the Google button + magic-link form render with Videbacken branding + muted-indigo wash. Confirm `/` redirects to `/login` when unauthenticated. (Full Google round-trip is deferred — no OAuth creds; documented in README.)

- [ ] **Step 5: Coexistence check**

Confirm no port/bucket/cookie collides with a running Oceanview: `grep -rnE '1450[0-9]|1452[0-9]' . --include='*.ts' --include='*.yaml' --include='*.json'` is empty, and the two docker projects use distinct ports.

- [ ] **Step 6: Final commit / tag**

```bash
git add -A
git commit -m "chore: verified Videbacken starter template" --allow-empty
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** stack copy → Task 0; bun → Task 1; strip domains → Task 2; allowlist schema/service → Task 3; Google+magic-link+gate+seed → Task 4; invite/revoke/users + admin-only authz → Task 5; login + onboarding trim → Task 6; branding/ports/tokens → Task 7; ADRs/CLAUDE/README/CI → Task 8; verification (incl. honest Google-E2E gap) → Task 9. All spec sections map to a task.
- **Placeholder scan:** no "TBD"/"implement later". Deferred exact code is limited to Better-Auth-API-volatile spots, each gated on a docs-fetch step (spec constraint), and to faithful copies of existing files (each preceded by a "read the current file" step) — not invented behavior.
- **Type consistency:** `isApproved`, `resolveSignInDecision`, `addApproved`, `removeApproved`, `listApproved`, `seedApprovedEmails`, `ApprovedEmailDomainError('EMAIL_ALREADY_APPROVED')` used consistently across Tasks 3–5. Procedure gating (`protectedProcedure` reads / `adminProcedure` mutations / self-account exception) is consistent with `context.ts`.
- **Ordering:** auth.ts config precedes `auth:schema` regen (so the right tables emit); migration regen (Task 4) follows both strip (Task 2) and auth schema (Task 4); ports/branding (Task 7) after functional correctness; docs/CI (Task 8) last before final verification.
