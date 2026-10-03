# Solar-aware cost, step 2: Emaldo readings sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the house's 5-minute energy flows from Emaldo every hour into `house_energy_reading`, backfilling
from a week before the first charging session, health-tracked like the other pulled sources, so step 3 can derive
each session's energy mix from them.

**Architecture:** `emaldo` becomes the fourth pulled source (ADR-0019) on the shared `runPulledSync` lifecycle. The
orchestrator `src/lib/houseEnergy/sync.ts` asks the step-1 client (`emaldo.fetchDay`) for yesterday and today
every run, then walks the backfill forward from the watermark (≤ 30 days a run) and stores each answered Stockholm
day whole through `houseEnergy.replaceDay` (delete the day's range + insert, one transaction). The watermark is
`integration_sync.last_success_started_at`, fed by `run.syncedUntil` = the end of the last fully stored day. A
`:45` cron, the admin "Synka nu" and an admin-only health alert + run card on `/charging` expose it. Nothing reads
the readings yet (step 3 does). One PR.

**Tech Stack:** TanStack Start, oRPC, Drizzle 0.45 (`pg`), zod 4, date-fns 4 + `@date-fns/tz`, Paraglide,
TanStack Query, Vitest (node + browser).

**Spec:** `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` ("Data model" → `house_energy_reading`,
"Sync (roadmap step 2)", "Errors, health, privacy") · **ADR:** `docs/adr/0023-solar-aware-charging-cost.md` ·
**Roadmap:** `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, step 2.

**Branch / PR:** `feat/emaldo-readings-sync` → PR `feat(charging): sync house energy readings from Emaldo`.

## Contract deviations

All additive; nothing in the contract is renamed or retyped.

1. `EmaldoSyncRun` gains three counters: `emptyDays` (answered days with no readings; stored data kept),
   `rejectedDays` (old days whose readings failed validation; skipped) and `retries` (mirrors step 1's
   `EmaldoCallStats.retries`, from the shared `fetchWithRetry`). All go to the run line and run timings.
2. `runEmaldoSync`'s `deps` gains `sleep?: (ms: number) => Promise<void>` (the polite pause between backfill
   days, injectable for tests, like `runElprisSync`).
3. The service also exports `HouseEnergyDomainError` (`errors.ts`, codes `INVALID_DAY` | `INVALID_READINGS`), and
   `replaceDay` takes `readonly HouseReading[]` (accepts the contract's `HouseReading[]`).
4. The schema file also exports `HOUSE_BUCKET_KWH_MAX = 10` (absurd-value CHECK backstop, used by the service).
5. `src/lib/time/stockholm.ts` gains `daysBetween(from, to)` (calendar days, for `fetchDay`'s offset).
6. The orchestrator also exports the pure `planEmaldoDays` (unit-tested).

## Global Constraints

- All DB access through `src/lib/services/<entity>/` (ADR-0002); every `pgTable(...)` ends with `.enableRLS()`;
  every timestamp column is `timestamp(..., { withTimezone: true })`.
- Never `console.*`; server code logs via `~/lib/logger/server` (`logger`) or the injected `log`.
- **Readings are a household load profile** (ADR-0023): never logged, never in an error message, a run row or the
  run line, never returned to the client. Messages name a bucket index and a field, never a value. Test fixtures
  are synthetic; nothing from `data/private/emaldo/` is ever committed (the repo is public), and no real figures go
  in the PR.
- Emaldo is a pulled source: **no devLog/fake adapter**. Any of `EMALDO_USER`, `EMALDO_PASSWORD`,
  `EMALDO_APP_ID`, `EMALDO_APP_SECRET` unset, or `VITEST=true` → every call fails `not_configured`.
- Policy: `STALE_AFTER_MS.emaldo = 3 h`, `ALERT_AFTER_FAILURES.emaldo = 1`.
- Cron `{ path: '/api/cron/emaldo-sync', schedule: '45 * * * *' }`, `CRON_SECRET`-gated via `handleCronRun`.
- Each run: yesterday, then today, then backfill days oldest first. Backfill start = the later of the watermark's
  day and (the earliest **counted** session's Stockholm day − **7** days); at most **30** backfill days a run; no
  new backfill day once the run is **120 s** old; **1 s** pause between backfill days; run deadline **240 s**.
- Watermark = the end (a Stockholm midnight) of the last fully stored day. It never moves backwards, today never
  moves it, and a run that never got an answer from Emaldo never plants one.
- An empty answer never deletes stored readings. An empty **yesterday** fails the run (`unexpected_response`);
  an empty backfill day counts as done.
- `battery_charge_ac` is stored as reported. Its meaning is settled from real data at checkpoint 2, not in code.
- Client code imports only **types** from services. User-facing text lives in `messages/sv.json` (source of truth)
  and `messages/en.json` (key-complete); run `bun run i18n:compile` after editing them.
- **Migrations are frozen once pushed.** `migration-guard` + schema-design approval before the first push; a later
  fix is a new migration. Generate with `bun run db:generate --name=house_energy_reading`; never hand-edit
  `drizzle/meta/`. Every Vercel deploy migrates prod.
- `EMALDO_*` go in Vercel **Production only**: a login ends the account's other sessions, so a Preview deploy
  would log prod out. Use the dedicated Emaldo account (ADR-0023).
- Conventional Commits, subject ≤ 72 chars, one hat per commit; end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **The watermark must never skip a day.** A run whose budget ends before any backfill day, a backfill that
   fails part-way, and a DST day (23/25 h) must leave the watermark at the end of the last day actually stored,
   never at "now". Task 4: "no new backfill day once the budget is used, and the watermark stays put", "a failure
   part-way keeps the stored days as the watermark", "backfills … across the DST switch".
2. **An empty or partial answer must not wipe stored readings.** Task 4: "an empty yesterday fails the run and
   keeps what was stored", "an empty backfill day keeps its stored readings"; Task 3: "a re-fetched day replaces
   its rows and leaves the neighbouring days alone".
3. **Our day and Emaldo's day must agree.** A run straddling midnight, or a client that computes the wrong bounds,
   must fail rather than store a day under the wrong dates. Task 4: "a day whose bounds are not the asked Stockholm
   day fails"; Task 3: "listReadings is [from, to)" (a bucket at exactly `dayEnd` belongs to the next day).
4. **Invalid readings never reach the table and never wedge the backfill.** Task 3: "rejects readings outside the
   day, repeated, or with a bad kWh"; Task 4: "an old day with invalid readings is skipped and warned", "invalid
   readings for yesterday fail the run".
5. **Readings never leak.** Task 3: "an error names the bucket and field, never the value"; Task 4: "one run row
   and one run line with counts only"; Task 6: `syncNow` returns counts only.

---

### Task 0: Verify main matches this plan

**Files:** none (read-only), except this plan if something differs.
**Reviewers:** none (a check, not a deliverable).

- [ ] **Step 1: Fresh worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken
git fetch origin
git worktree add ../videbacken-emaldo-sync -b feat/emaldo-readings-sync origin/main
cd ../videbacken-emaldo-sync
cp ../videbacken/.env .env            # gitignored; never print it
cp ../videbacken/.env.local .env.local 2>/dev/null || true
bun install
```

Check `.env.local` has no `DATABASE_URL` line pointing anywhere but localhost (CLAUDE.md gotcha):
`grep -c '^DATABASE_URL' .env.local` must be 0, or the value must contain `localhost` (check without printing it:
`grep '^DATABASE_URL' .env.local | grep -vc localhost` → 0).

- [ ] **Step 2: Previous step merged and its checkpoint passed**

```bash
git log --oneline origin/main | grep -i emaldo          # step 1's squash commit is there
grep -n '^| 1 ' docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md   # status: checkpoint passed
ls docs/superpowers/plans/2026-10-03-solar-cost-2-readings-sync.md               # this plan is on main
```

If row 1 isn't `checkpoint passed`, STOP: run checkpoint 1 first (roadmap, "How a session runs a step").

- [ ] **Step 3: The step-1 client is as the contract says**

```bash
cat src/lib/effects/emaldo/index.ts
grep -n "export type HouseBucket\|export type EmaldoDay\|droppedBuckets\|batteryChargeAcKwh" src/lib/effects/emaldo/emaldo.ts
grep -n "fetchDay(offset: number" src/lib/effects/emaldo/emaldo.ts
grep -n "export function newCallStats\|logins" src/lib/effects/emaldo/emaldo.ts
grep -n "export const emaldo\|VITEST" src/lib/effects/emaldo/emaldo.ts
grep -n "class EmaldoError\|'stats'" src/lib/effects/emaldo/errors.ts
grep -n "export { emaldo }" src/lib/effects/index.ts
grep -n "EMALDO_" .env.example
```

Expect: the barrel exports `emaldo`, `EmaldoError`, `newCallStats` and the types `EmaldoClient`, `EmaldoDay`,
`HouseBucket`, `EmaldoCallStats` (if a type isn't re-exported, import it from `~/lib/effects/emaldo/emaldo` instead
and note it here); `EmaldoError(code, op, status?, options?)` with `op` including `'stats'`; `EmaldoCallStats` is
`{ fetchMs, requests, logins, retries }` (step 1 routes requests through the shared `fetchWithRetry`; HTTP 429 maps
to `rate_limited`, which the shared health copy already covers).

Then read two behaviours this plan relies on, in `src/lib/effects/emaldo/parse.ts` and its tests:
- **An empty day** (no rows in a series): `fetchDay` must resolve `{ dayStart, dayEnd, buckets: [], … }` with the
  day's real bounds, not throw. If it throws, change Task 4's empty-day handling to catch that error instead.
- **Negative watt values**: step 1 drops a bucket with any negative reading and counts it in `droppedBuckets`
  (confirm: `grep -n "negative\|< 0" src/lib/effects/emaldo/parse.ts`). The service's rejection of negative kWh
  (Task 3) is then a backstop only; if step 1 instead passes negatives through, raise it with the owner before
  Task 3 (an old day with one would be skipped whole, yesterday would fail every run).

- [ ] **Step 4: The seams this plan consumes**

```bash
ls drizzle/*.sql | tail -2                     # last is 0012_…; this plan generates 0013
grep -n "INTEGRATION_SOURCES = " src/lib/integrationHealth.ts   # ['zaptec', 'elpris', 'skoda']
grep -n "export async function earliestCountedStartAt" src/lib/services/evCharging/sessionEnergy.ts
grep -n "sessionEnergy" src/lib/services/evCharging/index.ts
grep -n "export async function getLastSuccessStartedAt" src/lib/services/integrationSync/integrationSync.ts
grep -n "lastSuccessStartedAt: outcome.syncedUntil" src/lib/services/integrationSync/transition.ts
grep -n "export async function runPulledSync\|export function withDeadline\|export type RunBase" src/lib/integrations/runPulledSync.ts
grep -n "export async function handleCronRun" src/lib/integrations/cron.ts
grep -n "skoda-sync" vite.config.ts
grep -n "chargingSource = z.enum" src/lib/orpc/procedures/evCharging.ts
grep -n "type SyncSource" src/components/evCharging/SyncNowButton.tsx
grep -n "skodaHealthQuery\|skodaRunsQuery" src/routes/_authenticated/charging/index.tsx
grep -n "the threshold table is pinned" src/lib/services/integrationSync/transition.test.ts
```

Every line must be found. `transition.ts` must still write `outcome.syncedUntil ?? startedAt` on success and
`outcome.syncedUntil ?? prev.lastSuccessStartedAt` on failure: the watermark design depends on it.

- [ ] **Step 5: Database up, suite green before touching anything**

```bash
bun run db:up && bun run db:migrate
bunx vitest run src/lib/spotPrice/sync.test.ts src/lib/services/integrationSync
```

Expected: PASS. If anything above differs, fix this plan first (and tell the owner), then build.

---

### Task 1: `emaldo` as an integration source (vocabulary, policy, health copy)

Adding `'emaldo'` to `INTEGRATION_SOURCES` breaks compilation everywhere a source is switched on exhaustively, so
the vocabulary, policy and health copy land together. The DB CHECKs follow in Task 2's migration.

**Files:**
- Modify: `src/lib/integrationHealth.ts:1-7`
- Modify: `src/lib/services/integrationSync/policy.ts`
- Modify: `src/lib/integrationHealthMessage.ts` (`integrationSourceName`, `integrationErrorMessage`)
- Modify: `src/components/evCharging/SyncHealthAlert.tsx` (`neverSyncedCopy`, `staleCopy`)
- Modify: `messages/sv.json`, `messages/en.json`
- Test: `src/lib/services/integrationSync/transition.test.ts`, `src/lib/integrationHealthMessage.test.ts`,
  `src/components/evCharging/SyncHealthAlert.browser.test.tsx`

**Interfaces:**
- Produces: `IntegrationSource` includes `'emaldo'`; `STALE_AFTER_MS.emaldo`, `ALERT_AFTER_FAILURES.emaldo`;
  `integrationSourceName('emaldo') === 'Emaldo'`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`. (The alert copy is reviewed again, as UI, in Task 7.)

- [ ] **Step 1: Write the failing tests**

In `transition.test.ts`, change the pinned table and add a staleness case inside `describe('deriveState', …)`:

```ts
  test('the threshold table is pinned', () => {
    expect(ALERT_AFTER_FAILURES).toEqual({ zaptec: 1, elpris: 1, skoda: 3, emaldo: 1 })
  })
```

```ts
  test('emaldo goes stale after 3 h, like Zaptec', () => {
    expect(STALE_AFTER_MS.emaldo).toBe(3 * 60 * 60 * 1000)
    expect(deriveState('emaldo', healthy, new Date(T0.getTime() + STALE_AFTER_MS.emaldo))).toBe('ok')
    expect(deriveState('emaldo', healthy, new Date(T0.getTime() + STALE_AFTER_MS.emaldo + 1))).toBe(
      'stale',
    )
  })
```

Append to `integrationHealthMessage.test.ts` (the existing loops cover the name and every code for the new source
automatically once it is in `INTEGRATION_SOURCES`):

```ts
test('emaldo is a source with its own name', () => {
  expect(INTEGRATION_SOURCES).toContain('emaldo')
  expect(integrationSourceName('emaldo')).toBe('Emaldo')
})

test('an unexpected Emaldo answer hints that the app key may have changed', () => {
  expect(integrationErrorMessage('unexpected_response', { source: 'emaldo', locale: 'sv' })).toContain(
    'nyckel',
  )
  expect(integrationErrorMessage('unexpected_response', { source: 'emaldo', locale: 'en' })).toContain(
    'key',
  )
  // Other codes keep the shared, source-named copy.
  expect(integrationErrorMessage('unreachable', { source: 'emaldo', locale: 'en' })).toContain('Emaldo')
})
```

Append to `SyncHealthAlert.browser.test.tsx`:

```tsx
test('Emaldo has its own never-synced copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'emaldo', state: 'never_synced' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_never_synced_emaldo())).toBeVisible()
})

test('Emaldo has its own stale copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'emaldo', state: 'stale' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_emaldo())).toBeVisible()
})

test('an unexpected Emaldo answer says the app key may have changed', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, source: 'emaldo', code: 'unexpected_response' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(screen.getByText(integrationErrorMessage('unexpected_response', { source: 'emaldo' }), { exact: false }))
    .toBeVisible()
})
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
bunx vitest run src/lib/services/integrationSync/transition.test.ts src/lib/integrationHealthMessage.test.ts
bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx
```

Expected: FAIL (`emaldo` missing from the tables; `m.charging_health_never_synced_emaldo` is not a function).

- [ ] **Step 3: Implement**

`src/lib/integrationHealth.ts` — replace the header comment and the source list:

```ts
// Shared vocabulary for third-party integration sync health (Zaptec sessions,
// elpris spot prices, the Škoda car state and the Emaldo house energy flows).
// Dependency-free and client-safe —
// no `db`/`postgres` import here — so the client can import these unions for
// status badges without dragging the db layer (and its `Buffer` usage) into the
// browser bundle. See `src/lib/sensor/range.ts` for the same pattern.
// Adding a source changes the rendered DB CHECK text: run `bun run db:generate`.
export const INTEGRATION_SOURCES = ['zaptec', 'elpris', 'skoda', 'emaldo'] as const
```

`src/lib/services/integrationSync/policy.ts`:

```ts
// Domain rule: how long after its last success a source counts as `stale`.
// Zaptec syncs hourly, so 3 h = two missed runs. elpris runs at 12:30 and
// 15:30 UTC (at most 21 h apart), so 26 h = a whole missed day plus slack.
// skoda polls every 15 min, so 1 h = three missed polls. Emaldo syncs hourly
// (:45), so 3 h like Zaptec.
export const STALE_AFTER_MS: Record<IntegrationSource, number> = {
  zaptec: 3 * millisecondsInHour,
  elpris: 26 * millisecondsInHour,
  skoda: millisecondsInHour,
  emaldo: 3 * millisecondsInHour,
}

// How many consecutive alertable failures open an alert email (a
// not_configured run restarts the count). Hourly/daily
// sources alert at once; Škoda polls every 15 min, where a single 503 or 429
// would otherwise email every admin and then "recovered" 15 min later.
export const ALERT_AFTER_FAILURES: Record<IntegrationSource, number> = {
  zaptec: 1,
  elpris: 1,
  skoda: 3,
  emaldo: 1,
}
```

`src/lib/integrationHealthMessage.ts` — in `integrationSourceName` add

```ts
    case 'emaldo':
      return m.integration_health_source_emaldo()
```

and replace the `unexpected_response` case of `integrationErrorMessage`:

```ts
    case 'unexpected_response':
      // Emaldo's API is unofficial: an answer we can't decode usually means
      // the app's id/secret rotated (ADR-0023); say what to look for.
      return options.source === 'emaldo'
        ? m.integration_health_error_unexpected_response_emaldo({}, opts)
        : m.integration_health_error_unexpected_response({ source }, opts)
```

`src/components/evCharging/SyncHealthAlert.tsx` — extend the comment above `neverSyncedCopy` ("…the car's state
polls every 15 min and feeds attribution; the house's energy flows sync hourly and will feed the cost mix") and add
a case to each switch:

```ts
    case 'emaldo':
      return m.charging_health_never_synced_emaldo()
```

```ts
    case 'emaldo':
      return m.charging_health_stale_emaldo()
```

Messages (add beside the matching skoda keys, same position in both files):

| key | sv | en |
|---|---|---|
| `integration_health_source_emaldo` | Emaldo | Emaldo |
| `integration_health_error_unexpected_response_emaldo` | Emaldo svarade på ett oväntat sätt. Appens nyckel kan ha bytts ut – en admin behöver undersöka det. | Emaldo responded unexpectedly. The app's key may have changed – an admin needs to look into it. |
| `charging_health_never_synced_emaldo` | Husets energidata (sol, batteri och elnät) har inte hämtats ännu. Den hämtas varje timme. | The house's energy data (solar, battery and grid) hasn't been fetched yet. It's fetched every hour. |
| `charging_health_stale_emaldo` | Husets energidata har inte kunnat hämtas på ett tag. De senaste timmarna saknas. | The house's energy data couldn't be fetched for a while. The last few hours are missing. |

Then `bun run i18n:compile`.

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/services/integrationSync/transition.test.ts src/lib/integrationHealthMessage.test.ts
bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx
bun run typecheck
```

Expected: PASS, and `tsc` clean (every exhaustive switch now has its `emaldo` case).

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrationHealth.ts src/lib/services/integrationSync src/lib/integrationHealthMessage.ts \
  src/lib/integrationHealthMessage.test.ts src/components/evCharging/SyncHealthAlert.tsx \
  src/components/evCharging/SyncHealthAlert.browser.test.tsx messages/sv.json messages/en.json
git commit -m "feat(charging): add emaldo as an integration source" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `house_energy_reading` schema + migration (with the regenerated source CHECKs)

**Files:**
- Create: `src/lib/db/schema/houseEnergy.ts`
- Modify: `src/lib/db/schema/index.ts` (add `export * from './houseEnergy'` after `./file`)
- Create (generated): `drizzle/0013_house_energy_reading.sql`, `drizzle/meta/0013_snapshot.json`, `drizzle/meta/_journal.json`
- Test: `src/lib/db/houseEnergySchema.test.ts` (in `src/lib/db/`, not `schema/`: drizzle-kit would `require()` a
  test file inside the schema directory)

**Interfaces:**
- Produces: `houseEnergyReading` table; `HOUSE_BUCKET_KWH_MAX = 10`; `integration_sync(_run)` CHECKs accept
  `'emaldo'`.

**Reviewers:** A = `migration-guard`, B = schema-design reviewer (`general-purpose` agent that loads
`supabase-postgres-best-practices`), judging against the queries that will run:
- `replaceDay` (Task 3), hourly: `DELETE … WHERE bucket_start >= $dayStart AND bucket_start < $dayEnd` + one
  multi-row `INSERT` of ≤ 300 rows, for yesterday and today, plus ≤ 30 backfill days a run until caught up
  (≈ 260 days in prod: ≈ 75k rows over ≈ 9 runs).
- `listReadings` (step 3): `bucket_start` range scans — per session (its window − 30 min) and "from day D to the
  last reading" for a re-derive (≈ 105k rows a year in total).
- `firstReadingAt`: `min(bucket_start)`.
- The two regenerated `*_source_check` constraints on `integration_sync` (≤ 4 rows) and `integration_sync_run`
  (90 days of runs): `DROP` + `ADD CONSTRAINT … CHECK` validates existing rows under an `ACCESS EXCLUSIVE` lock.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/db/houseEnergySchema.test.ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import {
  HOUSE_BUCKET_KWH_MAX,
  houseEnergyReading,
  integrationSync,
  integrationSyncRun,
} from '~/lib/db/schema'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/): drizzle-kit scans schema/ and would try to
// require() this file.
setupDatabase()

type Insert = typeof houseEnergyReading.$inferInsert

// Synthetic values only — never real household readings (the repo is public).
const row = (overrides: Partial<Insert> = {}): Insert => ({
  bucketStart: new Date('2026-04-01T10:00:00Z'),
  gridImportKwh: 0.1,
  gridExportKwh: 0,
  solarKwh: 0.05,
  loadKwh: 0.15,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
  ...overrides,
})

test('a reading is keyed by its bucket start', async () => {
  await db.insert(houseEnergyReading).values(row())
  await expectConstraintViolation(
    db.insert(houseEnergyReading).values(row()),
    'house_energy_reading_pkey',
  )
})

test.each([
  ['gridImportKwh', 'house_energy_reading_grid_import_kwh_check'],
  ['gridExportKwh', 'house_energy_reading_grid_export_kwh_check'],
  ['solarKwh', 'house_energy_reading_solar_kwh_check'],
  ['loadKwh', 'house_energy_reading_load_kwh_check'],
  ['batteryDischargeKwh', 'house_energy_reading_battery_discharge_kwh_check'],
  ['batteryChargeSolarKwh', 'house_energy_reading_battery_charge_solar_kwh_check'],
  ['batteryChargeGridKwh', 'house_energy_reading_battery_charge_grid_kwh_check'],
  ['batteryChargeAcKwh', 'house_energy_reading_battery_charge_ac_kwh_check'],
] as const)('a negative or absurd %s is rejected', async (field, constraint) => {
  const negative = { [field]: -0.001 } as Partial<Insert>
  const absurd = { [field]: HOUSE_BUCKET_KWH_MAX } as Partial<Insert>
  await expectConstraintViolation(db.insert(houseEnergyReading).values(row(negative)), constraint)
  await expectConstraintViolation(db.insert(houseEnergyReading).values(row(absurd)), constraint)
})

test('zero is a valid reading', async () => {
  await db.insert(houseEnergyReading).values(
    row({ gridImportKwh: 0, solarKwh: 0, loadKwh: 0 }),
  )
})

test('every integration source, emaldo included, passes both source CHECKs', async () => {
  expect(INTEGRATION_SOURCES).toContain('emaldo')
  for (const source of INTEGRATION_SOURCES) {
    await db.insert(integrationSync).values({ source })
    await db.insert(integrationSyncRun).values({
      source,
      trigger: 'cron',
      startedAt: new Date('2026-04-01T10:00:00Z'),
      finishedAt: new Date('2026-04-01T10:00:01Z'),
      durationMs: 1000,
      outcome: 'ok',
    })
  }
})
```

- [ ] **Step 2: Run it, expect FAIL**

`bunx vitest run src/lib/db/houseEnergySchema.test.ts` → FAIL (`houseEnergyReading` is not exported).

- [ ] **Step 3: Implement the schema**

```ts
// src/lib/db/schema/houseEnergy.ts
import { sql } from 'drizzle-orm'
import { type AnyPgColumn, check, doublePrecision, pgTable, timestamp } from 'drizzle-orm/pg-core'

/**
 * Absurd-value backstop for one 5-minute bucket, in kWh (a 120 kW average; a
 * 25 A three-phase main fuse allows ≈ 1.5). It catches a unit slip (W stored as
 * kWh), not real data; the Emaldo parser does the real validation. Changing it
 * changes the rendered CHECK text: run `bun run db:generate`.
 */
export const HOUSE_BUCKET_KWH_MAX = 10
const kwhMax = sql.raw(String(HOUSE_BUCKET_KWH_MAX))

const kwhCheck = (name: string, column: AnyPgColumn) =>
  check(`house_energy_reading_${name}_check`, sql`${column} >= 0 AND ${column} < ${kwhMax}`)

// One row per 5-minute bucket of the house's energy flows, pulled from the
// Emaldo cloud (ADR-0023). Written a whole Stockholm day at a time
// (`houseEnergy.replaceDay`: delete the day's range, then insert, in one
// transaction), so a re-fetched day never leaves stale buckets behind; gaps
// stay gaps. A household load profile: server-only, never logged raw, never
// sent to the client. Kept indefinitely, like vehicle_state_snapshot. The
// primary key serves every read: the day replace, range reads and min().
export const houseEnergyReading = pgTable(
  'house_energy_reading',
  {
    /** The response's start_time + the row's minute offset, as a UTC instant. */
    bucketStart: timestamp('bucket_start', { withTimezone: true }).primaryKey(),
    gridImportKwh: doublePrecision('grid_import_kwh').notNull(),
    gridExportKwh: doublePrecision('grid_export_kwh').notNull(),
    /** Every MPPT string plus the third-party (AC-coupled) inverter. */
    solarKwh: doublePrecision('solar_kwh').notNull(),
    /** The whole house, the car charger included. */
    loadKwh: doublePrecision('load_kwh').notNull(),
    batteryDischargeKwh: doublePrecision('battery_discharge_kwh').notNull(),
    /** Emaldo's battery `charge_mppt`: charged straight from the panels. */
    batteryChargeSolarKwh: doublePrecision('battery_charge_solar_kwh').notNull(),
    batteryChargeGridKwh: doublePrecision('battery_charge_grid_kwh').notNull(),
    /**
     * Emaldo's battery `charge_ac`, stored as reported. Its meaning is settled
     * from real data at the roadmap's checkpoint 2; until then the derivation
     * treats it as grid-origin (spec, "Sync").
     */
    batteryChargeAcKwh: doublePrecision('battery_charge_ac_kwh').notNull(),
  },
  (table) => [
    kwhCheck('grid_import_kwh', table.gridImportKwh),
    kwhCheck('grid_export_kwh', table.gridExportKwh),
    kwhCheck('solar_kwh', table.solarKwh),
    kwhCheck('load_kwh', table.loadKwh),
    kwhCheck('battery_discharge_kwh', table.batteryDischargeKwh),
    kwhCheck('battery_charge_solar_kwh', table.batteryChargeSolarKwh),
    kwhCheck('battery_charge_grid_kwh', table.batteryChargeGridKwh),
    kwhCheck('battery_charge_ac_kwh', table.batteryChargeAcKwh),
  ],
).enableRLS()
```

If `AnyPgColumn` isn't exported by the installed drizzle-orm (check with Context7, library `drizzle-orm`), type the
parameter as `PgColumn` from the same module.

Add `export * from './houseEnergy'` to `src/lib/db/schema/index.ts` (alphabetical, after `./file`).

- [ ] **Step 4: Generate and apply**

```bash
bun run db:generate --name=house_energy_reading
bun run db:migrate
```

Expected `drizzle/0013_house_energy_reading.sql` (statement order may differ):
- `CREATE TABLE "house_energy_reading"` with `"bucket_start" timestamp with time zone PRIMARY KEY NOT NULL`, eight
  `double precision NOT NULL` columns and eight `CONSTRAINT "house_energy_reading_<col>_check" CHECK (… >= 0 AND …
  < 10)` (the `10` rendered literally);
- `ALTER TABLE "house_energy_reading" ENABLE ROW LEVEL SECURITY;`
- `ALTER TABLE "integration_sync" DROP CONSTRAINT "integration_sync_source_check";` + `ADD CONSTRAINT … IN
  ('zaptec', 'elpris', 'skoda', 'emaldo')`, and the same pair for `integration_sync_run_source_check` (the pattern
  of `0011_vehicle_source_skoda_live.sql`).

Nothing else may change. If drizzle-kit wants to alter anything else, stop: the snapshot is out of sync.

- [ ] **Step 5: Run, expect PASS**

```bash
bunx vitest run src/lib/db/houseEnergySchema.test.ts test/rls.test.ts src/lib/db/evChargingSchema.test.ts
```

Expected: PASS (`rls.test.ts` proves the new table has RLS on).

- [ ] **Step 6: Review gate before anything builds on it**

Dispatch `migration-guard` and the schema-design reviewer in parallel (told to assume the schema is wrong). Fix or
explicitly rule on every finding **before Task 3** — once pushed, 0013 is frozen. If a fix changes the schema,
delete the unpushed `drizzle/0013_*` + its meta entries with `bunx drizzle-kit drop`, then regenerate.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/houseEnergy.ts src/lib/db/schema/index.ts src/lib/db/houseEnergySchema.test.ts drizzle/
git commit -m "feat(charging): add the house energy reading table" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `houseEnergy` service (replace a day, read a range, first reading)

**Files:**
- Create: `src/lib/services/houseEnergy/errors.ts`, `src/lib/services/houseEnergy/houseEnergy.ts`,
  `src/lib/services/houseEnergy/index.ts`
- Test: `src/lib/services/houseEnergy/houseEnergy.test.ts`

**Interfaces:**
- Consumes: `houseEnergyReading`, `HOUSE_BUCKET_KWH_MAX` (Task 2).
- Produces:
  ```ts
  export type HouseReading = { bucketStart: Date; gridImportKwh: number; gridExportKwh: number; solarKwh: number;
    loadKwh: number; batteryDischargeKwh: number; batteryChargeSolarKwh: number; batteryChargeGridKwh: number;
    batteryChargeAcKwh: number }
  export async function replaceDay(day: { dayStart: Date; dayEnd: Date }, buckets: readonly HouseReading[]): Promise<number>
  export async function listReadings(range: { from: Date; to: Date }): Promise<HouseReading[]>   // [from, to), ascending
  export async function firstReadingAt(): Promise<Date | null>
  export type HouseEnergyDomainErrorCode = 'INVALID_DAY' | 'INVALID_READINGS'
  export class HouseEnergyDomainError extends Error { readonly code: HouseEnergyDomainErrorCode }
  ```

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/services/houseEnergy/houseEnergy.test.ts
import { expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { HouseEnergyDomainError } from './errors'
import { firstReadingAt, type HouseReading, listReadings, replaceDay } from './houseEnergy'

setupDatabase()

const FIVE_MIN = 300_000

const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}

// Synthetic values only — never real household readings (the repo is public).
const reading = (bucketStart: Date, kwh = 0.1): HouseReading => ({
  bucketStart,
  gridImportKwh: kwh,
  gridExportKwh: 0,
  solarKwh: 0.02,
  loadKwh: kwh,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
})

/** Every 5-minute bucket of the Stockholm day (276 / 288 / 300 of them). */
const fullDay = (day: string): HouseReading[] => {
  const { dayStart, dayEnd } = dayOf(day)
  const n = (dayEnd.getTime() - dayStart.getTime()) / FIVE_MIN
  return Array.from({ length: n }, (_, i) => reading(new Date(dayStart.getTime() + i * FIVE_MIN)))
}

const all = () =>
  listReadings({ from: new Date('2000-01-01T00:00:00Z'), to: new Date('2100-01-01T00:00:00Z') })

test('stores a whole spring-forward day (276 buckets) and reads it back ascending', async () => {
  const day = dayOf('2026-03-29')
  const buckets = fullDay('2026-03-29').reverse()
  expect(buckets).toHaveLength(276)

  expect(await replaceDay(day, buckets)).toBe(276)

  const stored = await listReadings({ from: day.dayStart, to: day.dayEnd })
  expect(stored).toHaveLength(276)
  expect(stored[0]).toEqual(reading(day.dayStart))
  expect(stored.at(-1)?.bucketStart).toEqual(new Date(day.dayEnd.getTime() - FIVE_MIN))
})

test('stores a whole fall-back day (300 buckets)', async () => {
  expect(await replaceDay(dayOf('2026-10-25'), fullDay('2026-10-25'))).toBe(300)
})

test('a re-fetched day replaces its rows and leaves the neighbouring days alone', async () => {
  await replaceDay(dayOf('2026-03-31'), fullDay('2026-03-31'))
  await replaceDay(dayOf('2026-04-01'), fullDay('2026-04-01'))
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const d = dayOf('2026-04-01')

  // Gaps stay gaps: the new answer has two buckets, so only those two remain.
  await replaceDay(d, [
    reading(d.dayStart, 0.3),
    reading(new Date(d.dayStart.getTime() + 2 * FIVE_MIN), 0.4),
  ])

  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.gridImportKwh)).toEqual([0.3, 0.4])
  expect(await all()).toHaveLength(288 + 2 + 288)
})

test('listReadings is [from, to): a bucket at `to` belongs to the next range', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, [reading(d.dayStart)])
  await replaceDay(dayOf('2026-04-02'), [reading(d.dayEnd)])
  const day = await listReadings({ from: d.dayStart, to: d.dayEnd })
  expect(day.map((r) => r.bucketStart)).toEqual([d.dayStart])
})

test('an empty list clears the day and writes nothing', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  expect(await replaceDay(d, [])).toBe(0)
  expect(await all()).toHaveLength(0)
})

test('rejects readings outside the day, repeated, or with a bad kWh — and keeps the stored day', async () => {
  const d = dayOf('2026-04-01')
  await replaceDay(d, fullDay('2026-04-01'))
  const bad: [string, HouseReading[]][] = [
    ['before the day', [reading(new Date(d.dayStart.getTime() - FIVE_MIN))]],
    ['at the next midnight', [reading(d.dayEnd)]],
    ['a repeated start', [reading(d.dayStart), reading(d.dayStart)]],
    ['a negative value', [{ ...reading(d.dayStart), solarKwh: -0.01 }]],
    ['NaN', [{ ...reading(d.dayStart), loadKwh: Number.NaN }]],
    ['Infinity', [{ ...reading(d.dayStart), gridExportKwh: Number.POSITIVE_INFINITY }]],
    ['an absurd value', [{ ...reading(d.dayStart), gridImportKwh: 1000 }]],
    ['an invalid date', [reading(new Date(Number.NaN))]],
  ]
  for (const [label, buckets] of bad) {
    await expect(replaceDay(d, buckets), label).rejects.toMatchObject({
      name: 'HouseEnergyDomainError',
      code: 'INVALID_READINGS',
    })
  }
  expect(await all()).toHaveLength(288)
})

test('an error names the bucket and field, never the value', async () => {
  const d = dayOf('2026-04-01')
  const error = await replaceDay(d, [
    { ...reading(d.dayStart), batteryChargeAcKwh: -0.123456 },
  ]).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(HouseEnergyDomainError)
  expect((error as Error).message).toContain('bucket 0')
  expect((error as Error).message).toContain('batteryChargeAcKwh')
  expect((error as Error).message).not.toContain('0.123456')
})

test('rejects a day that is not 1 ms–25 h long', async () => {
  const start = new Date('2026-04-01T22:00:00Z')
  for (const dayEnd of [
    start,
    new Date(start.getTime() - 1),
    new Date(start.getTime() + 26 * 3_600_000),
    new Date(Number.NaN),
  ]) {
    await expect(replaceDay({ dayStart: start, dayEnd }, [])).rejects.toMatchObject({
      code: 'INVALID_DAY',
    })
  }
})

test('firstReadingAt is null before any reading, then the earliest bucket', async () => {
  expect(await firstReadingAt()).toBeNull()
  await replaceDay(dayOf('2026-04-02'), fullDay('2026-04-02'))
  const early = new Date(dayOf('2026-03-30').dayStart.getTime() + 7 * FIVE_MIN)
  await replaceDay(dayOf('2026-03-30'), [reading(early)])
  expect(await firstReadingAt()).toEqual(early)
})
```

- [ ] **Step 2: Run it, expect FAIL**

`bunx vitest run src/lib/services/houseEnergy/houseEnergy.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/services/houseEnergy/errors.ts
export type HouseEnergyDomainErrorCode =
  // The day's bounds can't be a Stockholm day: the end isn't after the start,
  // or the day is longer than 25 h.
  | 'INVALID_DAY'
  // A bucket lies outside the day or repeats a bucket start, or a kWh value is
  // not finite, negative or absurd. Stored days are all-or-nothing.
  | 'INVALID_READINGS'

export class HouseEnergyDomainError extends Error {
  constructor(
    public readonly code: HouseEnergyDomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'HouseEnergyDomainError'
  }
}
```

```ts
// src/lib/services/houseEnergy/houseEnergy.ts
import { millisecondsInHour } from 'date-fns/constants'
import { and, asc, gte, lt, min } from 'drizzle-orm'
import { db } from '~/lib/db'
import { HOUSE_BUCKET_KWH_MAX, houseEnergyReading } from '~/lib/db/schema'
import { HouseEnergyDomainError } from './errors'

/**
 * One 5-minute bucket of the house's energy flows, kWh each (ADR-0023). The
 * same shape as the Emaldo client's `HouseBucket`, declared here so the derive
 * and client code can `import type` it without reaching into an effect.
 */
export type HouseReading = {
  bucketStart: Date
  gridImportKwh: number
  gridExportKwh: number
  solarKwh: number
  loadKwh: number
  batteryDischargeKwh: number
  batteryChargeSolarKwh: number
  batteryChargeGridKwh: number
  batteryChargeAcKwh: number
}

const KWH_FIELDS = [
  'gridImportKwh',
  'gridExportKwh',
  'solarKwh',
  'loadKwh',
  'batteryDischargeKwh',
  'batteryChargeSolarKwh',
  'batteryChargeGridKwh',
  'batteryChargeAcKwh',
] as const satisfies readonly (keyof HouseReading)[]

/** A Stockholm day is 23–25 h; anything longer is a caller bug. */
const MAX_DAY_MS = 25 * millisecondsInHour
/** Problems quoted in one error message. */
const MAX_PROBLEMS = 5

const readingColumns = {
  bucketStart: houseEnergyReading.bucketStart,
  gridImportKwh: houseEnergyReading.gridImportKwh,
  gridExportKwh: houseEnergyReading.gridExportKwh,
  solarKwh: houseEnergyReading.solarKwh,
  loadKwh: houseEnergyReading.loadKwh,
  batteryDischargeKwh: houseEnergyReading.batteryDischargeKwh,
  batteryChargeSolarKwh: houseEnergyReading.batteryChargeSolarKwh,
  batteryChargeGridKwh: houseEnergyReading.batteryChargeGridKwh,
  batteryChargeAcKwh: houseEnergyReading.batteryChargeAcKwh,
}

// What's wrong with `buckets` as the readings of `[startMs, endMs)`. Messages
// name the bucket index and field only — never a value (ADR-0023, privacy).
function readingProblems(startMs: number, endMs: number, buckets: readonly HouseReading[]) {
  const problems: string[] = []
  const seen = new Set<number>()
  for (const [i, b] of buckets.entries()) {
    const t = b.bucketStart.getTime()
    if (!(t >= startMs && t < endMs)) problems.push(`bucket ${i} starts outside the day`)
    else if (seen.has(t)) problems.push(`bucket ${i} repeats a bucket start`)
    seen.add(t)
    for (const field of KWH_FIELDS) {
      const value = b[field]
      if (!Number.isFinite(value)) problems.push(`bucket ${i}: ${field} is not a finite number`)
      else if (value < 0) problems.push(`bucket ${i}: ${field} is negative`)
      else if (value >= HOUSE_BUCKET_KWH_MAX) problems.push(`bucket ${i}: ${field} is implausibly large`)
    }
  }
  return problems
}

/**
 * Stores one Stockholm day's readings, replacing whatever the day held: delete
 * `[dayStart, dayEnd)`, then insert, in one transaction (like
 * `spotPrice.replaceDay`). Validated first, so a rejected day leaves the stored
 * one untouched. An empty list clears the day — the sync never passes one (an
 * empty answer keeps what's stored). Returns the rows written.
 */
export async function replaceDay(
  day: { dayStart: Date; dayEnd: Date },
  buckets: readonly HouseReading[],
): Promise<number> {
  const startMs = day.dayStart.getTime()
  const endMs = day.dayEnd.getTime()
  if (!(endMs - startMs > 0 && endMs - startMs <= MAX_DAY_MS)) {
    throw new HouseEnergyDomainError('INVALID_DAY', 'A day must end 1 ms to 25 h after it starts')
  }
  const problems = readingProblems(startMs, endMs, buckets)
  if (problems.length > 0) {
    const more = problems.length > MAX_PROBLEMS ? ` (+${problems.length - MAX_PROBLEMS} more)` : ''
    throw new HouseEnergyDomainError(
      'INVALID_READINGS',
      `${problems.slice(0, MAX_PROBLEMS).join('; ')}${more}`,
    )
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(houseEnergyReading)
      .where(
        and(
          gte(houseEnergyReading.bucketStart, day.dayStart),
          lt(houseEnergyReading.bucketStart, day.dayEnd),
        ),
      )
    if (buckets.length === 0) return
    await tx.insert(houseEnergyReading).values(
      buckets.map((b) => ({
        bucketStart: b.bucketStart,
        gridImportKwh: b.gridImportKwh,
        gridExportKwh: b.gridExportKwh,
        solarKwh: b.solarKwh,
        loadKwh: b.loadKwh,
        batteryDischargeKwh: b.batteryDischargeKwh,
        batteryChargeSolarKwh: b.batteryChargeSolarKwh,
        batteryChargeGridKwh: b.batteryChargeGridKwh,
        batteryChargeAcKwh: b.batteryChargeAcKwh,
      })),
    )
  })
  return buckets.length
}

/** The readings in `[from, to)`, oldest first — a primary-key range scan. */
export async function listReadings(range: { from: Date; to: Date }): Promise<HouseReading[]> {
  return db
    .select(readingColumns)
    .from(houseEnergyReading)
    .where(
      and(
        gte(houseEnergyReading.bucketStart, range.from),
        lt(houseEnergyReading.bucketStart, range.to),
      ),
    )
    .orderBy(asc(houseEnergyReading.bucketStart))
}

/** The earliest stored bucket's start, or null with none. */
export async function firstReadingAt(): Promise<Date | null> {
  const [row] = await db
    .select({ first: min(houseEnergyReading.bucketStart) })
    .from(houseEnergyReading)
  return row?.first ?? null
}
```

```ts
// src/lib/services/houseEnergy/index.ts
export * from './errors'
export * from './houseEnergy'
```

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/services/houseEnergy/houseEnergy.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/houseEnergy
git commit -m "feat(charging): store house energy readings a day at a time" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `runEmaldoSync` (recent days + backfill, watermark)

**Files:**
- Modify: `src/lib/time/stockholm.ts` (add `daysBetween`), `src/lib/time/stockholm.test.ts`
- Create: `src/lib/houseEnergy/sync.ts`
- Test: `src/lib/houseEnergy/sync.test.ts`

**Interfaces:**
- Consumes: `emaldo`, `EmaldoClient`, `EmaldoDay`, `EmaldoError`, `newCallStats`, `EmaldoCallStats`, `HouseBucket`
  (step 1, `~/lib/effects/emaldo`); `replaceDay`, `HouseEnergyDomainError` (Task 3); `earliestCountedStartAt()`
  (`~/lib/services/evCharging`); `getLastSuccessStartedAt(source)` (`~/lib/services/integrationSync`);
  `runPulledSync`, `withDeadline`, `RunBase` (`~/lib/integrations/runPulledSync`).
- Produces:
  ```ts
  export function daysBetween(from: string, to: string): number   // stockholm.ts; to − from in calendar days
  export type EmaldoDayPlan = { today: string; yesterday: string; start: string; backfill: string[]; backfillLeft: number }
  export function planEmaldoDays(a: { today: string; watermarkDay: string | null; firstSessionDay: string | null; max: number }): EmaldoDayPlan
  export type EmaldoSyncRun = RunBase & { source: 'emaldo'; daysFetched: number; bucketsStored: number;
    droppedBuckets: number; emptyDays: number; rejectedDays: number; fetchMs: number; storeMs: number;
    requests: number; retries: number; logins: number; backfillDaysLeft: number; earliestReplacedDay: string | null }
  export async function runEmaldoSync(opts: { trigger: SyncTrigger; now?: () => Date; deadlineMs?: number;
    deps?: { emaldo?: EmaldoClient; log?: Logger; sleep?: (ms: number) => Promise<void> } }): Promise<EmaldoSyncRun>
  ```
  Step 3 reads `run.earliestReplacedDay` to re-derive from that day.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: `daysBetween` — failing test, then implement**

Append to `src/lib/time/stockholm.test.ts` (and add `daysBetween` to its import list):

```ts
describe('daysBetween', () => {
  test('counts calendar days, negative backwards, unaffected by DST', () => {
    expect(daysBetween('2026-04-01', '2026-04-01')).toBe(0)
    expect(daysBetween('2026-04-01', '2026-03-31')).toBe(-1)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // spans the 23 h day
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2) // spans the 25 h day
    expect(daysBetween('2026-01-03', '2026-03-31')).toBe(87)
  })

  test('rejects a malformed day', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(RangeError)
  })
})
```

`bunx vitest run src/lib/time/stockholm.test.ts` → FAIL. Then in `stockholm.ts` change the date-fns import to
`import { addDays as addCalendarDays, differenceInCalendarDays, formatISO, startOfMonth } from 'date-fns'` and add,
after `addDays`:

```ts
/** Calendar days from `from` to `to` (negative when `to` is earlier); DST never shifts it. */
export function daysBetween(from: string, to: string): number {
  return differenceInCalendarDays(midnightOf(to), midnightOf(from), { in: inStockholm })
}
```

`bunx vitest run src/lib/time/stockholm.test.ts` → PASS.

- [ ] **Step 2: Write the failing sync test**

```ts
// src/lib/houseEnergy/sync.test.ts
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import {
  type EmaldoClient,
  type EmaldoDay,
  EmaldoError,
  type HouseBucket,
} from '~/lib/effects/emaldo'
import { createServerLogger } from '~/lib/logger/server'
import { listReadings, replaceDay } from '~/lib/services/houseEnergy'
import {
  beginAttempt,
  getHealth,
  getLastSuccessStartedAt,
  listRecentRuns,
} from '~/lib/services/integrationSync'
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import { insertSession } from '~test/fixtures/evCharging'
import { setupDatabase } from '~test/setup'
import { planEmaldoDays, runEmaldoSync } from './sync'

setupDatabase()

// 2026-04-01 12:00 local (CEST). Backfills from late March cross the
// 2026-03-29 spring-forward day (23 h).
const NOW = new Date('2026-04-01T10:00:00Z')
const TODAY = '2026-04-01'
const YESTERDAY = '2026-03-31'
const startOf = (day: string) => new Date(stockholmDayBounds(day).startMs)
const endOf = (day: string) => new Date(stockholmDayBounds(day).endMs)

// Synthetic values only — never real household readings (the repo is public).
const bucket = (bucketStart: Date, kwh = 0.05): HouseBucket => ({
  bucketStart,
  gridImportKwh: kwh,
  gridExportKwh: 0,
  solarKwh: 0.01,
  loadKwh: kwh,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
})

/** `n` buckets from the day's start, 5 min apart. */
function syntheticDay(day: string, n = 3, kwh?: number): EmaldoDay {
  const { startMs, endMs } = stockholmDayBounds(day)
  return {
    dayStart: new Date(startMs),
    dayEnd: new Date(endMs),
    buckets: Array.from({ length: n }, (_, i) => bucket(new Date(startMs + i * 300_000), kwh)),
    droppedBuckets: day === TODAY ? 1 : 0,
  }
}

// In-memory Emaldo: offset → day relative to TODAY, each day scriptable.
function fakeEmaldo(
  script: Record<string, (day: string) => EmaldoDay | Promise<EmaldoDay>> = {},
  onFetch?: () => void,
) {
  const requested: string[] = []
  const client: EmaldoClient = {
    async fetchDay(offset, o) {
      if (offset > 0) throw new RangeError(`offset ${offset}`)
      const day = addDays(TODAY, offset)
      requested.push(day)
      onFetch?.()
      if (o?.stats) {
        o.stats.requests += 4
        o.stats.fetchMs += 10
        o.stats.retries += 1
      }
      return (script[day] ?? ((d: string) => syntheticDay(d)))(day)
    },
  }
  return { client, requested }
}

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string })
  return { log, entries, raw: () => lines.join('') }
}

type RunExtra = {
  log?: ReturnType<typeof capturingLogger>['log']
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}
const run = (client: EmaldoClient, extra: RunExtra = {}) =>
  runEmaldoSync({
    trigger: 'cron',
    now: extra.now ?? (() => NOW),
    deps: {
      emaldo: client,
      log: extra.log ?? capturingLogger().log,
      sleep: extra.sleep ?? (async () => {}),
    },
  })

const countOn = async (day: string) =>
  (await listReadings({ from: startOf(day), to: endOf(day) })).length

/** A counted session on `day` (local evening), so the backfill starts 7 days earlier. */
const sessionOn = (day: string) =>
  insertSession({
    startAt: new Date(`${day}T16:00:00Z`),
    endAt: new Date(`${day}T18:00:00Z`),
  })

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('planEmaldoDays', () => {
  test('with no watermark and no sessions there is nothing to backfill', () => {
    expect(
      planEmaldoDays({ today: TODAY, watermarkDay: null, firstSessionDay: null, max: 30 }),
    ).toEqual({ today: TODAY, yesterday: YESTERDAY, start: YESTERDAY, backfill: [], backfillLeft: 0 })
  })

  test('starts 7 days before the first session and stops before yesterday', () => {
    const plan = planEmaldoDays({
      today: TODAY,
      watermarkDay: null,
      firstSessionDay: '2026-03-25',
      max: 30,
    })
    expect(plan.start).toBe('2026-03-18')
    expect(plan.backfill).toEqual(Array.from({ length: 13 }, (_, i) => addDays('2026-03-18', i)))
    expect(plan.backfillLeft).toBe(0)
  })

  test('the later of the watermark and the lead start wins', () => {
    expect(
      planEmaldoDays({ today: TODAY, watermarkDay: '2026-03-28', firstSessionDay: '2026-03-25', max: 30 })
        .backfill,
    ).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    expect(
      planEmaldoDays({ today: TODAY, watermarkDay: '2026-03-01', firstSessionDay: '2026-03-29', max: 30 })
        .start,
    ).toBe('2026-03-22')
  })

  test('caps the backfill and reports what is left', () => {
    const plan = planEmaldoDays({
      today: TODAY,
      watermarkDay: null,
      firstSessionDay: '2026-01-10',
      max: 30,
    })
    expect(plan.backfill).toHaveLength(30)
    expect(plan.backfill[0]).toBe('2026-01-03')
    expect(plan.backfillLeft).toBe(57)
  })

  test('a watermark at yesterday or later needs no backfill, and the start never passes today', () => {
    for (const watermarkDay of [YESTERDAY, TODAY, '2026-04-05']) {
      const plan = planEmaldoDays({ today: TODAY, watermarkDay, firstSessionDay: '2026-01-10', max: 30 })
      expect(plan.backfill).toEqual([])
      expect(plan.start <= TODAY).toBe(true)
    }
  })
})

test('with no sessions it fetches yesterday then today and moves the watermark to today', async () => {
  const { client, requested } = fakeEmaldo()

  const result = await run(client)

  expect(requested).toEqual([YESTERDAY, TODAY])
  expect(result).toMatchObject({
    source: 'emaldo',
    outcome: 'ok',
    code: null,
    daysFetched: 2,
    bucketsStored: 6,
    droppedBuckets: 1,
    emptyDays: 0,
    backfillDaysLeft: 0,
    earliestReplacedDay: YESTERDAY,
    syncedUntil: startOf(TODAY),
    requests: 8,
    retries: 2,
  })
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(TODAY))
  expect((await getHealth('emaldo', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('backfills from 7 days before the first counted session, oldest first, across the DST switch', async () => {
  await sessionOn('2026-03-25')
  // A noise session (under the counting threshold) earlier on doesn't move the start.
  await insertSession({
    startAt: new Date('2026-03-01T16:00:00Z'),
    endAt: new Date('2026-03-01T16:10:00Z'),
    energyKwh: 0.1,
  })
  const dst = '2026-03-29'
  const { client, requested } = fakeEmaldo({ [dst]: (d) => syntheticDay(d, 276) })

  const result = await run(client)

  expect(requested.slice(0, 2)).toEqual([YESTERDAY, TODAY])
  expect(requested.slice(2)).toEqual(Array.from({ length: 13 }, (_, i) => addDays('2026-03-18', i)))
  expect(result).toMatchObject({
    outcome: 'ok',
    daysFetched: 15,
    backfillDaysLeft: 0,
    earliestReplacedDay: '2026-03-18',
    since: startOf('2026-03-18'),
    syncedUntil: startOf(TODAY),
  })
  expect(await countOn(dst)).toBe(276)
})

test('a long backfill is capped at 30 days a run and continues from the watermark', async () => {
  await sessionOn('2026-01-10')
  const left: number[] = []
  const watermarks: (Date | null)[] = []
  for (let i = 0; i < 3; i++) {
    const { client, requested } = fakeEmaldo()
    const result = await run(client)
    left.push(result.backfillDaysLeft)
    watermarks.push(await getLastSuccessStartedAt('emaldo'))
    if (i === 1) expect(requested[2]).toBe('2026-02-02')
  }
  expect(left).toEqual([57, 27, 0])
  expect(watermarks).toEqual([startOf('2026-02-02'), startOf('2026-03-04'), startOf(TODAY)])

  // Caught up: the next run fetches only the two recent days.
  const done = fakeEmaldo()
  await run(done.client)
  expect(done.requested).toEqual([YESTERDAY, TODAY])
})

test('no new backfill day once the budget is used, and the watermark stays put', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  let clock = NOW.getTime()
  const { client, requested } = fakeEmaldo({}, () => {
    clock += 70_000
  })

  const result = await run(client, { now: () => new Date(clock) })

  // Yesterday and today took 140 s, past the 120 s budget: no backfill day starts.
  expect(requested).toEqual([YESTERDAY, TODAY])
  expect(result).toMatchObject({ outcome: 'ok', backfillDaysLeft: 7 })
  // Never "now": the backfill still starts where it would have.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-24'))
})

test('an empty backfill day keeps its stored readings and still counts as done', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const empty = '2026-03-26'
  await replaceDay(
    { dayStart: startOf(empty), dayEnd: endOf(empty) },
    syntheticDay(empty, 4).buckets,
  )
  const { client } = fakeEmaldo({ [empty]: (d) => syntheticDay(d, 0) })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', emptyDays: 1, syncedUntil: startOf(TODAY) })
  expect(await countOn(empty)).toBe(4)
})

test('an empty yesterday fails the run and keeps what was stored for it', async () => {
  await replaceDay(
    { dayStart: startOf(YESTERDAY), dayEnd: endOf(YESTERDAY) },
    syntheticDay(YESTERDAY, 5).buckets,
  )
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 0) })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', emptyDays: 1 })
  expect(await countOn(YESTERDAY)).toBe(5)
  expect(await countOn(TODAY)).toBe(3)
  // Only what is fully stored counts: up to the start of yesterday.
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf(YESTERDAY))
  const health = await getHealth('emaldo', { now: NOW, includeAdminDetail: true })
  expect(health.adminDetail?.lastErrorMessage).toContain(YESTERDAY)
})

test('a re-fetched day replaces its stored readings', async () => {
  await replaceDay(
    { dayStart: startOf(YESTERDAY), dayEnd: endOf(YESTERDAY) },
    syntheticDay(YESTERDAY, 5).buckets,
  )
  await run(fakeEmaldo().client)
  expect(await countOn(YESTERDAY)).toBe(3)
})

test('a day whose bounds are not the asked Stockholm day fails, storing nothing for it', async () => {
  const { client } = fakeEmaldo({ [YESTERDAY]: () => syntheticDay(TODAY) })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', bucketsStored: 0 })
  expect(await countOn(TODAY)).toBe(0)
  expect(await countOn(YESTERDAY)).toBe(0)
})

test('an old day with invalid readings is skipped and warned; the backfill goes on', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const bad = '2026-03-26'
  const cap = capturingLogger()
  const { client } = fakeEmaldo({ [bad]: (d) => syntheticDay(d, 3, -0.5) })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, syncedUntil: startOf(TODAY) })
  expect(await countOn(bad)).toBe(0)
  expect(await countOn('2026-03-27')).toBe(3)
  expect(cap.entries().some((e) => e.msg === 'emaldo day rejected' && e.day === bad)).toBe(true)
  expect(cap.raw()).not.toContain('-0.5')
})

test('invalid readings for yesterday fail the run', async () => {
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 3, -0.5) })
  expect(await run(client)).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
})

test('a remote failure is failed with its code and alerts admins on the first failure', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const client: EmaldoClient = {
    async fetchDay() {
      throw new EmaldoError('auth_failed', 'login', 401)
    },
  }

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'auth_failed', daysFetched: 0 })
  // A run that never got an answer plants no watermark.
  expect(await getLastSuccessStartedAt('emaldo')).toBeNull()
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({ source: 'emaldo', transition: 'started_failing', to: 'a@example.com' }),
  )
})

test('a failure part-way through the backfill keeps the stored days as the watermark', async () => {
  await sessionOn(YESTERDAY) // backfill 2026-03-24 … 2026-03-30
  const { client } = fakeEmaldo({
    '2026-03-27': () => {
      throw new EmaldoError('unreachable', 'stats', 503)
    },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
  expect(await getLastSuccessStartedAt('emaldo')).toEqual(startOf('2026-03-27'))

  // The next run resumes at the failed day.
  const next = fakeEmaldo()
  await run(next.client)
  expect(next.requested.slice(2)).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'])
})

test('a call that outlives the deadline fails as unreachable', async () => {
  const client: EmaldoClient = { fetchDay: () => new Promise<EmaldoDay>(() => {}) }
  const result = await runEmaldoSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 20,
    deps: { emaldo: client, log: capturingLogger().log, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('backfill pauses between days', async () => {
  await sessionOn(YESTERDAY) // 7 backfill days → 6 pauses
  const sleeps: number[] = []
  await run(fakeEmaldo().client, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  expect(sleeps).toHaveLength(6)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('one run row and one run line, with counts only — never readings', async () => {
  const cap = capturingLogger()
  const { client } = fakeEmaldo({ [YESTERDAY]: (d) => syntheticDay(d, 3, 0.123456) })

  await run(client, { log: cap.log })

  const [row] = await listRecentRuns('emaldo', { limit: 5 })
  // Zaptec-era columns: pages = days fetched, sessionsSeen/upserted = readings stored.
  expect(row).toMatchObject({ outcome: 'ok', pages: 2, sessionsSeen: 6, upserted: 6 })
  const lines = cap.entries().filter((e) => e.msg === 'integration sync run')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    source: 'emaldo',
    daysFetched: 2,
    bucketsStored: 6,
    earliestReplacedDay: YESTERDAY,
    requests: 8,
  })
  expect(cap.raw()).not.toContain('0.123456')
})

test('a held lease skips the run without calling Emaldo', async () => {
  await beginAttempt('emaldo', { now: NOW })
  const { client, requested } = fakeEmaldo()
  expect((await run(client)).outcome).toBe('skipped')
  expect(requested).toEqual([])
})

test('without credentials (the real facade under VITEST) the run is not_configured and alerts nobody', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const result = await runEmaldoSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  expect(publish).not.toHaveBeenCalled()
  expect(await getLastSuccessStartedAt('emaldo')).toBeNull()
})
```

- [ ] **Step 3: Run it, expect FAIL**

`bunx vitest run src/lib/houseEnergy/sync.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/lib/houseEnergy/sync.ts
import {
  type EmaldoCallStats,
  type EmaldoClient,
  EmaldoError,
  emaldo,
  newCallStats,
} from '~/lib/effects/emaldo'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import { earliestCountedStartAt } from '~/lib/services/evCharging'
import { HouseEnergyDomainError, replaceDay } from '~/lib/services/houseEnergy'
import { getLastSuccessStartedAt } from '~/lib/services/integrationSync'
import { addDays, daysBetween, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'

// Server-only (db, effects). Never import it from client code — and keep
// `src/lib/houseEnergy/` free of an index barrel, so the client-safe modules
// that step 3 adds beside it stay importable on their own.

/**
 * The Emaldo sync run (ADR-0019, ADR-0023), inside the shared `runPulledSync`
 * lifecycle: fetch yesterday and today, then backfill older days oldest first,
 * storing each answered Stockholm day whole. No reading ever reaches a log
 * line, an error message or a run row — only counts.
 *
 * Watermark (`run.syncedUntil` → `integration_sync.last_success_started_at`):
 * the end of the last fully stored day, a Stockholm midnight. Today is still
 * filling, so it never moves it.
 */
export type EmaldoSyncRun = RunBase & {
  source: 'emaldo'
  /** Days Emaldo answered (recent + backfill). */
  daysFetched: number
  /** Readings written (replaced days only). */
  bucketsStored: number
  /** Buckets the client dropped: partial series, outside the day, today's filling one. */
  droppedBuckets: number
  /** Answered days without readings; what's stored is kept. */
  emptyDays: number
  /** Old days whose readings failed validation; skipped and warned. */
  rejectedDays: number
  fetchMs: number
  storeMs: number
  requests: number
  /** Request retries inside the client's shared `fetchWithRetry`. */
  retries: number
  logins: number
  /** Backfill days still missing after this run. */
  backfillDaysLeft: number
  /** Earliest Stockholm day this run replaced; step 3 re-derives from it. */
  earliestReplacedDay: string | null
}

const SOURCE = 'emaldo'
/** The battery pool needs a week of history before the first session it prices (spec). */
const BACKFILL_LEAD_DAYS = 7
/** Backfill days per run; ≈ 260 days in prod spread over ≈ 9 hourly runs. */
const BACKFILL_DAYS_PER_RUN = 30
/** No new backfill day starts once the run is this old; the next run continues. */
const DAY_BUDGET_MS = 120_000
/** Pause between backfill days: four requests each to an unofficial API. */
const BACKFILL_PAUSE_MS = 1_000
/** Same 240 s budget as Zaptec and elpris: well under Vercel's 300 s limit. */
const RUN_DEADLINE_MS = 240_000

export type EmaldoDayPlan = {
  today: string
  yesterday: string
  /** The first day not yet fully stored; its start is the watermark floor. */
  start: string
  /** Days in [start, yesterday), oldest first, capped. */
  backfill: string[]
  /** Backfill days beyond the cap. */
  backfillLeft: number
}

/**
 * Pure: which days a run fetches besides yesterday and today. The backfill
 * starts at the later of the watermark's day and 7 days before the first
 * counted session (with neither, at yesterday: nothing to backfill). Sessions
 * imported later that start before an existing watermark are not backfilled.
 */
export function planEmaldoDays(a: {
  today: string
  watermarkDay: string | null
  firstSessionDay: string | null
  max: number
}): EmaldoDayPlan {
  const yesterday = addDays(a.today, -1)
  const lead = a.firstSessionDay ? addDays(a.firstSessionDay, -BACKFILL_LEAD_DAYS) : null
  const candidates = [a.watermarkDay, lead].filter((d): d is string => d !== null)
  let start = candidates.length > 0 ? candidates.reduce((x, y) => (x > y ? x : y)) : yesterday
  if (start > a.today) start = a.today
  const total = Math.max(0, daysBetween(start, yesterday))
  const count = Math.min(total, a.max)
  return {
    today: a.today,
    yesterday,
    start,
    backfill: Array.from({ length: count }, (_, i) => addDays(start, i)),
    backfillLeft: total - count,
  }
}

export async function runEmaldoSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s deadline (tests). */
  deadlineMs?: number
  deps?: { emaldo?: EmaldoClient; log?: Logger; sleep?: (ms: number) => Promise<void> }
}): Promise<EmaldoSyncRun> {
  const client = opts.deps?.emaldo ?? emaldo
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stats = newCallStats()
  return runPulledSync<EmaldoSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'emaldo'.
      source: SOURCE,
      daysFetched: 0,
      bucketsStored: 0,
      droppedBuckets: 0,
      emptyDays: 0,
      rejectedDays: 0,
      fetchMs: 0,
      storeMs: 0,
      requests: 0,
      retries: 0,
      logins: 0,
      backfillDaysLeft: 0,
      earliestReplacedDay: null,
    }),
    execute: ({ run, signal, now, log }) => syncDays(client, run, stats, { signal, now, sleep, log }),
    toRunStats: (run) => ({
      since: run.since,
      // Zaptec-era column names: pages = days fetched, sessionsSeen/upserted = readings stored.
      pages: run.daysFetched,
      sessionsSeen: run.bucketsStored,
      upserted: run.bucketsStored,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        storeMs: Math.round(run.storeMs),
        requests: stats.requests,
        retries: stats.retries,
        logins: stats.logins,
        daysFetched: run.daysFetched,
        droppedBuckets: run.droppedBuckets,
        emptyDays: run.emptyDays,
        rejectedDays: run.rejectedDays,
        backfillDaysLeft: run.backfillDaysLeft,
      },
    }),
    finalize: (run) => {
      run.fetchMs = Math.round(stats.fetchMs)
      run.storeMs = Math.round(run.storeMs)
      run.requests = stats.requests
      run.retries = stats.retries
      run.logins = stats.logins
    },
    logFields: (run) => ({
      fetchMs: run.fetchMs,
      storeMs: run.storeMs,
      requests: run.requests,
      retries: run.retries,
      logins: run.logins,
      daysFetched: run.daysFetched,
      bucketsStored: run.bucketsStored,
      droppedBuckets: run.droppedBuckets,
      emptyDays: run.emptyDays,
      rejectedDays: run.rejectedDays,
      backfillDaysLeft: run.backfillDaysLeft,
      earliestReplacedDay: run.earliestReplacedDay,
    }),
  })
}

type Ctx = {
  signal: AbortSignal
  now: () => Date
  sleep: (ms: number) => Promise<void>
  log: Logger
}

const startOf = (day: string) => new Date(stockholmDayBounds(day).startMs)
const endOf = (day: string) => new Date(stockholmDayBounds(day).endMs)

// Recent days first (they matter most, and a long backfill must never starve
// them), then the backfill oldest first. Mutates `run` as it goes, so a
// failure part-way still reports — and keeps — what landed.
async function syncDays(
  client: EmaldoClient,
  run: EmaldoSyncRun,
  stats: EmaldoCallStats,
  ctx: Ctx,
): Promise<void> {
  const { now, sleep } = ctx
  const today = stockholmDayOf(now().getTime())
  const watermark = await getLastSuccessStartedAt(SOURCE)
  const earliest = await earliestCountedStartAt()
  const plan = planEmaldoDays({
    today,
    watermarkDay: watermark ? stockholmDayOf(watermark.getTime()) : null,
    firstSessionDay: earliest ? stockholmDayOf(earliest.getTime()) : null,
    max: BACKFILL_DAYS_PER_RUN,
  })
  run.backfillDaysLeft = plan.backfill.length + plan.backfillLeft
  run.since = startOf(plan.backfill[0] ?? plan.yesterday)
  const sync = (day: string, recent: boolean) =>
    syncDay(client, run, stats, ctx, { day, today, recent })

  const yesterdayStored = await sync(plan.yesterday, true)
  // Emaldo answered, so the plan's start is safe as the watermark floor: every
  // day before it is stored or before the lead. Set only now, so a run that
  // never got an answer (not configured, auth) plants no watermark.
  run.syncedUntil = startOf(plan.start)
  await sync(plan.today, true)

  for (const [i, day] of plan.backfill.entries()) {
    if (now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS) break
    if (i > 0) await sleep(BACKFILL_PAUSE_MS)
    await sync(day, false)
    run.backfillDaysLeft--
    run.syncedUntil = endOf(day)
  }
  // Caught up, and yesterday is complete: the watermark moves past it.
  if (run.backfillDaysLeft === 0 && yesterdayStored) {
    const end = endOf(plan.yesterday)
    if (run.syncedUntil === null || end > run.syncedUntil) run.syncedUntil = end
  }
  // After the backfill, so its progress still lands. An old empty day is
  // normal (before the battery existed); an empty yesterday means data is
  // missing. Next day, yesterday becomes a backfill day and is retried.
  if (!yesterdayStored) {
    throw new EmaldoError('unexpected_response', 'stats', undefined, {
      message: `Emaldo returned no readings for ${plan.yesterday}`,
    })
  }
}

// Fetches and stores one Stockholm day; true when readings were written.
async function syncDay(
  client: EmaldoClient,
  run: EmaldoSyncRun,
  stats: EmaldoCallStats,
  ctx: Ctx,
  a: { day: string; today: string; recent: boolean },
): Promise<boolean> {
  const { signal, log } = ctx
  const offset = daysBetween(a.today, a.day)
  const fetched = await withDeadline(
    client.fetchDay(offset, { signal, stats }),
    signal,
    () =>
      new EmaldoError('unreachable', 'stats', undefined, {
        cause: { name: 'TimeoutError' },
        message: 'Emaldo stats did not finish within the sync deadline',
      }),
  )
  run.daysFetched++
  run.droppedBuckets += fetched.droppedBuckets
  const { startMs, endMs } = stockholmDayBounds(a.day)
  if (fetched.dayStart.getTime() !== startMs || fetched.dayEnd.getTime() !== endMs) {
    // Our "today" and Emaldo's disagree (a run straddling midnight), or the
    // client's bounds are off. Storing it would file readings under the wrong day.
    throw new EmaldoError('unexpected_response', 'stats', undefined, {
      message: `Emaldo answered offset ${offset} with another day than ${a.day}`,
    })
  }
  // An empty answer never deletes what's stored.
  if (fetched.buckets.length === 0) {
    run.emptyDays++
    return false
  }
  const started = performance.now()
  try {
    run.bucketsStored += await replaceDay(
      { dayStart: fetched.dayStart, dayEnd: fetched.dayEnd },
      fetched.buckets,
    )
  } catch (error) {
    if (!(error instanceof HouseEnergyDomainError)) throw error
    // Bad data from Emaldo is Emaldo's failure (`failed`, not `error`). One bad
    // old day must not wedge the backfill (as in the elpris sync); a bad
    // recent day fails the run so health shows it.
    if (a.recent) {
      throw new EmaldoError('unexpected_response', 'stats', undefined, {
        cause: error,
        message: `Emaldo readings for ${a.day} failed validation: ${error.message}`,
      })
    }
    run.rejectedDays++
    // The domain message names bucket indexes and fields, never values.
    log.warn('emaldo day rejected', { day: a.day, error })
    return false
  } finally {
    run.storeMs += performance.now() - started
  }
  if (run.earliestReplacedDay === null || a.day < run.earliestReplacedDay) {
    run.earliestReplacedDay = a.day
  }
  return true
}
```

If Task 0 found that a type isn't re-exported by `~/lib/effects/emaldo`, import it from
`~/lib/effects/emaldo/emaldo` here and in the test.

- [ ] **Step 5: Run, expect PASS**

```bash
bunx vitest run src/lib/houseEnergy/sync.test.ts src/lib/time/stockholm.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/time src/lib/houseEnergy
git commit -m "feat(charging): add the Emaldo readings sync run" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: hourly cron (handler, route, schedule) + docs

**Files:**
- Create: `src/lib/houseEnergy/emaldoSyncCron.ts`, `src/routes/api/cron/emaldo-sync.ts`
- Modify: `vite.config.ts` (crons + their comment), `src/routeTree.gen.ts` (regenerated, never hand-edited),
  `CLAUDE.md`, `.env.example`
- Test: `src/lib/houseEnergy/emaldoSyncCron.test.ts`

**Interfaces:**
- Consumes: `runEmaldoSync` (Task 4), `handleCronRun` (`~/lib/integrations/cron`).
- Produces: `handleEmaldoSyncCron(request: Request): Promise<Response>`; `GET /api/cron/emaldo-sync` → 401 without
  the secret, 200 `{ outcome, code, daysFetched, bucketsStored, backfillDaysLeft }`, 500 on an unexpected throw.

**Reviewers:** A = `code-reviewer`, B = security reviewer loading `better-auth-security-best-practices` (the cron
route is a permission boundary: `CRON_SECRET` gate, no reading in the response body).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/houseEnergy/emaldoSyncCron.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

const control = vi.hoisted(() => ({ throwFromSync: false, okRun: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runEmaldoSync: (opts: Parameters<typeof actual.runEmaldoSync>[0]) => {
      if (control.throwFromSync) return Promise.reject(new Error('sync exploded'))
      if (control.okRun)
        return Promise.resolve({
          outcome: 'ok',
          code: null,
          daysFetched: 32,
          bucketsStored: 9_000,
          backfillDaysLeft: 12,
        })
      return actual.runEmaldoSync(opts)
    },
  }
})

import { handleEmaldoSyncCron } from './emaldoSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/emaldo-sync', {
    headers: auth ? { authorization: auth } : {},
  })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  control.throwFromSync = false
  control.okRun = false
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('401 without the secret, or with a wrong one', async () => {
  expect((await handleEmaldoSyncCron(request())).status).toBe(401)
  expect((await handleEmaldoSyncCron(request('Bearer nope'))).status).toBe(401)
})

test('a not-configured run is still a 200 with its summary', async () => {
  const res = await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'failed',
    code: 'not_configured',
    daysFetched: 0,
    bucketsStored: 0,
    backfillDaysLeft: 0,
  })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})

test('an ok run is a 200 with its counts', async () => {
  control.okRun = true
  const res = await handleEmaldoSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'ok',
    code: null,
    daysFetched: 32,
    bucketsStored: 9_000,
    backfillDaysLeft: 12,
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

`bunx vitest run src/lib/houseEnergy/emaldoSyncCron.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/houseEnergy/emaldoSyncCron.ts
import { handleCronRun } from '~/lib/integrations/cron'
import { runEmaldoSync } from './sync'

// The hourly (:45) Emaldo cron entrypoint. Kept out of the route file so the
// flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`). The body carries counts only, never readings.
export function handleEmaldoSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runEmaldoSync({ trigger: 'cron', deps: { log } }),
    (run) => ({
      daysFetched: run.daysFetched,
      bucketsStored: run.bucketsStored,
      backfillDaysLeft: run.backfillDaysLeft,
    }),
  )
}
```

```ts
// src/routes/api/cron/emaldo-sync.ts
import { createFileRoute } from '@tanstack/react-router'
import { handleEmaldoSyncCron } from '~/lib/houseEnergy/emaldoSyncCron'

// Hourly (:45) Vercel Cron target (vite.config.ts `vercel.config.crons`). Auth
// is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside the
// `_authenticated` guard, like api/cron/zaptec-sync.ts.
export const Route = createFileRoute('/api/cron/emaldo-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleEmaldoSyncCron(request),
    },
  },
})
```

`vite.config.ts` — add to the crons comment, after the Škoda bullet:

```ts
              // - Emaldo house energy hourly at :45 — after Zaptec's :00, clear of Škoda's
              //   :07/:22/:37/:52 (src/lib/houseEnergy/emaldoSyncCron.ts).
```

and to `crons`, after the Škoda entry:

```ts
                { path: '/api/cron/emaldo-sync', schedule: '45 * * * *' },
```

Regenerate the route tree: `bun run build` (the TanStack router plugin rewrites `src/routeTree.gen.ts`; confirm
`grep -n "emaldo-sync" src/routeTree.gen.ts` finds it).

- [ ] **Step 4: Docs**

`CLAUDE.md` (code map only; keep each line's existing style):
- `api/cron/` line → `secret-gated cron entrypoints (zaptec-sync.ts hourly, skoda-sync.ts every 15 min (:07
  offset), emaldo-sync.ts hourly at :45, elpris-sync.ts 12:30+15:30 UTC, grid-tariff-catalogue.ts monthly)`.
- `db/` line: add `houseEnergy` to `schema/{…}` (after `vehicleState`).
- `services/` line: add `houseEnergy` (after `vehicleState`).
- New code-map line after `vehicleState/`:
  `    houseEnergy/                Emaldo house-energy readings sync (sync.ts: recent days + backfill, day watermark) + cron (ADR-0019, ADR-0023) — no index barrel`
- Step 1 already added the `EMALDO_*` env-var bullet and the `effects/` entry; leave them. Only if the env bullet
  doesn't mention the hourly sync, append "synced hourly at :45 by `/api/cron/emaldo-sync`" to it. If the Stack
  line's "Pulled integrations (…)" list still lacks Emaldo, add it.

`.env.example`:
- The `CRON_SECRET` comment's first line → `# Shared secret for Vercel Cron → /api/cron/* (the Zaptec, elpris, Škoda
  and Emaldo syncs and the grid-tariff check).`
- At the end of step 1's `EMALDO_*` comment block add (keep step 1's wording above it):
  ```
  # Synced hourly at :45 by /api/cron/emaldo-sync (5-minute readings into
  # house_energy_reading); the first runs backfill from a week before the first
  # charging session, 30 days a run. Vercel Production only: a login ends the
  # account's other sessions, so a Preview deploy would log prod out.
  ```

- [ ] **Step 5: Run, expect PASS**

```bash
bunx vitest run src/lib/houseEnergy/emaldoSyncCron.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/houseEnergy/emaldoSyncCron.ts src/lib/houseEnergy/emaldoSyncCron.test.ts \
  src/routes/api/cron/emaldo-sync.ts src/routeTree.gen.ts vite.config.ts CLAUDE.md .env.example
git commit -m "feat(charging): run the Emaldo sync hourly" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: admin `syncNow`, `syncStatus` and `recentRuns` take `emaldo`

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts:26-33` (`chargingSource`), `:268-300` (`syncNow`)
- Test: `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: `runEmaldoSync` (Task 4).
- Produces: `evCharging.syncNow({ source: 'emaldo' }) → { outcome, code, upserted }` (admin; `upserted` = readings
  stored), `syncStatus({ source: 'emaldo' })`, `recentRuns({ source: 'emaldo' })`; request timings
  `emaldoSyncMs`, `emaldoFetchMs`, `emaldoStoreMs`.

**Reviewers:** A = `code-reviewer`, B = security reviewer loading `better-auth-security-best-practices` (`syncNow` and
`recentRuns` stay `adminProcedure`; `syncStatus`'s `adminDetail` is still derived from the caller's role).

- [ ] **Step 1: Write the failing tests** (append to `evCharging.test.ts`)

```ts
test('syncNow with source emaldo runs only the house sync (not configured under VITEST)', async () => {
  await signIn('admin')
  const timings: Record<string, number> = {}
  const result = await call(
    evChargingRouter.syncNow,
    { source: 'emaldo' },
    { context: { ...baseContext(), timings } },
  )
  expect(result).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
  for (const key of ['emaldoSyncMs', 'emaldoFetchMs', 'emaldoStoreMs'])
    expect(typeof timings[key]).toBe('number')
  const zaptec = await integrationSyncService.getHealth('zaptec', {
    now: new Date(),
    includeAdminDetail: false,
  })
  expect(zaptec.state).toBe('never_synced')
})

test('syncNow with source emaldo is forbidden for a non-admin user', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.syncNow, { source: 'emaldo' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('syncStatus and recentRuns take emaldo', async () => {
  await signIn('admin')
  await call(evChargingRouter.syncNow, { source: 'emaldo' }, { context: baseContext() })
  const health = await call(
    evChargingRouter.syncStatus,
    { source: 'emaldo' },
    { context: baseContext() },
  )
  expect(health).toMatchObject({ source: 'emaldo', state: 'not_configured' })
  const runs = await call(
    evChargingRouter.recentRuns,
    { source: 'emaldo' },
    { context: baseContext() },
  )
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ trigger: 'admin', errorCode: 'not_configured' })
})
```

- [ ] **Step 2: Run, expect FAIL**

`bunx vitest run src/lib/orpc/procedures/evCharging.test.ts` → FAIL (input validation rejects `'emaldo'`).

- [ ] **Step 3: Implement** (`evCharging.ts`)

```ts
import { runEmaldoSync } from '~/lib/houseEnergy/sync'
```

```ts
/**
 * The sources the charging page tracks: sessions (Zaptec), spot prices
 * (elpris), the car's live state (Škoda) and the house's energy flows (Emaldo).
 */
const chargingSource = z.enum(['zaptec', 'elpris', 'skoda', 'emaldo'])
```

In `syncNow`, before the `skoda` branch:

```ts
    if (input?.source === 'emaldo') {
      const run = await runEmaldoSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.emaldoSyncMs = run.durationMs
        context.timings.emaldoFetchMs = run.fetchMs
        context.timings.emaldoStoreMs = run.storeMs
      }
      // Counts only: readings never leave the server (ADR-0023).
      return { outcome: run.outcome, code: run.code, upserted: run.bucketsStored }
    }
```

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/orpc/procedures/evCharging.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/orpc/procedures/evCharging.ts src/lib/orpc/procedures/evCharging.test.ts
git commit -m "feat(charging): let admins sync Emaldo on demand" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `/charging` — "Synka nu" includes Emaldo; its health alert and run history

**Files:**
- Modify: `src/components/evCharging/SyncNowButton.tsx`, `src/routes/_authenticated/charging/index.tsx`,
  `messages/{sv,en}.json`
- Test: `src/components/evCharging/SyncNowButton.browser.test.tsx`,
  `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` (seed the new queries)

**Interfaces:**
- Consumes: Task 6's procedures; Task 1's health copy.
- Produces: `useSyncNow().syncAll()` fires zaptec + elpris + emaldo in parallel; `syncSource('emaldo')`,
  `isPendingFor('emaldo')`.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Messages** (sv / en; beside `charging_sync_skoda_*`), then `bun run i18n:compile`

| key | sv | en |
|---|---|---|
| `charging_sync_house_ok` | Husets energidata är uppdaterad | The house's energy data is up to date |
| `charging_sync_house_failed` | Husets energidata kunde inte hämtas | The house's energy data couldn't be fetched |

- [ ] **Step 2: Failing browser tests** (`SyncNowButton.browser.test.tsx`)

Widen the helpers' source types to `'zaptec' | 'elpris' | 'skoda' | 'emaldo'` (`respond`'s parameter and
`mockImplementation`, `Harness`'s `only`). Update the two full-sync tests: in "sync all runs both sources…" rename it
to `'sync all runs sessions, prices and house energy, toasts the session result once and invalidates evCharging'`
and expect

```ts
  await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(3))
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([
    { source: 'zaptec' },
    { source: 'elpris' },
    { source: 'emaldo' },
  ])
```

and in "a full sync keeps a skipped price run silent" expect `toHaveBeenCalledTimes(3)`. Append:

```tsx
test('a failed house sync in a full sync gets its own error toast', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 2 },
    emaldo: { outcome: 'failed', code: 'unreachable', upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('unreachable', { source: 'emaldo' }),
    }),
  )
  expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_ok({ count: 2 }))
})

test('a full sync keeps an unconfigured Emaldo silent (its health alert says so)', async () => {
  respond({
    zaptec: { outcome: 'ok', code: null, upserted: 1 },
    emaldo: { outcome: 'failed', code: 'not_configured', upserted: 0 },
  })
  const { screen } = await renderWithProviders(<Harness />)
  await click(screen)
  await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledOnce())
  expect(toastMock.error).not.toHaveBeenCalled()
})

test('retrying Emaldo alone runs only emaldo and confirms success', async () => {
  respond({})
  const { screen } = await renderWithProviders(<Harness only="emaldo" />)
  await click(screen)
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_house_ok()))
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([{ source: 'emaldo' }])
})

test('an explicit Emaldo retry does report not_configured', async () => {
  respond({ emaldo: { outcome: 'failed', code: 'not_configured', upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness only="emaldo" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('not_configured', { source: 'emaldo' }),
    }),
  )
})

test('an Emaldo sync keeps the heading pending until it settles', async () => {
  let release: (r: Result) => void = () => {}
  syncFn.mockImplementation(
    () =>
      new Promise<Result>((resolve) => {
        release = resolve
      }),
  )
  function HouseHarness() {
    const { syncSource, isPending, isPendingFor } = useSyncNow()
    return (
      <>
        <button type="button" onClick={() => syncSource('emaldo')}>
          house
        </button>
        <output data-testid="state">{`${isPending}/${isPendingFor('emaldo')}`}</output>
      </>
    )
  }
  const { screen } = await renderWithProviders(<HouseHarness />)
  await screen.getByRole('button', { name: 'house' }).click()
  await expect.element(screen.getByTestId('state')).toHaveTextContent('true/true')
  release(OK)
  await expect.element(screen.getByTestId('state')).toHaveTextContent('false/false')
})
```

In `-vehicleScopePages.browser.test.tsx`, seed the new admin queries next to the Škoda ones (`seedShell`:
`syncStatus` with `{ source: 'emaldo' }` → `health('emaldo')`; `seedOverviewShell`: `recentRuns` with
`{ source: 'emaldo', limit: 20 }` → `[]`).

`bunx vitest run --project browser src/components/evCharging/SyncNowButton.browser.test.tsx` → FAIL.

- [ ] **Step 3: `useSyncNow`** (`SyncNowButton.tsx`)

`type SyncSource = 'zaptec' | 'elpris' | 'skoda' | 'emaldo'`. Extend the hook's header comment: "`syncAll` fires the
session, price and house-energy syncs in parallel … House energy, like prices, has two mutations: inside a full sync
only a real failure toasts (an unconfigured Emaldo stays quiet, its health alert already says so); an explicit
retry confirms either way." After the price mutations add:

```ts
  const houseToast = (result: SyncResult, announce: boolean) => {
    switch (result.outcome) {
      case 'ok':
        if (announce) toast.success(m.charging_sync_house_ok())
        return
      case 'skipped':
        if (announce) toast.info(m.charging_sync_skipped())
        return
      case 'failed':
      case 'error':
        // Unconfigured is a setup state, not news on every full sync.
        if (!announce && result.code === 'not_configured') return
        toast.error(m.charging_sync_house_failed(), {
          description: integrationErrorMessage(result.code ?? 'internal_error', {
            source: 'emaldo',
          }),
        })
        return
    }
  }
  const houseError = () =>
    toast.error(m.charging_sync_house_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'emaldo' }),
    })
  // Part of a full sync: only a failure is worth a toast.
  const house = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => houseToast(result, false),
      onError: houseError,
      onSettled: invalidate,
    }),
  )
  // An explicit retry: confirm the outcome either way.
  const houseRetry = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => houseToast(result, true),
      onError: houseError,
      onSettled: invalidate,
    }),
  )
```

Then: `const housePending = house.isPending || houseRetry.isPending`; `syncAll` adds
`house.mutate({ source: 'emaldo' })` after the price call (doc comment "Sessions, prices and house energy, in
parallel."); `syncSource` gets `case 'emaldo': return houseRetry.mutate({ source: 'emaldo' })`; `isPending` becomes
`sessions.isPending || pricesPending || housePending` (comment: "The heading button syncs everything but the car.");
`isPendingFor` gets `case 'emaldo': return housePending`.

- [ ] **Step 4: Route** (`charging/index.tsx`)

Next to the Škoda queries:

```ts
// The house's energy flows (Emaldo), admin-only like the car feed.
const emaldoHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'emaldo' } })
const emaldoRunsQuery = orpc.evCharging.recentRuns.queryOptions({
  input: { source: 'emaldo', limit: RECENT_RUNS },
})
```

Loader, after the Škoda prefetches (prefetched: a failed read must not take the page down):

```ts
      user.role === 'admin' ? queryClient.prefetchQuery(emaldoHealthQuery) : null,
      user.role === 'admin' ? queryClient.prefetchQuery(emaldoRunsQuery) : null,
```

Component, after `skodaRuns`:

```ts
  const { data: emaldoHealth } = useQuery({ ...emaldoHealthQuery, enabled: isAdmin })
  const { data: emaldoRuns } = useQuery({ ...emaldoRunsQuery, enabled: isAdmin })
```

JSX, after the `CredentialExpiryAlert` block:

```tsx
      {/* Admin-only like the car feed: members can't act on it, and nothing on
          the page uses the house data yet (ADR-0023, step 4). */}
      {isAdmin && emaldoHealth ? (
        <SyncHealthAlert
          health={emaldoHealth}
          isAdmin
          onRetry={() => syncNow.syncSource('emaldo')}
          retrying={syncNow.isPendingFor('emaldo')}
        />
      ) : null}
```

and after the Škoda run card:

```tsx
      {isAdmin && emaldoRuns ? <RecentRunsCard source="emaldo" runs={emaldoRuns} /> : null}
```

- [ ] **Step 5: Run, expect PASS**

```bash
bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/components/evCharging src/routes/_authenticated/charging messages/sv.json messages/en.json
git commit -m "feat(charging): show Emaldo health and runs on the charging page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Branch review (feature-workflow Phase 5)

**Reviewers:** the gates below, dispatched in parallel, each told to assume the branch is wrong and off-spec.

- [ ] **Step 1: Gates that apply** (`git diff origin/main...HEAD`)
  - Schema/`drizzle/` changed → `migration-guard` **and** the schema-design reviewer (`general-purpose` loading
    `supabase-postgres-best-practices`) on `0013_house_energy_reading.sql`: every finding fixed or ruled on
    (Non-negotiable). Already approved in Task 2: re-run only if the schema changed since.
  - Services/effects/`errors.ts` changed → `test-completeness` (both `HouseEnergyDomainError` codes exercised;
    `runEmaldoSync`'s failure paths covered).
  - Always → `code-reviewer` (ADR-0001/0002/0003/0019/0023 adherence) plus a correctness pass over the watermark
    logic in `src/lib/houseEnergy/sync.ts` against Review Focus 1–3.
  - Permission boundaries (cron route, `adminProcedure`s) and privacy → a security pass (`/security-review`), with
    an explicit check that no reading value can reach a log line, error message, run row, cron body or RPC
    response, and that no file under `data/private/` is staged (`git diff origin/main...HEAD --stat | grep -i
    private` → nothing).
- [ ] **Step 2:** Fix every confirmed finding in this branch (one hat per commit, e.g.
  `fix(charging): <what>`), or write down why it is dismissed. Re-run the affected tests.

---

### Task 9: Pre-PR gate + live verification

- [ ] **Step 1: Pre-PR gate** (from `docs/feature-workflow.md`)

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

- [ ] **Step 2: Live run against the real Emaldo** (needs the four `EMALDO_*` in the worktree's `.env.local`, as
  used at checkpoint 1; never print them). A local login ends prod's Emaldo session if prod is already configured;
  prod's client re-logs in once on its next run, which is fine.

```bash
bun run dev:up      # db + queue + mail + storage, migrates
bun run dev         # :14600
```

  - Sign in as an admin, open `/charging`, press **Synka nu**: no Emaldo error toast; after it settles, no Emaldo
    health alert (state `ok`), and the "Senaste körningar – Emaldo" card shows an OK row with a non-zero
    "Uppdaterade" count. Press it a few times until the local backfill is done (30 days a click).
  - The cron route: `curl -s -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" http://localhost:14600/api/cron/emaldo-sync`
    → 200 with `outcome`, `daysFetched`, `bucketsStored`, `backfillDaysLeft`; without the header → 401.
  - The server log's `integration sync run` line for `source: "emaldo"` has counts only.
  - Run checkpoint 2's balance query (Task 11) against the local DB
    (`docker compose exec -T db psql -U videbacken -d videbacken`): within ≈ 2 % on full days. Don't paste the
    figures anywhere public.
- [ ] **Step 3: Responsive check** of `/charging` as admin at 360, 820 and 1600 px wide (the new alert and run card
  wrap, no horizontal scroll), e.g. with `claude-in-chrome` (`resize_window`). Force the alert by stopping the
  sync with an unset `EMALDO_USER` if it is `ok`.

---

### Task 10: Roadmap row + PR

- [ ] **Step 1:** In `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, row 2: PR column = the PR
  link (fill after Step 2 and amend in a follow-up commit, or push the row with `PR open` and edit the link in), status
  `PR open`. Commit `docs(charging): mark solar-cost step 2 as PR open`.
- [ ] **Step 2:** Push and open the PR with `.github/PULL_REQUEST_TEMPLATE.md`:
  - **Title:** `feat(charging): sync house energy readings from Emaldo`
  - **Why:** step 2 of the solar-aware cost roadmap (ADR-0023): raw 5-minute house energy flows, health-tracked,
    as the input for step 3's mix. Nothing reads them yet.
  - **What changed:** `emaldo` source + migration 0013 (`house_energy_reading`, source CHECKs); `houseEnergy`
    service; `runEmaldoSync` (recent days + 30-day backfill, day watermark); `:45` cron; "Synka nu" + admin health
    alert + run card.
  - **Verification:** paste the gate output summary and the live checks (no real readings).
  - **Risks / follow-ups:** after merge the owner sets the four `EMALDO_*` in Vercel **Production only** and
    redeploys; the backfill takes ≈ 9 hourly runs; `battery_charge_ac` semantics are settled at checkpoint 2.
  - Body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 11: STOP — checkpoint 2 (for the owner / the next session)

Do not start step 3 in this session. After the PR is merged and deployed, the owner sets `EMALDO_USER`,
`EMALDO_PASSWORD`, `EMALDO_APP_ID`, `EMALDO_APP_SECRET` in Vercel **Production** and redeploys (or waits for the next
deploy). Roadmap row 2 → `merged`. Then checkpoint 2 runs (copied from the roadmap):

> **After step 2 (prod).**
> - Backfill complete: the watermark has reached yesterday.
> - Emaldo health is `ok`, and Vercel's Cron Jobs list shows `/api/cron/emaldo-sync`.
> - A read-only SELECT on prod shows the daily energy balance within ≈2 % for a handful of real days.
> - `battery_charge_ac`'s meaning is settled from real data, recorded in the spec.

How to run it. Read-only `SELECT`s only, in the Supabase SQL editor for the prod project (or the Supabase MCP
`execute_sql`). **Never paste the result rows into GitHub or any committed file** (the repo is public): record only
the conclusions and the error percentages.

**1. Watermark and health.** Passes when `watermark_day` is today (Stockholm) — the watermark is the end of
yesterday — and `error_code` is null. Also check `/charging` as admin (no Emaldo alert) and Vercel → Project →
Settings → Cron Jobs lists `/api/cron/emaldo-sync` at `45 * * * *`.

```sql
SELECT source,
       last_success_at,
       last_success_started_at AS watermark,
       (last_success_started_at AT TIME ZONE 'Europe/Stockholm')::date AS watermark_day,
       error_code,
       consecutive_failures
FROM integration_sync
WHERE source = 'emaldo';
```

**2. Coverage.** Days with fewer buckets than the day has 5-minute slots (gaps; today is always short). A handful
of short days is normal (the probe saw a 95-minute hole); many, or whole missing days, need a look.

```sql
SELECT (bucket_start AT TIME ZONE 'Europe/Stockholm')::date AS day,
       count(*) AS buckets,
       min(bucket_start) AS first_bucket
FROM house_energy_reading
GROUP BY 1
HAVING count(*) < 288
ORDER BY 1;
-- 276 on the spring-forward day and 300 on the fall-back day are complete.
SELECT min(bucket_start), max(bucket_start), count(*) FROM house_energy_reading;
```

**3. Daily energy balance** (supply = use) for the last 14 full days, computed two ways: counting `charge_ac` as a
separate battery inflow, and not counting it. Passes when one column is within ≈ ±2 % on most full days (the probe
saw ≈ 1.4 %). Which column fits is the first evidence for `charge_ac` (step 4 below).

```sql
WITH d AS (
  SELECT (bucket_start AT TIME ZONE 'Europe/Stockholm')::date AS day,
         count(*) AS buckets,
         sum(grid_import_kwh) AS import,
         sum(solar_kwh) AS solar,
         sum(battery_discharge_kwh) AS discharge,
         sum(load_kwh) AS load,
         sum(grid_export_kwh) AS export,
         sum(battery_charge_solar_kwh) AS ch_solar,
         sum(battery_charge_grid_kwh) AS ch_grid,
         sum(battery_charge_ac_kwh) AS ch_ac
  FROM house_energy_reading
  WHERE bucket_start >= (date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') - interval '14 days')
                          AT TIME ZONE 'Europe/Stockholm'
    AND bucket_start <  date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm'
  GROUP BY 1
)
SELECT day,
       buckets,
       round((100 * (import + solar + discharge - (load + export + ch_solar + ch_grid + ch_ac))
              / nullif(load + export + ch_solar + ch_grid + ch_ac, 0))::numeric, 2) AS err_pct_with_ac,
       round((100 * (import + solar + discharge - (load + export + ch_solar + ch_grid))
              / nullif(load + export + ch_solar + ch_grid, 0))::numeric, 2) AS err_pct_without_ac
FROM d
ORDER BY day;
```

**4. What `battery_charge_ac` is.** Monthly totals of the battery's inflows against solar and import, and whether
`charge_ac` ever runs with no solar at all.

```sql
SELECT to_char(bucket_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM') AS month,
       round(sum(solar_kwh)::numeric, 1) AS solar,
       round(sum(grid_import_kwh)::numeric, 1) AS import,
       round(sum(battery_charge_solar_kwh)::numeric, 1) AS charge_solar,
       round(sum(battery_charge_grid_kwh)::numeric, 1) AS charge_grid,
       round(sum(battery_charge_ac_kwh)::numeric, 1) AS charge_ac,
       count(*) FILTER (WHERE battery_charge_ac_kwh > 0) AS ac_buckets,
       count(*) FILTER (WHERE battery_charge_ac_kwh > 0 AND solar_kwh = 0) AS ac_buckets_no_solar,
       round(coalesce(sum(battery_charge_ac_kwh) FILTER (WHERE solar_kwh = 0), 0)::numeric, 2) AS ac_kwh_no_solar,
       count(*) FILTER (WHERE battery_charge_ac_kwh > 0 AND grid_import_kwh = 0) AS ac_buckets_no_import,
       count(*) FILTER (WHERE battery_charge_ac_kwh > 0 AND battery_charge_grid_kwh > 0) AS ac_with_grid_buckets
FROM house_energy_reading
GROUP BY 1
ORDER BY 1;

-- Is charge_ac a copy of charge_grid? (equal ≈ both_nonzero means yes)
SELECT count(*) AS both_nonzero,
       count(*) FILTER (WHERE abs(battery_charge_ac_kwh - battery_charge_grid_kwh) < 0.001) AS equal
FROM house_energy_reading
WHERE battery_charge_ac_kwh > 0 AND battery_charge_grid_kwh > 0;
```

Reading it:
- `charge_ac` ≈ 0 in every month → unused on this installation; record that, the grid-origin default is moot.
- `ac_buckets_no_solar` > 0 with real kWh (`ac_kwh_no_solar`), e.g. at night → it can only be grid energy: keep the
  spec's **grid-origin** default.
- `charge_ac` > 0 only while `solar_kwh` > 0 and mostly in `ac_buckets_no_import` → AC-coupled solar (e.g. the
  third-party inverter): **solar-origin**. Step 3's `supply.ts`/`pool.ts` must then count it as a solar inflow:
  amend the spec ("Derivation", supply and pool bullets) and ADR-0023 before step 3 starts.
- `equal` ≈ `both_nonzero`, and the balance fits `err_pct_without_ac` → a duplicate of `charge_grid`: step 3 must
  not add it twice; amend the spec's grid → house formula (`import − charge_grid − charge_ac`) accordingly.

Record the result in a small `docs(charging): record checkpoint 2` PR: roadmap row 2 → `checkpoint passed` with a
one-line result (e.g. "backfill to 2026-01-20, balance ±1.5 %, charge_ac = grid-origin"), the `battery_charge_ac`
conclusion in the spec's "Sync (roadmap step 2)" section (replacing "Until then it's treated as grid-origin"), and
an ADR-0023 note if the meaning changes the derivation. Only then does step 3 start, in a new session.
