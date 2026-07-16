# Plan 01 — Schema + migration

> Part of [season-booking](./README.md). Read the README's locked decisions first. Steps use checkbox syntax for tracking.

**Goal:** The three booking tables + two enums exist as migration `0022_add_season_booking`, matching ADR-0020's schema section exactly.

---

### Task 1: `booking.ts` schema + generated migration

**Files:**
- Create: `src/lib/db/schema/booking.ts`
- Modify: `src/lib/db/schema/index.ts` (barrel)
- Create (generated): `drizzle/0022_add_season_booking.sql`

**Interfaces:**
- Consumes: `shareCodeEnum` from `./ownership`, `user` from `./betterAuth`.
- Produces: `bookingTargetEnum`, `slotKindEnum`, `seasonBooking`, `seasonWish`, `seasonSlot` — plans 03+ import these from `~/lib/db/schema`.

- [ ] **Step 1: Write the schema**

Create `src/lib/db/schema/booking.ts`:

```ts
import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'
import { shareCodeEnum } from './ownership'

// What a wish points at: another share's rotation block ('share', with
// target_share set) or one of the two shoulder periods (ADR-0020).
export const bookingTargetEnum = pgEnum('booking_target', ['share', 'extra_early', 'extra_late'])

// Rotation slots always have a holder; extras may be holder-less — nobody
// sails those weeks. Backstopped by season_slot_rotation_held below.
export const slotKindEnum = pgEnum('slot_kind', ['rotation', 'extra'])

// One row per booking round (= season year). Created lazily by the first
// wish or admin draft action; locked_at NULL = round open. Lock is
// reversible (ADR-0020 product decision 7).
export const seasonBooking = pgTable('season_booking', {
  year: integer('year').primaryKey(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: uuid('locked_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Consent-based trade wishes + extra-period interest, one row per marked
// target (ADR-0020). Rows are kept after lock — the record of what was
// asked for; the UI hides them.
export const seasonWish = pgTable(
  'season_wish',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    year: integer('year')
      .notNull()
      .references(() => seasonBooking.year, { onDelete: 'cascade' }),
    // The wishing share; only its current owner may manage its wishes.
    shareCode: shareCodeEnum('share_code').notNull(),
    targetKind: bookingTargetEnum('target_kind').notNull(),
    // Set iff target_kind = 'share' (CHECK below).
    targetShare: shareCodeEnum('target_share'),
    // Who clicked (ADR-0018 actor precedent); survives user deletion.
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // NULLS NOT DISTINCT is required: extra wishes carry NULL target_share
    // and Postgres treats NULLs as distinct by default, so repeat extra
    // wishes would otherwise duplicate freely. Drizzle 0.45 exposes this on
    // the unique() constraint builder (NOT on uniqueIndex — see the
    // coalesce workaround note in schema/folder.ts).
    unique('season_wish_unique')
      .on(table.year, table.shareCode, table.targetKind, table.targetShare)
      .nullsNotDistinct(),
    check(
      'season_wish_target_share_iff_share_kind',
      sql`(${table.targetKind} = 'share') = (${table.targetShare} IS NOT NULL)`,
    ),
    check(
      'season_wish_no_self_target',
      sql`${table.targetShare} IS NULL OR ${table.targetShare} <> ${table.shareCode}`,
    ),
  ],
)

// The admin draft; becomes THE schedule at lock. Concrete first/last weeks
// per ADR-0019's revisit trigger — never derived from era math at read
// time. A share may hold several slots (its own block + an extra + an
// unassigned share's block); an unassigned share left holding its slot
// means nobody sails those weeks.
export const seasonSlot = pgTable(
  'season_slot',
  {
    year: integer('year')
      .notNull()
      .references(() => seasonBooking.year, { onDelete: 'cascade' }),
    firstWeek: integer('first_week').notNull(),
    lastWeek: integer('last_week').notNull(),
    kind: slotKindEnum('kind').notNull(),
    // NULL only on extras = nobody sails them.
    holder: shareCodeEnum('holder'),
  },
  (table) => [
    primaryKey({ columns: [table.year, table.firstWeek] }),
    check('season_slot_first_week_range', sql`${table.firstWeek} BETWEEN 1 AND 53`),
    check('season_slot_last_week_range', sql`${table.lastWeek} BETWEEN 1 AND 53`),
    check('season_slot_week_order', sql`${table.lastWeek} > ${table.firstWeek}`),
    check(
      'season_slot_rotation_held',
      sql`${table.kind} = 'extra' OR ${table.holder} IS NOT NULL`,
    ),
  ],
)
```

- [ ] **Step 2: Re-export from the barrel**

In `src/lib/db/schema/index.ts`, add (alphabetically among the existing re-exports):

```ts
export * from './booking'
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate --name=add_season_booking`
Expected: creates `drizzle/0022_add_season_booking.sql` and a new entry `idx: 22, tag: "0022_add_season_booking"` in `drizzle/meta/_journal.json` (last entry before this was `0021_drop_season_table`). **Never run `db:generate` without `--name=`.**

- [ ] **Step 4: Inspect the generated SQL**

Open `drizzle/0022_add_season_booking.sql` and verify, in order:

- `CREATE TYPE "public"."booking_target"` and `"public"."slot_kind"` with the exact value lists.
- Three `CREATE TABLE` statements (`season_booking`, `season_wish`, `season_slot`) — **no ALTER/DROP of any existing table** (this migration is purely additive).
- The wish uniqueness renders as `CONSTRAINT "season_wish_unique" UNIQUE NULLS NOT DISTINCT("year","share_code","target_kind","target_share")`.
- All four `season_slot` CHECKs and both `season_wish` CHECKs present.
- FKs: `season_wish.year`/`season_slot.year` → `season_booking.year` ON DELETE cascade; `locked_by`/`actor_user_id` → `user.id` ON DELETE set null.
- Timestamps are `timestamp with time zone` (new columns on new tables — no `USING … AT TIME ZONE` needed; that rule applies only to *altering existing* timestamp columns).

- [ ] **Step 5: Apply locally and sanity-check the test pipeline**

Run: `pnpm db:up && pnpm db:migrate`
Expected: migration applies cleanly against the local `postgres:17-alpine` on :14520.

Run: `pnpm test:node src/lib/services/share/share.test.ts`
Expected: PASS — proves the per-test schema CREATE/migrate/DROP pipeline (which replays *all* migrations including 0022) still works. `test/setup.ts` needs no changes.

- [ ] **Step 6: Review checkpoint — migration-guard**

Dispatch the `migration-guard` agent on the diff (it checks: `--name=` used, no destructive ops, no timestamptz-alter footguns, no `betterAuth.ts` hand-edits, `.env.local` hazard). Address findings before committing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/booking.ts src/lib/db/schema/index.ts drizzle/0022_add_season_booking.sql drizzle/meta/
git commit --no-gpg-sign -m "feat(booking): add season booking, wish and slot tables"
```
