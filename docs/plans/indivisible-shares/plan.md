# Indivisible Shares Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove split-share ownership per [ADR-0018](../../adr/0018-indivisible-shares.md): a share (A–J) is owned whole by exactly one user or unassigned; `share_part` and `ownership_assignment_event` are dropped; per-share ownership history stays a first-class feature.

**Architecture:** The `share_code` pgEnum *is* the share (no table). A flat `ownership_assignment` table holds one row per ownership stint (`assignedTo IS NULL` = active) and carries `actorUserId` itself. Layers change along the dependency spine: migration → share service → season service → oRPC procedures → UI → i18n → docs. Season/calendar math is functionally untouched (20 weeks, 2 consecutive weeks per share, 6-week slip per season).

**Tech Stack:** Drizzle + postgres-js (Neon Postgres), oRPC + TanStack Query, TanStack Start/Router, @tanstack/react-form via `useAppForm`, Paraglide i18n, Vitest (node project = per-test schema DB tests).

**Branch:** `feat/indivisible-shares` (already exists; ADR-0018 committed on it). All work lands there; PR squash-merges to `main`.

## Global Constraints

- All `db` access through `src/lib/services/<entity>/` (ADR-0002). Procedures are thin glue.
- Logging via `context.log` in procedures; never `console.*` (ADR-0003).
- Realtime: mutating share procedures publish `{ kind: 'share.changed', ids: [shareCode] }` (ADR-0004).
- Forms via `useAppForm`; never `useState` for field values (ADR-0005).
- User-facing strings via `m.<key>()` from `~/paraglide/messages`; sv is source of truth, en stays key-complete. After editing `messages/*.json` outside `pnpm dev`: `pnpm i18n:compile`.
- Zod per-field message overrides must be lazy callbacks: `{ error: () => m.key() }`, never string literals.
- Migrations: always `--name=`; all timestamps `timestamp({ withTimezone: true })`.
- The share oRPC router **stays message-based** (`rethrowAsORPC` → Swedish `ORPCError`) — do not convert to code-only errors in this PR.
- Every remaining `ShareDomainError` code literal must be exercised by a test (ADR-0002; `test-completeness` agent enforces).
- Conventional Commits, ≤72-char imperative subject. Branch commits may be scrappy; the PR title/description must be clean (squash-merge).
- **Never run `vercel env pull`** (prod `DATABASE_URL` hazard). Local DB is the plain postgres container on :14520 (`pnpm db:up`).
- **Suite-green checkpoints:** this is a cross-layer rework; tasks 1–5 keep *their own* test files green (commands given per task), and Task 7 is the first point where `pnpm test` + `pnpm build` must be fully green. Do not "fix forward" unrelated red outside the listed checkpoints — if something unexpected breaks, stop and investigate (superpowers:systematic-debugging).

---

### Task 1: Schema + migration 0018

**Files:**
- Modify: `src/lib/db/schema/ownership.ts`
- Create: `drizzle/0018_indivisible_shares.sql` (via `pnpm db:generate`, then hand-tuned)
- Auto-updated: `drizzle/meta/_journal.json`, `drizzle/meta/0018_snapshot.json`

**Interfaces:**
- Produces: `ownershipAssignment` Drizzle table with columns `id (uuid)`, `shareCode (share_code enum)`, `userId (uuid)`, `actorUserId (uuid | null)`, `assignedFrom (date)`, `assignedTo (date | null)`, `createdAt (timestamptz)`. Exports `shareCodeEnum`, `season` (unchanged), `ownershipAssignment`, `seasonRelations`-free (season has none today), `ownershipAssignmentRelations`. `sharePart`, `ownershipAssignmentEvent` and their relations are **gone**.

- [ ] **Step 1: Rewrite the ownership schema**

Replace the full contents of `src/lib/db/schema/ownership.ts` with:

```ts
import { relations, sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'

export const shareCodeEnum = pgEnum('share_code', [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
])

export const season = pgTable(
  'season',
  {
    year: integer('year').primaryKey(),
    startWeek: integer('start_week').notNull(),
    startShare: shareCodeEnum('start_share').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [check('season_start_week_check', sql`${table.startWeek} BETWEEN 1 AND 53`)],
)

// One row per ownership stint: `userId` owned `shareCode` from `assignedFrom`
// (inclusive) until `assignedTo` (exclusive); NULL assignedTo = active. Rows
// are only ever closed, never deleted — this table IS the per-share history.
// Shares are indivisible (ADR-0018): the share_code enum is the share (no
// share table), and each row is one whole admin decision, so `actorUserId`
// lives here directly (nullable so admin deletion doesn't fail, and so
// system-generated rows can record no actor).
export const ownershipAssignment = pgTable(
  'ownership_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shareCode: shareCodeEnum('share_code').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    // Half-open: owner from `assignedFrom` (inclusive) until `assignedTo`
    // (exclusive). `assignedTo IS NULL` means the assignment is still active.
    assignedFrom: date('assigned_from', { mode: 'date' }).notNull(),
    assignedTo: date('assigned_to', { mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ownership_assignment_share_code_idx').on(table.shareCode),
    index('ownership_assignment_user_id_idx').on(table.userId),
    uniqueIndex('ownership_assignment_one_current_per_share_idx')
      .on(table.shareCode)
      .where(sql`${table.assignedTo} IS NULL`),
    check(
      'ownership_assignment_range_check',
      sql`${table.assignedTo} IS NULL OR ${table.assignedTo} > ${table.assignedFrom}`,
    ),
  ],
)

export const ownershipAssignmentRelations = relations(ownershipAssignment, ({ one }) => ({
  user: one(user, {
    fields: [ownershipAssignment.userId],
    references: [user.id],
  }),
  actor: one(user, {
    fields: [ownershipAssignment.actorUserId],
    references: [user.id],
  }),
}))
```

Note: `sharePart`, `ownershipAssignmentEvent`, `sharePartRelations`, `ownershipAssignmentEventRelations` are deleted. `schema/index.ts` needs no change (it re-exports `./ownership` wholesale).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate --name=indivisible_shares`

Expected: creates `drizzle/0018_indivisible_shares.sql` + `drizzle/meta/0018_snapshot.json`, and appends `{ "idx": 18, ..., "tag": "0018_indivisible_shares" }` to `drizzle/meta/_journal.json`.

If drizzle-kit prompts about the `share_code` column ("create column" vs "rename from part_id"), choose **create column** (it is a new enum column, not a rename).

- [ ] **Step 3: Hand-tune the generated SQL to drop-and-recreate**

The diff-generated SQL will try to ALTER `ownership_assignment` in place (e.g. `ADD COLUMN share_code ... NOT NULL`), which fails on any non-empty table. Existing part-level rows cannot be mapped to whole-share rows, and we are pre-launch (ADR-0018: destructive by design). Replace the **entire body** of `drizzle/0018_indivisible_shares.sql` with:

```sql
-- ADR-0018: shares become indivisible. Destructive by design (pre-launch):
-- part-level assignment rows cannot be mapped to whole-share rows, so the
-- ownership tables are dropped and recreated. The share_code enum survives
-- (season.start_share uses it); share_part and the event parent table go away.
DROP TABLE "ownership_assignment";--> statement-breakpoint
DROP TABLE "ownership_assignment_event";--> statement-breakpoint
DROP TABLE "share_part";--> statement-breakpoint
CREATE TABLE "ownership_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_code" "share_code" NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"assigned_from" date NOT NULL,
	"assigned_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_assignment_range_check" CHECK ("assigned_to" IS NULL OR "assigned_to" > "assigned_from")
);--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_assignment" ADD CONSTRAINT "ownership_assignment_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ownership_assignment_share_code_idx" ON "ownership_assignment" USING btree ("share_code");--> statement-breakpoint
CREATE INDEX "ownership_assignment_user_id_idx" ON "ownership_assignment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_assignment_one_current_per_share_idx" ON "ownership_assignment" USING btree ("share_code") WHERE "assigned_to" IS NULL;
```

Keep the `--> statement-breakpoint` markers exactly — `test/setup.ts` and the migrator split on them. Compare the generated snapshot's constraint/index names against the SQL above and align the SQL to whatever names the snapshot uses (the snapshot is what future diffs run against).

- [ ] **Step 4: Smoke-test the migration locally**

Run: `pnpm db:up && pnpm db:migrate`
Expected: exits 0. (Applies 0018 to the local dev DB — old part tables drop, new table created. Prod applies it via `vercel-build` on deploy; the destructive migration is the "reset" for ownership data.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema/ownership.ts drizzle/
git commit -m "feat(db): indivisible shares schema + migration 0018 (ADR-0018)"
```

Note: from this commit until Task 3 completes, `src/lib/services/share/share.test.ts` and the season DB tests are red (they reference dropped tables). That is expected — they are rewritten in Tasks 3–4.

---

### Task 2: Vocabulary — codes.ts; delete dead part concepts

**Files:**
- Modify: `src/lib/shares/codes.ts`
- Delete: `src/lib/shares/collapse.ts`, `src/lib/shares/collapse.test.ts`, `src/components/share/ShareBadge.tsx`

**Interfaces:**
- Produces: `WEEKS_PER_SHARE = 2`, `YEAR_WEEK_SLIP = 6`, `WEEKS_PER_SEASON = 20`, `DEFAULT_YEAR_ROTATION = -3` (derived). `SHARE_CODES`, `ShareCode`, `isShareCode`, `shareIndexOf`, `rotateShare`, `ANCHOR_START_SHARE` unchanged.
- Removes: `PARTS_PER_SHARE`, `SharePartId`, `sharePartId`, `collapseShares`, `ShareBadgeKind`.

- [ ] **Step 1: Rewrite `src/lib/shares/codes.ts`**

```ts
export const SHARE_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const

export type ShareCode = (typeof SHARE_CODES)[number]

// Calendar truth: each share occupies this many consecutive weeks per season.
// Purely week math since ADR-0018 — shares are indivisible, so there is no
// ownership concept of a "part" anymore.
export const WEEKS_PER_SHARE = 2
export const WEEKS_PER_SEASON = SHARE_CODES.length * WEEKS_PER_SHARE

// The schedule slips 6 weeks per season for every share (e.g. share A:
// weeks 21/22 → 27/28 the following year). Expressed as a start-share
// rotation: -3 share positions × WEEKS_PER_SHARE = 6 weeks. Stored
// per-season so admins can deviate when calendar quirks demand it; this is
// just the default used when creating a new season after an existing one.
export const YEAR_WEEK_SLIP = 6
export const DEFAULT_YEAR_ROTATION = -(YEAR_WEEK_SLIP / WEEKS_PER_SHARE)

// The reference row in the historical schedule: 2024 starts at share J.
export const ANCHOR_START_SHARE: ShareCode = 'J'

export function isShareCode(value: string): value is ShareCode {
  return (SHARE_CODES as readonly string[]).includes(value)
}

export function shareIndexOf(code: ShareCode): number {
  return SHARE_CODES.indexOf(code)
}

export function rotateShare(code: ShareCode, offset: number): ShareCode {
  const n = SHARE_CODES.length
  const idx = (((shareIndexOf(code) + offset) % n) + n) % n
  return SHARE_CODES[idx]
}
```

- [ ] **Step 2: Delete the dead files**

```bash
git rm src/lib/shares/collapse.ts src/lib/shares/collapse.test.ts src/components/share/ShareBadge.tsx
```

(`collapseShares` existed only to render A1+A2 pairs as one badge; `src/components/share/ShareBadge.tsx` is imported by nothing — `OwnersTable` defines its own local `ShareBadge`. Verify before deleting: `grep -rn "components/share/ShareBadge" src/` must return nothing.)

- [ ] **Step 3: Commit**

```bash
git add -A src/lib/shares src/components/share
git commit -m "refactor(shares): week-based vocabulary; drop part/collapse concepts"
```

---

### Task 3: Share service rewrite (TDD)

**Files:**
- Modify: `src/lib/services/share/errors.ts`
- Modify: `src/lib/services/share/share.ts` (full rewrite)
- Modify: `src/lib/services/share/share.test.ts` (full rewrite — **written first**)
- Unchanged: `src/lib/services/share/index.ts` (barrel already re-exports `./errors` + `./share`)

**Interfaces:**
- Consumes: `ownershipAssignment` from Task 1; `SHARE_CODES`, `ShareCode` from Task 2; `userService.findActiveById(userId, tx)`.
- Produces (the service's entire public surface — everything else is deleted):
  - `type AssignmentRow = { id: string; shareCode: ShareCode; userId: string; actorUserId: string | null; assignedFrom: Date; assignedTo: Date | null }`
  - `type ShareWithCurrentOwnerRow = { shareCode: ShareCode; currentUserId: string | null }`
  - `listSharesWithCurrentOwner(): Promise<Array<ShareWithCurrentOwnerRow>>` — always 10 rows, A→J
  - `listCurrentSharesForUser(userId: string): Promise<Array<ShareCode>>` — sorted A→J
  - `getCurrentOwner(shareCode: ShareCode): Promise<string | null>`
  - `listShareHistory(shareCode: ShareCode): Promise<Array<AssignmentRow>>` — newest first
  - `assignShareAsAdmin(input: { shareCode: ShareCode; userId: string; from: Date }, ctx?: { actorUserId?: string | null }): Promise<void>`
  - `unassignShareAsAdmin(input: { shareCode: ShareCode; on: Date }): Promise<void>`
  - `ShareDomainError` with code union `'USER_NOT_FOUND' | 'ALREADY_CURRENT_OWNER' | 'FROM_DATE_NOT_AFTER_CURRENT' | 'NOT_ASSIGNED' | 'DATE_NOT_AFTER_CURRENT'`
- Deleted (deletion test — only tests consumed them): `listParts`, `findPartById`, `listPartsWithCurrentOwner`, `getOwnerAt`, `listAssignmentsForUser`, `listCurrentPartsForUser`, `listAssignmentHistory`, `listShareEvents`, `assignPart`, `unassignPart`, `LEAVES_USER_WITH_ONLY_HALVES`, `assertEveryAffectedUserHasWhole`, types `SharePartRow`, `PartWithCurrentOwnerRow`, `ShareEventRow`, `AssignPartInput`.

- [ ] **Step 1: Shrink the error union**

Replace `src/lib/services/share/errors.ts` with:

```ts
export type ShareDomainErrorCode =
  | 'USER_NOT_FOUND'
  | 'ALREADY_CURRENT_OWNER'
  | 'FROM_DATE_NOT_AFTER_CURRENT'
  | 'NOT_ASSIGNED'
  | 'DATE_NOT_AFTER_CURRENT'

export class ShareDomainError extends Error {
  constructor(public readonly code: ShareDomainErrorCode) {
    super(code)
    this.name = 'ShareDomainError'
  }
}
```

- [ ] **Step 2: Write the failing test file**

Replace the full contents of `src/lib/services/share/share.test.ts` with:

```ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { ownershipAssignment, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import type { ShareDomainError } from './errors'
import {
  assignShareAsAdmin,
  getCurrentOwner,
  listCurrentSharesForUser,
  listShareHistory,
  listSharesWithCurrentOwner,
  unassignShareAsAdmin,
} from './share'

setupDatabase()

async function seedUsers(...names: Array<string>): Promise<Array<string>> {
  const rows = await db
    .insert(user)
    .values(names.map((name) => ({ name, email: `${name.toLowerCase()}@test.oceanview.local` })))
    .returning({ id: user.id })
  return rows.map((r) => r.id)
}

test('getCurrentOwner returns null when the share has never been assigned', async () => {
  expect(await getCurrentOwner('A')).toBeNull()
})

test('assignShareAsAdmin creates an active assignment and records the actor', async () => {
  const [aliceId, adminId] = await seedUsers('Alice', 'Admin')

  await assignShareAsAdmin(
    { shareCode: 'A', userId: aliceId, from: new Date('2024-01-01') },
    { actorUserId: adminId },
  )

  expect(await getCurrentOwner('A')).toBe(aliceId)
  const history = await listShareHistory('A')
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({
    shareCode: 'A',
    userId: aliceId,
    actorUserId: adminId,
    assignedTo: null,
  })
})

test('reassigning closes the prior stint on the new from date (half-open)', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')

  await assignShareAsAdmin({ shareCode: 'A', userId: aliceId, from: new Date('2024-01-01') })
  await assignShareAsAdmin({ shareCode: 'A', userId: bobId, from: new Date('2025-01-01') })

  expect(await getCurrentOwner('A')).toBe(bobId)

  const history = await listShareHistory('A')
  expect(history).toHaveLength(2)
  // Newest first; prior stint closed exactly at the new from date.
  expect(history[0]).toMatchObject({ userId: bobId, assignedTo: null })
  expect(history[1].userId).toBe(aliceId)
  expect(history[1].assignedTo?.toISOString().slice(0, 10)).toBe('2025-01-01')
})

test('assignShareAsAdmin rejects assigning to the current owner', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2024-01-01') })

  await expect(
    assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2025-01-01') }),
  ).rejects.toMatchObject({ code: 'ALREADY_CURRENT_OWNER' } satisfies Partial<ShareDomainError>)
})

test('assignShareAsAdmin rejects a from-date not after the current assignedFrom', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')
  await assignShareAsAdmin({ shareCode: 'C', userId: aliceId, from: new Date('2024-06-01') })

  await expect(
    assignShareAsAdmin({ shareCode: 'C', userId: bobId, from: new Date('2024-06-01') }),
  ).rejects.toMatchObject({
    code: 'FROM_DATE_NOT_AFTER_CURRENT',
  } satisfies Partial<ShareDomainError>)
})

test('assignShareAsAdmin rejects an unknown user', async () => {
  await expect(
    assignShareAsAdmin({
      shareCode: 'D',
      userId: '00000000-0000-0000-0000-000000000000',
      from: new Date('2024-01-01'),
    }),
  ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' } satisfies Partial<ShareDomainError>)
})

test('listSharesWithCurrentOwner returns all 10 shares A→J with owners left-joined', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'D', userId: aliceId, from: new Date('2024-01-01') })

  const rows = await listSharesWithCurrentOwner()
  expect(rows).toHaveLength(10)
  expect(rows.map((r) => r.shareCode)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
  expect(rows.find((r) => r.shareCode === 'D')?.currentUserId).toBe(aliceId)
  expect(rows.find((r) => r.shareCode === 'E')?.currentUserId).toBeNull()
})

test('listCurrentSharesForUser returns owned share codes sorted A→J', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'G', userId: aliceId, from: new Date('2024-01-01') })
  await assignShareAsAdmin({ shareCode: 'B', userId: aliceId, from: new Date('2024-01-01') })

  expect(await listCurrentSharesForUser(aliceId)).toEqual(['B', 'G'])
})

test('unassignShareAsAdmin closes the stint and preserves history', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'E', userId: aliceId, from: new Date('2024-01-01') })

  await unassignShareAsAdmin({ shareCode: 'E', on: new Date('2024-06-30') })

  expect(await getCurrentOwner('E')).toBeNull()
  const history = await listShareHistory('E')
  expect(history).toHaveLength(1)
  expect(history[0].assignedTo?.toISOString().slice(0, 10)).toBe('2024-06-30')
})

test('a share can be reassigned after an unassign gap', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')
  await assignShareAsAdmin({ shareCode: 'F', userId: aliceId, from: new Date('2024-01-01') })
  await unassignShareAsAdmin({ shareCode: 'F', on: new Date('2024-06-30') })
  await assignShareAsAdmin({ shareCode: 'F', userId: bobId, from: new Date('2025-01-01') })

  expect(await getCurrentOwner('F')).toBe(bobId)
  expect(await listShareHistory('F')).toHaveLength(2)
})

test('unassignShareAsAdmin throws NOT_ASSIGNED when the share has no active stint', async () => {
  await expect(
    unassignShareAsAdmin({ shareCode: 'H', on: new Date('2024-06-30') }),
  ).rejects.toMatchObject({ code: 'NOT_ASSIGNED' } satisfies Partial<ShareDomainError>)
})

test('unassignShareAsAdmin rejects a date not after the current assignedFrom', async () => {
  const [aliceId] = await seedUsers('Alice')
  await assignShareAsAdmin({ shareCode: 'I', userId: aliceId, from: new Date('2024-01-01') })

  await expect(
    unassignShareAsAdmin({ shareCode: 'I', on: new Date('2024-01-01') }),
  ).rejects.toMatchObject({ code: 'DATE_NOT_AFTER_CURRENT' } satisfies Partial<ShareDomainError>)
})

test('partial unique index forbids two simultaneously-open assignments for one share', async () => {
  const [aliceId, bobId] = await seedUsers('Alice', 'Bob')

  await db.insert(ownershipAssignment).values({
    shareCode: 'G',
    userId: aliceId,
    assignedFrom: new Date('2024-01-01'),
    assignedTo: null,
  })

  await expect(
    db.insert(ownershipAssignment).values({
      shareCode: 'G',
      userId: bobId,
      assignedFrom: new Date('2024-06-01'),
      assignedTo: null,
    }),
  ).rejects.toThrow()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:node src/lib/services/share/share.test.ts`
Expected: FAIL — the old `share.ts` doesn't export `listSharesWithCurrentOwner` etc. (compile errors against the new schema).

- [ ] **Step 4: Rewrite the service**

Replace the full contents of `src/lib/services/share/share.ts` with:

```ts
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '~/lib/db'
import { ownershipAssignment } from '~/lib/db/schema'
import * as userService from '~/lib/services/user'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { ShareDomainError } from './errors'

export type AssignmentRow = {
  id: string
  shareCode: ShareCode
  userId: string
  actorUserId: string | null
  assignedFrom: Date
  assignedTo: Date | null
}

export type ShareWithCurrentOwnerRow = {
  shareCode: ShareCode
  currentUserId: string | null
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbOrTx = typeof db | DbTransaction

const assignmentSelection = {
  id: ownershipAssignment.id,
  shareCode: ownershipAssignment.shareCode,
  userId: ownershipAssignment.userId,
  actorUserId: ownershipAssignment.actorUserId,
  assignedFrom: ownershipAssignment.assignedFrom,
  assignedTo: ownershipAssignment.assignedTo,
}

// Admin grid view: every share A→J with its current owner (or null). The
// share_code enum is the share (ADR-0018), so the 10 rows are driven from
// SHARE_CODES in code and only active assignments are read from the DB.
export async function listSharesWithCurrentOwner(): Promise<Array<ShareWithCurrentOwnerRow>> {
  const active = await db
    .select({ shareCode: ownershipAssignment.shareCode, userId: ownershipAssignment.userId })
    .from(ownershipAssignment)
    .where(isNull(ownershipAssignment.assignedTo))
  const byShare = new Map(active.map((r) => [r.shareCode, r.userId]))
  return SHARE_CODES.map((shareCode) => ({
    shareCode,
    currentUserId: byShare.get(shareCode) ?? null,
  }))
}

export async function getCurrentOwner(shareCode: ShareCode): Promise<string | null> {
  const active = await getActiveAssignment(shareCode)
  return active?.userId ?? null
}

async function getActiveAssignment(
  shareCode: ShareCode,
  dbOrTx: DbOrTx = db,
): Promise<AssignmentRow | null> {
  const [row] = await dbOrTx
    .select(assignmentSelection)
    .from(ownershipAssignment)
    .where(
      and(eq(ownershipAssignment.shareCode, shareCode), isNull(ownershipAssignment.assignedTo)),
    )
    .limit(1)
  return row ?? null
}

export async function listCurrentSharesForUser(userId: string): Promise<Array<ShareCode>> {
  const rows = await db
    .select({ shareCode: ownershipAssignment.shareCode })
    .from(ownershipAssignment)
    .where(and(eq(ownershipAssignment.userId, userId), isNull(ownershipAssignment.assignedTo)))
    .orderBy(asc(ownershipAssignment.shareCode))
  return rows.map((r) => r.shareCode)
}

// Per-share history, newest first. Rows are only ever closed, never deleted,
// so this is the share's complete ownership timeline (powers the admin
// history sheet).
export async function listShareHistory(shareCode: ShareCode): Promise<Array<AssignmentRow>> {
  return db
    .select(assignmentSelection)
    .from(ownershipAssignment)
    .where(eq(ownershipAssignment.shareCode, shareCode))
    .orderBy(desc(ownershipAssignment.assignedFrom))
}

export type AssignShareInput = {
  shareCode: ShareCode
  userId: string
  from: Date
}

export type UnassignShareInput = {
  shareCode: ShareCode
  on: Date
}

// Admin entry-points: check-first invariants inside the mutation tx
// (ADR-0002); typed ShareDomainError so the procedure layer can map to
// Swedish ORPCError. Concurrent-admin check-then-write races are accepted
// at this scale; the partial unique index is the silent backstop.
export async function assignShareAsAdmin(
  input: AssignShareInput,
  ctx: { actorUserId?: string | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    // Active-user check; a deleted user can never be assigned. Must run on
    // `tx`: with the test pool pinned to one connection, an outer-`db` query
    // inside this transaction would wait on the connection the tx holds.
    const u = await userService.findActiveById(input.userId, tx)
    if (!u) throw new ShareDomainError('USER_NOT_FOUND')

    const existing = await getActiveAssignment(input.shareCode, tx)
    if (existing && existing.userId === input.userId) {
      throw new ShareDomainError('ALREADY_CURRENT_OWNER')
    }
    if (existing && input.from.getTime() <= existing.assignedFrom.getTime()) {
      throw new ShareDomainError('FROM_DATE_NOT_AFTER_CURRENT')
    }

    if (existing) {
      await tx
        .update(ownershipAssignment)
        .set({ assignedTo: input.from })
        .where(
          and(
            eq(ownershipAssignment.shareCode, input.shareCode),
            isNull(ownershipAssignment.assignedTo),
          ),
        )
    }
    await tx.insert(ownershipAssignment).values({
      shareCode: input.shareCode,
      userId: input.userId,
      actorUserId: ctx.actorUserId ?? null,
      assignedFrom: input.from,
      assignedTo: null,
    })
  })
}

export async function unassignShareAsAdmin(input: UnassignShareInput): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await getActiveAssignment(input.shareCode, tx)
    if (!existing) throw new ShareDomainError('NOT_ASSIGNED')
    if (input.on.getTime() <= existing.assignedFrom.getTime()) {
      throw new ShareDomainError('DATE_NOT_AFTER_CURRENT')
    }
    await tx
      .update(ownershipAssignment)
      .set({ assignedTo: input.on })
      .where(
        and(
          eq(ownershipAssignment.shareCode, input.shareCode),
          isNull(ownershipAssignment.assignedTo),
        ),
      )
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:node src/lib/services/share/share.test.ts`
Expected: PASS (13 tests). Every code in `ShareDomainErrorCode` is asserted: `USER_NOT_FOUND`, `ALREADY_CURRENT_OWNER`, `FROM_DATE_NOT_AFTER_CURRENT`, `NOT_ASSIGNED`, `DATE_NOT_AFTER_CURRENT`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/share
git commit -m "feat(shares): whole-share service with flat assignment history"
```

---

### Task 4: Season service update (TDD)

**Files:**
- Modify: `src/lib/services/season/season.ts`
- Modify: `src/lib/services/season/logic.test.ts`
- Modify: `src/lib/services/season/season.test.ts`

**Interfaces:**
- Consumes: `WEEKS_PER_SHARE`, `WEEKS_PER_SEASON`, `rotateShare`, `DEFAULT_YEAR_ROTATION` (Task 2); `ownershipAssignment` (Task 1); `assignShareAsAdmin` (Task 3, tests only).
- Produces: `shareForWeek(input: { startWeek: number; startShare: ShareCode }, isoWeek: number): ShareCode | null` (replaces `partForWeek`/`WeekSlot`); `type ScheduleEntry = { week: number; shareCode: ShareCode; userId: string | null }`; `scheduleForYear(year)` returns the 20 entries. Everything else in the season service is unchanged.

- [ ] **Step 1: Update the logic tests first**

In `src/lib/services/season/logic.test.ts`:

1. Change the import line to:

```ts
import { DEFAULT_YEAR_ROTATION, rotateShare } from '~/lib/shares/codes'
import { monthBandsForSeason, monthForISOWeek, shareForWeek } from './season'
```

2. Replace the two `partForWeek` tests with:

```ts
test('shareForWeek reproduces the 2026 row from the Disponeringslista', () => {
  const s = { startWeek: 21, startShare: 'D' as const }
  const expected: Array<readonly [number, string]> = [
    [21, 'D'],
    [22, 'D'],
    [23, 'E'],
    [24, 'E'],
    [25, 'F'],
    [26, 'F'],
    [27, 'G'],
    [28, 'G'],
    [29, 'H'],
    [30, 'H'],
    [31, 'I'],
    [32, 'I'],
    [33, 'J'],
    [34, 'J'],
    [35, 'A'],
    [36, 'A'],
    [37, 'B'],
    [38, 'B'],
    [39, 'C'],
    [40, 'C'],
  ]
  for (const [week, shareCode] of expected) {
    expect(shareForWeek(s, week)).toBe(shareCode)
  }
})

test('shareForWeek returns null for weeks outside the 20-week window', () => {
  const s = { startWeek: 21, startShare: 'D' as const }
  expect(shareForWeek(s, 20)).toBeNull()
  expect(shareForWeek(s, 41)).toBeNull()
  // First and last in-window weeks are still valid.
  expect(shareForWeek(s, 21)).toBe('D')
  expect(shareForWeek(s, 40)).toBe('C')
})

test('default year rotation slips every share 6 weeks (ADR-0018)', () => {
  // Year 1: startShare A → share A owns weeks 21/22.
  const y1 = { startWeek: 21, startShare: 'A' as const }
  expect(shareForWeek(y1, 21)).toBe('A')
  expect(shareForWeek(y1, 22)).toBe('A')

  // Year 2 via the default rotation: A slips to weeks 27/28.
  const y2 = { startWeek: 21, startShare: rotateShare('A', DEFAULT_YEAR_ROTATION) }
  expect(y2.startShare).toBe('H')
  expect(shareForWeek(y2, 27)).toBe('A')
  expect(shareForWeek(y2, 28)).toBe('A')
})
```

(The `monthForISOWeek` and `monthBandsForSeason` tests are untouched.)

- [ ] **Step 2: Update the DB tests**

In `src/lib/services/season/season.test.ts`:

1. Change `import { assignPart } from '~/lib/services/share'` to `import { assignShareAsAdmin } from '~/lib/services/share'`.
2. In the `scheduleForYear joins each weekly slot with the current owner` test, replace the two `assignPart(...)` calls and the assertions:

```ts
  await assignShareAsAdmin({ shareCode: 'D', userId: aliceId, from: new Date('2020-01-01') })
  await assignShareAsAdmin({ shareCode: 'A', userId: bobId, from: new Date('2020-01-01') })

  const schedule = await scheduleForYear(2026)
  if (!schedule) throw new Error('expected schedule for year 2026')
  expect(schedule).toHaveLength(20)

  const byWeek = new Map(schedule.map((e) => [e.week, e]))
  // Owning a share means owning BOTH of its weeks (ADR-0018).
  expect(byWeek.get(21)).toMatchObject({ shareCode: 'D', userId: aliceId })
  expect(byWeek.get(22)).toMatchObject({ shareCode: 'D', userId: aliceId })
  expect(byWeek.get(35)).toMatchObject({ shareCode: 'A', userId: bobId })
  expect(byWeek.get(36)).toMatchObject({ shareCode: 'A', userId: bobId })
  expect(byWeek.get(40)).toMatchObject({ shareCode: 'C', userId: null })
```

3. In the `each initial year produces a schedule that starts at the expected share` test, if it asserts `partId`/`partNumber` on `schedule[0]`, trim the assertion to `{ week: seed.startWeek, shareCode: seed.startShare }`.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `pnpm test:node src/lib/services/season`
Expected: FAIL — `shareForWeek` is not exported; `ScheduleEntry` still has parts.

- [ ] **Step 4: Update the season service**

In `src/lib/services/season/season.ts`:

1. Imports: remove `sharePart` from the schema import (keep `ownershipAssignment`, `season`); remove `and` if now unused; replace the codes import with:

```ts
import {
  ANCHOR_START_SHARE,
  DEFAULT_YEAR_ROTATION,
  rotateShare,
  SHARE_CODES,
  type ShareCode,
  shareIndexOf,
  WEEKS_PER_SEASON,
  WEEKS_PER_SHARE,
} from '~/lib/shares/codes'
```

2. Replace `WeekSlot` + `partForWeek` with:

```ts
// Pure: returns the share occupying `isoWeek` within the season, or null if
// the week sits outside the 20-week window. Weeks map to shares in blocks of
// WEEKS_PER_SHARE consecutive weeks, advancing from startShare and wrapping
// mod 10.
export function shareForWeek(
  input: { startWeek: number; startShare: ShareCode },
  isoWeek: number,
): ShareCode | null {
  const offset = isoWeek - input.startWeek
  if (offset < 0 || offset >= WEEKS_PER_SEASON) return null

  const shareOffset = Math.floor(offset / WEEKS_PER_SHARE)
  const shareIndex = (shareIndexOf(input.startShare) + shareOffset) % SHARE_CODES.length
  return SHARE_CODES[shareIndex]
}
```

3. Replace `ScheduleEntry` + `scheduleForYear` with:

```ts
export type ScheduleEntry = {
  week: number
  shareCode: ShareCode
  userId: string | null
}

// Returns the 20-week schedule for a given year with the current owner of
// each share left-joined in. Useful for the admin "Disponeringslista" grid.
export async function scheduleForYear(year: number): Promise<Array<ScheduleEntry> | null> {
  const s = await findSeason(year)
  if (!s) return null

  const owners = await db
    .select({ shareCode: ownershipAssignment.shareCode, userId: ownershipAssignment.userId })
    .from(ownershipAssignment)
    .where(isNull(ownershipAssignment.assignedTo))
  const ownerByShare = new Map(owners.map((r) => [r.shareCode, r.userId]))

  const entries: Array<ScheduleEntry> = []
  for (let i = 0; i < WEEKS_PER_SEASON; i++) {
    const week = s.startWeek + i
    const shareCode = shareForWeek(s, week)
    if (!shareCode) continue
    entries.push({ week, shareCode, userId: ownerByShare.get(shareCode) ?? null })
  }
  return entries
}
```

- [ ] **Step 5: Run to verify green**

Run: `pnpm test:node src/lib/services/season`
Expected: PASS (all logic + DB season tests).

Also run the share suite to confirm no regression: `pnpm test:node src/lib/services/share/share.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/season
git commit -m "feat(season): shareForWeek + whole-share schedule entries"
```

---

### Task 5: oRPC procedures — share, season, user

**Files:**
- Modify: `src/lib/orpc/procedures/share.ts` (full rewrite below)
- Modify: `src/lib/orpc/procedures/season.ts:40-55` (listSchedules cells)
- Modify: `src/lib/orpc/procedures/user.ts` (listContacts share badges)

**Interfaces:**
- Consumes: the Task 3 service surface; `shareForWeek` from Task 4.
- Produces (client-facing shapes the UI tasks rely on):
  - `orpc.share.listMine` → `Array<ShareCode>`
  - `orpc.share.listAll` → `Array<AdminShareRow>` where `AdminShareRow = { shareCode: ShareCode; currentOwner: { id: string; name: string; image: string | null; imageBlurhash: string | null } | null }`
  - `orpc.share.listHistory({ shareCode })` → `Array<AdminHistoryEntry>` where `AdminHistoryEntry = { id: string; assignedFrom: Date; assignedTo: Date | null; isActive: boolean; user: AdminShareRow['currentOwner'] }`
  - `orpc.share.assign({ shareCode, userId, from })`, `orpc.share.unassign({ shareCode, on })`
  - `orpc.season.listSchedules` cells → `{ week: number; shareCode: ShareCode; month: number }` (no `partId`)
  - `orpc.user.listContacts` rows → `shares: Array<ShareCode>`

- [ ] **Step 1: Rewrite `src/lib/orpc/procedures/share.ts`**

```ts
import { ORPCError } from '@orpc/server'
import { z } from 'zod'
import { realtime } from '~/lib/effects'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as shareService from '~/lib/services/share'
import { ShareDomainError } from '~/lib/services/share'
import * as userService from '~/lib/services/user'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

const shareCodeSchema = z.enum(SHARE_CODES)

function rethrowAsORPC(err: unknown): never {
  if (!(err instanceof ShareDomainError)) throw err
  switch (err.code) {
    case 'USER_NOT_FOUND':
      throw new ORPCError('NOT_FOUND', {
        message: m.share_error_user_not_found(),
      })
    case 'ALREADY_CURRENT_OWNER':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_already_owner(),
      })
    case 'FROM_DATE_NOT_AFTER_CURRENT':
    case 'DATE_NOT_AFTER_CURRENT':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_date_not_after_current(),
      })
    case 'NOT_ASSIGNED':
      throw new ORPCError('CONFLICT', {
        message: m.share_error_not_assigned(),
      })
  }
}

type OwnerSummary = {
  id: string
  name: string
  image: string | null
  imageBlurhash: string | null
}

export type AdminShareRow = {
  shareCode: ShareCode
  currentOwner: OwnerSummary | null
}

export type AdminHistoryEntry = {
  id: string
  assignedFrom: Date
  assignedTo: Date | null
  isActive: boolean
  user: OwnerSummary | null
}

function toOwnerSummary(u: {
  id: string
  name: string
  image: string | null
  imageBlurhash: string | null
}): OwnerSummary {
  return { id: u.id, name: u.name, image: u.image, imageBlurhash: u.imageBlurhash }
}

export const shareRouter = {
  // Current user's owned shares, sorted A→J. The same set is applied to
  // every visible year on the client — ownership changes mid-season are rare.
  listMine: protectedProcedure.handler(
    ({ context }): Promise<Array<ShareCode>> =>
      shareService.listCurrentSharesForUser(context.user.id),
  ),

  // Admin grid view: every share with its current owner decorated.
  listAll: adminProcedure.handler(async (): Promise<Array<AdminShareRow>> => {
    const [shares, users] = await Promise.all([
      shareService.listSharesWithCurrentOwner(),
      userService.listAll(),
    ])
    const byId = new Map(users.map((u) => [u.id, u]))
    return shares.map((s) => {
      const owner = s.currentUserId ? byId.get(s.currentUserId) : null
      return {
        shareCode: s.shareCode,
        currentOwner: owner ? toOwnerSummary(owner) : null,
      }
    })
  }),

  // Per-share history Sheet payload: one entry per ownership stint, newest
  // first (shares are indivisible per ADR-0018 — no event grouping needed).
  listHistory: adminProcedure
    .input(z.object({ shareCode: shareCodeSchema }))
    .handler(async ({ input }): Promise<Array<AdminHistoryEntry>> => {
      const [rows, users] = await Promise.all([
        shareService.listShareHistory(input.shareCode),
        userService.listAll(),
      ])
      const byId = new Map(users.map((u) => [u.id, u]))
      return rows.map((r) => {
        const u = byId.get(r.userId)
        return {
          id: r.id,
          assignedFrom: r.assignedFrom,
          assignedTo: r.assignedTo,
          isActive: r.assignedTo === null,
          user: u ? toOwnerSummary(u) : null,
        }
      })
    }),

  assign: adminProcedure
    .input(
      z.object({
        shareCode: shareCodeSchema,
        userId: z.uuid(),
        from: z.date(),
      }),
    )
    .handler(async ({ input, context }) => {
      try {
        await shareService.assignShareAsAdmin(input, { actorUserId: context.user.id })
      } catch (err) {
        rethrowAsORPC(err)
      }
      context.log.info('admin assigned share', { shareCode: input.shareCode })
      await realtime.publish(
        { kind: 'share.changed', ids: [input.shareCode] },
        { source: context.user.id },
      )
    }),

  unassign: adminProcedure
    .input(z.object({ shareCode: shareCodeSchema, on: z.date() }))
    .handler(async ({ input, context }) => {
      try {
        await shareService.unassignShareAsAdmin(input)
      } catch (err) {
        rethrowAsORPC(err)
      }
      context.log.info('admin unassigned share', { shareCode: input.shareCode })
      await realtime.publish(
        { kind: 'share.changed', ids: [input.shareCode] },
        { source: context.user.id },
      )
    }),
}
```

- [ ] **Step 2: Update `season.ts` listSchedules**

In `src/lib/orpc/procedures/season.ts`, inside `listSchedules`, replace the cell mapping:

```ts
      const cells = Array.from({ length: WEEKS_PER_SEASON }, (_, i) => {
        const week = s.startWeek + i
        const shareCode = seasonService.shareForWeek(s, week)
        // Within [startWeek, startWeek + WEEKS_PER_SEASON) shareForWeek always
        // resolves; this guard exists so a future change to WEEKS_PER_SEASON
        // can't silently produce nulls.
        if (!shareCode) {
          throw new Error(`shareForWeek returned null for ${s.year} week ${week}`)
        }
        return {
          week,
          shareCode,
          month: seasonService.monthForISOWeek(s.year, week),
        }
      })
```

- [ ] **Step 3: Update `user.ts` listContacts**

In `src/lib/orpc/procedures/user.ts`:

1. Replace the imports `import type { SharePartRow } from '~/lib/services/share'` → `import type { ShareCode } from '~/lib/shares/codes'` (keep `import * as shareService`).
2. In `listContacts`, replace the shares aggregation:

```ts
    const [users, sharesWithOwner] = await Promise.all([
      userService.listAll(),
      shareService.listSharesWithCurrentOwner(),
    ])

    // listSharesWithCurrentOwner is A→J ordered, so per-user lists come out
    // sorted without an extra sort.
    const byUser = new Map<string, Array<ShareCode>>()
    for (const s of sharesWithOwner) {
      if (!s.currentUserId) continue
      const list = byUser.get(s.currentUserId) ?? []
      list.push(s.shareCode)
      byUser.set(s.currentUserId, list)
    }
```

(The `.map((u) => ({ ...withInviteExpiry(u), shares: byUser.get(u.id) ?? [] }))` line below is unchanged — `shares` is now `Array<ShareCode>`.)

- [ ] **Step 4: Verify no service-test regressions and lint**

Run: `pnpm test:node src/lib/services` → PASS.
Run: `pnpm check` → no errors in the three touched files. (Full `pnpm build` typecheck still red until Task 6 updates the UI — expected.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/orpc/procedures
git commit -m "feat(orpc): whole-share assign/unassign/history shapes"
```

---

### Task 6: Admin shares UI

**Files:**
- Create: `src/components/share/ShareCard.tsx`
- Delete: `src/components/share/SharePartCard.tsx`
- Modify: `src/components/share/ShareAssignForm.tsx` (full rewrite)
- Modify: `src/components/share/UnassignShareDialog.tsx` (full rewrite)
- Modify: `src/components/share/AssignmentHistorySheet.tsx`
- Modify: `src/routes/_authenticated/admin/shares.index.tsx`
- Modify: `src/routes/_authenticated/admin/shares.assign.$shareCode.tsx`

**Interfaces:**
- Consumes: `AdminShareRow`, `AdminHistoryEntry` from Task 5; existing `useAppForm`, `optimisticPatch`, `useUrlDialog`, `UserOption`, `ResponsiveDialog`, `Sheet` primitives; message keys from Task 7 (reworded keys keep their names, so this task compiles against the existing messages).
- Produces: `ShareCard({ share, onAssign, onUnassign, onHistory })`, `ShareAssignForm({ share, users, onDone })`, `UnassignShareDialog({ open, onOpenChange, share })`, `AssignmentHistorySheet({ open, onOpenChange, shareCode })` (unchanged signature).

- [ ] **Step 1: Create `src/components/share/ShareCard.tsx`, delete `SharePartCard.tsx`**

```tsx
import { ClockIcon, UserMinusIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Button } from '~/components/ui/button'
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn, initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  share: AdminShareRow
  onAssign: () => void
  onUnassign: () => void
  onHistory: () => void
}

export function ShareCard({ share, onAssign, onUnassign, onHistory }: Props) {
  const owner = share.currentOwner

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border bg-surface-raised">
      <header
        className={cn(
          'flex items-baseline justify-between gap-2 px-4 py-3 text-foreground',
          shareBackgroundClass[share.shareCode],
        )}
      >
        <span className="font-semibold text-2xl tracking-tight">{share.shareCode}</span>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-4">
        {owner ? (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <Avatar className="size-12">
              {owner.image ? (
                <AvatarImage
                  src={owner.image}
                  alt={owner.name}
                  width={48}
                  height={48}
                  blurhash={owner.imageBlurhash}
                />
              ) : null}
              <AvatarFallback>{initials(owner.name)}</AvatarFallback>
            </Avatar>
            <span className="break-words font-medium leading-tight">{owner.name}</span>
          </div>
        ) : (
          <p className="py-4 text-center text-muted-foreground text-sm">
            {m.share_card_unassigned()}
          </p>
        )}
      </div>

      <footer className="flex flex-col gap-2 border-t bg-muted/30 p-3">
        <Button size="sm" variant="default" onClick={onAssign} className="w-full">
          {owner ? m.share_card_reassign() : m.share_assign_submit()}
        </Button>
        <div className="flex gap-2">
          {owner ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={m.share_card_unassign_label()}
              onClick={onUnassign}
              className="flex-1"
            >
              <UserMinusIcon />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            aria-label={m.share_card_history_label()}
            onClick={onHistory}
            className="flex-1"
          >
            <ClockIcon />
          </Button>
        </div>
      </footer>
    </article>
  )
}
```

```bash
git rm src/components/share/SharePartCard.tsx
```

- [ ] **Step 2: Rewrite `src/components/share/ShareAssignForm.tsx`**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import type { UserOption } from '~/components/form/UserSelectField'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { optimisticPatch } from '~/lib/orpc/optimistic'
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { m } from '~/paraglide/messages'

// The share-assignment form: one owner + effective date (shares are
// indivisible per ADR-0018). Lives on a dedicated route rather than an
// overlay — see ADR-0013. Container-agnostic: the route supplies the data +
// page chrome and an `onDone` (navigate back to the grid), called after the
// optimistic submit and on cancel.

function todayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

const schema = z.object({
  from: z.date(),
  userId: z.string().min(1, { error: () => m.share_validation_owner_required() }),
})

type Props = {
  share: AdminShareRow
  users: ReadonlyArray<UserOption>
  /** Navigate back to the grid — called after an optimistic submit and on cancel. */
  onDone: () => void
}

export function ShareAssignForm({ share, users, onDone }: Props) {
  const queryClient = useQueryClient()

  // Build the optimistic owner cell from the selected option. UserOption carries
  // no blurhash, so leave it null — the onSettled refetch fills in the real one.
  const ownerFromOption = (userId: string): AdminShareRow['currentOwner'] => {
    const u = users.find((o) => o.id === userId)
    return u ? { id: u.id, name: u.name, image: u.image, imageBlurhash: null } : null
  }

  const assignMutation = useMutation(
    orpc.share.assign.mutationOptions({
      // Paint the new owner into the admin grid before the round-trip. "Current
      // owner" in listAll is the open-ended assignment's owner, so it flips to the
      // new owner regardless of the effective `from` date — this patch is always
      // correct. The owners list (listContacts share badges) reconciles on settle.
      onMutate: (vars) =>
        optimisticPatch(
          queryClient,
          orpc.share.listAll.queryKey(),
          (s) => s.shareCode === vars.shareCode,
          (s) => ({ ...s, currentOwner: ownerFromOption(vars.userId) }),
        ),
      // onError/onSettled live on useMutation (not the mutate call) so they still
      // run after we navigate away below. onSettled re-syncs the grid and owners
      // to the backend's truth (and reverts the optimistic patch on failure).
      onError: (err) => {
        toast.error(err.message || m.share_assign_error())
      },
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() }),
        ]),
    }),
  )

  const form = useAppForm({
    defaultValues: {
      from: todayUtc(),
      userId: share.currentOwner?.id ?? '',
    },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => {
      // Optimistic submit: onMutate paints the new owner, we navigate back now,
      // and onError/onSettled reconcile in the background.
      assignMutation.mutate({
        shareCode: share.shareCode,
        from: value.from,
        userId: value.userId,
      })
      onDone()
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="flex flex-col gap-4"
    >
      <form.AppField
        name="from"
        children={(field) => <field.DateField label={m.share_field_from()} />}
      />
      <form.AppField
        name="userId"
        children={(field) => (
          <field.UserSelectField label={m.share_field_new_owner()} users={users} />
        )}
      />

      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton
            label={m.share_assign_submit()}
            pendingLabel={m.share_assign_pending()}
          />
        </form.AppForm>
      </div>
    </form>
  )
}
```

- [ ] **Step 3: Rewrite `src/components/share/UnassignShareDialog.tsx`**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import type { AdminShareRow } from '~/lib/orpc/procedures/share'
import { m } from '~/paraglide/messages'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  share: AdminShareRow | undefined
}

function todayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

const schema = z.object({
  on: z.date(),
})

export function UnassignShareDialog({ open, onOpenChange, share }: Props) {
  if (!share) return null
  return (
    <UnassignShareDialogBody
      key={share.shareCode}
      open={open}
      onOpenChange={onOpenChange}
      share={share}
    />
  )
}

function UnassignShareDialogBody({
  open,
  onOpenChange,
  share,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  share: AdminShareRow
}) {
  const queryClient = useQueryClient()

  const unassignMutation = useMutation(
    orpc.share.unassign.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.user.listContacts.key() }),
        ])
        toast.success(m.share_unassigned())
        onOpenChange(false)
      },
      onError: (err) => {
        toast.error(err.message || m.share_unassign_error())
      },
    }),
  )

  const form = useAppForm({
    defaultValues: { on: todayUtc() },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await unassignMutation.mutateAsync({
        shareCode: share.shareCode,
        on: value.on,
      })
    },
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {m.share_unassign_title({ code: share.shareCode })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {m.share_unassign_description()}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
          className="flex flex-col gap-4"
        >
          <form.AppField
            name="on"
            children={(field) => <field.DateField label={m.share_field_from()} />}
          />
          <ResponsiveDialogFooter className="mt-2">
            <form.AppForm>
              <form.CancelButton onClick={() => onOpenChange(false)}>
                {m.common_cancel()}
              </form.CancelButton>
              <form.SubmitButton
                label={m.share_unassign_submit()}
                pendingLabel={m.share_unassign_pending()}
              />
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
```

- [ ] **Step 4: Simplify `src/components/share/AssignmentHistorySheet.tsx`**

Keep the outer `AssignmentHistorySheet`, `HistoryFallback`, and `HistoryBody` structure; the entry list keys change to `entry.id` and the entry component collapses to a single-user row. Replace `HistoryBody`'s list, delete `ChildRow`, and replace `HistoryEntry`:

```tsx
function HistoryBody({ shareCode }: { shareCode: ShareCode }) {
  const { data: history } = useSuspenseQuery(
    orpc.share.listHistory.queryOptions({ input: { shareCode } }),
  )

  if (history.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground text-sm">{m.share_history_empty()}</p>
    )
  }

  return (
    <ol className="flex flex-col gap-3">
      {history.map((entry) => (
        <HistoryEntry key={entry.id} entry={entry} />
      ))}
    </ol>
  )
}

function HistoryEntry({ entry }: { entry: AdminHistoryEntry }) {
  return (
    <li className="flex items-center gap-3 rounded-md border bg-card p-3">
      <Avatar className="size-9">
        {entry.user?.image ? (
          <AvatarImage
            src={entry.user.image}
            alt={entry.user.name}
            width={36}
            height={36}
            blurhash={entry.user.imageBlurhash ?? undefined}
          />
        ) : null}
        <AvatarFallback>{initials(entry.user?.name ?? '?')}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">
            {entry.user?.name ?? m.share_history_unknown_user()}
          </span>
          {entry.isActive ? (
            <Badge variant="secondary">{m.share_history_active_badge()}</Badge>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatDate(entry.assignedFrom)} →{' '}
          {entry.assignedTo ? formatDate(entry.assignedTo) : m.share_history_ongoing()}
        </span>
      </div>
    </li>
  )
}
```

Update the type import: `import type { AdminHistoryEntry } from '~/lib/orpc/procedures/share'`.

- [ ] **Step 5: Update `src/routes/_authenticated/admin/shares.index.tsx`**

Component body changes (loader/search schema unchanged):

```tsx
function AdminShares() {
  const { data: shares } = useSuspenseQuery(orpc.share.listAll.queryOptions())
  const navigate = Route.useNavigate()
  const dialogShareCode = Route.useSearch({ select: (s) => s.shareCode })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const { isOpen, open, close } = useUrlDialog<SharesDialog, SharesSearch>({
    current: dialog,
    navigate,
    clearKeys: ['shareCode'],
  })

  const isUnassign = isOpen('unassign')
  const isHistory = isOpen('history')
  const activeShare = dialogShareCode
    ? shares.find((s) => s.shareCode === dialogShareCode)
    : undefined

  return (
    <PageContainer>
      <header className="flex flex-col gap-2">
        <span className="font-semibold text-primary text-xs uppercase tracking-wider">
          {m.user_role_admin()}
        </span>
        <h1 className="font-bold text-3xl tracking-tight text-balance md:text-4xl">
          {m.share_manage_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.share_manage_description()}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {shares.map((share) => (
          <ShareCard
            key={share.shareCode}
            share={share}
            onAssign={() =>
              navigate({
                to: '/admin/shares/assign/$shareCode',
                params: { shareCode: share.shareCode },
              })
            }
            onUnassign={() => open('unassign', { shareCode: share.shareCode })}
            onHistory={() => open('history', { shareCode: share.shareCode })}
          />
        ))}
      </div>

      <UnassignShareDialog
        open={isUnassign && !!activeShare}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        share={activeShare}
      />

      <AssignmentHistorySheet
        open={isHistory && !!dialogShareCode}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        shareCode={dialogShareCode}
      />
    </PageContainer>
  )
}
```

Imports: swap `SharePartCard` → `ShareCard`; drop `useMemo` and `AdminPartRow`/`ShareCode` if unused after the edit.

- [ ] **Step 6: Update `src/routes/_authenticated/admin/shares.assign.$shareCode.tsx`**

In `AssignSharePage`, replace the part lookups:

```tsx
  // `shareCode` is validated in the loader; narrow it for the typed lookup.
  const code = shareCode as ShareCode
  const share = shares.find((s) => s.shareCode === code)
  if (!share) return <Navigate to="/admin/shares" replace />
```

(rename the query result: `const { data: shares } = useSuspenseQuery(orpc.share.listAll.queryOptions())`), and render:

```tsx
      <div className="max-w-md">
        <ShareAssignForm share={share} users={userOptions} onDone={goBack} />
      </div>
```

Also update the loader comment (parts no longer exist): `// Guard an invalid code before fetching; listAll always returns all 10 shares.`

- [ ] **Step 7: Lint and commit**

Run: `pnpm check` → clean for the touched files.

```bash
git add -A src/components/share src/routes/_authenticated/admin
git commit -m "feat(shares): single-owner admin UI (card, form, dialog, history)"
```

---

### Task 7: Consumers + i18n — calendar, owners table, messages; full green gate

**Files:**
- Modify: `src/routes/_authenticated/index.tsx`
- Modify: `src/components/season/DisponeringslistaTable.tsx`
- Modify: `src/components/user/OwnersTable.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `orpc.share.listMine` → `Array<ShareCode>`; `listSchedules` cells `{ week, shareCode, month }`; `listContacts` rows `shares: Array<ShareCode>` (Task 5).
- Produces: fully compiling app — this task ends with the whole suite + build green.

- [ ] **Step 1: Calendar route (`src/routes/_authenticated/index.tsx`)**

Replace the owned-parts wiring in the `Calendar` component:

```tsx
  const { data: schedules } = useSuspenseQuery(orpc.season.listSchedules.queryOptions())
  const { data: ownedShares } = useSuspenseQuery(orpc.share.listMine.queryOptions())

  const ownedShareCodes = new Set(ownedShares)
```

and pass `ownedShareCodes={ownedShareCodes}` to `DisponeringslistaTable` (prop renamed in Step 2).

- [ ] **Step 2: `DisponeringslistaTable.tsx`**

Mechanical rename + type tightening:

1. `export type Cell = { week: number; shareCode: ShareCode; month: number }` (drop `partId`).
2. Rename the prop `ownedPartIds: ReadonlySet<string>` → `ownedShareCodes: ReadonlySet<ShareCode>` in `Props` and in **every** sub-component that threads it through (grep shows ~8 occurrences in this file).
3. The ownership check becomes `const isMine = ownedShareCodes.has(cell.shareCode)` (was `ownedPartIds.has(cell.partId)`).

Everything else (month bands, `season_my_week` aria-label, `OWNED_RING`, share colors) is unchanged. Note the user-visible improvement: a "my week" ring now lights **both** weeks of an owned share.

- [ ] **Step 3: `OwnersTable.tsx`**

1. Imports: remove `import type { SharePartRow } from '~/lib/services/share'` and `import { collapseShares, type ShareBadgeKind } from '~/lib/shares/collapse'`; add `import type { ShareCode } from '~/lib/shares/codes'`.
2. The owner row type: `shares: Array<SharePartRow>` → `shares: Array<ShareCode>`.
3. Replace `sortedShares` + `primaryShareKey` with:

```ts
// Sort key for the Andelar column: the primary (alphabetically first) share.
// Owners with no shares get "~" so they sort last in ascending order.
function primaryShareKey(shares: Array<ShareCode>): string {
  return shares.length === 0 ? '~' : [...shares].sort()[0]
}
```

4. At the row-render site (`const shares = collapseShares(owner.shares)` around line 230): `const shares = owner.shares`.
5. Badge rendering: keys and labels are the share code itself. Replace `shareBadgeKey` + the local `ShareBadge` with:

```tsx
function ShareBadge({ code }: { code: ShareCode }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent text-foreground', shareBackgroundClass[code])}
    >
      {code}
    </Badge>
  )
}
```

and update both call sites (~lines 280 and 343) to `shares.map((code) => <ShareBadge key={code} code={code} />)`.

- [ ] **Step 4: Prune + reword messages**

In `messages/sv.json` **delete** these keys (verify each is now unreferenced first: `grep -rn "m\.<key>(" src/` must return nothing):

`share_assign_split`, `share_assign_whole`, `share_assigned`, `share_error_only_halves`, `share_field_assignment`, `share_field_part_owner`, `share_split_badge`, `share_unassign_both`, `share_unassign_parts_label`, `share_validation_part_owner_required`

(`share_assigned` was already unreferenced before this rework — dead key, delete it.)

**Reword** (splits no longer exist):

```json
"share_assign_description": "Andelen tilldelas i sin helhet till en ägare.",
"share_manage_description": "Tilldela andelar. Varje andel ägs av en person i taget."
```

Mirror both edits in `messages/en.json` (same keys deleted; rewordings):

```json
"share_assign_description": "The share is assigned in its entirety to one owner.",
"share_manage_description": "Assign shares. Each share is owned by one person at a time."
```

`en.json` must keep exactly the same key set as `sv.json`.

Then: `pnpm i18n:compile` → exits 0.

- [ ] **Step 5: Full green gate**

```bash
pnpm check        # Biome format+lint — clean
pnpm test         # BOTH projects (node DB suite + browser component tests) — all green
pnpm build        # vite build + tsc --noEmit — exits 0 (first full-typecheck point)
```

Also confirm no stragglers: `grep -rn "partNumber\|partId\|sharePartId\|PARTS_PER_SHARE\|collapseShares\|SharePartRow\|ownershipAssignmentEvent\|share_part" src/ --include='*.ts' --include='*.tsx'` → no hits (except none at all; `drizzle/` history keeps its references, which is fine).

- [ ] **Step 6: Commit**

```bash
git add -A src messages
git commit -m "feat(shares): whole-share calendar highlight, owner badges, i18n prune"
```

---

### Task 8: Docs — ADR-0009 amendment + CLAUDE.md

**Files:**
- Modify: `docs/adr/0009-organization-rules.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: ADR-0009 Rule 1 retirement amendment**

Change the Rule 1 heading to `### Rule 1: Every owner holds at least one whole share (2026-05-27) — RETIRED` and insert directly under the heading:

```markdown
> **Retired 2026-07-05 — [ADR-0018](./0018-indivisible-shares.md).** Shares are
> indivisible: `share_part` is gone and every assignment covers a whole share, so
> the states this rule disallowed are no longer representable ("defined out of
> existence"). `assertEveryAffectedUserHasWhole` and
> `ShareDomainError('LEAVES_USER_WITH_ONLY_HALVES')` were deleted with it. The
> original rule text stays below for historical context.
```

- [ ] **Step 2: CLAUDE.md updates**

1. **Skill-loading router table**: add a row
   `| Shares & ownership (indivisible shares, assignment history) | docs/adr/0018-indivisible-shares.md |`
2. **"Decisions made" list** — replace the two superseded bullets:
   - Replace the bullet starting `**Admin assigns ownership in whole-share pairs by default; split via toggle** (2026-05-26).` with:
     `- **Shares are indivisible** (2026-07-05). One owner per share (or unassigned); the split path, `share_part`, and `src/lib/shares/collapse.ts` are gone; assignments reference the `share_code` enum directly and carry `actor_user_id`; per-share history is the flat assignment rows; ADR-0009 Rule 1 retired. Migration `0018` is destructive by design (pre-launch). See ADR-0018.`
   - Replace the bullet starting `**Assignment events are first-class** (2026-05-27).` with:
     `- **Assignment events are first-class** (2026-05-27, superseded 2026-07-05 by ADR-0018): with indivisible shares each admin decision is exactly one assignment row, so the `ownership_assignment_event` parent table was dropped — the row itself is the decision record.`
3. Sanity-check the code map for stale mentions (`collapse.ts` is not listed there; no change expected).

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0009-organization-rules.md CLAUDE.md
git commit -m "docs: retire ADR-0009 Rule 1; record indivisible shares in CLAUDE.md"
```

---

### Task 9: Review, end-to-end verification, ship

**Files:** none (verification + review only)

- [ ] **Step 1: Project review agents** (read-only; fix findings, re-run until clean)

Dispatch in parallel:
- `migration-guard` — audits `drizzle/0018_indivisible_shares.sql` + schema change (destructive ops are *expected and ADR-sanctioned* here; the agent should confirm naming, journal consistency, no `betterAuth.ts` touch).
- `test-completeness` — verifies every remaining `ShareDomainError` code is exercised (Task 3 test list).
- `code-reviewer` — ADR adherence (thin procedures, realtime publish, optimistic-mutation placement, i18n).

- [ ] **Step 2: Browser verification** (evidence before "done" — superpowers:verification-before-completion)

```bash
pnpm dev:up && pnpm dev
```

Sign in as an `ADMIN_EMAILS` address (empty local DB bootstraps an admin; create 1–2 extra users via `/admin` invite or DB seed as needed), then verify:

1. `/admin/shares`: 10 single-owner cards render; assign share A to a user via the dedicated route → grid updates instantly (optimistic) and stays after reload.
2. Reassign A to another user → history sheet shows two stints, oldest closed on the new from-date, newest badged "Aktiv".
3. Unassign A → card shows "Ej tilldelad"; history keeps both stints (history preserved).
4. Error path: assign A to its current owner again → Swedish toast "Användaren äger redan andelen".
5. `/` calendar: the signed-in owner's share highlights **both** consecutive weeks (ring on e.g. weeks 21+22).
6. `/owners`: share badges show single letters; sort by Andelar works.
7. Locale switch to English: shares pages render, no missing-key artifacts.

- [ ] **Step 3: Ship**

Push and open the PR (squash-merge; title = squash subject):

```bash
git push -u origin feat/indivisible-shares
gh pr create --title "feat(shares): make shares indivisible (ADR-0018)" --body "$(cat <<'EOF'
A share (A–J) is now owned whole by exactly one user or unassigned — the split
path is removed per ADR-0018 (docs/adr/0018-indivisible-shares.md).

- Drop `share_part` + `ownership_assignment_event`; `ownership_assignment`
  references the `share_code` enum directly and carries `actor_user_id`.
  Migration 0018 is destructive by design (pre-launch posture).
- Per-share ownership history preserved as flat stint rows (close, never delete).
- ADR-0009 Rule 1 retired — "only halves" is no longer representable.
- Season math untouched: 20 weeks, 2 consecutive weeks per share, 6-week slip
  per season (constant re-documented in weeks).
- Admin UI: single-owner cards, one-picker assign form, simplified unassign +
  history; calendar highlights both weeks of an owned share.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Address (or consciously dismiss) any `security-guidance` push-review findings before merging. CI must pass `Check (Biome)`, `Build`, `Test`, `Validate Conventional Commit title`.

After merge: reset the prod DB per the pre-launch posture (the deploy's `vercel-build` migration applies 0018, which itself drops all part-level ownership data — no further manual reset is required unless stale seasons/users should also go).
