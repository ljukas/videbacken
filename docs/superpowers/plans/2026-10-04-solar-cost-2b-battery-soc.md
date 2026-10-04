# Solar-aware cost, step 2b: battery state of charge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the battery's state of charge (SoC %) with every 5-minute house reading, for the whole history, so
step 3's battery pool can be capped at what the battery really holds.

**Architecture:** The step-1 client fetches a fifth series, `/bmt/stats/battery/power-level/day/`, in parallel with
the four energy series. `buildDay` attaches its value to each bucket as `batterySocPct` (null when the series lacks
the minute or the value is outside 0–100). SoC never decides whether a bucket exists. `house_energy_reading` gains
a nullable `battery_soc_pct` column with a 0–100 CHECK, and the service validates and stores it. A one-off migration
clears the Emaldo watermark, so the hourly sync re-fetches the whole history (≈9 runs) and fills the column. The run
counts buckets stored without SoC. Nothing reads SoC yet (step 3 does). One PR.

**Tech Stack:** TanStack Start, Drizzle 0.45 (`pg`), zod 4, Vitest (node).

**Spec:** `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` (decision 7; "What the API does" →
State of charge; "Data model" → `battery_soc_pct`; "Sync" → SoC; "Derivation" 3) · **ADR:**
`docs/adr/0023-solar-aware-charging-cost.md` (decision 5, amendment 2026-10-04) · **Roadmap:**
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, step 2b.

**Branch / PR:** `feat/emaldo-battery-soc` (worktree `.claude/worktrees/emaldo-battery-soc`) → PR
`feat(charging): sync the home battery's state of charge`.

## Global Constraints

- All DB access through `src/lib/services/<entity>/` (ADR-0002); the table already has `.enableRLS()`.
- Never `console.*`; server code logs via `~/lib/logger/server` or the injected `log`.
- **Readings are a household load profile** (ADR-0023), SoC included: never logged, never in an error message, a
  run row or the run line. Messages name a bucket index and a field, never a value. Fixtures are synthetic; nothing
  from `data/private/emaldo/` is ever committed, and no real figures go in the PR.
- SoC series: path `/bmt/stats/battery/power-level/day/`, body `{ home_id, id, model, offset }` (no extra fields),
  rows `[minute, percent, …]`, same `start_time` / `timezone` / `interval: 5` envelope as the others.
- **SoC never gates a bucket.** A bucket exists iff all four energy series have its minute (unchanged). Missing SoC
  minute, or a value `< 0` or `> 100` → `batterySocPct: null`. The offset-0 cutoff stays over the four energy
  series only.
- The SoC request fails the day like any series (sibling cancel, same error mapping): a day is all-or-nothing.
- `battery_soc_pct`: `double precision`, nullable, `CHECK (battery_soc_pct >= 0 AND battery_soc_pct <= 100)`. Stored
  as reported for the row's minute; whether that is the bucket's start or end state is step 3's call.
- The watermark reset is its own custom migration: `UPDATE integration_sync SET last_success_started_at = NULL
  WHERE source = 'emaldo'`. Health reads `last_success_at`, not the watermark, so health is unaffected.
- **Migrations are frozen once pushed.** `migration-guard` + schema-design approval before the first push; never
  hand-edit `drizzle/meta/`. Every Vercel deploy migrates prod.
- **Merge timing:** the reset runs during the production build while the old deployment still serves the `:45` cron.
  Merge outside xx:35–xx:55 so no old-code run re-fetches days without SoC. Checkpoint 2b catches it if one does.
- Conventional Commits, subject ≤ 72 chars, one hat per commit; end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **A missing or odd SoC must never drop energy data.** A gap in the SoC series only, an empty SoC series, a
   negative or > 100 value, and a decimal value. Task 2: "SoC is attached per minute; a missing or out-of-range
   value is null and the bucket stays", "an empty SoC series keeps every energy bucket".
2. **Today's cutoff must not move because of SoC.** A SoC series that lags (or leads) the energy series on offset 0.
   Task 2: "today's cutoff ignores the SoC series".
3. **A day whose SoC series is another day is refused**, not silently mixed. Task 2: the "disagree" test covers
   `level` too.
4. **Stored SoC round-trips exactly, null included**, and the service rejects a value the DB CHECK would (so a bad
   value is a domain error with index + field, never a Postgres error quoting the row). Task 3.
5. **The re-fetch really re-fetches.** After the reset migration, a run with stored history backfills from the
   lead day again. Task 4: "a cleared watermark re-fetches the history and fills SoC".

---

### Task 0: Verify main matches this plan

- [ ] `git log --oneline -3` shows #72 (`docs(charging): record solar-cost checkpoint 2`) on the base.
- [ ] `ls drizzle/*.sql | tail -1` is `0013_house_energy_reading.sql` (so this step generates 0014 + 0015).
- [ ] `grep -n "SERIES_NAMES\|SERIES_REQUEST" src/lib/effects/emaldo/{parse,client}.ts` matches the shapes below.
- [ ] `bun run test:node` is green on the base.

---

### Task 1: `battery_soc_pct` column + the watermark reset migration

**Reviewers:** `migration-guard` + schema-design reviewer (loads `supabase-postgres-best-practices`; judge against
the writes `replaceDay` makes and step 3's range reads).

**Files:**
- Modify: `src/lib/db/schema/houseEnergy.ts`
- Modify: `src/lib/db/houseEnergySchema.test.ts`
- Create (generated): `drizzle/0014_house_energy_battery_soc.sql`, `drizzle/0015_emaldo_refetch_battery_soc.sql`,
  `drizzle/meta/*`

**Interfaces:**
- Produces: `houseEnergyReading.batterySocPct` (`number | null` on select, optional on insert); constraint
  `house_energy_reading_battery_soc_pct_check`.

- [ ] **Step 1: Write the failing schema tests** (append to `houseEnergySchema.test.ts`)

```ts
test('battery SoC is optional and must be 0–100', async () => {
  await db.insert(houseEnergyReading).values(row({ bucketStart: new Date('2026-04-01T10:00:00Z') }))
  for (const [i, batterySocPct] of [null, 0, 100, 42.5].entries()) {
    await db
      .insert(houseEnergyReading)
      .values(row({ bucketStart: new Date(Date.UTC(2026, 3, 1, 11, i * 5)), batterySocPct }))
  }
  for (const batterySocPct of [-0.001, 100.001]) {
    await expectConstraintViolation(
      db.insert(houseEnergyReading).values(row({ bucketStart: new Date('2026-04-01T12:00:00Z'), batterySocPct })),
      'house_energy_reading_battery_soc_pct_check',
    )
  }
})
```

- [ ] **Step 2:** `bunx vitest run src/lib/db/houseEnergySchema.test.ts` → FAIL (`batterySocPct` unknown).
- [ ] **Step 3: Add the column** in `houseEnergy.ts`, after `batteryChargeAcKwh`:

```ts
    /**
     * The battery's state of charge, % (0–100), for the row's minute as
     * Emaldo reports it; null when its SoC series lacked the minute. Step 3
     * caps the battery pool at it (spec "Derivation" 3).
     */
    batterySocPct: doublePrecision('battery_soc_pct'),
```

  and in the table callback, after the kWh checks:

```ts
    // NULL passes a CHECK: a missing SoC is allowed, a wrong one is not.
    check(
      'house_energy_reading_battery_soc_pct_check',
      sql`${table.batterySocPct} >= 0 AND ${table.batterySocPct} <= 100`,
    ),
```

- [ ] **Step 4: Generate** `bun run db:generate --name=house_energy_battery_soc`. Expect `0014_…sql` with
  `ALTER TABLE "house_energy_reading" ADD COLUMN "battery_soc_pct" double precision;` and the `ADD CONSTRAINT …
  CHECK`. Nothing else (no source CHECK churn).
- [ ] **Step 5: The reset migration** `bunx drizzle-kit generate --custom --name=emaldo_refetch_battery_soc`, then
  fill `0015_…sql`:

```sql
-- One-off (solar-cost step 2b): clear the Emaldo day watermark so the hourly
-- sync re-fetches the whole history and fills house_energy_reading.battery_soc_pct.
-- Health reads last_success_at, which this leaves alone. No row (Emaldo never ran) → no-op.
UPDATE "integration_sync" SET "last_success_started_at" = NULL WHERE "source" = 'emaldo';
```

- [ ] **Step 6:** `bun run db:migrate && bunx vitest run src/lib/db/houseEnergySchema.test.ts test/rls.test.ts` → PASS.
- [ ] **Step 7: Commit** `feat(charging): add battery state of charge to house readings`.

---

### Task 2: the client fetches the SoC series

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/effects/emaldo/parse.ts`, `emaldo.ts` (`HouseBucket`), `client.ts` (`SERIES_REQUEST`),
  `fixtures.ts` (`syntheticRow`)
- Test: `src/lib/effects/emaldo/parse.test.ts`, `emaldo.test.ts`

**Interfaces:**
- Produces: `HouseBucket.batterySocPct: number | null`; `ENERGY_SERIES` (`grid | mppt | usage | battery`);
  `SERIES_NAMES` = `[...ENERGY_SERIES, 'level']`; `SeriesName` includes `'level'`.

- [ ] **Step 1: Fixtures.** `syntheticRow` gains `case 'level': return [m, (m / 5) % 101, 0]` (a trailing unused
  column, as live). In `parse.test.ts`, `expected()` gains `batterySocPct: (m / 5) % 101`; in `emaldo.test.ts`,
  `STATS` gains `level: \`POST /bmt/stats/battery/power-level/day/${TEST_APP_ID}\``.
- [ ] **Step 2: Write the failing tests** in `parse.test.ts` (`describe('buildDay')`):

```ts
  test('SoC is attached per minute; a missing or out-of-range value is null and the bucket stays', () => {
    const row = (name: SeriesName, m: number) => {
      const r: unknown[] = syntheticRow(name, m)
      if (name === 'level' && m === 15) r[1] = -1
      if (name === 'level' && m === 20) r[1] = 100.5
      if (name === 'level' && m === 25) r[1] = 37.5
      return r
    }
    const noLevelAt10 = dayMinutes('2026-06-10').filter((m) => m !== 10)
    const out = buildDay(-1, day('2026-06-10', { level: noLevelAt10 }, row))
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(0)
    expect(out.buckets.slice(0, 6).map((b) => b.batterySocPct)).toEqual([0, 1, null, null, null, 37.5])
    expect(out.buckets[287]).toEqual(expected('2026-06-10', 1435))
  })

  test('an empty SoC series keeps every energy bucket', () => {
    const out = buildDay(-1, day('2026-06-10', { level: [] }))
    expect(out.buckets).toHaveLength(288)
    expect(out.buckets.every((b) => b.batterySocPct === null)).toBe(true)
  })

  test("today's cutoff ignores the SoC series", () => {
    const upTo = (last: number) => dayMinutes('2026-10-03').filter((m) => m <= last)
    const energy = { grid: upTo(430), mppt: upTo(430), usage: upTo(430), battery: upTo(430) }
    expect(buildDay(0, day('2026-10-03', { ...energy, level: upTo(400) })).buckets).toHaveLength(86)
    expect(buildDay(0, day('2026-10-03', { ...energy, level: upTo(500) })).buckets).toHaveLength(86)
  })
```

  extend the "disagree" test with `unexpected(() => buildDay(-1, { ...day('2026-06-10'), level: day('2026-06-11').level }), 'stats', 'disagree')`,
  and the short-row `test.each` with `['level', 'data.0.1', [0]]`.
  In `emaldo.test.ts`, add: the SoC request carries `{ home_id, id, model, offset }` and nothing else, and a
  refused SoC request (`[STATS.level]: () => statusReply(-1)`) fails `fetchDay` with `unexpected_response`.
  Update any request-count assertion that assumed four series (`requests` per day is now 5).
- [ ] **Step 3:** `bunx vitest run src/lib/effects/emaldo` → FAIL.
- [ ] **Step 4: Implement.** `parse.ts`:

```ts
/** The series a bucket needs: a minute missing from any of them is no bucket. */
export const ENERGY_SERIES = ['grid', 'mppt', 'usage', 'battery'] as const
/** Every series fetched for a day: the energy series, plus the battery's state of charge. */
export const SERIES_NAMES = [...ENERGY_SERIES, 'level'] as const
```

  `ROWS.level = z.tuple([minute, w], rest) // min, SoC %, …`; `parseSeries` gains
  `case 'level': return collect(parse('stats', dayOf(ROWS.level), result), (r) => [r[1]])`.
  In `buildDay`: the day-start agreement check stays over `SERIES_NAMES`; `cutoff`, `minutes` and the
  presence/negative checks use `ENERGY_SERIES`; each bucket gets

```ts
      batterySocPct: socOf(series.level.rows.get(m)),
```

  with

```ts
/** A SoC reading, or null: SoC is optional and never drops a bucket. */
const socOf = (cols: readonly number[] | undefined) => {
  const pct = cols?.[0]
  return pct !== undefined && pct >= 0 && pct <= 100 ? pct : null
}
```

  `emaldo.ts`: `HouseBucket` gains `/** Battery state of charge, % (0–100), as reported for the minute; null when missing or out of range. */ batterySocPct: number | null`, and `EmaldoDay.buckets`' comment says "present in all four energy series". `client.ts`: `SERIES_REQUEST.level = { path: '/bmt/stats/battery/power-level/day/', extra: {} }`.
- [ ] **Step 5:** `bunx vitest run src/lib/effects/emaldo && bun run typecheck` → PASS (the sync passes `HouseBucket`
  to `replaceDay`; the extra field is fine until Task 3).
- [ ] **Step 6: Commit** `feat(charging): fetch the battery's state of charge from Emaldo`.

---

### Task 3: the service validates, stores and reads SoC

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/services/houseEnergy/houseEnergy.ts`
- Test: `src/lib/services/houseEnergy/houseEnergy.test.ts`

**Interfaces:**
- Produces: `HouseReading.batterySocPct: number | null` (read and write); `listReadings` returns it.

- [ ] **Step 1: Write the failing tests.** `reading()` gains `batterySocPct: 50`.

```ts
test('SoC round-trips exactly, null included', async () => {
  const d = dayOf('2026-04-01')
  const at = (i: number) => new Date(d.dayStart.getTime() + i * FIVE_MIN)
  const rows = [null, 0, 37.5, 100].map((batterySocPct, i) => ({ ...reading(at(i)), batterySocPct }))
  await replaceDay(d, rows)
  expect((await all()).map((r) => r.batterySocPct)).toEqual([null, 0, 37.5, 100])
})

test.each([-0.001, 100.001, Number.NaN, Number.POSITIVE_INFINITY])(
  'a SoC of %s is a domain error naming the bucket and field only',
  async (batterySocPct) => {
    const d = dayOf('2026-04-01')
    const err = await replaceDay(d, [{ ...reading(d.dayStart), batterySocPct }]).catch((e) => e)
    expect(err).toBeInstanceOf(HouseEnergyDomainError)
    expect(err).toMatchObject({ code: 'INVALID_READINGS' })
    expect(err.message).toContain('bucket 0: batterySocPct')
    expect(err.message).not.toContain(String(batterySocPct))
  },
)
```

- [ ] **Step 2:** `bunx vitest run src/lib/services/houseEnergy` → FAIL.
- [ ] **Step 3: Implement.** `HouseReading` gains the field (same comment as `HouseBucket`); `readingColumns` and
  `insertDay`'s `values` gain `batterySocPct`; `readingProblems` gains, inside the per-bucket loop:

```ts
    const soc = b.batterySocPct
    if (soc !== null && !(Number.isFinite(soc) && soc >= 0 && soc <= 100)) {
      problems.push(`bucket ${i}: batterySocPct is not a percentage`)
    }
```

- [ ] **Step 4:** `bunx vitest run src/lib/services/houseEnergy src/lib/houseEnergy && bun run typecheck` → PASS
  (the sync tests' `bucket()` helper needs `batterySocPct` once `HouseReading` requires it: add `batterySocPct: 50`).
- [ ] **Step 5: Commit** `feat(charging): store the battery's state of charge per reading`.

---

### Task 4: the sync counts buckets without SoC, and the reset re-fetches

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/houseEnergy/sync.ts`
- Test: `src/lib/houseEnergy/sync.test.ts`

**Interfaces:**
- Produces: `EmaldoSyncRun.bucketsWithoutSoc: number` (stored days only), in the run line and run timings.

- [ ] **Step 1: Write the failing tests.**

```ts
test('stored SoC lands with the readings, and buckets without it are counted', async () => {
  const withGaps = (d: string): EmaldoDay => {
    const day = syntheticDay(d, 3)
    day.buckets[1] = { ...day.buckets[1], batterySocPct: null }
    return day
  }
  const { client } = fakeEmaldo({ [YESTERDAY]: withGaps, [TODAY]: withGaps })
  const result = await run(client)
  expect(result.bucketsWithoutSoc).toBe(2)
  const stored = await listReadings({ from: startOf(YESTERDAY), to: endOf(YESTERDAY) })
  expect(stored.map((r) => r.batterySocPct)).toEqual([50, null, 50])
})

test('a cleared watermark re-fetches the history and fills SoC', async () => {
  await sessionOn('2026-03-28')
  await run(fakeEmaldo().client) // backfills from 2026-03-21
  await db
    .update(integrationSync)
    .set({ lastSuccessStartedAt: null })
    .where(eq(integrationSync.source, 'emaldo')) // what migration 0015 does
  const { client, requested } = fakeEmaldo()
  await run(client)
  expect(requested).toContain('2026-03-21')
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(endOf(YESTERDAY))
})
```

  add `bucketsWithoutSoc: 0` to "the run row records since and every counter" and
  `bucketsWithoutSoc: 0` to the run-line `toMatchObject` (import `integrationSync` from `~/lib/db/schema` and
  `eq` from `drizzle-orm`).
- [ ] **Step 2:** `bunx vitest run src/lib/houseEnergy` → FAIL.
- [ ] **Step 3: Implement.** `EmaldoSyncRun` gains

```ts
  /** Stored buckets without a battery SoC (missing or out of range in Emaldo's series). */
  bucketsWithoutSoc: number
```

  `init` → `bucketsWithoutSoc: 0`; `toRunStats.timings`, `logFields` gain it; in `syncDay`, after a successful
  `replaceDay`: `run.bucketsWithoutSoc += fetched.buckets.filter((b) => b.batterySocPct === null).length`.
- [ ] **Step 4:** `bunx vitest run src/lib/houseEnergy` → PASS.
- [ ] **Step 5: Commit** `feat(charging): count house readings stored without SoC`.

---

### Task 5: Branch review (feature-workflow Phase 5)

- [ ] Dispatch in parallel on `git diff origin/main...HEAD`: `code-reviewer`, `migration-guard`, `test-completeness`,
  and the schema-design reviewer. Each starts from the assumption that the branch is wrong.
- [ ] Fix or rule on every finding, one commit per hat.

### Task 6: Pre-PR gate + live verification

- [ ] **Pre-PR gate** (`docs/feature-workflow.md`): `bun run check`, `check:ci`, `build`, `db:up && db:migrate`,
  `test`, sv/en key check (no copy changes expected).
- [ ] **Live, local, real Emaldo** (four `EMALDO_*` in the worktree's `.env.local`; never print them; a local
  login ends prod's session, which re-logs in on its next run). Migration 0015 cleared the local watermark too.
  `bun run dev`, then repeat the cron route until `backfillDaysLeft` is 0:
  `curl -s -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" http://localhost:14600/api/cron/emaldo-sync`.
  Then, in `psql`: every day's share of buckets with SoC (expect ≈100 %), and the stored SoC of 2026-02-15 and
  2026-06-10 against `data/private/emaldo/data/<day>.level.json` (exact match). Figures stay out of the PR.

### Task 7: Roadmap row + PR

- [ ] Roadmap row 2b: PR link, status `PR open`; log line. Commit `docs(charging): mark solar-cost step 2b as PR open`.
- [ ] Push; PR from `.github/PULL_REQUEST_TEMPLATE.md`. **Title:** `feat(charging): sync the home battery's state of
  charge`. **Risks:** merge outside xx:35–xx:55; the re-fetch takes ≈9 hourly runs; step 3's plan must be revised
  for the SoC pool first. Body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### Task 8: STOP — checkpoint 2b (for the owner / the next session)

Don't start step 3 here. After merge + deploy, checkpoint 2b (roadmap) runs on prod with read-only SELECTs (Supabase
SQL editor or MCP `execute_sql`); record conclusions, never rows.
