# EV charging Phase 5 — ours vs others — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every counted charge session to our car or a guest, and let every charging view (Översikt,
Mönster, Ekonomi) show only our car (default), only guests, or everything.

**Architecture:** Two columns on `ev_charge_session` (`vehicle`, `vehicle_source`) plus a new
`vehicle_charge_record` table holding the Enyaq's own charging log (imported once from the MySkoda CSV, parsed in
the browser). One SQL statement re-derives Škoda-based attribution after every import and every Zaptec sync; an
admin tag always wins. The single `countedSessionFilter({ vehicle })` seam scopes every read; procedures default to
`all`, routes to `ours`.

**Tech stack:** TanStack Start + Router, oRPC + TanStack Query, Drizzle (node-postgres, `^0.45`), zod 4, Vitest
(node + browser), shadcn/Radix (ToggleGroup, Select, Badge, responsive dialog), `@tanstack/react-form`
(`useAppForm`), sonner, Paraglide, **papaparse** (new, PR 2, lazy-loaded).

**Spec (binding):** `docs/superpowers/specs/2026-10-01-ev-charging-phase5-design.md`. **ADR:**
`docs/adr/0021-charging-session-vehicle-attribution.md`.

### Delivery

| PR | Branch | Title | Tasks |
|---|---|---|---|
| 1 | `feat/charging-vehicle-attribution` | `feat(charging): attribute sessions to our car or guests` | 1–6 |
| 2 | `feat/charging-vehicle-filter` | `feat(charging): filter charging views by vehicle` | 7–10 |

The spec, ADR and this plan already sit on `feat/charging-vehicle-attribution` (worktree
`.claude/worktrees/charging-vehicle-attribution`) and ride in PR 1. PR 2 branches off `main` after PR 1 is
squash-merged (or stacks on it with the no-force-push recipe in the Phase 3 notes: PATCH base → `git merge
origin/main`).

### Deviation from the spec (flag in PR 1's description)

1. **`sessionCosts` stays unscoped.** It prices the ids the (already scoped) session list chose; a second vehicle
   filter would only silently drop rows. `getSessionCosts` is unchanged.

### Reviewer pairings (Phase 4 loop — two in parallel, each told to assume the task is wrong)

| Task | Reviewer A | Reviewer B |
|---|---|---|
| 1 | `migration-guard` | schema-design reviewer (`general-purpose`, loads `supabase-postgres-best-practices`, judges against Task 3/4's queries) |
| 2, 3, 4, 5 | `code-reviewer` | `test-completeness` |
| 6 | `code-reviewer` | reviewer loading `better-auth-security-best-practices` (admin gates, input bounds) |
| 7 | `code-reviewer` | `test-completeness` |
| 8, 9, 10 | `code-reviewer` | reviewer loading `web-design-guidelines` + `vercel-react-best-practices` |

## Global Constraints

- Every `pgTable(...)` ends with `.enableRLS()`; all timestamps `timestamp(…, { withTimezone: true })`.
- Enum-like columns are `text` + CHECK built with `sqlList(CONST_ARRAY)` from `~/lib/db/sqlList`; the arrays live in a client-safe module.
- Migration via `bun run db:generate --name=vehicle_attribution` (→ `drizzle/0007_vehicle_attribution.sql`); never hand-edit `drizzle/meta/`.
- All `db` access in `src/lib/services/`; procedures are thin glue; reads `protectedProcedure`, every mutation `adminProcedure`.
- Client code may only `import type` from services; shared vocab in `src/lib/evCharging/vehicle.ts` (no db import).
- Never `console.*`; `context.log` / `logger`. Heavier RPCs record `context.timings` sub-timings.
- No file bytes through a function: the CSV is parsed in the browser; only structured rows go to the RPC. Location name, prices and charging location are never sent or stored.
- The real MySkoda CSV (`data/private/…`) is never committed; tests use a synthetic fixture.
- User-facing text in `messages/sv.json` (source) + `en.json` (key-complete); keys `charging_vehicle_*`.
- Responsive at desktop, tablet, mobile; no fixed pixel widths.
- Conventional commits, one hat per commit, ending with the `Co-Authored-By` trailer.

## Review Focus

1. **A CSV saved by Excel/Windows** (UTF-8 BOM, CRLF line endings, trailing empty line) must parse exactly like the app's export → Task 7 test.
2. **Re-importing the same CSV** must not duplicate records and must report everything as unchanged; attribution counts stay the same → Task 2 + Task 6 tests.
3. **An admin tag survives every automatic pass** — the next Zaptec sync and the next import leave it alone → Task 3 + Task 5 tests.
4. **A guest session's own page still opens under any scope** and shows its vehicle + source → Task 4 test (`getSessionEconomy` on an `other` session).
5. **A junk `?vehicle=` in the URL** falls back to Vår bil instead of erroring → Task 8 test.

---

## PR 1 — `feat(charging): attribute sessions to our car or guests`

### Task 1: Vocabulary, schema and migration

**Files:**
- Create: `src/lib/evCharging/vehicle.ts`
- Create: `src/lib/db/schema/vehicleCharge.ts`
- Modify: `src/lib/db/schema/evCharging.ts:32-67` (two columns + two CHECKs)
- Modify: `src/lib/db/schema/index.ts` (add `export * from './vehicleCharge'` after `spotPrice`)
- Generated: `drizzle/0007_vehicle_attribution.sql`, `drizzle/meta/*`
- Modify: `src/lib/evCharging/clientSafe.browser.test.tsx` (one more import test)
- Modify: `test/fixtures/evCharging.ts` (add `insertVehicleRecord`)
- Test: `src/lib/services/evCharging/evCharging.test.ts` (constraint tests)

**Interfaces — Produces:**
```ts
// src/lib/evCharging/vehicle.ts (client-safe: imports zod only)
export const VEHICLES = ['ours', 'other'] as const
export type Vehicle = (typeof VEHICLES)[number]
export const VEHICLE_SCOPES = ['ours', 'other', 'all'] as const
export type VehicleScope = (typeof VEHICLE_SCOPES)[number]
export const VEHICLE_SOURCES = ['default', 'skoda', 'admin'] as const
export type VehicleSource = (typeof VEHICLE_SOURCES)[number]
export const VEHICLE_RECORD_SOURCES = ['skoda_export'] as const
export type VehicleRecordSource = (typeof VEHICLE_RECORD_SOURCES)[number]
export const vehicleScope = z.enum(VEHICLE_SCOPES)
export const MAX_IMPORT_ROWS = 5_000
export const vehicleRecordInput = z.object({…}) // see Step 3
export type VehicleRecordInput = z.infer<typeof vehicleRecordInput>
// schema
export const vehicleChargeRecord: PgTable  // columns per spec
// ev_charge_session gains: vehicle: text ('ours'), vehicleSource: text ('default')
// test/fixtures/evCharging.ts
export async function insertVehicleRecord(overrides?: Partial<typeof vehicleChargeRecord.$inferInsert>): Promise<string>
```

- [ ] **Step 1: Write the failing constraint tests** — append to `src/lib/services/evCharging/evCharging.test.ts`
  (it already calls `setupDatabase()`; use `expectConstraintViolation` from `~test/expectConstraintViolation`,
  check its signature first):

```ts
import { vehicleChargeRecord } from '~/lib/db/schema'
import { insertSession, insertVehicleRecord } from '~test/fixtures/evCharging'

test('a new session defaults to ours, decided by default', async () => {
  const id = await insertSession()
  const [row] = await db
    .select({ vehicle: evChargeSession.vehicle, source: evChargeSession.vehicleSource })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, id))
  expect(row).toEqual({ vehicle: 'ours', source: 'default' })
})

test('vehicle and vehicle_source reject unknown values', async () => {
  await expectConstraintViolation(insertSession({ vehicle: 'neighbour' }), 'ev_charge_session_vehicle_check')
  await expectConstraintViolation(insertSession({ vehicleSource: 'guess' }), 'ev_charge_session_vehicle_source_check')
})

test('vehicle_charge_record enforces its checks and (source, source_session_id) uniqueness', async () => {
  await insertVehicleRecord({ sourceSessionId: 'a' })
  await expectConstraintViolation(insertVehicleRecord({ sourceSessionId: 'a' }), 'vehicle_charge_record_source_session_id_unique')
  await expectConstraintViolation(insertVehicleRecord({ endAt: new Date('2026-01-01T09:00:00Z') }), 'vehicle_charge_record_end_at_check')
  await expectConstraintViolation(insertVehicleRecord({ energyKwh: -1 }), 'vehicle_charge_record_energy_kwh_nonneg_check')
  await expectConstraintViolation(insertVehicleRecord({ startSocPercent: 101 }), 'vehicle_charge_record_start_soc_percent_check')
  await expectConstraintViolation(insertVehicleRecord({ source: 'myskoda_api' }), 'vehicle_charge_record_source_check')
})
```

  Fixture in `test/fixtures/evCharging.ts`:

```ts
let recordCounter = 0
export async function insertVehicleRecord(
  overrides: Partial<typeof vehicleChargeRecord.$inferInsert> = {},
): Promise<string> {
  recordCounter += 1
  const [row] = await db
    .insert(vehicleChargeRecord)
    .values({
      source: 'skoda_export',
      sourceSessionId: `skoda-${recordCounter}`,
      startAt: new Date('2026-01-01T10:00:00Z'),
      endAt: new Date('2026-01-01T11:00:00Z'),
      energyKwh: 5,
      isPublic: false,
      ...overrides,
    })
    .returning({ id: vehicleChargeRecord.id })
  return row.id
}
```

- [ ] **Step 2: Run to verify it fails** — `bunx vitest run src/lib/services/evCharging/evCharging.test.ts` →
  FAIL (type errors / missing table).

- [ ] **Step 3: Implement the vocabulary** `src/lib/evCharging/vehicle.ts`:

```ts
import { z } from 'zod'

// Dependency-free, client-safe vocabulary for "who charged" (ADR-0021). The
// schema's CHECK constraints, the procedures' zod inputs and the UI all read
// these arrays, so the allowed values are single-sourced.
export const VEHICLES = ['ours', 'other'] as const
export type Vehicle = (typeof VEHICLES)[number]
/** What a charging view shows: our car, guests, or every counted session. */
export const VEHICLE_SCOPES = ['ours', 'other', 'all'] as const
export type VehicleScope = (typeof VEHICLE_SCOPES)[number]
/** Why a session has its vehicle: nobody decided (counts as ours), the car's log, or an admin. */
export const VEHICLE_SOURCES = ['default', 'skoda', 'admin'] as const
export type VehicleSource = (typeof VEHICLE_SOURCES)[number]
export const VEHICLE_RECORD_SOURCES = ['skoda_export'] as const
export type VehicleRecordSource = (typeof VEHICLE_RECORD_SOURCES)[number]

export const vehicleScope = z.enum(VEHICLE_SCOPES)

/** Upper bound on one import (a year of the car's log is ≈ 200 rows). */
export const MAX_IMPORT_ROWS = 5_000

const socPercent = z.number().int().min(0).max(100).nullable()

/** One row of the car's own charging log, as the browser sends it after parsing the export. */
export const vehicleRecordInput = z
  .object({
    sourceSessionId: z.string().trim().min(1).max(100),
    startAt: z.date(),
    endAt: z.date(),
    energyKwh: z.number().min(0).max(1_000),
    startSocPercent: socPercent,
    endSocPercent: socPercent,
    isPublic: z.boolean(),
  })
  .refine((r) => r.endAt.getTime() >= r.startAt.getTime(), { path: ['endAt'] })
export type VehicleRecordInput = z.infer<typeof vehicleRecordInput>
```

- [ ] **Step 4: Implement the schema.** In `src/lib/db/schema/evCharging.ts`, import
  `VEHICLES, VEHICLE_SOURCES` from `'../../evCharging/vehicle'` and `sqlList` from `'../sqlList'`; add before
  `createdAt`:

```ts
    // Who charged (ADR-0021). Never in `zaptecOwnedSessionUpdateSet`, so the
    // Zaptec sync can't clobber an attribution. 'default' counts as ours.
    vehicle: text('vehicle').notNull().default('ours'),
    vehicleSource: text('vehicle_source').notNull().default('default'),
```

  and in the table callback:

```ts
    check('ev_charge_session_vehicle_check', sql`${table.vehicle} IN (${sqlList(VEHICLES)})`),
    check(
      'ev_charge_session_vehicle_source_check',
      sql`${table.vehicleSource} IN (${sqlList(VEHICLE_SOURCES)})`,
    ),
```

  Create `src/lib/db/schema/vehicleCharge.ts`:

```ts
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { VEHICLE_RECORD_SOURCES } from '../../evCharging/vehicle'
import { sqlList } from '../sqlList'

// The car's own charging log (ADR-0021): one row per charge the car itself
// recorded, wherever it charged. Imported from the MySkoda export; location
// names and prices are never stored (`is_public` keeps only the fact). Read by
// the vehicle re-match and, later, Phase 6's SoC insights.
export const vehicleChargeRecord = pgTable(
  'vehicle_charge_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceSessionId: text('source_session_id').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    startSocPercent: smallint('start_soc_percent'),
    endSocPercent: smallint('end_soc_percent'),
    isPublic: boolean('is_public').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Re-importing the same export is a no-op.
    unique('vehicle_charge_record_source_session_id_unique').on(table.source, table.sourceSessionId),
    check('vehicle_charge_record_source_check', sql`${table.source} IN (${sqlList(VEHICLE_RECORD_SOURCES)})`),
    check('vehicle_charge_record_end_at_check', sql`${table.endAt} >= ${table.startAt}`),
    check('vehicle_charge_record_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
    check(
      'vehicle_charge_record_start_soc_percent_check',
      sql`${table.startSocPercent} IS NULL OR ${table.startSocPercent} BETWEEN 0 AND 100`,
    ),
    check(
      'vehicle_charge_record_end_soc_percent_check',
      sql`${table.endSocPercent} IS NULL OR ${table.endSocPercent} BETWEEN 0 AND 100`,
    ),
  ],
).enableRLS()
```

  Index decision deferred to the schema-design reviewer (the re-match joins records by time overlap; ≈200 rows).

- [ ] **Step 5: Generate + apply the migration** — `bun run db:generate --name=vehicle_attribution && bun run db:migrate`.
  Inspect `drizzle/0007_vehicle_attribution.sql`: two `ALTER TABLE "ev_charge_session" ADD COLUMN … DEFAULT … NOT NULL`,
  two `ADD CONSTRAINT … CHECK`, `CREATE TABLE "vehicle_charge_record"` with its constraints, `ENABLE ROW LEVEL SECURITY`.
  No destructive statements.

- [ ] **Step 6: Client-safe guard** — add to `src/lib/evCharging/clientSafe.browser.test.tsx`, matching its existing shape:

```ts
test('vehicle vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/evCharging/vehicle')
  expect(mod.VEHICLE_SCOPES).toEqual(['ours', 'other', 'all'])
})
```

- [ ] **Step 7: Run** — `bunx vitest run src/lib/services/evCharging/evCharging.test.ts test/rls.test.ts` → PASS;
  `bunx vitest run --project browser src/lib/evCharging/clientSafe.browser.test.tsx` → PASS; `bun run typecheck` → clean.

- [ ] **Step 8: Commit** — `feat(charging): add vehicle attribution columns and car log table`.

- [ ] **Step 9: Review gate** — `migration-guard` + schema-design reviewer in parallel. Fix or rule on every finding before Task 2.

### Task 2: `vehicleCharge` service (import + coverage)

**Files:**
- Create: `src/lib/services/vehicleCharge/{vehicleCharge.ts,vehicleCharge.test.ts,index.ts}`

**Interfaces:**
- Consumes: `vehicleChargeRecord`, `VehicleRecordInput`, `VehicleRecordSource` (Task 1).
- Produces:
```ts
export async function importRecords(
  rows: readonly VehicleRecordInput[],
  opts?: { source?: VehicleRecordSource }, // default 'skoda_export'
): Promise<{ inserted: number; unchanged: number }>
export async function coverage(): Promise<{ from: Date; to: Date; count: number } | null>
```

- [ ] **Step 1: Write the failing tests** `vehicleCharge.test.ts`:

```ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { vehicleChargeRecord } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { coverage, importRecords } from './vehicleCharge'

setupDatabase()

const row = (id: string, start: string, end: string, extra: Partial<Parameters<typeof importRecords>[0][number]> = {}) => ({
  sourceSessionId: id,
  startAt: new Date(start),
  endAt: new Date(end),
  energyKwh: 10,
  startSocPercent: 20,
  endSocPercent: 60,
  isPublic: false,
  ...extra,
})

test('imports rows and reports them inserted', async () => {
  const result = await importRecords([
    row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z'),
    row('b', '2026-02-03T10:00:00Z', '2026-02-03T11:00:00Z', { isPublic: true }),
  ])
  expect(result).toEqual({ inserted: 2, unchanged: 0 })
  expect(await db.select().from(vehicleChargeRecord)).toHaveLength(2)
})

test('re-importing the same export is a no-op', async () => {
  const rows = [row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z')]
  await importRecords(rows)
  expect(await importRecords(rows)).toEqual({ inserted: 0, unchanged: 1 })
  expect(await db.select().from(vehicleChargeRecord)).toHaveLength(1)
})

test('a duplicate id inside one import counts once', async () => {
  const r = row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z')
  expect(await importRecords([r, r])).toEqual({ inserted: 1, unchanged: 1 })
})

test('an empty import writes nothing', async () => {
  expect(await importRecords([])).toEqual({ inserted: 0, unchanged: 0 })
})

test('coverage spans every record, public ones included', async () => {
  expect(await coverage()).toBeNull()
  await importRecords([
    row('a', '2026-02-01T10:00:00Z', '2026-02-01T12:00:00Z'),
    row('b', '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z', { isPublic: true }),
  ])
  expect(await coverage()).toEqual({
    from: new Date('2026-02-01T10:00:00Z'),
    to: new Date('2026-03-05T09:00:00Z'),
    count: 2,
  })
})
```

- [ ] **Step 2: Run** — `bunx vitest run src/lib/services/vehicleCharge` → FAIL (module missing).

- [ ] **Step 3: Implement** `vehicleCharge.ts`:

```ts
import { count, max, min } from 'drizzle-orm'
import { db } from '~/lib/db'
import { vehicleChargeRecord } from '~/lib/db/schema'
import type { VehicleRecordInput, VehicleRecordSource } from '~/lib/evCharging/vehicle'

/**
 * Stores the car's own charging log (ADR-0021). Idempotent on
 * `(source, source_session_id)`: an already-imported id is left as it was
 * (the export never revises a past charge), so re-importing reports it
 * `unchanged`. One statement, so an import lands whole or not at all.
 * ≤ 5 000 rows × 9 params stays under Postgres's 65 535 bind-parameter cap.
 */
export async function importRecords(
  rows: readonly VehicleRecordInput[],
  opts: { source?: VehicleRecordSource } = {},
): Promise<{ inserted: number; unchanged: number }> {
  if (rows.length === 0) return { inserted: 0, unchanged: 0 }
  const source = opts.source ?? 'skoda_export'
  const inserted = await db
    .insert(vehicleChargeRecord)
    .values(rows.map((r) => ({ source, ...r })))
    .onConflictDoNothing({ target: [vehicleChargeRecord.source, vehicleChargeRecord.sourceSessionId] })
    .returning({ id: vehicleChargeRecord.id })
  return { inserted: inserted.length, unchanged: rows.length - inserted.length }
}

/** The span the car's log covers (every record, wherever it charged), or null before any import. */
export async function coverage(): Promise<{ from: Date; to: Date; count: number } | null> {
  const [row] = await db
    .select({
      from: min(vehicleChargeRecord.startAt),
      to: max(vehicleChargeRecord.endAt),
      count: count(),
    })
    .from(vehicleChargeRecord)
  if (!row?.from || !row.to) return null
  return { from: row.from, to: row.to, count: row.count }
}
```

  `index.ts`: `export * from './vehicleCharge'`.

- [ ] **Step 4: Run** — `bunx vitest run src/lib/services/vehicleCharge` → PASS. If drizzle returns `min()`/`max()` of
  timestamptz as strings, wrap with `new Date(...)` and keep the test as written.

- [ ] **Step 5: Commit** — `feat(charging): store the car's own charging log`.

- [ ] **Step 6: Review gate** — `code-reviewer` + `test-completeness`.

### Task 3: Attribution (re-match + admin tag)

**Files:**
- Create: `src/lib/services/evCharging/attribution.ts`, `attribution.test.ts`
- Modify: `src/lib/services/evCharging/counted.ts` (accept a scope — used here and in Task 4)
- Modify: `src/lib/services/evCharging/index.ts` (`export * from './attribution'`)

**Interfaces:**
- Consumes: Task 1 columns/table, `Vehicle`, `VehicleScope`, `VehicleSource`; `EvChargingDomainError` (`EV_SESSION_NOT_FOUND`).
- Produces:
```ts
// counted.ts
export function countedSessionFilter(opts?: { vehicle?: VehicleScope }): SQL
// attribution.ts
export async function reattributeSessions(opts?: { sessionId?: string }): Promise<{ ours: number; other: number; changed: number }>
export async function setSessionVehicle(sessionId: string, vehicle: Vehicle | null): Promise<{ vehicle: Vehicle; vehicleSource: VehicleSource }>
```

- [ ] **Step 1: Write the failing tests** `attribution.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeSession } from '~/lib/db/schema'
import { insertSession, insertVehicleRecord } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { reattributeSessions, setSessionVehicle } from './attribution'
import { EvChargingDomainError } from './errors'

setupDatabase()

const at = (iso: string) => new Date(iso)
async function attribution(id: string) {
  const [row] = await db
    .select({ vehicle: evChargeSession.vehicle, source: evChargeSession.vehicleSource, updatedAt: evChargeSession.updatedAt })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, id))
  return row
}
// Coverage 2026-02-01 → 2026-03-31 via two bracketing records.
async function seedCoverage() {
  await insertVehicleRecord({ startAt: at('2026-02-01T00:00:00Z'), endAt: at('2026-02-01T01:00:00Z') })
  await insertVehicleRecord({ startAt: at('2026-03-31T00:00:00Z'), endAt: at('2026-03-31T01:00:00Z') })
}

test('no records → nothing changes', async () => {
  const id = await insertSession({ startAt: at('2026-02-10T10:00:00Z'), endAt: at('2026-02-10T12:00:00Z') })
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 0, changed: 0 })
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('a session overlapping a home record is ours; one overlapping nothing is other', async () => {
  await seedCoverage()
  const ours = await insertSession({ startAt: at('2026-02-10T10:00:00Z'), endAt: at('2026-02-10T12:00:00Z') })
  await insertVehicleRecord({ startAt: at('2026-02-10T11:00:00Z'), endAt: at('2026-02-10T13:00:00Z') })
  const guest = await insertSession({ startAt: at('2026-02-20T10:00:00Z'), endAt: at('2026-02-20T12:00:00Z') })
  expect(await reattributeSessions()).toEqual({ ours: 1, other: 1, changed: 2 })
  expect(await attribution(ours)).toMatchObject({ vehicle: 'ours', source: 'skoda' })
  expect(await attribution(guest)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('touching intervals do not overlap', async () => {
  await seedCoverage()
  const id = await insertSession({ startAt: at('2026-02-10T10:00:00Z'), endAt: at('2026-02-10T12:00:00Z') })
  await insertVehicleRecord({ startAt: at('2026-02-10T12:00:00Z'), endAt: at('2026-02-10T13:00:00Z') })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('a public record never makes a session ours', async () => {
  await seedCoverage()
  const id = await insertSession({ startAt: at('2026-02-10T10:00:00Z'), endAt: at('2026-02-10T12:00:00Z') })
  await insertVehicleRecord({ startAt: at('2026-02-10T10:30:00Z'), endAt: at('2026-02-10T11:00:00Z'), isPublic: true })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'other', source: 'skoda' })
})

test('sessions outside coverage, admin-tagged or uncounted are left alone', async () => {
  await seedCoverage()
  const after = await insertSession({ startAt: at('2026-04-02T10:00:00Z'), endAt: at('2026-04-02T12:00:00Z') })
  const tagged = await insertSession({ startAt: at('2026-02-10T10:00:00Z'), endAt: at('2026-02-10T12:00:00Z'), vehicle: 'ours', vehicleSource: 'admin' })
  const noise = await insertSession({ startAt: at('2026-02-11T10:00:00Z'), endAt: at('2026-02-11T10:05:00Z'), energyKwh: 0.1 })
  await reattributeSessions()
  expect(await attribution(after)).toMatchObject({ vehicle: 'ours', source: 'default' })
  expect(await attribution(tagged)).toMatchObject({ vehicle: 'ours', source: 'admin' })
  expect(await attribution(noise)).toMatchObject({ vehicle: 'ours', source: 'default' })
})

test('a session starting inside coverage and ending after it is decided', async () => {
  await seedCoverage()
  const id = await insertSession({ startAt: at('2026-03-31T00:30:00Z'), endAt: at('2026-04-01T06:00:00Z') })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'skoda' })
})

test('a second pass changes nothing and leaves updated_at alone', async () => {
  await seedCoverage()
  const id = await insertSession({ startAt: at('2026-02-20T10:00:00Z'), endAt: at('2026-02-20T12:00:00Z') })
  await reattributeSessions()
  const before = await attribution(id)
  expect(await reattributeSessions()).toEqual({ ours: 0, other: 1, changed: 0 })
  expect((await attribution(id)).updatedAt).toEqual(before.updatedAt)
})

test('sessionId limits the pass to one session', async () => {
  await seedCoverage()
  const a = await insertSession({ startAt: at('2026-02-20T10:00:00Z'), endAt: at('2026-02-20T12:00:00Z') })
  const b = await insertSession({ startAt: at('2026-02-21T10:00:00Z'), endAt: at('2026-02-21T12:00:00Z') })
  expect(await reattributeSessions({ sessionId: a })).toEqual({ ours: 0, other: 1, changed: 1 })
  expect(await attribution(b)).toMatchObject({ source: 'default' })
})

test('setSessionVehicle tags as admin, and a later pass keeps it', async () => {
  await seedCoverage()
  const id = await insertSession({ startAt: at('2026-02-20T10:00:00Z'), endAt: at('2026-02-20T12:00:00Z') })
  expect(await setSessionVehicle(id, 'ours')).toEqual({ vehicle: 'ours', vehicleSource: 'admin' })
  await reattributeSessions()
  expect(await attribution(id)).toMatchObject({ vehicle: 'ours', source: 'admin' })
})

test('setSessionVehicle(null) resets to automatic and re-derives', async () => {
  await seedCoverage()
  const inside = await insertSession({ startAt: at('2026-02-20T10:00:00Z'), endAt: at('2026-02-20T12:00:00Z'), vehicle: 'ours', vehicleSource: 'admin' })
  const outside = await insertSession({ startAt: at('2026-05-01T10:00:00Z'), endAt: at('2026-05-01T12:00:00Z'), vehicle: 'other', vehicleSource: 'admin' })
  expect(await setSessionVehicle(inside, null)).toEqual({ vehicle: 'other', vehicleSource: 'skoda' })
  expect(await setSessionVehicle(outside, null)).toEqual({ vehicle: 'ours', vehicleSource: 'default' })
})

test('setSessionVehicle rejects unknown, non-uuid and uncounted sessions', async () => {
  const noise = await insertSession({ energyKwh: 0.1 })
  for (const id of ['00000000-0000-4000-8000-000000000000', 'nope', noise]) {
    await expect(setSessionVehicle(id, 'other')).rejects.toEqual(new EvChargingDomainError('EV_SESSION_NOT_FOUND'))
  }
})
```

- [ ] **Step 2: Run** — `bunx vitest run src/lib/services/evCharging/attribution.test.ts` → FAIL.

- [ ] **Step 3: Scope the counted filter** (`counted.ts`):

```ts
import { and, eq, gte, isNull, type SQL } from 'drizzle-orm'
import { evChargeSession } from '~/lib/db/schema'
import { NOISE_THRESHOLD_KWH } from '~/lib/evCharging/counting'
import type { VehicleScope } from '~/lib/evCharging/vehicle'

// The one "counted session" predicate every charging read shares (overview
// totals, session list, cost, patterns, economy): noise (sub-threshold), voided
// and replaced sessions never appear in totals, lists or cost. `vehicle`
// narrows it to our car or guests (ADR-0021); omitted or 'all' adds nothing.
export function countedSessionFilter(opts: { vehicle?: VehicleScope } = {}): SQL {
  const vehicle = opts.vehicle && opts.vehicle !== 'all' ? opts.vehicle : undefined
  return and(
    eq(evChargeSession.voided, false),
    isNull(evChargeSession.replacedByZaptecSessionId),
    gte(evChargeSession.energyKwh, NOISE_THRESHOLD_KWH),
    vehicle ? eq(evChargeSession.vehicle, vehicle) : undefined,
  ) as SQL
}
```

- [ ] **Step 4: Implement** `attribution.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '~/lib/db'
import { evChargeSession, vehicleChargeRecord } from '~/lib/db/schema'
import type { Vehicle, VehicleSource } from '~/lib/evCharging/vehicle'
import { countedSessionFilter } from './counted'
import { EvChargingDomainError } from './errors'

/**
 * Re-derives attribution from the car's own log (ADR-0021): every counted
 * session starting inside the log's coverage, not tagged by an admin, becomes
 * 'ours' when a non-public record overlaps it in time and 'other' otherwise.
 * One statement; rows already right aren't written (updated_at untouched).
 * `ours`/`other` count every session the rule decided, `changed` the rows written.
 */
export async function reattributeSessions(
  opts: { sessionId?: string } = {},
): Promise<{ ours: number; other: number; changed: number }> {
  const s = evChargeSession
  const r = vehicleChargeRecord
  const onlyOne = opts.sessionId ? sql`and ${s.id} = ${opts.sessionId}` : sql``
  const result = await db.execute<{ ours: string; other: string; changed: string }>(sql`
    with coverage as (
      select min(${r.startAt}) as from_at, max(${r.endAt}) as to_at from ${r}
    ),
    target as (
      select ${s.id} as id,
        case when exists (
          select 1 from ${r}
          where not ${r.isPublic} and ${r.startAt} < ${s.endAt} and ${r.endAt} > ${s.startAt}
        ) then 'ours' else 'other' end as vehicle
      from ${s}, coverage
      where coverage.from_at is not null
        and ${s.startAt} between coverage.from_at and coverage.to_at
        and ${s.vehicleSource} <> 'admin'
        and ${countedSessionFilter()}
        ${onlyOne}
    ),
    updated as (
      update ${s} set vehicle = target.vehicle, vehicle_source = 'skoda', updated_at = now()
      from target
      where ${s.id} = target.id
        and (${s.vehicle} <> target.vehicle or ${s.vehicleSource} <> 'skoda')
      returning ${s.id}
    )
    select
      count(*) filter (where target.vehicle = 'ours') as ours,
      count(*) filter (where target.vehicle = 'other') as other,
      (select count(*) from updated) as changed
    from target
  `)
  const row = result.rows[0]
  return { ours: Number(row?.ours ?? 0), other: Number(row?.other ?? 0), changed: Number(row?.changed ?? 0) }
}

/**
 * An admin's call on who charged. `null` ("Automatiskt") drops the tag back to
 * 'default' and lets the car's log decide again. Unknown, non-uuid or
 * uncounted ids are EV_SESSION_NOT_FOUND, like the session page.
 */
export async function setSessionVehicle(
  sessionId: string,
  vehicle: Vehicle | null,
): Promise<{ vehicle: Vehicle; vehicleSource: VehicleSource }> {
  if (!z.uuid().safeParse(sessionId).success) throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  const [row] = await db
    .update(evChargeSession)
    .set(vehicle ? { vehicle, vehicleSource: 'admin' } : { vehicle: 'ours', vehicleSource: 'default' })
    .where(and(eq(evChargeSession.id, sessionId), countedSessionFilter()))
    .returning({ id: evChargeSession.id })
  if (!row) throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  if (vehicle === null) await reattributeSessions({ sessionId })
  const [after] = await db
    .select({ vehicle: evChargeSession.vehicle, vehicleSource: evChargeSession.vehicleSource })
    .from(evChargeSession)
    .where(eq(evChargeSession.id, sessionId))
  return after as { vehicle: Vehicle; vehicleSource: VehicleSource }
}
```

  If drizzle renders `${s.startAt}` qualified as `"ev_charge_session"."start_at"`, the `from ${s}` alias-free form
  above is valid SQL; verify by running the tests (not by guessing). Inside the `update … from target` CTE the
  bare `vehicle =` / `vehicle_source =` SET targets are deliberate (SET columns can't be table-qualified).

- [ ] **Step 5: Run** — `bunx vitest run src/lib/services/evCharging` → PASS (attribution + the existing suites,
  unchanged by the defaulted `countedSessionFilter`).

- [ ] **Step 6: Commit** — `feat(charging): derive session attribution from the car's log`.

- [ ] **Step 7: Review gate** — `code-reviewer` + `test-completeness`.

### Task 4: Scope every charging read and return the attribution

**Files:**
- Modify: `src/lib/services/evCharging/overview.ts` (`monthlyTotals`, `allTimeTotals`, `getOverview`, `listSessions`, `SessionRow`)
- Modify: `src/lib/services/evCharging/patterns.ts` (`fetchSessions`, `getChargingPatterns`, `getChargingTimeline`)
- Modify: `src/lib/services/evCharging/sessionEnergy.ts` (`listSessionEnergy` filter, `SessionEnergy`)
- Modify: `src/lib/evCharging/costing.ts` (`getCostOverview` only)
- Modify: `src/lib/evCharging/chargingEconomy.ts` (`getEconomyOverview`, `EconomySessionRow`, `SessionEconomyDetail`)
- Test: `overview.test.ts`, `patterns.test.ts`, `sessionEnergy.test.ts`, `src/lib/evCharging/costing.test.ts`, `chargingEconomy.test.ts`

**Interfaces:**
- Consumes: `countedSessionFilter({ vehicle })` (Task 3), `Vehicle`, `VehicleScope`, `VehicleSource`.
- Produces (signatures later tasks call):
```ts
getOverview(input: { year?: number; now?: Date; vehicle?: VehicleScope })
listSessions(input: { limit: number; vehicle?: VehicleScope }) // SessionRow gains vehicle: Vehicle
getChargingPatterns(input: { year?; now?; timings?; vehicle?: VehicleScope })
getChargingTimeline(input: { year?; month?; now?; timings?; vehicle?: VehicleScope })
listSessionEnergy(filter: { all: true; vehicle?: VehicleScope } | { sessionIds: readonly string[] })
// SessionEnergy gains vehicle: Vehicle; vehicleSource: VehicleSource
getCostOverview(input: { year?; now?; timings?; vehicle?: VehicleScope })
getEconomyOverview(input: { year?; now?; timings?; vehicle?: VehicleScope }) // EconomySessionRow gains vehicle
// SessionEconomyDetail.session gains vehicle: Vehicle; vehicleSource: VehicleSource
```
- **Unscoped on purpose:** `distinctCountedYears`, `earliestCountedStartAt`, `getSessionEnergy`, `getSessionEconomy`, `getSessionCosts`.

- [ ] **Step 1: Write the failing scope tests.** One per read model, each seeding one `ours` and one `other`
  session (`insertSession({ vehicle: 'other' })` / the files' local `session(..., overrides)` helpers) and asserting
  `ours` → only ours, `other` → only the guest, omitted/`all` → both. Concretely:

```ts
// overview.test.ts
test('getOverview and listSessions follow the vehicle scope', async () => {
  const ours = await insertSession({ startAt: new Date('2026-03-01T10:00:00Z'), endAt: new Date('2026-03-01T11:00:00Z'), energyKwh: 10 })
  const guest = await insertSession({ startAt: new Date('2026-03-02T10:00:00Z'), endAt: new Date('2026-03-02T11:00:00Z'), energyKwh: 4, vehicle: 'other' })
  const now = new Date('2026-03-15T12:00:00Z')
  expect((await getOverview({ year: 2026, now, vehicle: 'ours' })).tiles.allTime).toMatchObject({ kwh: 10, sessions: 1 })
  expect((await getOverview({ year: 2026, now, vehicle: 'other' })).tiles.allTime).toMatchObject({ kwh: 4, sessions: 1 })
  expect((await getOverview({ year: 2026, now })).tiles.allTime).toMatchObject({ kwh: 14, sessions: 2 })
  expect((await getOverview({ year: 2026, now, vehicle: 'other' })).years).toContain(2026) // years unscoped
  const list = await listSessions({ limit: 10, vehicle: 'other' })
  expect(list.sessions.map((s) => [s.id, s.vehicle])).toEqual([[guest, 'other']])
  expect((await listSessions({ limit: 10 })).sessions.map((s) => s.id)).toEqual([guest, ours])
})
```

  Match the tile/field names to `ChargingOverview` (`overview.ts:14-19`) — read them, don't assume `tiles.allTime`.
  Equivalent tests: `patterns.test.ts` (`getChargingPatterns` totals + `getChargingTimeline` months/sessions under
  `other`), `sessionEnergy.test.ts` (`listSessionEnergy({ all: true, vehicle: 'ours' })` excludes the guest;
  `getSessionEnergy(guestId)` still returns it with `vehicle: 'other', vehicleSource`; `earliestCountedStartAt()`
  still sees the guest), `costing.test.ts` (`getCostOverview({ vehicle: 'ours' })` all-time kWh excludes the guest),
  `chargingEconomy.test.ts` (`getEconomyOverview({ vehicle: 'other' }).sessions` = the guest row with
  `vehicle: 'other'`; **`getSessionEconomy({ sessionId: guestId }).session` has `vehicle: 'other'` and
  `vehicleSource: 'default'`** — Review Focus 4).

- [ ] **Step 2: Run** — `bunx vitest run src/lib/services/evCharging src/lib/evCharging` → FAIL.

- [ ] **Step 3: Thread the scope.**
  - `overview.ts`: `monthlyTotals(year, vehicle?)` and `allTimeTotals(vehicle?)` pass
    `countedSessionFilter({ vehicle })` at every use (:71, :84, :97, :156, :162, :167); `getOverview` passes
    `input.vehicle` to both; `distinctCountedYears()` unchanged. `listSessions` passes it at :232 and selects
    `vehicle: evChargeSession.vehicle`; `SessionRow` gains `vehicle: Vehicle` (cast the selected text with
    `sql<Vehicle>` or `as Vehicle` in the map — the CHECK guarantees it).
  - `patterns.ts`: `fetchSessions(where, vehicle?)` uses `and(countedSessionFilter({ vehicle }), where)`; both
    callers pass `input.vehicle`; the timeline's month query (:116) uses `countedSessionFilter({ vehicle: input.vehicle })`.
  - `sessionEnergy.ts`: the `{ all: true }` branch becomes `countedSessionFilter({ vehicle: filter.vehicle })`;
    select `vehicle`, `vehicleSource`; `SessionEnergy` gains `vehicle: Vehicle; vehicleSource: VehicleSource`.
    `getSessionEnergy` and `earliestCountedStartAt` unchanged.
  - `costing.ts:79`: `listSessionEnergy({ all: true, vehicle: input.vehicle })`.
  - `chargingEconomy.ts:103`: `listSessionEnergy({ all: true, vehicle: input.vehicle })`; rows (:118) add
    `vehicle: s.vehicle`; `EconomySessionRow` adds `vehicle: Vehicle`; `getSessionEconomy`'s `session` adds
    `vehicle: energy.vehicle, vehicleSource: energy.vehicleSource`; `SessionEconomyDetail.session` adds both types.

- [ ] **Step 4: Run** — `bunx vitest run src/lib/services/evCharging src/lib/evCharging` → PASS; `bun run typecheck` clean.

- [ ] **Step 5: Commit** — `feat(charging): scope charging reads by vehicle`.

- [ ] **Step 6: Review gate** — `code-reviewer` + `test-completeness`. Reviewers grep every `countedSessionFilter(`
  call and justify each unscoped one against the list above.

### Task 5: Re-match after every Zaptec sync

**Files:**
- Modify: `src/lib/evCharging/sync.ts` (`SyncRun`, `init`, `execute`, `logFields`, `runStats`)
- Test: `src/lib/evCharging/sync.test.ts`

**Interfaces:**
- Consumes: `reattributeSessions()` via the services barrel (`~/lib/services/evCharging`).
- Produces: `SyncRun.reattributeMs: number` (run line + run-row timings).

- [ ] **Step 1: Write the failing tests** (next to "a failed alert publish is logged…", ~:463; add
  `import * as evChargingService from '~/lib/services/evCharging'` and `insertVehicleRecord` from the fixtures):

```ts
test('a successful sync re-derives attribution and keeps admin tags', async () => {
  await insertVehicleRecord({ startAt: new Date(T1.getTime() - 10 * DAY), endAt: new Date(T1.getTime() - 10 * DAY + HOUR) })
  await insertVehicleRecord({ startAt: new Date(T1.getTime() - HOUR), endAt: new Date(T1.getTime()) })
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - 3 * DAY))])
  const { log, runLines } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(run.outcome).toBe('ok')
  const [row] = await sessionRows()
  // s0 overlaps no record but sits inside coverage → a guest.
  expect(row).toMatchObject({ zaptecSessionId: 's0', vehicle: 'other', vehicleSource: 'skoda' })
  expect(runLines()[0]).toHaveProperty('reattributeMs')

  await db.update(evChargeSession).set({ vehicle: 'ours', vehicleSource: 'admin' })
  await runZaptecSync({ trigger: 'cron', now: () => new Date(T1.getTime() + HOUR), deps: { zaptec: client, log } })
  expect((await sessionRows())[0]).toMatchObject({ vehicle: 'ours', vehicleSource: 'admin' })
})

test('a failed re-match is logged as a warning and does not fail the run', async () => {
  vi.spyOn(evChargingService, 'reattributeSessions').mockRejectedValueOnce(new Error('db hiccup'))
  const { client } = fakeZaptec([session('s0', new Date(T1.getTime() - DAY))])
  const { log, entries } = capturingLogger()
  const run = await runZaptecSync({ trigger: 'cron', now: () => T1, deps: { zaptec: client, log } })
  expect(run.outcome).toBe('ok')
  expect(entries().find((e) => e.msg === 'zaptec sync: vehicle re-match failed')).toMatchObject({ level: WARN })
})
```

  Check `sessionRows()` selects `vehicle`/`vehicleSource`; extend it if not. If the namespace spy doesn't intercept
  (ESM live binding), make `sync.ts` call it as `evChargingService.reattributeSessions()` through a namespace import —
  the same way `integrationSyncService.recordOutcome` is spied at :714.

- [ ] **Step 2: Run** — `bunx vitest run src/lib/evCharging/sync.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `SyncRun` gains `/** Time spent re-deriving vehicle attribution after the import. */ reattributeMs: number`;
  `init` sets `reattributeMs: 0`; `execute` becomes:

```ts
    execute: async ({ run, signal, now, log }) => {
      await fetchAndImport(client, run, stats, signal, now)
      // Attribution follows the import (ADR-0021). Health tracks Zaptec, not
      // attribution, so a failure here is a warning, never a failed run.
      const started = performance.now()
      try {
        await evChargingService.reattributeSessions()
      } catch (error) {
        log.warn('zaptec sync: vehicle re-match failed', { error })
      } finally {
        run.reattributeMs = Math.round(performance.now() - started)
      }
    },
```

  `logFields` adds `reattributeMs: run.reattributeMs`; `runStats().timings` adds `reattributeMs: run.reattributeMs`.
  Import: `import * as evChargingService from '~/lib/services/evCharging'` (keep the existing named imports or
  switch them to the namespace — one style per file).

- [ ] **Step 4: Run** — `bunx vitest run src/lib/evCharging` → PASS.

- [ ] **Step 5: Commit** — `feat(charging): re-derive attribution after each Zaptec sync`.

- [ ] **Step 6: Review gate** — `code-reviewer` + `test-completeness`.

### Task 6: Procedures

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts`
- Test: `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 service functions; `vehicleScope`, `vehicleRecordInput`, `MAX_IMPORT_ROWS`, `VEHICLES`.
- Produces (router keys PR 2 calls):
```ts
evCharging.overview|sessions|costOverview|patterns|timeline|economy  input += { vehicle?: VehicleScope } (default 'all')
evCharging.setSessionVehicle   admin  { sessionId: uuid, vehicle: 'ours'|'other'|null } → { vehicle, vehicleSource }
evCharging.importVehicleRecords admin { rows: VehicleRecordInput[] (1..5000) } → { inserted, unchanged, ours, other }
evCharging.vehicleRecordCoverage admin → { from: Date; to: Date; count: number } | null
```

- [ ] **Step 1: Write the failing tests** (reuse `signIn`, `baseContext`, `call`):

```ts
test('reads take a vehicle scope and default to all', async () => {
  await signIn('user')
  await insertSession({ startAt: new Date('2026-03-01T10:00:00Z'), endAt: new Date('2026-03-01T11:00:00Z') })
  await insertSession({ startAt: new Date('2026-03-02T10:00:00Z'), endAt: new Date('2026-03-02T11:00:00Z'), vehicle: 'other' })
  const all = await call(evChargingRouter.sessions, { limit: 10 }, { context: baseContext() })
  const guests = await call(evChargingRouter.sessions, { limit: 10, vehicle: 'other' }, { context: baseContext() })
  expect(all.sessions).toHaveLength(2)
  expect(guests.sessions.map((s) => s.vehicle)).toEqual(['other'])
  await expect(call(evChargingRouter.sessions, { limit: 10, vehicle: 'x' as never }, { context: baseContext() })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('the attribution mutations and coverage are admin-only', async () => {
  await signIn('user')
  const id = await insertSession()
  for (const [proc, input] of [
    [evChargingRouter.setSessionVehicle, { sessionId: id, vehicle: 'other' }],
    [evChargingRouter.importVehicleRecords, { rows: [importRow('a')] }],
    [evChargingRouter.vehicleRecordCoverage, undefined],
  ] as const) {
    await expect(call(proc as never, input as never, { context: baseContext() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  }
})

test('importVehicleRecords stores rows, re-matches, and is idempotent', async () => {
  await signIn('admin')
  const id = await insertSession({ startAt: new Date('2026-02-10T10:00:00Z'), endAt: new Date('2026-02-10T12:00:00Z') })
  const rows = [importRow('a', '2026-02-10T11:00:00Z', '2026-02-10T13:00:00Z')]
  expect(await call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() })).toEqual({ inserted: 1, unchanged: 0, ours: 1, other: 0 })
  expect(await call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() })).toEqual({ inserted: 0, unchanged: 1, ours: 1, other: 0 })
  expect(await call(evChargingRouter.vehicleRecordCoverage, undefined, { context: baseContext() })).toMatchObject({ count: 1 })
  expect(await call(evChargingRouter.setSessionVehicle, { sessionId: id, vehicle: 'other' }, { context: baseContext() })).toEqual({ vehicle: 'other', vehicleSource: 'admin' })
})

test('importVehicleRecords rejects an empty, oversized or inverted import', async () => {
  await signIn('admin')
  for (const rows of [
    [],
    Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => importRow(`r${i}`)),
    [importRow('a', '2026-02-10T12:00:00Z', '2026-02-10T11:00:00Z')],
  ]) {
    await expect(call(evChargingRouter.importVehicleRecords, { rows }, { context: baseContext() })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})

test('setSessionVehicle maps an unknown session to NOT_FOUND', async () => {
  await signIn('admin')
  await expect(
    call(evChargingRouter.setSessionVehicle, { sessionId: '00000000-0000-4000-8000-000000000000', vehicle: null }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND' })
})
```

  with a local helper:

```ts
const importRow = (id: string, start = '2026-02-01T10:00:00Z', end = '2026-02-01T11:00:00Z') => ({
  sourceSessionId: id, startAt: new Date(start), endAt: new Date(end), energyKwh: 5,
  startSocPercent: 20, endSocPercent: 40, isPublic: false,
})
```

  Check how the existing session-page NOT_FOUND test asserts the code (it may be `code: 'EV_SESSION_NOT_FOUND'` or
  `status: 404`) and match it.

- [ ] **Step 2: Run** — `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Add `const vehicleInput = vehicleScope.default('all')` beside `yearInput` and add
  `vehicle: vehicleInput` to the input objects of `overview`, `sessions`, `costOverview`, `patterns`, `timeline`,
  `economy`, passing `input.vehicle` to each service (`timeline` already spreads `...input`). Then:

```ts
  // Admin's call on who charged one session (ADR-0021); null = back to automatic.
  setSessionVehicle: adminProcedure
    .errors(evChargingErrors)
    .input(z.object({ sessionId: z.uuid(), vehicle: z.enum(VEHICLES).nullable() }))
    .handler(async ({ input, errors }) => {
      try {
        return await evChargingService.setSessionVehicle(input.sessionId, input.vehicle)
      } catch (err) {
        if (err instanceof EvChargingDomainError) throw errors[err.code]()
        throw err
      }
    }),

  // The car's own charging log, parsed in the admin's browser (no file bytes
  // here — ADR-0006), then one re-match. Two writes → sub-timings.
  importVehicleRecords: adminProcedure
    .input(z.object({ rows: z.array(vehicleRecordInput).min(1).max(MAX_IMPORT_ROWS) }))
    .handler(async ({ input, context }) => {
      const importStart = performance.now()
      const imported = await vehicleChargeService.importRecords(input.rows)
      const reattributeStart = performance.now()
      const { ours, other } = await evChargingService.reattributeSessions()
      if (context.timings) {
        context.timings.vehicleImportMs = Math.round(reattributeStart - importStart)
        context.timings.vehicleReattributeMs = Math.round(performance.now() - reattributeStart)
      }
      return { ...imported, ours, other }
    }),

  vehicleRecordCoverage: adminProcedure.handler(() => vehicleChargeService.coverage()),
```

  Imports: `VEHICLES, MAX_IMPORT_ROWS, vehicleRecordInput, vehicleScope` from `~/lib/evCharging/vehicle`;
  `* as vehicleChargeService from '~/lib/services/vehicleCharge'`.

- [ ] **Step 4: Run** — `bunx vitest run src/lib/orpc` → PASS; `bun run typecheck` clean.

- [ ] **Step 5: Commit** — `feat(charging): expose vehicle scope, tagging and log import`.

- [ ] **Step 6: Review gate** — `code-reviewer` + security reviewer (admin gates, input bounds, nothing PII-shaped logged).

- [ ] **Step 7: PR 1 branch review + pre-PR gate** — Phase 5 gates (`migration-guard` + schema-design review over
  the whole diff, `test-completeness`, `code-reviewer`, a general correctness pass), then the pre-PR gate in
  `docs/feature-workflow.md`. Also: import the real CSV into the **local** DB through a throwaway,
  uncommitted `bun -e` script (quote-aware regex split, the same field mapping as Task 7; papaparse arrives in PR 2)
  that calls `importRecords` + `reattributeSessions`, and confirm **91 ours / 4 other**. Open PR 1 with the
  template; list the deviation.

---

## PR 2 — `feat(charging): filter charging views by vehicle`

Branch `feat/charging-vehicle-filter` off `main` after PR 1 merges (new worktree).

### Task 7: MySkoda CSV parser (client-safe, lazy-loaded)

**Files:**
- `bun add papaparse && bun add -d @types/papaparse`
- Create: `src/lib/evCharging/skodaExport.ts`, `skodaExport.test.ts`
- Create: `test/fixtures/skodaExport.ts` (synthetic, no real data; a string constant so node **and** browser tests share it)
- Modify: `.gitignore` (add `/data/private/`)

**Interfaces:**
- Produces:
```ts
export type SkodaParseResult =
  | { ok: true; rows: VehicleRecordInput[]; dropped: number; publicCount: number; from: Date; to: Date }
  | { ok: false; error: 'not_skoda_export' | 'empty' }
export function parseSkodaExport(text: string): SkodaParseResult
```

- [ ] **Step 1: Fixture** `test/fixtures/skodaExport.ts` exporting `SKODA_EXPORT_FIXTURE: string` — the export's exact header (16 quoted columns), CRLF line
  endings, a UTF-8 BOM, every field quoted, a trailing empty line, 4 rows: two home charges, one public (location
  `"Laddplats, Testgatan 1"` — a comma inside quotes), and one with an unparseable `Started on` (`"n/a"`):

```
\uFEFF"Session ID","Started on","Ended on","Charging time (s)","Actual charging time (s)","Total energy (kWh)","Battery energy (kWh)","""Comfort"" energy (kWh)","Start SOC (%)","End SOC (%)","Total price","Energy price","Blocking fees","Voucher amount used","Location name","Charging location"
"s-1","2026-02-10T11:00:00Z","2026-02-10T13:00:00Z","7200","7000","12.00","","","20.00","45.00","","","","","",""
"s-2","2026-03-01T08:00:00Z","2026-03-01T09:30:00Z","5400","5400","8.00","","","50.00","70.00","","","","","",""
"s-3","2026-03-05T12:00:00Z","2026-03-05T12:40:00Z","2400","2400","30.00","","","10.00","80.00","199.00","","","","Laddplats, Testgatan 1",""
"s-4","n/a","2026-03-06T10:00:00Z","0","0","1.00","","","","","","","","","",""
```

  Build it as `'\uFEFF' + LINES.join('\r\n') + '\r\n'` so the BOM, CRLF and trailing empty line are real.

- [ ] **Step 2: Failing tests** `skodaExport.test.ts`:

```ts
import { expect, test } from 'vitest'
import { SKODA_EXPORT_FIXTURE as fixture } from '~test/fixtures/skodaExport'
import { parseSkodaExport } from './skodaExport'

test('parses the export (BOM, CRLF, quoted commas), dropping unreadable rows', () => {
  const result = parseSkodaExport(fixture)
  expect(result).toMatchObject({ ok: true, dropped: 1, publicCount: 1 })
  if (!result.ok) throw new Error('unreachable')
  expect(result.rows).toEqual([
    { sourceSessionId: 's-1', startAt: new Date('2026-02-10T11:00:00Z'), endAt: new Date('2026-02-10T13:00:00Z'), energyKwh: 12, startSocPercent: 20, endSocPercent: 45, isPublic: false },
    { sourceSessionId: 's-2', startAt: new Date('2026-03-01T08:00:00Z'), endAt: new Date('2026-03-01T09:30:00Z'), energyKwh: 8, startSocPercent: 50, endSocPercent: 70, isPublic: false },
    { sourceSessionId: 's-3', startAt: new Date('2026-03-05T12:00:00Z'), endAt: new Date('2026-03-05T12:40:00Z'), energyKwh: 30, startSocPercent: 10, endSocPercent: 80, isPublic: true },
  ])
  expect(result.from).toEqual(new Date('2026-02-10T11:00:00Z'))
  expect(result.to).toEqual(new Date('2026-03-05T12:40:00Z'))
})

test('never carries the location name or price', () => {
  const result = parseSkodaExport(fixture)
  expect(JSON.stringify(result)).not.toContain('Testgatan')
  expect(JSON.stringify(result)).not.toContain('199')
})

test('rejects a file that is not a MySkoda export', () => {
  expect(parseSkodaExport('name,email\nA,a@b.c\n')).toEqual({ ok: false, error: 'not_skoda_export' })
  expect(parseSkodaExport('')).toEqual({ ok: false, error: 'not_skoda_export' })
})

test('a header with no readable rows is empty', () => {
  const header = fixture.split(/\r?\n/)[0]
  expect(parseSkodaExport(`${header}\r\n`)).toEqual({ ok: false, error: 'empty' })
})

test('missing SoC becomes null; a blank Started on is dropped', () => {
  const header = fixture.split(/\r?\n/)[0]
  const text = `${header}\n"x","2026-02-01T10:00:00Z","2026-02-01T11:00:00Z","","","3.00","","","","","","","","","",""\n"y","","2026-02-01T11:00:00Z","","","3.00","","","","","","","","","",""`
  const result = parseSkodaExport(text)
  expect(result).toMatchObject({ ok: true, dropped: 1 })
  if (result.ok) expect(result.rows[0]).toMatchObject({ startSocPercent: null, endSocPercent: null })
})
```

- [ ] **Step 3: Run** — `bunx vitest run src/lib/evCharging/skodaExport.test.ts` → FAIL.

- [ ] **Step 4: Implement** `skodaExport.ts`:

```ts
import { isValid, parseISO } from 'date-fns'
import Papa from 'papaparse'
import { type VehicleRecordInput, vehicleRecordInput } from './vehicle'

// Client-safe parser for the MySkoda app's charging-history CSV (ADR-0021).
// Runs in the admin's browser (the dialog imports it lazily), so the file and
// its location names never reach a server; only the fields below leave.
const COLUMNS = {
  id: 'Session ID',
  start: 'Started on',
  end: 'Ended on',
  kwh: 'Total energy (kWh)',
  startSoc: 'Start SOC (%)',
  endSoc: 'End SOC (%)',
  location: 'Location name',
} as const

export type SkodaParseResult =
  | { ok: true; rows: VehicleRecordInput[]; dropped: number; publicCount: number; from: Date; to: Date }
  | { ok: false; error: 'not_skoda_export' | 'empty' }

const date = (v: string | undefined) => {
  const d = v ? parseISO(v) : new Date(Number.NaN)
  return isValid(d) ? d : null
}
const soc = (v: string | undefined) => (v?.trim() ? Math.round(Number(v)) : null)

export function parseSkodaExport(text: string): SkodaParseResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
  })
  const fields = parsed.meta.fields ?? []
  if (!Object.values(COLUMNS).every((c) => fields.includes(c))) return { ok: false, error: 'not_skoda_export' }

  const rows: VehicleRecordInput[] = []
  let dropped = 0
  for (const raw of parsed.data) {
    const candidate = {
      sourceSessionId: raw[COLUMNS.id] ?? '',
      startAt: date(raw[COLUMNS.start]),
      endAt: date(raw[COLUMNS.end]),
      energyKwh: Number(raw[COLUMNS.kwh]),
      startSocPercent: soc(raw[COLUMNS.startSoc]),
      endSocPercent: soc(raw[COLUMNS.endSoc]),
      isPublic: Boolean(raw[COLUMNS.location]?.trim()),
    }
    const row = vehicleRecordInput.safeParse(candidate)
    if (row.success) rows.push(row.data)
    else dropped += 1
  }
  if (rows.length === 0) return { ok: false, error: 'empty' }
  return {
    ok: true,
    rows,
    dropped,
    publicCount: rows.filter((r) => r.isPublic).length,
    from: new Date(Math.min(...rows.map((r) => r.startAt.getTime()))),
    to: new Date(Math.max(...rows.map((r) => r.endAt.getTime()))),
  }
}
```

  Add a client-safe guard test for `skodaExport` in `clientSafe.browser.test.tsx` (same shape as Task 1 Step 6).
  Add `/data/private/` to `.gitignore` with the comment `# Personal exports (e.g. the MySkoda CSV) — never commit`.

- [ ] **Step 5: Run** — node test + `bunx vitest run --project browser src/lib/evCharging/clientSafe.browser.test.tsx` → PASS.
  Then parse the real file locally (not committed) and check the counts:
  `bun -e 'import {parseSkodaExport} from "./src/lib/evCharging/skodaExport"; const r=parseSkodaExport(await Bun.file("../../../data/private/skoda/charging_statistics_20260930_080323.csv").text()); console.log(r.ok && {rows:r.rows.length,dropped:r.dropped,publicCount:r.publicCount})'`
  (path relative to the worktree; adjust). Expect 197 rows (or 197 − dropped), 19 public.

- [ ] **Step 6: Commit** — `feat(charging): parse the MySkoda charging export`.

- [ ] **Step 7: Review gate** — `code-reviewer` + `test-completeness`.

### Task 8: Scope selector on Översikt, Mönster, Ekonomi

**Files:**
- Create: `src/components/evCharging/VehicleScopeToggle.tsx`, `VehicleScopeToggle.browser.test.tsx`
- Modify: `src/components/evCharging/ChargingHeading.tsx` (optional `note` line)
- Modify: `src/routes/_authenticated/charging/index.tsx`, `patterns.tsx`, `economy.tsx`
- Modify: `messages/sv.json`, `messages/en.json`
- Test: `src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx` (search-schema + empty-state tests)

**Interfaces:**
- Consumes: `VEHICLE_SCOPES`, `VehicleScope`, `vehicleScope` (Task 1); procedures' `vehicle` input (Task 6); `MetricToggle` (`MetricToggle.tsx:6-37`).
- Produces:
```ts
export function VehicleScopeToggle(props: { value: VehicleScope; onChange: (v: VehicleScope) => void }): JSX.Element
export function scopeNote(scope: VehicleScope): string | undefined // 'Visar bara vår bil' | 'Visar bara gäster' | undefined
// each charging route's searchSchema gains: vehicle: vehicleScope.optional().catch(undefined)
```

- [ ] **Step 1: Messages** (sv / en):

| key | sv | en |
|---|---|---|
| `charging_vehicle_scope_label` | Vems laddningar | Whose charging |
| `charging_vehicle_scope_ours` | Vår bil | Our car |
| `charging_vehicle_scope_other` | Gäster | Guests |
| `charging_vehicle_scope_all` | Alla | All |
| `charging_vehicle_note_ours` | Visar bara vår bil | Showing our car only |
| `charging_vehicle_note_other` | Visar bara gäster | Showing guests only |
| `charging_vehicle_empty_other_title` | Inga gästladdningar {year} | No guest charging in {year} |
| `charging_vehicle_empty_other_description` | Gästladdningar visas här när en admin har markerat dem. | Guest sessions show up here once an admin marks them. |
| `charging_vehicle_sessions_empty_other` | Inga gästladdningar ännu | No guest charging yet |

- [ ] **Step 2: Failing tests** `VehicleScopeToggle.browser.test.tsx` (pattern: `renderWithProviders`, `m.*` labels):

```tsx
test('shows the three scopes and reports a change', async () => {
  const onChange = vi.fn()
  const { screen } = renderWithProviders(<VehicleScopeToggle value="ours" onChange={onChange} />)
  await expect.element(screen.getByRole('radio', { name: m.charging_vehicle_scope_ours() })).toHaveAttribute('aria-checked', 'true')
  await screen.getByRole('radio', { name: m.charging_vehicle_scope_other() }).click()
  expect(onChange).toHaveBeenCalledWith('other')
})
```

  (Check what role Radix ToggleGroup `type="single"` exposes in the existing `MetricToggle` usage tests — `radio`
  with `aria-checked`, or `button` with `aria-pressed` — and assert that.)

  And `-vehicleScope.browser.test.tsx`, through each route's `Route.options.validateSearch`:

```ts
import { Route as Overview } from './index'
import { Route as Patterns } from './patterns'
import { Route as Economy } from './economy'
test.each([Overview, Patterns, Economy])('a junk ?vehicle= falls back to our car', (route) => {
  const validate = route.options.validateSearch as (s: unknown) => { vehicle?: string }
  expect(validate({ vehicle: 'neighbour' }).vehicle).toBeUndefined()
  expect(validate({ vehicle: 'other' }).vehicle).toBe('other')
})
```

- [ ] **Step 3: Run** — `bunx vitest run --project browser src/components/evCharging/VehicleScopeToggle.browser.test.tsx src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx` → FAIL.

- [ ] **Step 4: Implement** `VehicleScopeToggle.tsx`:

```tsx
import { VEHICLE_SCOPES, type VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { MetricToggle } from './MetricToggle'

const LABEL: Record<VehicleScope, () => string> = {
  ours: m.charging_vehicle_scope_ours,
  other: m.charging_vehicle_scope_other,
  all: m.charging_vehicle_scope_all,
}

// Whose sessions a charging view shows (ADR-0021). One option is always on.
export function VehicleScopeToggle({ value, onChange }: { value: VehicleScope; onChange: (v: VehicleScope) => void }) {
  return (
    <MetricToggle
      value={value}
      options={VEHICLE_SCOPES.map((scope) => ({ value: scope, label: LABEL[scope]() }))}
      onChange={onChange}
      aria-label={m.charging_vehicle_scope_label()}
    />
  )
}

/** The line under the page heading, so a screenshot or shared link says what the totals cover. */
export function scopeNote(scope: VehicleScope): string | undefined {
  if (scope === 'ours') return m.charging_vehicle_note_ours()
  if (scope === 'other') return m.charging_vehicle_note_other()
  return undefined
}
```

  `ChargingHeading`: add `note?: string`, rendered as one more `<p className="text-muted-foreground text-sm">` after
  the description.

  In each route:
  - `searchSchema` gains `vehicle: vehicleScope.optional().catch(undefined)`; `loaderDeps` adds
    `vehicle: search.vehicle ?? 'ours'`; every scoped query (`overview`, `sessions` via `sessionsQuery(limit, vehicle)`,
    `costOverview`, `patterns`, `timeline`, `economy`) passes `vehicle: deps.vehicle` in the loader and the same
    value in the component (`const vehicle = search.vehicle ?? 'ours'`). `sessionCosts` stays id-based.
  - `setVehicle = (v) => navigate({ to: '.', search: (s) => ({ ...s, vehicle: v === 'ours' ? undefined : v, ...(patterns ? { month: undefined } : {}) }), replace: true, resetScroll: false })`
    (a clean URL means our car; on Mönster a scope change clears `month`, like a year change does).
  - `<VehicleScopeToggle value={vehicle} onChange={setVehicle} />` goes inside the same flex-wrap div as the
    `YearSelector` (index :251-261, patterns :137-143, economy :100-102).
  - `<ChargingHeading … note={scopeNote(vehicle)} />`.
  - Empty states: when `vehicle === 'other'`, use `charging_vehicle_empty_other_title({ year })` / `_description`
    (chart empty on index :273, patterns :259-267, economy :151-159) and `charging_vehicle_sessions_empty_other`
    for `SessionList`'s empty title (pass an `emptyTitle` prop).

- [ ] **Step 5: Run** — browser tests above + the existing route/component browser tests
  (`bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging`) → PASS; typecheck clean.

- [ ] **Step 6: Commit** — `feat(charging): add the vehicle scope selector to charging views`.

- [ ] **Step 7: Review gate** — `code-reviewer` + UI reviewer (`web-design-guidelines` + `vercel-react-best-practices`).

### Task 9: Gäst badge and "Vem laddade?"

**Files:**
- Create: `src/components/evCharging/GuestBadge.tsx`, `SessionVehicle.tsx`, `SessionVehicle.browser.test.tsx`
- Modify: `SessionList.tsx:101-106`, `EconomySessionTable.tsx:62-63`, `src/routes/_authenticated/charging/sessions/$sessionId.tsx:55-75`
- Modify: `SessionList.browser.test.tsx`, `EconomySessionTable.browser.test.tsx` (row fixtures gain `vehicle`; a badge assertion)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `evCharging.setSessionVehicle` (Task 6); `SessionEconomyDetail.session.vehicle/vehicleSource`, row `vehicle` (Task 4).
- Produces:
```tsx
export function GuestBadge(): JSX.Element
export function SessionVehicle(props: { sessionId: string; vehicle: Vehicle; vehicleSource: VehicleSource; isAdmin: boolean }): JSX.Element
```

- [ ] **Step 1: Messages:**

| key | sv | en |
|---|---|---|
| `charging_vehicle_guest_badge` | Gäst | Guest |
| `charging_vehicle_who_label` | Vem laddade? | Who charged? |
| `charging_vehicle_ours` | Vår bil | Our car |
| `charging_vehicle_other` | Gäst | Guest |
| `charging_vehicle_source_default` | antaget | assumed |
| `charging_vehicle_source_skoda` | matchad mot bilens laddlogg | matched against the car's log |
| `charging_vehicle_source_admin` | satt av admin | set by an admin |
| `charging_vehicle_auto` | Automatiskt | Automatic |
| `charging_vehicle_saved` | Sparat | Saved |
| `charging_vehicle_save_error` | Kunde inte spara vem som laddade | Couldn't save who charged |

- [ ] **Step 2: Failing tests** `SessionVehicle.browser.test.tsx` (mock `~/lib/orpc/client` and `sonner` like
  `TariffDialog.browser.test.tsx:18-31`):

```tsx
test('everyone sees who charged and why', async () => {
  const { screen } = renderWithProviders(<SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="skoda" isAdmin={false} />)
  await expect.element(screen.getByText(`${m.charging_vehicle_ours()} · ${m.charging_vehicle_source_skoda()}`)).toBeVisible()
  expect(screen.getByRole('combobox').query()).toBeNull()
})

test('an admin retags the session and gets a toast', async () => {
  setVehicleFn.mockResolvedValue({ vehicle: 'other', vehicleSource: 'admin' })
  const { screen } = renderWithProviders(<SessionVehicle sessionId={ID} vehicle="ours" vehicleSource="default" isAdmin />)
  await screen.getByRole('combobox', { name: m.charging_vehicle_who_label() }).click()
  await screen.getByRole('option', { name: m.charging_vehicle_other() }).click()
  await vi.waitFor(() => expect(setVehicleFn).toHaveBeenCalledWith({ sessionId: ID, vehicle: 'other' }, expect.anything()))
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_vehicle_saved())
})

test('Automatiskt sends null; a failure shows the error toast', async () => {
  setVehicleFn.mockRejectedValue(new Error('down'))
  const { screen } = renderWithProviders(<SessionVehicle sessionId={ID} vehicle="other" vehicleSource="admin" isAdmin />)
  await screen.getByRole('combobox', { name: m.charging_vehicle_who_label() }).click()
  await screen.getByRole('option', { name: m.charging_vehicle_auto() }).click()
  await vi.waitFor(() => expect(setVehicleFn).toHaveBeenCalledWith({ sessionId: ID, vehicle: null }, expect.anything()))
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(m.charging_vehicle_save_error()))
})
```

  In `SessionList.browser.test.tsx` / `EconomySessionTable.browser.test.tsx`: a row with `vehicle: 'other'` shows
  `m.charging_vehicle_guest_badge()`; a `vehicle: 'ours'` row doesn't.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement.**

```tsx
// GuestBadge.tsx — marks a session another car charged (ADR-0021); ours carry none.
import { Badge } from '~/components/ui/badge'
import { m } from '~/paraglide/messages'
export function GuestBadge() {
  return <Badge variant="outline">{m.charging_vehicle_guest_badge()}</Badge>
}
```

```tsx
// SessionVehicle.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { orpc } from '~/lib/orpc/client'
import type { Vehicle, VehicleSource } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'

const VEHICLE_LABEL: Record<Vehicle, () => string> = { ours: m.charging_vehicle_ours, other: m.charging_vehicle_other }
const SOURCE_LABEL: Record<VehicleSource, () => string> = {
  default: m.charging_vehicle_source_default,
  skoda: m.charging_vehicle_source_skoda,
  admin: m.charging_vehicle_source_admin,
}
/** The select's value: an admin tag shows the vehicle, anything automatic shows "Automatiskt". */
const AUTO = 'auto'

// Who charged one session and why (ADR-0021). Admins change it inline: one
// field, saved immediately with a toast (ADR-0016), no dialog.
export function SessionVehicle({ sessionId, vehicle, vehicleSource, isAdmin }: {
  sessionId: string; vehicle: Vehicle; vehicleSource: VehicleSource; isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const save = useMutation(
    orpc.evCharging.setSessionVehicle.mutationOptions({
      onSuccess: () => toast.success(m.charging_vehicle_saved()),
      onError: () => toast.error(m.charging_vehicle_save_error()),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    }),
  )
  const summary = `${VEHICLE_LABEL[vehicle]()} · ${SOURCE_LABEL[vehicleSource]()}`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-muted-foreground">{m.charging_vehicle_who_label()}</span>
      <span>{summary}</span>
      {isAdmin ? (
        <Select
          value={vehicleSource === 'admin' ? vehicle : AUTO}
          disabled={save.isPending}
          onValueChange={(v) => save.mutate({ sessionId, vehicle: v === AUTO ? null : (v as Vehicle) })}
        >
          <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={m.charging_vehicle_who_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ours">{m.charging_vehicle_ours()}</SelectItem>
            <SelectItem value="other">{m.charging_vehicle_other()}</SelectItem>
            <SelectItem value={AUTO}>{m.charging_vehicle_auto()}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
```

  Wire-up: `SessionList` and `EconomySessionTable` render `{row.vehicle === 'other' ? <GuestBadge /> : null}` beside
  `SessionLink` (wrap both in `flex items-center gap-2`). In `$sessionId.tsx`, read `const { user } = Route.useRouteContext()`;
  put `<GuestBadge />` beside the h1 when `session.vehicle === 'other'`, and `<SessionVehicle … isAdmin={user.role === 'admin'} />`
  after the header, before the summary card.

- [ ] **Step 5: Run** — `bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging` → PASS.
  Extend `-sessionRoute.browser.test.tsx`'s router context with a `user` if the page now needs one (its
  `createRootRouteWithContext` setup, :86-113).

- [ ] **Step 6: Commit** — `feat(charging): show and set who charged a session`.

- [ ] **Step 7: Review gate** — `code-reviewer` + UI reviewer.

### Task 10: "Bilens laddlogg" card + import dialog

**Files:**
- Create: `src/components/evCharging/VehicleLogCard.tsx`, `VehicleImportDialog.tsx`, `VehicleImportDialog.browser.test.tsx`, `VehicleLogCard.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/index.tsx` (dialog enum + guard + render; card near the admin cards :281-308; admin-only `vehicleRecordCoverage` prefetch in the loader)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `evCharging.vehicleRecordCoverage`, `evCharging.importVehicleRecords` (Task 6); `parseSkodaExport` (Task 7, dynamic import); `useAppForm` (`~/hooks/form`); `ResponsiveDialog*` (`~/components/ui/responsive-dialog`); `useUrlDialog` (as wired at index :112-133).
- Produces:
```tsx
export function VehicleLogCard(props: { coverage: { from: Date; to: Date; count: number } | null; onImport: () => void }): JSX.Element
export function VehicleImportDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element
// index.tsx dialog enum gains 'vehicleImport'
```

- [ ] **Step 1: Messages:**

| key | sv | en |
|---|---|---|
| `charging_vehicle_log_title` | Bilens laddlogg | The car's charging log |
| `charging_vehicle_log_description` | Används för att avgöra vilka laddningar som är vår bil. | Used to tell which sessions are our car. |
| `charging_vehicle_log_coverage` | {count} laddningar, {from} – {to} | {count} charges, {from} – {to} |
| `charging_vehicle_log_none` | Ingen laddlogg importerad | No charging log imported |
| `charging_vehicle_import_button` | Importera | Import |
| `charging_vehicle_import_title` | Importera bilens laddlogg | Import the car's charging log |
| `charging_vehicle_import_description` | Välj CSV-exporten från MySkoda-appen. Filen läses i din webbläsare; platser sparas inte. | Pick the CSV export from the MySkoda app. The file is read in your browser; locations are not stored. |
| `charging_vehicle_import_file` | Fil | File |
| `charging_vehicle_import_preview` | {count} laddningar · {from} – {to} · {public} publika (plats sparas inte) | {count} charges · {from} – {to} · {public} public (location not stored) |
| `charging_vehicle_import_dropped` | {count} rader kunde inte läsas och hoppas över | {count} rows couldn't be read and are skipped |
| `charging_vehicle_import_wrong_file` | Filen ser inte ut som en MySkoda-export | This doesn't look like a MySkoda export |
| `charging_vehicle_import_empty` | Filen innehåller inga laddningar | The file contains no charges |
| `charging_vehicle_import_done` | {ours} laddningar vår bil, {other} gäster | {ours} sessions our car, {other} guests |
| `charging_vehicle_import_error` | Importen misslyckades | The import failed |

  Dates format with the existing date-fns + locale helpers in `src/components/evCharging/format.ts` (read it; reuse
  its day formatter, e.g. "10 okt 2025").

- [ ] **Step 2: Failing tests.** `VehicleImportDialog.browser.test.tsx` (mock orpc + sonner as in Task 9; feed the
  file through the `<input type="file">` with Vitest Browser's `userEvent.upload(locator, file)` — if the installed
  provider lacks `upload`, set `input.files` via `DataTransfer` and dispatch `change`):

```tsx
import { SKODA_EXPORT_FIXTURE } from '~test/fixtures/skodaExport'
const fixture = new File([SKODA_EXPORT_FIXTURE], 'export.csv', { type: 'text/csv' })

test('previews the export and imports only the parsed rows', async () => {
  importFn.mockResolvedValue({ inserted: 3, unchanged: 0, ours: 2, other: 1 })
  const { screen } = renderWithProviders(<VehicleImportDialog open onOpenChange={() => {}} />)
  await userEvent.upload(screen.getByLabelText(m.charging_vehicle_import_file()), fixture)
  await expect.element(screen.getByText(/3 laddningar/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_import_dropped({ count: 1 }))).toBeVisible()
  await screen.getByRole('button', { name: m.charging_vehicle_import_button() }).click()
  await vi.waitFor(() => expect(importFn).toHaveBeenCalled())
  const sent = importFn.mock.calls[0][0].rows
  expect(sent).toHaveLength(3)
  expect(JSON.stringify(sent)).not.toContain('Testgatan')
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_vehicle_import_done({ ours: 2, other: 1 }))
})

test('a wrong file shows an error and cannot be imported', async () => {
  const { screen } = renderWithProviders(<VehicleImportDialog open onOpenChange={() => {}} />)
  await userEvent.upload(screen.getByLabelText(m.charging_vehicle_import_file()), new File(['a,b\n1,2\n'], 'x.csv'))
  await expect.element(screen.getByText(m.charging_vehicle_import_wrong_file())).toBeVisible()
  await screen.getByRole('button', { name: m.charging_vehicle_import_button() }).click()
  expect(importFn).not.toHaveBeenCalled()
})
```

  `VehicleLogCard.browser.test.tsx`: coverage renders the count + dates; `null` renders `charging_vehicle_log_none`;
  the button calls `onImport`.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement.**
  - `VehicleImportDialog`: `useAppForm({ defaultValues: { parsed: null as SkodaParseResult | null }, onSubmit })`;
    one `form.Field name="parsed"` rendering a labelled `<input type="file" accept=".csv,text/csv">` whose `onChange`
    does `const { parseSkodaExport } = await import('~/lib/evCharging/skodaExport'); field.handleChange(parseSkodaExport(await file.text()))`
    (papaparse loads only here). Below it: the preview / dropped / error lines from `field.state.value`. Validator
    `onSubmit: ({ value }) => (value.parsed?.ok ? undefined : 'invalid')`. `onSubmit` → `await importMutation.mutateAsync({ rows: value.parsed.rows })`
    → `toast.success(m.charging_vehicle_import_done({ ours, other }))` → `onOpenChange(false)`; failure →
    `toast.error(m.charging_vehicle_import_error())`, dialog stays open. `onSettled` invalidates `orpc.evCharging.key()`.
    Shell: the `ResponsiveDialog*` set and `form.SubmitButton` / `form.CancelButton` exactly as `TariffDialog.tsx`
    (key the form on `open` so it resets, :112).
  - `VehicleLogCard`: a `Card` matching `TariffCard`'s shape: title, description, coverage line (or the none line),
    `Importera` button → `onImport`.
  - `index.tsx`: dialog enum gains `'vehicleImport'`; `dialogUnavailable` treats it as admin-only; loader prefetches
    `orpc.evCharging.vehicleRecordCoverage.queryOptions()` for admins; render `<VehicleLogCard coverage={…} onImport={() => open('vehicleImport')} />`
    next to the `TariffCard` admin section and `<VehicleImportDialog open={dialog === 'vehicleImport'} onOpenChange={(o) => { if (!o) close() }} />`
    in the admin dialog block.

- [ ] **Step 5: Run** — `bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging` → PASS.

- [ ] **Step 6: Commit** — `feat(charging): import the car's charging log from MySkoda`.

- [ ] **Step 7: Review gate** — `code-reviewer` + UI reviewer.

- [ ] **Step 8: PR 2 branch review, live verification, pre-PR gate.** Branch review per Phase 5. Then in the real app
  (`bun run dev`, signed in as admin, local DB with the real Zaptec history): open Översikt → Bilens laddlogg →
  import `data/private/skoda/charging_statistics_20260930_080323.csv` → toast "91 laddningar vår bil, 4 gäster"
  (or the counts PR 1's script reported); flip Vår bil / Gäster / Alla on all three pages (totals add up: ours +
  guests = all); open the 2026-07-17 session → Gäst badge + "Gäst · matchad mot bilens laddlogg"; retag it and
  reset it; as a non-admin, no select and no import card. Check desktop, tablet (≈768 px) and mobile (≈390 px).
  Pre-PR gate incl. the sv/en key check. Open PR 2.
