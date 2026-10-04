# Datakällor sync progress bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an Emaldo or elpris sync is in flight, its Datakällor tile shows a real progress bar ("12 av 30 dagar"), polled — never pushed.

**Architecture:** Two nullable columns on `integration_sync` (the per-source health + lease row the tile already polls) hold the running run's progress. `runPulledSync` gives each source a throttled, best-effort `reportProgress(done, total)` that writes under the run's lease token; `getHealth` exposes `progress` only while the lease is live. The tile renders shadcn `Progress` from it and polls at 5 s from the click.

**Tech Stack:** Drizzle + Postgres (CHECKs), oRPC, TanStack Query `refetchInterval`, Radix/shadcn `Progress`, Paraglide, Vitest (node + browser).

**Spec:** `docs/superpowers/specs/2026-10-04-sync-progress-design.md`

**PR slicing:** one PR (`feat(charging): show sync progress on Datakällor tiles`), five task commits.

## Global Constraints

- All DB access through `src/lib/services/` (ADR-0002); logging via `~/lib/logger` only, never `console.*` (ADR-0003).
- Never hold a connection open; freshness by `refetchInterval` (ADR-0018).
- Every `pgTable` keeps `.enableRLS()`; migrations generated with `bun run db:generate --name=<desc>`; never hand-edit `drizzle/meta/`.
- Schema change → `migration-guard` **and** a schema-design review (subagent loading `supabase-postgres-best-practices`) before code builds on it.
- No CHECK may tie progress to `lease_token` (rollback safety — spec "Where progress lives").
- Throttle: ≥ 1 000 ms between progress writes, except `done === total`, which always writes.
- User-facing text via Paraglide; `messages/sv.json` is the source of truth, `en.json` key-complete.
- Every screen responsive (desktop, tablet, mobile); reduced-motion respected.
- Conventional Commits, ≤ 72 chars, imperative; end every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **A cron run is already in flight when the admin opens the page** (tab's mutation not pending, server says `running`) → the bar must show from the server's progress alone. Pinned in Task 5 (tile test with `syncing: false, running: true`).
2. **Leftover progress with no live lease** (a crashed run whose lease expired, or a rollback's `recordOutcome` that cleared the lease but not progress) → `getHealth` must return `progress: null`. Pinned in Task 2 (two tests).
3. **A late progress write after the outcome was recorded, or from a run whose lease was taken over** → writes nothing. Pinned in Task 2.
4. **A progress write fails (DB blip)** → the run still completes and records `ok`; one warn line. Pinned in Task 3.
5. **elpris days that are skipped, not stored** (not published, gap) still advance the bar to `total`. Pinned in Task 4.

---

### Task 1: Progress columns on `integration_sync`

**Reviewers:** `migration-guard` (agent) + schema-design reviewer (`general-purpose` agent loading `supabase-postgres-best-practices`; judge against the queries in Tasks 2–3: a PK+token `UPDATE`, the PK `SELECT` in `getHealth`).

**Files:**
- Modify: `src/lib/db/schema/integrationSync.ts` (columns after `credentialReminderDays`; CHECKs at the end of the `integration_sync` list)
- Create (generated): `drizzle/0016_integration_sync_progress.sql` + `drizzle/meta/*`
- Test: `src/lib/db/evChargingSchema.test.ts`

**Interfaces:**
- Produces: `integrationSync.progressDone`, `integrationSync.progressTotal` (`integer`, nullable); constraints `integration_sync_progress_pair_check`, `integration_sync_progress_range_check`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/db/evChargingSchema.test.ts` (after the `lease_until … no lease_token` test):

```ts
test('an integration_sync row with progress_done but no progress_total is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'emaldo', progressDone: 1, progressTotal: null }),
    'integration_sync_progress_pair_check',
  )
})

test('an integration_sync row with progress_total = 0 is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'emaldo', progressDone: 0, progressTotal: 0 }),
    'integration_sync_progress_range_check',
  )
})

test('an integration_sync row with progress_done > progress_total is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'emaldo', progressDone: 31, progressTotal: 30 }),
    'integration_sync_progress_range_check',
  )
})

test('an integration_sync row with a negative progress_done is rejected', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'emaldo', progressDone: -1, progressTotal: 30 }),
    'integration_sync_progress_range_check',
  )
})

test('an integration_sync row with progress 0 of 30 and no lease is accepted', async () => {
  // No CHECK ties progress to the lease: a rollback's recordOutcome clears the
  // lease without clearing progress, and must not fail.
  await db.insert(integrationSync).values({ source: 'emaldo', progressDone: 0, progressTotal: 30 })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run src/lib/db/evChargingSchema.test.ts`
Expected: FAIL — TypeScript/Drizzle reject the unknown `progressDone`/`progressTotal` keys (or the inserts succeed where a violation is expected).

- [ ] **Step 3: Add the columns and CHECKs** — in `src/lib/db/schema/integrationSync.ts`, after `credentialReminderDays`:

```ts
    // The in-flight run's progress ("12 of 30 days"), both null until it
    // reports. Overwritten in place under the run's lease token, cleared when a
    // lease is acquired and when the outcome is recorded. Read only while the
    // lease is live, so a leftover (a crashed run, a rollback's recordOutcome)
    // is never shown — which is why no CHECK ties it to `lease_token`.
    progressDone: integer('progress_done'),
    progressTotal: integer('progress_total'),
```

and at the end of the `integration_sync` CHECK list (after `integration_sync_credential_reminder_expiry_check`):

```ts
    check(
      'integration_sync_progress_pair_check',
      sql`(${table.progressDone} IS NULL) = (${table.progressTotal} IS NULL)`,
    ),
    check(
      'integration_sync_progress_range_check',
      sql`${table.progressTotal} IS NULL OR (${table.progressTotal} > 0 AND ${table.progressDone} BETWEEN 0 AND ${table.progressTotal})`,
    ),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `bun run db:generate --name=integration_sync_progress && bun run db:migrate`
Expected: `drizzle/0016_integration_sync_progress.sql` with exactly two `ADD COLUMN "progress_done" integer` / `"progress_total" integer` and two `ADD CONSTRAINT … CHECK`; nothing else (no drops, no type changes). Read the file and confirm.

- [ ] **Step 5: Run to verify they pass**

Run: `bunx vitest run src/lib/db/evChargingSchema.test.ts test/rls.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema/integrationSync.ts src/lib/db/evChargingSchema.test.ts drizzle/
git commit -m "feat(charging): add sync progress columns to integration_sync"
```

---

### Task 2: Service — write, clear and read progress

**Reviewers:** `code-reviewer` + `test-completeness` (agents).

**Files:**
- Modify: `src/lib/services/integrationSync/integrationSync.ts` (`IntegrationHealth`, `toHealth`, `beginAttempt`, `recordOutcome`, new `reportProgress`)
- Test: `src/lib/services/integrationSync/integrationSync.test.ts`
- Modify (type fixtures gain `progress: null`): `src/components/evCharging/SyncRunsDialog.browser.test.tsx`, `SyncHealthAlert.browser.test.tsx`, `SyncSourceTile.browser.test.tsx`, `SyncSourcesPanel.browser.test.tsx` — every object literal typed as the `syncStatus` output.

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `export type SyncProgress = { done: number; total: number }`
  - `IntegrationHealth.progress: SyncProgress | null` (also on `RouterOutputs['evCharging']['syncStatus']`)
  - `export async function reportProgress(source: IntegrationSource, attemptId: string, progress: SyncProgress, { now }: { now: Date }): Promise<void>`

- [ ] **Step 1: Write the failing tests** — add `reportProgress` to the import from `./integrationSync`, then append:

```ts
test('reportProgress writes under the held lease and getHealth shows it while running', async () => {
  const attemptId = await acquire(T0)
  await reportProgress('zaptec', attemptId, { done: 12, total: 30 }, { now: at(1000) })
  const health = await getHealth('zaptec', { now: at(2000), includeAdminDetail: false })
  expect(health.running).toBe(true)
  expect(health.progress).toEqual({ done: 12, total: 30 })
})

test('getHealth has no progress before the run reports any', async () => {
  await acquire(T0)
  expect((await getHealth('zaptec', { now: at(1000), includeAdminDetail: false })).progress).toBeNull()
})

test('reportProgress with another attempt’s id writes nothing', async () => {
  await acquire(T0)
  await reportProgress('zaptec', crypto.randomUUID(), { done: 1, total: 2 }, { now: at(1000) })
  const [row] = await db.select().from(integrationSync)
  expect(row.progressDone).toBeNull()
  expect(row.progressTotal).toBeNull()
})

test('recordOutcome clears progress, and a late write after it writes nothing', async () => {
  const attemptId = await acquire(T0)
  await reportProgress('zaptec', attemptId, { done: 1, total: 2 }, { now: at(1000) })
  await recordOutcome('zaptec', ok, { attemptId, trigger: 'cron', startedAt: T0, now: at(2000) })
  await reportProgress('zaptec', attemptId, { done: 2, total: 2 }, { now: at(3000) })
  const [row] = await db.select().from(integrationSync)
  expect(row.progressDone).toBeNull()
  expect(row.progressTotal).toBeNull()
})

test('taking over an expired lease clears the dead run’s progress, and its late write is ignored', async () => {
  const stale = await acquire(T0)
  await reportProgress('zaptec', stale, { done: 5, total: 30 }, { now: at(1000) })
  await acquire(at(6 * 60 * 1000))
  await reportProgress('zaptec', stale, { done: 6, total: 30 }, { now: at(6 * 60 * 1000 + 1) })
  const health = await getHealth('zaptec', { now: at(6 * 60 * 1000 + 2), includeAdminDetail: false })
  expect(health.running).toBe(true)
  expect(health.progress).toBeNull()
})

test('getHealth hides progress once the lease has expired', async () => {
  const attemptId = await acquire(T0)
  await reportProgress('zaptec', attemptId, { done: 5, total: 30 }, { now: at(1000) })
  const health = await getHealth('zaptec', { now: at(6 * 60 * 1000), includeAdminDetail: false })
  expect(health.running).toBe(false)
  expect(health.progress).toBeNull()
})

test('getHealth hides leftover progress on a row without a lease (a rollback’s recordOutcome)', async () => {
  await db.insert(integrationSync).values({ source: 'zaptec', progressDone: 3, progressTotal: 4 })
  expect((await getHealth('zaptec', { now: T0, includeAdminDetail: false })).progress).toBeNull()
})
```

Also add `progress: null,` to the `getHealth for a source with no row is never_synced` `toEqual` (after `running: false`).

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run src/lib/services/integrationSync/integrationSync.test.ts`
Expected: FAIL — `reportProgress` is not exported; `progress` is `undefined`.

- [ ] **Step 3: Implement** — in `src/lib/services/integrationSync/integrationSync.ts`:

Add above `IntegrationHealth`:

```ts
/** A running sync's progress, in the source's own unit (days, for Emaldo and elpris). */
export type SyncProgress = { done: number; total: number }
```

In `IntegrationHealth`, after `running: boolean`:

```ts
  /** Set only while `running` and the run has reported; null otherwise. */
  progress: SyncProgress | null
```

Replace the start of `toHealth`'s body and its `running` field:

```ts
  const snapshot = row ? toSnapshot(row) : null
  const running = row?.leaseUntil != null && row.leaseUntil.getTime() > now.getTime()
  return {
    source,
    state: deriveState(source, snapshot, now),
    running,
    // Only a live lease's progress: a crashed run's or a rollback's leftover is never shown.
    progress:
      running && row?.progressDone != null && row.progressTotal != null
        ? { done: row.progressDone, total: row.progressTotal }
        : null,
```

In `beginAttempt`'s `.set({…})` add `progressDone: null, progressTotal: null,` (after `leaseToken`). In `recordOutcome`'s `.set({…})` add `progressDone: null, progressTotal: null,` (after `leaseToken: null`).

Append after `recordOutcome`:

```ts
// The running attempt's progress, overwritten in place. Matched on the lease
// token, so a lost lease (expired, taken over, or already recorded) writes
// nothing: a late write can never touch a newer run's progress or re-set a
// finished one. Values come from runPulledSync, which normalizes them; the
// CHECKs are the backstop.
export async function reportProgress(
  source: IntegrationSource,
  attemptId: string,
  { done, total }: SyncProgress,
  { now }: { now: Date },
): Promise<void> {
  await db
    .update(integrationSync)
    .set({ progressDone: done, progressTotal: total, updatedAt: now })
    .where(and(eq(integrationSync.source, source), eq(integrationSync.leaseToken, attemptId)))
}
```

- [ ] **Step 4: Update the typed fixtures** — in the four browser test files listed above, add `progress: null,` after every `running: …,` in an object typed as the `syncStatus` output (`Health`).

- [ ] **Step 5: Run to verify**

Run: `bunx vitest run src/lib/services/integrationSync/ && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/integrationSync/ src/components/evCharging/*.browser.test.tsx
git commit -m "feat(charging): track a running sync's progress on its health row"
```

---

### Task 3: `runPulledSync` — throttled, best-effort `reportProgress` (+ ADR amendment)

**Reviewers:** `code-reviewer` + `test-completeness` (agents).

**Files:**
- Modify: `src/lib/integrations/runPulledSync.ts`
- Test: `src/lib/integrations/runPulledSync.test.ts`
- Modify: `docs/adr/0019-external-data-integrations.md` (new amendment before `## Amendments to other ADRs`)

**Interfaces:**
- Consumes: `reportProgress` (Task 2) from `~/lib/services/integrationSync`.
- Produces: `PulledSyncSpec.execute`'s context gains `reportProgress: (done: number, total: number) => Promise<void>`; the `integration sync run` log line gains `progressWrites: number`.

- [ ] **Step 1: Write the failing tests** — in `runPulledSync.test.ts`, give the `run` helper an optional clock: change its signature to

```ts
function run(
  execute: (ctx: {
    run: FakeRun
    signal: AbortSignal
    reportProgress: (done: number, total: number) => Promise<void>
  }) => Promise<void>,
  opts: {
    log?: ReturnType<typeof capturingLogger>['log']
    deadlineMs?: number
    now?: () => Date
  } = {},
) {
```

and use `now: opts.now ?? now,` in the spec. Then append:

```ts
const stepClock = (stepMs: number) => {
  let clock = T0.getTime()
  return () => {
    clock += stepMs
    return new Date(clock)
  }
}
const progressCalls = (spy: MockInstance<typeof integrationSyncService.reportProgress>) =>
  spy.mock.calls.map(([, , p]) => p)

test('reportProgress writes under the run’s lease and the outcome clears it', async () => {
  const seen: unknown[] = []
  await run(async ({ reportProgress }) => {
    await reportProgress(1, 3)
    seen.push((await getHealth('elpris', { now: new Date(T0.getTime() + 5000), includeAdminDetail: false })).progress)
  })
  expect(seen).toEqual([{ done: 1, total: 3 }])
  expect((await getHealth('elpris', { now: T0, includeAdminDetail: false })).progress).toBeNull()
})

test('reportProgress normalizes: no write for total ≤ 0, done clamped to [0, total]', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(async ({ reportProgress }) => {
    await reportProgress(0, 0)
    await reportProgress(-2, 4)
    await reportProgress(9, 4)
  })
  expect(progressCalls(spy)).toEqual([
    { done: 0, total: 4 },
    { done: 4, total: 4 },
  ])
})

test('reportProgress throttles to one write per second, but always writes done = total', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(
    async ({ reportProgress }) => {
      for (let done = 1; done <= 5; done++) await reportProgress(done, 5)
    },
    { now: stepClock(400) },
  )
  // The clock steps 400 ms per now() call; a write needs ≥ 1 000 ms since the last.
  const calls = progressCalls(spy)
  expect(calls[0]).toEqual({ done: 1, total: 5 })
  expect(calls.at(-1)).toEqual({ done: 5, total: 5 })
  expect(calls.length).toBeLessThan(5)
})

test('a failing progress write is logged and never fails the run', async () => {
  vi.spyOn(integrationSyncService, 'reportProgress').mockRejectedValue(new Error('db blip'))
  const cap = capturingLogger()
  const result = await run(
    async ({ run: r, reportProgress }) => {
      await reportProgress(1, 2)
      r.items = 1
    },
    { log: cap.log },
  )
  expect(result.outcome).toBe('ok')
  const warn = cap.entries().find((e) => e.msg === 'integration sync progress write failed')
  expect(warn).toMatchObject({ level: WARN, source: 'elpris' })
  expect(cap.runLines()[0]).toMatchObject({ outcome: 'ok', progressWrites: 0 })
})

test('the run line counts progress writes', async () => {
  const cap = capturingLogger()
  await run(
    async ({ reportProgress }) => {
      await reportProgress(1, 2)
      await reportProgress(2, 2)
    },
    { log: cap.log },
  )
  expect(cap.runLines()[0]).toMatchObject({ progressWrites: 2 })
})
```

(The default helper clock steps 1 000 ms per `now()`, so both writes in the last test pass the throttle.)

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run src/lib/integrations/runPulledSync.test.ts`
Expected: FAIL — `reportProgress` is not on the context.

- [ ] **Step 3: Implement** — in `src/lib/integrations/runPulledSync.ts`:

Import `reportProgress as writeProgress` alongside `beginAttempt` from `~/lib/services/integrationSync`.

Add above `runPulledSync`:

```ts
/** At most one progress write per second per run; the UI polls every 5 s. */
const PROGRESS_INTERVAL_MS = 1_000
```

In `PulledSyncSpec.execute`'s context type add:

```ts
    /**
     * Best effort: the run's progress for its Datakällor tile, in the source's
     * own unit. Throttled (`done === total` always writes); a failed write is
     * logged and never fails the run.
     */
    reportProgress: (done: number, total: number) => Promise<void>
```

In `runPulledSync`, declare `let progressWrites = 0` next to `let thrown`. After `if (!attempt.acquired) return run`:

```ts
    let lastProgressMs = Number.NEGATIVE_INFINITY
    const reportProgress = async (done: number, total: number) => {
      const t = Math.floor(total)
      if (!(t > 0)) return
      const d = Math.min(t, Math.max(0, Math.floor(done)))
      const at = now()
      if (d < t && at.getTime() - lastProgressMs < PROGRESS_INTERVAL_MS) return
      lastProgressMs = at.getTime()
      try {
        await writeProgress(source, attempt.attemptId, { done: d, total: t }, { now: at })
        progressWrites++
      } catch (error) {
        log.warn('integration sync progress write failed', { source, error })
      }
    }
```

Pass it: `await spec.execute({ run, signal: deadline.signal, now, log, reportProgress })`. In the `finally` block's `fields`, add `progressWrites,` after `durationMs: run.durationMs,`.

- [ ] **Step 4: Run to verify**

Run: `bunx vitest run src/lib/integrations/ src/lib/evCharging/ src/lib/spotPrice/ src/lib/houseEnergy/ src/lib/vehicleState/`
Expected: PASS. If an existing test asserts a run line with `toEqual` (exact keys), add `progressWrites: 0` to it.

- [ ] **Step 5: Amend ADR-0019** — insert before `## Amendments to other ADRs`:

```markdown
## Amendment (2026-10-04): sync progress on the health row

A running sync can report progress ("12 av 30 dagar") for its Datakällor tile. `runPulledSync` hands `execute` a
`reportProgress(done, total)` that writes `integration_sync.progress_done` / `progress_total` **under the run's lease
token** (a lost lease writes nothing), throttled to one write per second (the last always writes) and best effort (a
failed write is a `warn`, never a failed run). `beginAttempt` and `recordOutcome` clear it; `getHealth` exposes it
only while the lease is live, so a leftover is never shown — and no CHECK ties it to the lease, so a rollback's
`recordOutcome` (which doesn't know the columns) can't fail. Emaldo and elpris report days; Zaptec and Škoda finish
before a poll would see them and don't report.

Why the database, not a push or another store: the tile already polls this row (ADR-0018), the run already writes it,
and it works for cron runs and every viewer. Streaming the click's request serves only that tab; process memory
doesn't survive Fluid instance routing; Runtime Cache/Redis add a second store that can disagree with the lease;
Vercel Workflow was parked as a separate re-platforming decision. Design:
[`2026-10-04-sync-progress-design.md`](../superpowers/specs/2026-10-04-sync-progress-design.md).
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/integrations/ docs/adr/0019-external-data-integrations.md
git commit -m "feat(charging): let pulled syncs report throttled progress"
```

---

### Task 4: Emaldo and elpris report their days

**Reviewers:** `code-reviewer` + `test-completeness` (agents).

**Files:**
- Modify: `src/lib/houseEnergy/sync.ts` (`runEmaldoSync` execute → `syncDays`)
- Modify: `src/lib/spotPrice/sync.ts` (`runElprisSync` execute → `fetchMissingDays`)
- Test: `src/lib/houseEnergy/sync.test.ts`, `src/lib/spotPrice/sync.test.ts`

**Interfaces:**
- Consumes: the `reportProgress` context function (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

In `src/lib/houseEnergy/sync.test.ts`, add `import * as integrationSyncService from '~/lib/services/integrationSync'`, then:

```ts
test('reports progress over yesterday, today and the backfill, in days', async () => {
  // A session on 03-28 → the backfill starts 7 days earlier (03-21): 10 backfill days + 2.
  await sessionOn('2026-03-28')
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeEmaldo()
  // Each now() 1 s later, so the throttle never drops a write.
  await run(client, { now: () => new Date((clock += 1_001)) })
  expect(spy.mock.calls.map(([, , p]) => p)).toEqual(
    Array.from({ length: 12 }, (_, i) => ({ done: i + 1, total: 12 })),
  )
})
```

In `src/lib/spotPrice/sync.test.ts`, add `import * as integrationSyncService from '~/lib/services/integrationSync'`, then:

```ts
test('reports progress over every planned day, skipped ones included', async () => {
  // 09-20 … 09-29 planned (10 days): tomorrow is not published yet and 09-22 is a gap — both still count.
  await insertSession(new Date('2026-09-20T10:00:00Z'))
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  let clock = NOW.getTime()
  const { client } = fakeElpris({ missing: ['2026-09-22'] })
  await runElprisSync({
    trigger: 'cron',
    now: () => new Date((clock += 1_001)),
    deps: { elpris: client, sleep: async () => {} },
  })
  expect(spy.mock.calls.map(([, , p]) => p)).toEqual(
    Array.from({ length: 10 }, (_, i) => ({ done: i + 1, total: 10 })),
  )
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run src/lib/houseEnergy/sync.test.ts src/lib/spotPrice/sync.test.ts -t "reports progress"`
Expected: FAIL — no `reportProgress` calls.

- [ ] **Step 3: Implement Emaldo** — in `src/lib/houseEnergy/sync.ts`:
  - `Ctx` gains `reportProgress: (done: number, total: number) => Promise<void>`.
  - `execute: ({ run, signal, now, log, reportProgress }) => syncDays(client, run, stats, { signal, now, sleep, log, reportProgress })`.
  - In `syncDays`, after `const sync = …`:

```ts
  // Progress in days for the Datakällor tile: yesterday, today, then the backfill.
  const total = 2 + plan.backfill.length
  let done = 0
  const step = () => ctx.reportProgress(++done, total)
```

  - Call `await step()` right after `const yesterday = await sync(plan.yesterday)`, after `await sync(plan.today)`, and after `await sync(day)` inside the backfill loop (before `run.backfillDaysLeft--`).

- [ ] **Step 4: Implement elpris** — in `src/lib/spotPrice/sync.ts`:
  - `fetchMissingDays`'s `ctx` type gains `reportProgress: (done: number, total: number) => Promise<void>`; destructure it; `execute: ({ run, signal, now, log, reportProgress }) => fetchMissingDays(client, run, stats, { signal, now, sleep, log, reportProgress })`.
  - Move the loop body (from `run.dayRequests++` through `run.upserted += written`) into a local `async function fetchDay(day: string): Promise<void>` declared inside `fetchMissingDays` before the loop, turning each `continue` into `return`. The loop becomes:

```ts
  for (const [i, day] of planned.entries()) {
    // Always at least one day per run, so a run can never make no progress.
    if (i > 0 && now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS) break
    if (i > 0 && planned.length > 5) await sleep(BACKFILL_PAUSE_MS)
    await fetchDay(day)
    // Days handled, not days stored: a skipped day still moves the bar.
    await reportProgress(i + 1, planned.length)
  }
```

- [ ] **Step 5: Run to verify**

Run: `bunx vitest run src/lib/houseEnergy/ src/lib/spotPrice/`
Expected: PASS — the new tests and every existing one (the refactor of the elpris loop body must not change behavior).

- [ ] **Step 6: Commit**

```bash
git add src/lib/houseEnergy/ src/lib/spotPrice/
git commit -m "feat(charging): report Emaldo and elpris sync progress in days"
```

---

### Task 5: The tile's progress bar + 5 s polling from the click

**Reviewers:** `code-reviewer` (agent) + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/components/ui/progress.tsx` (forward `value` to Root; reduced motion)
- Modify: `src/components/evCharging/SyncSourceTile.tsx`
- Modify: `src/routes/_authenticated/charging/index.tsx` (`healthPoll`, its four uses)
- Modify: `messages/sv.json`, `messages/en.json`
- Test: `src/components/evCharging/SyncSourceTile.browser.test.tsx`

**Interfaces:**
- Consumes: `health.progress: { done: number; total: number } | null` (Task 2).
- Produces: i18n keys `charging_source_progress` (`{done}`, `{total}`), `charging_source_progress_label` (`{source}`).

- [ ] **Step 1: Add the strings** — after `charging_source_syncing` in each file:

`messages/sv.json`:
```json
  "charging_source_progress": "{done} av {total} dagar",
  "charging_source_progress_label": "Synkförlopp, {source}",
```

`messages/en.json`:
```json
  "charging_source_progress": "{done} of {total} days",
  "charging_source_progress_label": "Sync progress, {source}",
```

Run: `bun run i18n:compile`

- [ ] **Step 2: Write the failing tests** — append to `SyncSourceTile.browser.test.tsx` (import `integrationSourceName` from `~/lib/integrationHealthMessage`):

```tsx
const emaldoRunning: Health = {
  ...ok,
  source: 'emaldo',
  running: true,
  progress: { done: 12, total: 30 },
}
const progressBar = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen']) =>
  screen.getByRole('progressbar', {
    name: m.charging_source_progress_label({ source: integrationSourceName('emaldo') }),
  })

test('a run in flight (e.g. the cron’s) shows its progress as a bar and in days', async () => {
  // syncing: false — this tab didn't start it; the server's progress alone shows it.
  const { screen } = await renderWithProviders(tile(emaldoRunning))
  const bar = progressBar(screen)
  await expect.element(bar).toBeVisible()
  await expect.element(bar).toHaveAttribute('aria-valuenow', '40')
  await expect
    .element(bar)
    .toHaveAttribute('aria-valuetext', m.charging_source_progress({ done: 12, total: 30 }))
  await expect
    .element(screen.getByText(m.charging_source_progress({ done: 12, total: 30 })))
    .toBeVisible()
})

test('no bar before the run reports progress', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...emaldoRunning, progress: null }, { syncing: true }),
  )
  await expect.element(screen.getByRole('progressbar')).not.toBeInTheDocument()
})

test('no bar once the run is no longer in flight', async () => {
  const { screen } = await renderWithProviders(tile({ ...emaldoRunning, running: false }))
  await expect.element(screen.getByRole('progressbar')).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `bunx vitest run --project browser src/components/evCharging/SyncSourceTile.browser.test.tsx`
Expected: FAIL — no `progressbar`.

- [ ] **Step 4: Fix the shadcn `Progress`** — in `src/components/ui/progress.tsx`, pass the value to Radix (without it Root renders indeterminate with no `aria-valuenow`/`aria-valuetext`) and respect reduced motion:

```tsx
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
```

and the indicator's class: `"size-full flex-1 bg-primary transition-all motion-reduce:transition-none"`. (`AvatarUpload` is the only other user; it gains correct ARIA.)

- [ ] **Step 5: Render the bar in the tile** — in `SyncSourceTile.tsx`, import `Progress` from `~/components/ui/progress`; after `const syncLabel = …`:

```tsx
  // Only a run in flight; the server sends progress only while its lease is live.
  const progress = pending ? (health?.progress ?? null) : null
  const progressText = progress ? m.charging_source_progress(progress) : null
```

and between the status `<div className="flex flex-col items-start gap-1.5">…</div>` and the buttons grid:

```tsx
      {progress && progressText ? (
        <div className="flex flex-col gap-1.5">
          <Progress
            value={(progress.done / progress.total) * 100}
            aria-label={m.charging_source_progress_label({ source: name })}
            getValueLabel={() => progressText}
          />
          {/* The bar's aria-valuetext already says it; not re-read, and not a
              live region (a 5 s poll would be noisy). */}
          <p aria-hidden="true" className="text-muted-foreground text-xs tabular-nums">
            {progressText}
          </p>
        </div>
      ) : null}
```

- [ ] **Step 6: Poll at 5 s from the click** — in `src/routes/_authenticated/charging/index.tsx` replace `healthPoll` and its comment:

```ts
// Sync health polls every minute; every 5 s while a run is in flight — seen by
// the server (`running`, a cron run included) or started from this tab and not
// seen yet — so "Synkar…" and the progress bar follow the run and clear soon
// after it ends (a run's lease lasts at most 5 min).
const healthPoll =
  (pending: boolean) =>
  (query: { state: { data?: { running: boolean } } }) =>
    pending || query.state.data?.running ? 5_000 : 60_000
```

and the four uses: `refetchInterval: isAdmin ? healthPoll(syncNow.isPendingFor('zaptec')) : 60_000` (Zaptec), `healthPoll(syncNow.isPendingFor('elpris'))`, `healthPoll(syncNow.isPendingFor('skoda'))`, `healthPoll(syncNow.isPendingFor('emaldo'))`.

- [ ] **Step 7: Run to verify**

Run: `bunx vitest run --project browser src/components/evCharging/ && bun run typecheck && bun run check`
Expected: PASS; Biome may reformat — keep its changes.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/progress.tsx src/components/evCharging/ src/routes/_authenticated/charging/index.tsx messages/ src/paraglide 2>/dev/null; git add -u
git commit -m "feat(charging): show sync progress on Datakällor tiles"
```

(`src/paraglide/` is generated; add it only if it's tracked — check `git status`.)

---

## After the tasks (workflow Phases 5–7)

- **Branch review:** `migration-guard` + schema-design reviewer (Task 1 changed `drizzle/`), `test-completeness`, `code-reviewer`, plus a general correctness pass over the whole diff.
- **Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`): `check`, `check:ci`, `build`, `db:up && db:migrate`, `test`, the sv/en key diff.
- **Live verification:** `bun run dev` + `bun run dev:worker`, sign in as admin, open `/charging`, click Emaldo's "Synka nu" with a backfill pending (e.g. clear the local `integration_sync` watermark for `emaldo`), and watch the bar advance at desktop, tablet and mobile widths; confirm it disappears when the run ends and that Zaptec/Škoda show only the spinner.
- **PR:** `feat(charging): show sync progress on Datakällor tiles`, body per `.github/PULL_REQUEST_TEMPLATE.md`, linking the spec and the ADR-0019 amendment.
