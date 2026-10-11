# Heat pumps, step 1b: sync live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comfort Cloud becomes the fifth pulled source: credentials settable in Datakällor, a 6-hourly cron that
re-fetches the recent UTC days of every heat pump and backfills each unit back to its `registered_on`, health-tracked
with alerts, a Datakällor tile and "Synka nu". Nothing reads the readings yet (step 2 does).

**Architecture:** `comfortCloud` joins `INTEGRATION_SOURCES` and `CREDENTIAL_SOURCES` (one CHECK migration). The
step-1a client gets its facade (`keyedAdapter`, fail-closed `notConfigured`). The orchestrator
`src/lib/heatPump/sync.ts` runs inside the shared `runPulledSync` lifecycle (lease, deadline, progress, health, one
`integration sync run` line, alert on a streak edge): `units()` → `upsertUnits`; the recent UTC days of every unit
(today + 2, widened back to the last successful run's day, ≤ 14 days) → `dayHours` → `replaceDay`; then, per unit
without `history_complete_at`, a newest-first walk from the day before its oldest stored day, one `monthDays` call per
month to skip empty days, ≤ 60 days per unit per run and no new day after 120 s, until the walk passes `registered_on`
→ `markHistoryComplete`. A `20 */6 * * *` cron and the admin `evCharging.syncNow({ source: 'comfortCloud' })` run it.
One PR.

**Tech Stack:** TanStack Start, oRPC, Drizzle 0.45 (`pg`), zod 4, Paraglide, TanStack Query, lucide-react, Tailwind v4,
Vitest (node + browser), bun.

**Spec:** `docs/superpowers/specs/2026-10-08-heat-pumps-design.md` ("Source and adapter" → Credentials, "Schema" (the
source CHECK paragraph), "Sync (step 1b)", "Per-source wiring", "Error handling and edge cases", "Testing" → Sync) ·
**ADR:** `docs/adr/0027-heat-pump-energy-data.md` · **Roadmap:** `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`,
row 1b + checkpoint 2.

**Branch / PR:** `feat/heat-pumps-sync` → PR `feat(heat-pumps): sync heat pump readings from Comfort Cloud`.

## Decisions (ruled by the coordinator 2026-10-08; list them in the PR)

All additive to the brief's 1b contract; nothing in 1a's contract is renamed or retyped. The coordinator amends the
spec and ADR-0027 for decisions 1, 6 and 9 on the docs branch (Task 0 checks they're on main); this PR amends docs
only for something that changes during the build.

1. **Catch-up window.** Besides today + 2 previous days, the recent window reaches back to the UTC day the last
   successful run started (`integration_sync.last_success_started_at`, which `runPulledSync` already writes), capped at
   14 days, so an outage leaves no hole (the backfill only walks *below* the oldest stored day). Beyond the cap the run
   warns `comfort cloud catch-up capped` with the skipped day count. Steady state is unchanged (3 days). Exported as the
   pure `recentDays(today, lastSuccessStartedAt)`.
2. **A 500 ms pause between backfill day calls** (`deps.sleep`, injectable), like Emaldo's polite pause: the
   unofficial API runs on the owner's own account.
3. **Zero units listed fails the run** (`unexpected_response`, op `units`): an empty list from a changed API must not
   read as a green sync.
4. **An empty answer never deletes stored hours** (Emaldo's rule): an empty `dayHours` counts `emptyDays` and skips
   `replaceDay`. A rejected day (`HeatPumpDomainError` `INVALID_READING`) counts `rejectedDays`, is warned with the
   unit name, day and code only, and never fails the run (spec: "a bad row fails the day, not the run").
5. **Run counters** beyond the spec's list: `monthsFetched`, `emptyDays`, `unitsCompleted`, `storeMs`, plus 1a's call
   stats (`fetchMs`, `requests`, `retries`, `logins` from `newCallStats()`, passed to every client call with the
   run's `signal`). Exports besides `runComfortCloudSync`: the pure `recentDays`, `backfillCandidates`.
6. **Cron handler file name** is `src/lib/heatPump/comfortCloudSyncCron.ts` (`handleComfortCloudSyncCron`).
7. **"Synka nu" scope.** The tile's sync and each alert's retry run Comfort Cloud alone; the settings page heading's
   "Synka nu" (`syncAll`: sessions, prices, house energy) does **not** include it — a backfill run can take minutes and
   the charging pages don't use heat pump data. The existing test pinning `syncAll`'s three calls stays as is. A
   successful Comfort Cloud sync also invalidates the `energy` and `heatPump` query keys (Task 6).
8. **Datakällor layout:** the fifth tile wraps onto a second row of the existing `@4xl:grid-cols-4` grid (no grid
   change); verified live at 1440 / 820 / 390 px.
9. **`suspect_fields` CHECK unchanged** (`user` and `password` already exist in `CREDENTIAL_FIELD_NAMES`).
10. **Offline rule.** A unit whose most recent complete UTC day (yesterday) answers no hours fails the run
    (`unexpected_response`, the message names the unit) as long as the unit's newest stored hour is within the last
    14 days (`now − newest ≤ 14 days`); with no data for longer (or none at all) it only warns
    `comfort cloud unit without data` each run. So an outage keeps the source failing until data returns (no false
    "recovered" email), and a removed unit stops alerting after two weeks. A unit registered after yesterday has no
    yesterday and is exempt. Needs the unit's newest stored hour: `heatPump.newestHour(id)` (added in Task 4 unless 1a
    has it).
11. **A `registered_on` that moves earlier reopens the backfill.** Step 1a's `setRegisteredOn` clears
    `history_complete_at` when the day moves earlier; the sync mirrors that in memory and backfills the unit in the
    same run.
12. **Tone and icon:** `AirVentIcon` (lucide `air-vent`); `--source-comfort-cloud` light `oklch(0.62 0.19 310)`
    (`#a95dda`), dark `oklch(0.64 0.18 315)` (`#b464d6`). Computed during planning against the four existing tones:
    icon on its own wash 3.47:1 (light, /12 on white) and 3.60:1 (dark, /20 on `--card`); worst OKLab ΔE×100 vs the
    others 21.9 / 20.1 under normal vision and 9.9 / 10.6 under simulated protan/deutan (the existing palette's own
    worst pair, Škoda ↔ elpris, is 12.3 normal). Task 1 Step 5 re-runs the check.

## Global Constraints

- All DB access through `src/lib/services/<entity>/` (ADR-0002). The sync calls only the step-1a `heatPump` service and
  `integrationSync`; tests may read tables directly.
- Never `console.*`; server code logs via `~/lib/logger/server` (`logger`) or the injected `log` (ADR-0003).
- **Hourly readings are private** (ADR-0027 decision 6: they tell when someone is home): never in a log line, an error
  message, a run row, the run line, the cron body or an RPC response — counts only. Unit guids are never logged in full
  (use the unit's name). Fixtures are synthetic (`CS-HZ25ZKE+0000000001`, kWh like `0.03`), never real consumption.
- Comfort Cloud is a pulled source: **no devLog/fake adapter**. `PANASONIC_USER` or `PANASONIC_PASSWORD` unset (and no
  stored value), or `VITEST=true` → every call fails `not_configured`; an undecryptable stored row →
  `credentials_unreadable`.
- `CREDENTIAL_FIELDS.comfortCloud = ['user', 'password']` (both secret, both required);
  `CREDENTIAL_ENV_VARS.comfortCloud = { user: 'PANASONIC_USER', password: 'PANASONIC_PASSWORD' }`.
- Policy: `STALE_AFTER_MS.comfortCloud = 13 h` (two missed runs), `ALERT_AFTER_FAILURES.comfortCloud = 2`.
- Cron `{ path: '/api/cron/comfort-cloud-sync', schedule: '20 */6 * * *' }`, `CRON_SECRET`-gated via `handleCronRun`.
- Every request is a UTC day (`osTimezone '+00:00'` is the client's job, step 1a). The sync works in UTC calendar days
  (`YYYY-MM-DD`), never Stockholm days.
- Per run: recent days for every unit (always, no budget check); backfill ≤ **60** day calls per unit, no new backfill
  call once the run is **120 s** old, **500 ms** between backfill day calls, run deadline **240 s**.
- A unit whose **yesterday** (UTC) answers no hours fails the run (`unexpected_response`, naming the unit) while its
  newest stored hour is ≤ 14 days old; older (or none) → a warning only. Checked after the rest of the run has landed.
- Client code imports only **types** from services. User-facing text in `messages/sv.json` (source of truth) and
  `messages/en.json` (key-complete); run `bun run i18n:compile` after editing them. "Comfort Cloud" is a brand name,
  identical in both.
- **Migrations are frozen once pushed.** `bun run db:generate --name=comfort_cloud_source`; `migration-guard` +
  schema-design approval before the first push; never hand-edit `drizzle/meta/`. Every Vercel deploy migrates prod.
- `PANASONIC_*` go in Vercel **Production only** (roadmap prerequisites), or are entered in Datakällor after deploy.
- Conventional Commits, subject ≤ 72 chars, one hat per commit; end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB (`bun run db:up && bun run db:migrate`). Never run two vitest processes at once (shared local
  DB); reviewers must not run vitest while the implementer does. One-shot browser tests:
  `bunx vitest run --project browser <path>`.

## Review Focus

1. **An outage longer than two days must not leave a permanent hole.** After 5 days without a successful run, the next
   run re-fetches every missed day → Task 4 test "after a five-day outage the next run re-fetches every missed day"
   (+ the pure `recentDays` cases, including the 14-day cap).
2. **An empty answer must never wipe stored hours.** A recent day that comes back empty keeps what is stored → Task 4
   test "an empty recent day keeps its stored hours".
3. **A bad or empty backfill day must not wedge the backfill.** The walk continues past a rejected or empty day and
   still reaches `registered_on` → Task 4 tests "a rejected backfill day is skipped, warned without values, and the walk
   still completes" and "a listed day that answers no hours is skipped and the walk still completes".
4. **A changed API or a quiet unit must not read as healthy — and a removed unit must not alert forever.** No units
   listed fails the run; a unit that went quiet yesterday fails it (the other unit's data and backfill still land) and
   keeps failing on the following days; at exactly 14 days without data it still fails, an hour later it only warns →
   Task 4 tests "no units listed fails the run as unexpected_response", "yesterday empty fails the run, after the rest
   has landed", "an outage keeps the run failing until data returns", "the newest hour exactly 14 days old still fails
   the run" and "data older than 14 days only warns, every run".
5. **Readings never leak.** The run row, the run line, the cron body and `syncNow` carry counts only → Task 4 test "one
   run row and one run line, counts only, never an hourly value"; Task 5 tests "an ok run is a 200 with its counts" and
   "syncNow with source comfortCloud … returns counts only".

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/integrationHealth.ts` | modify | `comfortCloud` in `INTEGRATION_SOURCES` |
| `src/lib/integrationCredentials.ts` | modify | `comfortCloud` source, fields, env var names |
| `src/lib/services/integrationSync/policy.ts` | modify | stale 13 h, alert after 2 |
| `src/lib/integrationHealthMessage.ts` | modify | source name; auth_failed + unexpected_response copy |
| `src/lib/integrationCredentialsMessage.ts` | modify | field labels + hints |
| `src/lib/orpc/procedures/credentials.ts` | modify | `setCredentialsInput` branch |
| `src/components/evCharging/SyncHealthAlert.tsx` | modify | never-synced + stale copy |
| `src/components/evCharging/syncSourceCopy.ts` | modify | role + cadence copy |
| `src/components/evCharging/SyncSourceMark.tsx`, `src/styles/app.css` | modify | icon + `--source-comfort-cloud` |
| `src/components/evCharging/SyncNowButton.tsx` | modify | `SyncSource = IntegrationSource`; Task 1 compile-only case, Task 6 the mutation |
| `drizzle/00NN_comfort_cloud_source.sql` + meta | generate | the three source CHECKs |
| `src/lib/db/comfortCloudSourceSchema.test.ts` | create | CHECKs accept `comfortCloud`, still reject others |
| `src/lib/effects/comfortCloud/comfortCloud.ts` | modify | `selectComfortCloudAdapter`, `comfortCloud` facade |
| `src/lib/effects/comfortCloud/adapters/notConfigured.ts` | create | fail-closed client |
| `src/lib/effects/comfortCloud/index.ts`, `src/lib/effects/index.ts` | modify | exports |
| `src/lib/effects/comfortCloud/facade.test.ts` | create | selection, fail-closed, keyed rebuild |
| `src/lib/services/heatPump/heatPump.ts` (+ test) | modify | `newestHour(id)` (unless 1a has it) |
| `src/lib/heatPump/sync.ts` | create | `runComfortCloudSync`, `recentDays`, `backfillCandidates` |
| `src/lib/heatPump/sync.test.ts` | create | the sync's behaviour |
| `src/lib/heatPump/comfortCloudSyncCron.ts` (+ test) | create | cron handler |
| `src/routes/api/cron/comfort-cloud-sync.ts`, `src/routeTree.gen.ts` | create / regenerate | cron route |
| `vite.config.ts` | modify | cron + comment |
| `src/lib/orpc/procedures/evCharging.ts` | modify | `chargingSource` + `syncNow` branch |
| `src/routes/_authenticated/charging/settings.tsx` | modify | Datakällor entry |
| `src/bones/charging-sources.bones.json` | regenerate | the panel grew a tile |
| `messages/{sv,en}.json` | modify | new keys; panel description |
| tests listed per task | modify | source lists and fixtures |
| `CLAUDE.md`, `.env.example` | modify | env vars, code map, cron list |
| roadmap (+ spec/ADR only for a decision changed during the build) | modify | row 1b |

---

### Task 0: Verify `main` matches this plan

**Files:** none (read-only), except this plan if something differs.
**Reviewers:** none (a check, not a deliverable).

- [ ] **Step 1: Fresh worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken
git fetch origin
git worktree add ../videbacken-heat-pumps-sync -b feat/heat-pumps-sync origin/main
cd ../videbacken-heat-pumps-sync
cp ../videbacken/.env .env                       # gitignored; never print it
cp ../videbacken/.env.local .env.local 2>/dev/null || true
bun install
grep '^DATABASE_URL' .env.local | grep -vc localhost   # must print 0 (CLAUDE.md gotcha)
grep -c '^PANASONIC_USER=.\+' .env.local              # 1: the live check in Task 7 needs it (never print it)
```

- [ ] **Step 2: Step 1a merged, its checkpoint passed, this plan on main**

```bash
git log --oneline origin/main | grep -i "heat-pump\|comfort" | head
grep -n '^| 1a ' docs/superpowers/roadmaps/2026-10-08-heat-pumps.md   # status: checkpoint passed
ls docs/superpowers/plans/2026-10-08-heat-pumps-1b-sync.md
```

If row 1a isn't `checkpoint passed`, STOP: run checkpoint 1 first (roadmap, "How a session runs a step").

- [ ] **Step 3: The step-1a effect is as the brief's contract says**

```bash
cat src/lib/effects/comfortCloud/index.ts
grep -n "export type ComfortCloudUnit\|export type ComfortCloudHour\|export type ComfortCloudDay\|export type ComfortCloudHistory\|export interface ComfortCloudClient" src/lib/effects/comfortCloud/comfortCloud.ts
grep -n "units()\|dayHours(\|monthDays(" src/lib/effects/comfortCloud/comfortCloud.ts
grep -n "export function createComfortCloudClient" src/lib/effects/comfortCloud/client.ts
grep -n "class ComfortCloudError\|readonly op\|name = \|suspectFields" src/lib/effects/comfortCloud/errors.ts
grep -n "keyedAdapter\|export const comfortCloud" src/lib/effects/comfortCloud/comfortCloud.ts   # expect NOTHING yet
ls src/lib/effects/comfortCloud/adapters 2>/dev/null                                            # expect nothing yet
grep -n "deviceRegisterTime\|registeredOn\|temperatureUnit" src/lib/effects/comfortCloud/parse.ts | head
grep -n "export interface ComfortCloudCallStats\|export function newCallStats\|signal?\|stats?" src/lib/effects/comfortCloud/comfortCloud.ts
```

Expect:
- The types and `ComfortCloudClient` as the brief, plus 1a's optional call options (mirroring Emaldo):
  `units(o?)`, `dayHours(guid, utcDay, o?)`, `monthDays(guid, utcMonth, o?)` with `o: { signal?: AbortSignal;
  stats?: ComfortCloudCallStats }`, and `ComfortCloudCallStats` = `{ fetchMs, requests, retries, logins }` with
  `newCallStats()`. Each history is `{ registeredOn: 'YYYY-MM-DD'; rows }`. All exported from the barrel together with
  `createComfortCloudClient` and `ComfortCloudError`. A type missing from the barrel → import it from
  `~/lib/effects/comfortCloud/comfortCloud` in Tasks 3–4 instead and note it here. If the stats fields differ, map the
  ones that exist in Task 4's `toRunStats` / `finalize` / `logFields` and drop the rest.
- A non-Celsius `temperatureUnit` is `unexpected_response` in the client (the sync stores °C as given).
- `ComfortCloudError(code, op, status?, options?: { cause?; message?; suspectFields? })` with
  `op: 'login' | 'units' | 'history'` and `name = 'ComfortCloudError'` (the `EmaldoError` shape). A different
  constructor → adapt every `new ComfortCloudError(…)` in Tasks 3–4 to it.
- `suspectFields` typed as `readonly ('user' | 'password')[]` or `CredentialFieldName[]` (1a couldn't name
  `CredentialField<'comfortCloud'>` yet). Task 3 Step 3 tightens it.
- No facade yet (Task 3 adds it). If 1a already added a facade, skip Task 3's facade code and keep its tests.
- A history answer without a parseable `deviceRegisterTime` is `unexpected_response` in the client (the sync relies on
  `registeredOn` always being a day).
- `createComfortCloudClient` lives in `./client` (Task 3 imports it dynamically from there).

- [ ] **Step 4: The step-1a service and schema are as the contract says (with the SCREAMING_SNAKE codes)**

```bash
cat src/lib/services/heatPump/index.ts
grep -n "export async function \(upsertUnits\|listUnits\|replaceDay\|oldestDay\|setRegisteredOn\|markHistoryComplete\|newestHour\)" src/lib/services/heatPump/heatPump.ts
grep -n "historyCompleteAt" src/lib/services/heatPump/heatPump.ts   # setRegisteredOn clears it when the day moves earlier
grep -n "INVALID_READING\|UNKNOWN_HEAT_PUMP\|class HeatPumpDomainError" src/lib/services/heatPump/errors.ts
grep -n "registeredOn\|historyCompleteAt\|heatPumpReading = \|heatPump = " src/lib/db/schema/heatPump.ts
grep -n "heatPump" src/lib/db/schema/index.ts
```

Expect `upsertUnits(units, now): Promise<HeatPump[]>`, `listUnits()` (by name), `replaceDay(id, utcDay, hours):
Promise<{ stored: number }>` throwing `HeatPumpDomainError` with `code: 'INVALID_READING'` for a value outside the
CHECKs (energy ≥ 5 kWh included), `oldestDay(id): Promise<string | null>`, `setRegisteredOn(id, day)` — which
**clears `history_complete_at` when `day` is earlier than the stored `registered_on`** (the coordinator's ruling;
Task 4's reopen test depends on it) — and `markHistoryComplete(id, now)`; `HeatPump.registeredOn: string | null`
(drizzle `date`, string mode), `HeatPump.historyCompleteAt: Date | null`; `heatPumpReading` columns `heatPumpId`,
`hourStart`, `energyKwh`. If `newestHour` already exists (same contract as Task 4 Step 1), skip Task 4 Steps 1–3.

- [ ] **Step 4b: The coordinator's doc amendments are on main**

```bash
grep -n "comfortCloudSyncCron\|14 d" docs/superpowers/specs/2026-10-08-heat-pumps-design.md
grep -n "suspect_fields" docs/adr/0027-heat-pump-energy-data.md
```

Expect the spec to name `comfortCloudSyncCron.ts`, the 14-day catch-up and the 14-day offline rule, and ADR-0027 no
longer to say the `suspect_fields` CHECK widens. If not, tell the owner before building (this plan doesn't amend them).

- [ ] **Step 5: The seams this plan consumes, and the source lists it extends**

```bash
ls drizzle/*.sql | tail -2                       # last is 1a's 00NN_heat_pump.sql; this plan generates the next number
grep -n "INTEGRATION_SOURCES = " src/lib/integrationHealth.ts       # ['zaptec', 'elpris', 'skoda', 'emaldo']
grep -n "CREDENTIAL_SOURCES = " src/lib/integrationCredentials.ts   # ['zaptec', 'skoda', 'emaldo', 'gridTariff']
grep -n "emaldo: 3 \* millisecondsInHour\|emaldo: 1," src/lib/services/integrationSync/policy.ts
grep -n "export async function runPulledSync\|export function withDeadline\|export type RunBase" src/lib/integrations/runPulledSync.ts
grep -n "export async function handleCronRun" src/lib/integrations/cron.ts
grep -n "export async function getLastSuccessStartedAt" src/lib/services/integrationSync/integrationSync.ts
grep -n "lastSuccessStartedAt: outcome.syncedUntil ?? startedAt" src/lib/services/integrationSync/transition.ts
grep -n "export function keyedAdapter\|export type UnavailableCode" src/lib/effects/keyedAdapter.ts
grep -n "emaldo-sync" vite.config.ts
grep -n "const chargingSource = z.enum" src/lib/orpc/procedures/evCharging.ts
grep -n "^type SyncSource" src/components/evCharging/SyncNowButton.tsx
grep -n "source: z.literal('emaldo')" src/lib/orpc/procedures/credentials.ts
grep -n "source: 'emaldo'," src/routes/_authenticated/charging/settings.tsx
grep -n "source-emaldo" src/styles/app.css          # three lines: @theme, :root, .dark
grep -n "energy: energyRouter" src/lib/orpc/router.ts   # Task 6 invalidates orpc.energy.key()
grep -rn "utcDay\|addUtcDays" src/lib --include='*.ts' | grep -v test | head   # a 1a UTC helper module?
```

Every line must be found (the last one may be empty). If 1a added a client-safe UTC day helper module (e.g.
`src/lib/time/utc.ts` with day arithmetic), use it in Task 4 instead of the five private one-liners at the top of
`sync.ts`, and note it here. `transition.ts` must still write `outcome.syncedUntil ?? startedAt` on success: the
catch-up window (decision 1) reads it.

Then the exhaustive per-source sites this plan changes (the Emaldo entries are the template). Re-run and diff against
this list; any extra hit is a site this plan missed — add it to the task that owns its layer:

```bash
grep -rnE "'emaldo'|emaldo:|_emaldo|case 'emaldo'" src messages test vite.config.ts | grep -v "^src/paraglide\|routeTree.gen\|^src/lib/effects/emaldo/\|^src/lib/houseEnergy/\|^src/routes/_authenticated/energy/\|credentials/cache.test\|credentials/crypto.test\|integrationCredential.test\|credentialLink.test\|SyncSourceTile.browser.test\|SyncSourcesPanel.browser.test\|healthPoll.test\|houseEnergySchema.test\|evChargingSchema.test"
```

Expected sites (the excluded ones are Emaldo-only tests or Emaldo behaviour, not source lists):
`src/styles/app.css:52,187,259` · `SyncSourceMark.tsx:32` (+ its test `:12,19,26`) · `SyncHealthAlert.tsx:125,138`
(+ test) · `SyncNowButton.tsx:10,117,125,180,189,206` (+ test `:37,44`) · `syncSourceCopy.ts:17,31` ·
`CredentialsDialog.browser.test.tsx:136` · `integrationCredentials.ts:7,13,42` · `integrationHealthMessage.ts:31,54,68`
(+ test) · `integrationCredentialsMessage.ts:33,42-46,58,64-71` (+ test) · `integrationHealth.ts:8` ·
`credentials/env.test.ts:33` · `credentials.ts:46` · `evCharging.ts:38,303` (+ test `:340,977-1022`) ·
`policy.ts:13,24` (+ `transition.test.ts:227-247`) · `integrationSync.test.ts:429,434,510` ·
`charging/settings.tsx:184,256` (+ `-settingsPage.browser.test.tsx:57,70,194,219,282`) · `messages/{sv,en}.json`
(`charging_health_*_emaldo`, `charging_source_*_emaldo`, `charging_credentials_field_emaldo_*`,
`charging_credentials_hint_emaldo_app`, `integration_health_error_*_emaldo`, `integration_health_source_emaldo`,
`charging_sync_house_*`) · `vite.config.ts:142-149`.

- [ ] **Step 6: Database up, suite green before touching anything**

```bash
bun run db:up && bun run db:migrate
bunx vitest run src/lib/houseEnergy/sync.test.ts src/lib/services/integrationSync src/lib/services/heatPump
```

Expected: PASS. If anything above differs, fix this plan first (and tell the owner), then build.

---

### Task 1: `comfortCloud` as a source — vocabulary, policy and copy

Adding `'comfortCloud'` to `INTEGRATION_SOURCES` and `CREDENTIAL_SOURCES` is a compile error at every exhaustive
per-source site, so the vocabulary, policy, copy, the source mark and the credential input land together. The DB CHECKs
follow in Task 2; the facade in Task 3; the real "Synka nu" in Task 6 (this task gives `SyncNowButton` a compile-only
case, replaced there).

**Files:**
- Modify: `src/lib/integrationHealth.ts:1-8`, `src/lib/integrationCredentials.ts:7-49`,
  `src/lib/services/integrationSync/policy.ts`, `src/lib/integrationHealthMessage.ts`,
  `src/lib/integrationCredentialsMessage.ts`, `src/lib/orpc/procedures/credentials.ts:36-50`,
  `src/components/evCharging/SyncHealthAlert.tsx:112-142`, `src/components/evCharging/syncSourceCopy.ts`,
  `src/components/evCharging/SyncSourceMark.tsx`, `src/styles/app.css` (three places),
  `src/components/evCharging/SyncNowButton.tsx:10,183-211`, `messages/sv.json`, `messages/en.json`
- Test: `src/lib/services/integrationSync/transition.test.ts`, `src/lib/integrationHealthMessage.test.ts`,
  `src/lib/integrationCredentialsMessage.test.ts`, `src/lib/credentials/env.test.ts`,
  `src/lib/orpc/procedures/credentials.test.ts` (existing loop), `src/lib/services/integrationSync/integrationSync.test.ts`,
  `src/lib/orpc/procedures/evCharging.test.ts`, `src/components/evCharging/SyncHealthAlert.browser.test.tsx`,
  `src/components/evCharging/SyncSourceMark.browser.test.tsx`, `src/components/evCharging/CredentialsDialog.browser.test.tsx`

**Interfaces:**
- Produces: `IntegrationSource` and `CredentialSource` include `'comfortCloud'`;
  `CREDENTIAL_FIELDS.comfortCloud = ['user', 'password']`; `CREDENTIAL_ENV_VARS.comfortCloud`;
  `STALE_AFTER_MS.comfortCloud = 13 h`, `ALERT_AFTER_FAILURES.comfortCloud = 2`;
  `integrationSourceName('comfortCloud') === 'Comfort Cloud'`; `setCredentialsInput` accepts
  `{ source: 'comfortCloud', fields: { user?, password? } }`; `useSyncNow().syncSource/isPendingFor` accept any
  `IntegrationSource`; Tailwind colour `source-comfort-cloud`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`. (The mark, tone and copy are reviewed again as UI in Task 6.)

- [ ] **Step 1: Write the failing tests**

`transition.test.ts` — change the pinned table and add a staleness case in `describe('deriveState', …)`:

```ts
  test('the threshold table is pinned', () => {
    expect(ALERT_AFTER_FAILURES).toEqual({ zaptec: 1, elpris: 1, skoda: 3, emaldo: 1, comfortCloud: 2 })
  })
```

```ts
  test('comfortCloud goes stale after 13 h: two missed 6-hourly runs', () => {
    expect(STALE_AFTER_MS.comfortCloud).toBe(13 * 60 * 60 * 1000)
    const at = (ms: number) => new Date(T0.getTime() + ms)
    expect(deriveState('comfortCloud', healthy, at(STALE_AFTER_MS.comfortCloud))).toBe('ok')
    expect(deriveState('comfortCloud', healthy, at(STALE_AFTER_MS.comfortCloud + 1))).toBe('stale')
  })
```

Append to `integrationHealthMessage.test.ts` (the existing loops cover the name and every code automatically):

```ts
test('comfortCloud is a source named Comfort Cloud', () => {
  expect(INTEGRATION_SOURCES).toContain('comfortCloud')
  expect(integrationSourceName('comfortCloud')).toBe('Comfort Cloud')
})

// The client maps a rejected password and a demanded 2FA code both to auth_failed
// (the run's message says which); the copy names both causes.
test('a refused Comfort Cloud login names the password and the two-step code', () => {
  const sv = integrationErrorMessage('auth_failed', { source: 'comfortCloud', locale: 'sv' })
  expect(sv).toContain('lösenord')
  expect(sv).toContain('tvåstegskod')
  const en = integrationErrorMessage('auth_failed', { source: 'comfortCloud', locale: 'en' })
  expect(en).toContain('password')
  expect(en).toContain('two-step code')
})

test('an unexpected Comfort Cloud answer says a heat pump may be offline', () => {
  expect(
    integrationErrorMessage('unexpected_response', { source: 'comfortCloud', locale: 'sv' }),
  ).toContain('offline')
  expect(
    integrationErrorMessage('unexpected_response', { source: 'comfortCloud', locale: 'en' }),
  ).toContain('offline')
  // Other codes keep the shared, source-named copy.
  expect(integrationErrorMessage('unreachable', { source: 'comfortCloud', locale: 'en' })).toContain(
    'Comfort Cloud',
  )
})
```

`integrationCredentialsMessage.test.ts` — inside `describe('credential copy', …)`:

```ts
  test('Comfort Cloud asks for the Panasonic ID email and a password-only account', () => {
    expect(credentialFieldLabel('comfortCloud', 'user')).toBe(
      m.charging_credentials_field_comfortCloud_user(),
    )
    expect(credentialFieldLabel('comfortCloud', 'password')).toBe(
      m.charging_credentials_field_password(),
    )
    expect(credentialFieldHint('comfortCloud', 'user')).toBe(
      m.charging_credentials_hint_comfortCloud_user(),
    )
    expect(credentialFieldHint('comfortCloud', 'password')).toBe(
      m.charging_credentials_hint_comfortCloud_password(),
    )
    expect(credentialFieldList('comfortCloud', ['password', 'user'])).toBe('E-post och Lösenord')
    expect(suspectFieldsMessage('comfortCloud', ['password', 'user'])).toBe(
      m.charging_credentials_suspect({ fields: 'E-post och Lösenord' }),
    )
    expect(credentialsTitle('comfortCloud')).toBe(
      m.charging_credentials_title({ source: 'Comfort Cloud' }),
    )
  })
```

`credentials/env.test.ts` — in `it('matches the ADR-0026 names', …)` add after `emaldo`:

```ts
      comfortCloud: { user: 'PANASONIC_USER', password: 'PANASONIC_PASSWORD' },
```

(`credentials.test.ts`'s "the input schema allows exactly each source's own fields" loops `CREDENTIAL_SOURCES`: it
fails until the union branch exists. `integrationCredentials.test.ts`'s loops expect both fields secret and required:
they pass once the vocabulary is in.)

`integrationSync.test.ts`:
- line 429 → `expect(Object.keys(all).sort()).toEqual(['comfortCloud', 'elpris', 'emaldo', 'skoda', 'zaptec'])`
- line 434 → `for (const source of ['elpris', 'skoda', 'emaldo', 'comfortCloud'] as const)`
- line 510 → `expect(Object.keys(runs).sort()).toEqual(['comfortCloud', 'elpris', 'emaldo', 'skoda', 'zaptec'])`
- after line 514 (`expect(runs.emaldo).toEqual([])`) add `expect(runs.comfortCloud).toEqual([])`

`evCharging.test.ts`:
- line 340 → `expect(runs).toEqual({ zaptec: [], elpris: [], skoda: [], emaldo: [], comfortCloud: [] })`
- line 1022 → `expect(Object.keys(all).sort()).toEqual(['comfortCloud', 'elpris', 'emaldo', 'skoda', 'zaptec'])`

`SyncHealthAlert.browser.test.tsx` — append:

```tsx
test('Comfort Cloud has its own never-synced copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'comfortCloud', state: 'never_synced' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(screen.getByText(m.charging_health_never_synced_comfortCloud()))
    .toBeVisible()
})

test('Comfort Cloud has its own stale copy', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...base, source: 'comfortCloud', state: 'stale' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_health_stale_comfortCloud())).toBeVisible()
})

test('a refused Comfort Cloud login names the two-step code', async () => {
  const { screen } = await renderWithProviders(
    <SyncHealthAlert
      health={{ ...failing, source: 'comfortCloud', code: 'auth_failed' }}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(
      screen.getByText(m.integration_health_error_auth_failed_comfortCloud(), { exact: false }),
    )
    .toBeVisible()
})
```

`SyncSourceMark.browser.test.tsx` — the token name is kebab-case, the source literal camelCase:

```tsx
const ICON_CLASS = {
  zaptec: 'lucide-ev-charger',
  elpris: 'lucide-chart-line',
  skoda: 'lucide-car-front',
  emaldo: 'lucide-sun-medium',
  comfortCloud: 'lucide-air-vent',
} as const

/** The --source-* token of each source (kebab-case). */
const TONE = {
  zaptec: 'zaptec',
  elpris: 'elpris',
  skoda: 'skoda',
  emaldo: 'emaldo',
  comfortCloud: 'comfort-cloud',
} as const

const ROLE = {
  zaptec: m.charging_source_role_zaptec,
  elpris: m.charging_source_role_elpris,
  skoda: m.charging_source_role_skoda,
  emaldo: m.charging_source_role_emaldo,
  comfortCloud: m.charging_source_role_comfortCloud,
} as const

const CADENCE = {
  zaptec: m.charging_source_cadence_zaptec,
  elpris: m.charging_source_cadence_elpris,
  skoda: m.charging_source_cadence_skoda,
  emaldo: m.charging_source_cadence_emaldo,
  comfortCloud: m.charging_source_cadence_comfortCloud,
} as const
```

and in the first `test.each` replace the three `source` interpolations with `TONE[source]`:

```tsx
  expect(mark?.className).toContain(`bg-source-${TONE[source]}/`)
  expect(mark?.className).toContain(`text-source-${TONE[source]}`)
  expect(mark?.className).toContain(`dark:bg-source-${TONE[source]}/`)
```

`CredentialsDialog.browser.test.tsx` — in `status()`, after the `emaldo` entry:

```ts
      comfortCloud: {
        fields: { user: missing, password: missing },
        updatedAt: null,
        unreadable: false,
      },
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
bunx vitest run src/lib/services/integrationSync src/lib/integrationHealthMessage.test.ts \
  src/lib/integrationCredentialsMessage.test.ts src/lib/credentials/env.test.ts \
  src/lib/orpc/procedures/credentials.test.ts src/lib/orpc/procedures/evCharging.test.ts
bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx \
  src/components/evCharging/SyncSourceMark.browser.test.tsx
```

Expected: FAIL (`comfortCloud` missing from the tables and lists; `m.charging_health_never_synced_comfortCloud` is not
a function).

- [ ] **Step 3: Implement the vocabulary, policy and server-side copy**

`src/lib/integrationHealth.ts` — header comment's first two lines and the list:

```ts
// Shared vocabulary for third-party integration sync health (Zaptec sessions,
// elpris spot prices, the Škoda car state, the Emaldo house energy flows and
// the Comfort Cloud heat pumps).
```

```ts
export const INTEGRATION_SOURCES = ['zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'] as const
```

`src/lib/integrationCredentials.ts`:

```ts
export const CREDENTIAL_SOURCES = ['zaptec', 'skoda', 'emaldo', 'comfortCloud', 'gridTariff'] as const
```

```ts
export const CREDENTIAL_FIELDS = {
  zaptec: ['username', 'password'],
  skoda: ['apiKey', 'vin', 'homeCoordinates'],
  emaldo: ['user', 'password', 'appId', 'appSecret'],
  comfortCloud: ['user', 'password'],
  gridTariff: ['facilityId'],
} as const satisfies Record<CredentialSource, readonly string[]>
```

and in `CREDENTIAL_ENV_VARS`, after `emaldo`:

```ts
  comfortCloud: { user: 'PANASONIC_USER', password: 'PANASONIC_PASSWORD' },
```

(`CREDENTIAL_FIELD_NAMES` dedupes: `user` and `password` already exist, so the `suspect_fields` CHECK text is
unchanged.)

`src/lib/services/integrationSync/policy.ts`:

```ts
// Domain rule: how long after its last success a source counts as `stale`.
// Zaptec syncs hourly, so 3 h = two missed runs. elpris runs at 12:30 and
// 15:30 UTC (at most 21 h apart), so 26 h = a whole missed day plus slack.
// skoda polls every 15 min, so 1 h = three missed polls. Emaldo syncs hourly
// (:45), so 3 h like Zaptec. Comfort Cloud syncs every 6 h (:20), so 13 h =
// two missed runs plus slack.
export const STALE_AFTER_MS: Record<IntegrationSource, number> = {
  zaptec: 3 * millisecondsInHour,
  elpris: 26 * millisecondsInHour,
  skoda: millisecondsInHour,
  emaldo: 3 * millisecondsInHour,
  comfortCloud: 13 * millisecondsInHour,
}

// How many consecutive alertable failures open an alert email (a
// not_configured run restarts the count). Hourly/daily
// sources alert at once; Škoda polls every 15 min, where a single 503 or 429
// would otherwise email every admin and then "recovered" 15 min later.
// Comfort Cloud is an unofficial API whose live endpoints are flaky (ADR-0027):
// two failed runs in a row (≥ 6 h apart) before anyone is emailed.
export const ALERT_AFTER_FAILURES: Record<IntegrationSource, number> = {
  zaptec: 1,
  elpris: 1,
  skoda: 3,
  emaldo: 1,
  comfortCloud: 2,
}
```

`src/lib/integrationHealthMessage.ts` — in `integrationSourceName`:

```ts
    case 'comfortCloud':
      return m.integration_health_source_comfortCloud()
```

the `auth_failed` inner switch gains (before `default`):

```ts
        case 'comfortCloud':
          return m.integration_health_error_auth_failed_comfortCloud({}, opts)
```

and `unexpected_response` becomes a switch:

```ts
    case 'unexpected_response':
      // Emaldo's API is unofficial: an answer we can't decode usually means
      // the app's id/secret rotated (ADR-0023). Comfort Cloud's is too, and its
      // sync also fails when a unit went quiet (ADR-0027): say both.
      switch (options.source) {
        case 'emaldo':
          return m.integration_health_error_unexpected_response_emaldo({}, opts)
        case 'comfortCloud':
          return m.integration_health_error_unexpected_response_comfortCloud({}, opts)
        default:
          return m.integration_health_error_unexpected_response({ source }, opts)
      }
```

`src/lib/integrationCredentialsMessage.ts` — `credentialFieldLabel`: add `case 'comfortCloud.password':` to the shared
password group (after `case 'emaldo.password':`), and

```ts
    case 'comfortCloud.user':
      return m.charging_credentials_field_comfortCloud_user()
```

`credentialFieldHint`:

```ts
    case 'comfortCloud.user':
      return m.charging_credentials_hint_comfortCloud_user()
    case 'comfortCloud.password':
      return m.charging_credentials_hint_comfortCloud_password()
```

`src/lib/orpc/procedures/credentials.ts` — in `setCredentialsInput`, after the `emaldo` branch:

```ts
  z.object({
    source: z.literal('comfortCloud'),
    fields: fieldsOf({ user: value, password: value }),
  }),
```

- [ ] **Step 4: Implement the UI switches (copy, mark, tone) and the compile-only sync case**

`SyncHealthAlert.tsx` — the comment above `neverSyncedCopy` ends "…the house's energy flows sync hourly and feed the
cost mix; the heat pumps sync every 6 hours." and each switch gains:

```ts
    case 'comfortCloud':
      return m.charging_health_never_synced_comfortCloud()
```

```ts
    case 'comfortCloud':
      return m.charging_health_stale_comfortCloud()
```

`syncSourceCopy.ts`:

```ts
    case 'comfortCloud':
      return m.charging_source_role_comfortCloud()
```

```ts
    case 'comfortCloud':
      return m.charging_source_cadence_comfortCloud()
```

`SyncSourceMark.tsx` — add `AirVentIcon` to the lucide import (alphabetical: `AirVentIcon, CarFrontIcon, …`) and:

```ts
    case 'comfortCloud':
      // The indoor unit's vent: what the source gives us is the heat pumps.
      return {
        Icon: AirVentIcon,
        tone: 'bg-source-comfort-cloud/12 text-source-comfort-cloud dark:bg-source-comfort-cloud/20',
      }
```

`src/styles/app.css`:
- `@theme inline`, after `--color-source-emaldo: var(--source-emaldo);`:
  `    --color-source-comfort-cloud: var(--source-comfort-cloud);`
- `:root`, after `--source-emaldo: oklch(0.6 0.12 90);`: `  --source-comfort-cloud: oklch(0.62 0.19 310);`
- `.dark`, after `--source-emaldo: oklch(0.85 0.15 88);`: `  --source-comfort-cloud: oklch(0.64 0.18 315);`

`SyncNowButton.tsx` — `SyncSource` becomes every integration source (the panel passes any `IntegrationSource`):

```ts
import type { IntegrationErrorCode, IntegrationSource } from '~/lib/integrationHealth'
```

```ts
type SyncSource = IntegrationSource
```

and, until Task 6 adds its mutation, compile-only cases (Task 6 replaces both):

```ts
        case 'comfortCloud':
          // Task 6 (this branch) wires the Comfort Cloud mutation.
          return
```

```ts
        case 'comfortCloud':
          return false
```

Messages (beside the matching `emaldo` keys, same position in both files):

| key | sv | en |
|---|---|---|
| `integration_health_source_comfortCloud` | Comfort Cloud | Comfort Cloud |
| `integration_health_error_auth_failed_comfortCloud` | Comfort Cloud nekade inloggningen. Kontrollera Panasonic-kontots e-post och lösenord – eller så kräver kontot en tvåstegskod, som synken inte kan ange. En admin behöver undersöka det. | Comfort Cloud refused the login. Check the Panasonic account's email and password – or the account demands a two-step code, which the sync can't enter. An admin needs to look into it. |
| `integration_health_error_unexpected_response_comfortCloud` | Comfort Cloud svarade på ett oväntat sätt eller saknar data. En värmepump kan vara offline, eller så har Panasonic ändrat appen – en admin behöver undersöka det. | Comfort Cloud responded unexpectedly or is missing data. A heat pump may be offline, or Panasonic changed the app – an admin needs to look into it. |
| `charging_health_never_synced_comfortCloud` | Värmepumparnas data har inte hämtats ännu. Den hämtas var sjätte timme. | The heat pumps' data hasn't been fetched yet. It's fetched every six hours. |
| `charging_health_stale_comfortCloud` | Värmepumparnas data har inte kunnat hämtas på ett tag. Det som saknas hämtas i efterhand när det fungerar igen. | The heat pumps' data couldn't be fetched for a while. What's missing is fetched once it works again. |
| `charging_source_role_comfortCloud` | Värmepumpar | Heat pumps |
| `charging_source_cadence_comfortCloud` | Hämtas var 6:e timme | Fetched every 6 hours |
| `charging_credentials_field_comfortCloud_user` | E-post | Email |
| `charging_credentials_hint_comfortCloud_user` | E-postadressen till ditt Panasonic ID, samma som i Comfort Cloud-appen. | The email of your Panasonic ID, the same as in the Comfort Cloud app. |
| `charging_credentials_hint_comfortCloud_password` | Kontot måste kunna logga in med bara lösenord: synken kan inte ange en tvåstegskod. | The account must sign in with the password alone: the sync can't enter a two-step code. |

Then `bun run i18n:compile`.

- [ ] **Step 5: Re-check the tone (no repo change)**

In a scratch directory (not the repo), save the converter and run it with the dataviz skill's validator beside it
(`validate_palette.js` from the `dataviz` skill's `scripts/`; copy lines 39–116 into `lib.mjs` and change
`function deltaE` to `export function deltaE`):

```js
// tone.mjs — usage: node tone.mjs light|dark L C H
import { contrast, deltaE } from './lib.mjs'
const [mode, L, C, H] = process.argv.slice(2).map((v, i) => (i ? Number(v) : v))
const others = mode === 'dark' ? ['#ec785b', '#51cbbd', '#70b3f7', '#f7c747'] : ['#a8260a', '#0d736a', '#0c60a3', '#9c7c0b']
const card = mode === 'dark' ? [0x1c, 0x1c, 0x1f].map((x) => x / 255) : [1, 1, 1]
const alpha = mode === 'dark' ? 0.2 : 0.12
const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180)
const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
const hex = (v) => '#' + v.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')
const g = lin.map(enc), tone = hex(g), wash = hex(g.map((x, i) => alpha * x + (1 - alpha) * card[i]))
console.log(tone, 'in gamut', lin.every((x) => x >= 0 && x <= 1), 'icon/wash', contrast(tone, wash).toFixed(2),
  'min ΔE normal', Math.min(...others.map((o) => deltaE(tone, o))).toFixed(1),
  'min ΔE protan/deutan', Math.min(...others.map((o) => Math.min(deltaE(tone, o, 'protan'), deltaE(tone, o, 'deutan')))).toFixed(1))
```

`node tone.mjs light 0.62 0.19 310` → `#a95dda`, in gamut, icon/wash ≥ 3.0, min normal ≥ 15, min protan/deutan ≥ 8.
`node tone.mjs dark 0.64 0.18 315` → `#b464d6`, same thresholds. (Planning measured 3.47 / 21.9 / 9.9 and
3.60 / 20.1 / 10.6.) If an existing tone changed on main since, update `others` and, if a threshold fails, move L by
±0.02 until all pass; put the result in the `app.css` comment above the source tones:
`/* … Comfort Cloud (ADR-0027): violet, icon ≥3:1 on its wash, ΔE ≥ 15 (normal) / ≥ 8 (CVD) from the others. */`.

- [ ] **Step 6: Run, expect PASS**

```bash
bunx vitest run src/lib/services/integrationSync src/lib/integrationHealthMessage.test.ts \
  src/lib/integrationCredentialsMessage.test.ts src/lib/integrationCredentials.test.ts \
  src/lib/credentials/env.test.ts src/lib/orpc/procedures/credentials.test.ts \
  src/lib/orpc/procedures/evCharging.test.ts
bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx \
  src/components/evCharging/SyncSourceMark.browser.test.tsx \
  src/components/evCharging/CredentialsDialog.browser.test.tsx
bun run typecheck
```

Expected: PASS, and `tsc` clean (every exhaustive switch has its `comfortCloud` case; the `credentials.test.ts` loop
finds the new branch).

- [ ] **Step 7: Commit**

```bash
git add src/lib/integrationHealth.ts src/lib/integrationCredentials.ts src/lib/services/integrationSync \
  src/lib/integrationHealthMessage.ts src/lib/integrationHealthMessage.test.ts \
  src/lib/integrationCredentialsMessage.ts src/lib/integrationCredentialsMessage.test.ts \
  src/lib/credentials/env.test.ts src/lib/orpc/procedures/credentials.ts \
  src/lib/orpc/procedures/evCharging.test.ts src/components/evCharging src/styles/app.css \
  messages/sv.json messages/en.json
git commit -m "feat(heat-pumps): add Comfort Cloud as an integration source" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The source CHECK migration

**Files:**
- Create (generated): `drizzle/00NN_comfort_cloud_source.sql`, `drizzle/meta/00NN_snapshot.json`,
  `drizzle/meta/_journal.json` (NN = the number after 1a's `heat_pump` migration)
- Test: `src/lib/db/comfortCloudSourceSchema.test.ts` (in `src/lib/db/`, not `schema/`: drizzle-kit would `require()`
  a test file inside the schema directory)

**Interfaces:**
- Consumes: Task 1's vocabulary (the CHECKs render `INTEGRATION_SOURCES` / `CREDENTIAL_SOURCES` via `sqlList`).
- Produces: `integration_sync_source_check`, `integration_sync_run_source_check` and
  `integration_credential_source_check` accept `'comfortCloud'`.

**Reviewers:** A = `migration-guard`, B = schema-design reviewer (`general-purpose` agent that loads
`supabase-postgres-best-practices`), told to assume the migration is wrong, judging it against what runs:
- Each `DROP CONSTRAINT` + `ADD CONSTRAINT … CHECK` validates every existing row under an `ACCESS EXCLUSIVE` lock:
  `integration_sync` (≤ 5 rows), `integration_credential` (≤ 5 rows), `integration_sync_run` (90 days of runs,
  ≈ 13k rows: Zaptec + Emaldo hourly, Škoda every 15 min, elpris twice a day). The deploy runs `drizzle-kit migrate`
  while the old deployment still serves; a sync run writing a run row waits on the lock for the validation's
  milliseconds. Expected ruling: accept (the `0011` / `0013` source-CHECK migrations did the same); `NOT VALID` +
  `VALIDATE` isn't worth a hand-edited migration at this size.
- Writes after the change: one `integration_sync` upsert per run, one `integration_sync_run` insert per run, one
  `integration_credential` upsert per admin save — all with literal sources from the vocabulary.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/db/comfortCloudSourceSchema.test.ts
import { test } from 'vitest'
import { db } from '~/lib/db'
import { integrationCredential, integrationSync, integrationSyncRun } from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/): drizzle-kit scans schema/ and would try to
// require() this file.
setupDatabase()

const runRow = (source: string) => ({
  source,
  trigger: 'cron',
  startedAt: new Date('2026-04-01T10:00:00Z'),
  finishedAt: new Date('2026-04-01T10:00:01Z'),
  durationMs: 1000,
  outcome: 'ok',
})
// Any well-formed envelope: the CHECK looks at the shape, never decrypts.
const ENVELOPE = 'v1.aaaa.bbbb.cccc'

test('comfortCloud passes both sync source CHECKs', async () => {
  await db.insert(integrationSync).values({ source: 'comfortCloud' })
  await db.insert(integrationSyncRun).values(runRow('comfortCloud'))
})

test('comfortCloud passes the credential source CHECK with its two field names', async () => {
  await db
    .insert(integrationCredential)
    .values({ source: 'comfortCloud', ciphertext: ENVELOPE, fieldsSet: ['user', 'password'] })
})

test('a failed comfortCloud run may blame user and password (suspect_fields unchanged)', async () => {
  await db.insert(integrationSyncRun).values({
    ...runRow('comfortCloud'),
    outcome: 'failed',
    errorCode: 'auth_failed',
    suspectFields: ['user', 'password'],
  })
})

test('a source outside the vocabulary is still rejected by every source CHECK', async () => {
  await expectConstraintViolation(
    db.insert(integrationSync).values({ source: 'comfort_cloud' }),
    'integration_sync_source_check',
  )
  await expectConstraintViolation(
    db.insert(integrationSyncRun).values(runRow('comfort_cloud')),
    'integration_sync_run_source_check',
  )
  await expectConstraintViolation(
    db
      .insert(integrationCredential)
      .values({ source: 'comfort_cloud', ciphertext: ENVELOPE, fieldsSet: ['user'] }),
    'integration_credential_source_check',
  )
})
```

- [ ] **Step 2: Run it, expect FAIL**

`bunx vitest run src/lib/db/comfortCloudSourceSchema.test.ts` → the first three FAIL (`integration_sync_source_check`,
`integration_credential_source_check`), the last passes.

- [ ] **Step 3: Generate and apply**

```bash
bun run db:generate --name=comfort_cloud_source
bun run db:migrate
```

Expected `drizzle/00NN_comfort_cloud_source.sql`, exactly six statements (order may differ):

```sql
ALTER TABLE "integration_credential" DROP CONSTRAINT "integration_credential_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync" DROP CONSTRAINT "integration_sync_source_check";--> statement-breakpoint
ALTER TABLE "integration_sync_run" DROP CONSTRAINT "integration_sync_run_source_check";--> statement-breakpoint
ALTER TABLE "integration_credential" ADD CONSTRAINT "integration_credential_source_check" CHECK ("integration_credential"."source" IN ('zaptec', 'skoda', 'emaldo', 'comfortCloud', 'gridTariff'));--> statement-breakpoint
ALTER TABLE "integration_sync" ADD CONSTRAINT "integration_sync_source_check" CHECK ("integration_sync"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'));--> statement-breakpoint
ALTER TABLE "integration_sync_run" ADD CONSTRAINT "integration_sync_run_source_check" CHECK ("integration_sync_run"."source" IN ('zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'));
```

Nothing else — in particular no `suspect_fields` statement. If drizzle-kit wants to change anything else, stop: the
snapshot is out of sync with main.

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/db/comfortCloudSourceSchema.test.ts src/lib/db/houseEnergySchema.test.ts test/rls.test.ts
```

(`houseEnergySchema.test.ts`'s "every integration source … passes both source CHECKs" now loops over `comfortCloud`
too.)

- [ ] **Step 5: Review gate before anything builds on it**

Dispatch `migration-guard` and the schema-design reviewer in parallel. Fix or explicitly rule on every finding
**before Task 3** — once pushed, the migration is frozen. If a fix changes it, `bunx drizzle-kit drop` the unpushed
migration and regenerate.

- [ ] **Step 6: Commit**

```bash
git add drizzle/ src/lib/db/comfortCloudSourceSchema.test.ts
git commit -m "feat(heat-pumps): widen the source CHECKs for Comfort Cloud" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The Comfort Cloud facade (keyed, fail-closed)

**Files:**
- Modify: `src/lib/effects/comfortCloud/comfortCloud.ts` (append the selector + facade), `src/lib/effects/comfortCloud/index.ts`,
  `src/lib/effects/index.ts`, `src/lib/effects/comfortCloud/errors.ts` (only to tighten `suspectFields`, Step 3)
- Create: `src/lib/effects/comfortCloud/adapters/notConfigured.ts`
- Test: `src/lib/effects/comfortCloud/facade.test.ts` (a new file: 1a's client tests keep their own)

**Interfaces:**
- Consumes: `ComfortCloudClient`, `ComfortCloudError`, `createComfortCloudClient` (1a); `keyedAdapter`,
  `UnavailableCode` (`~/lib/effects/keyedAdapter`); `CredentialValues<'comfortCloud'>` (Task 1).
- Produces:
  ```ts
  export function selectComfortCloudAdapter(values: CredentialValues<'comfortCloud'>): 'notConfigured' | 'http'
  export const comfortCloud: ComfortCloudClient   // also re-exported from ~/lib/effects
  // adapters/notConfigured.ts
  export function unavailable(code: UnavailableCode): ComfortCloudClient
  export const notConfigured: ComfortCloudClient
  ```

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/effects/comfortCloud/facade.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type ComfortCloudClient,
  ComfortCloudError,
  comfortCloud as comfortCloudSingleton,
  newCallStats,
  selectComfortCloudAdapter,
} from '.'
import { notConfigured, unavailable } from './adapters/notConfigured'

// Synthetic credentials: never a real account.
const USER = 'heat-owner@example.com'
const PASSWORD = 'synthetic-password-1'

const calls = (client: ComfortCloudClient) => [
  () => client.units(),
  () => client.dayHours('CS-HZ25ZKE+0000000001', '2026-04-01'),
  () => client.monthDays('CS-HZ25ZKE+0000000001', '2026-03'),
]

describe('adapter selection', () => {
  test('http only with both fields', () => {
    expect(selectComfortCloudAdapter({ user: USER, password: PASSWORD })).toBe('http')
    expect(selectComfortCloudAdapter({ user: USER, password: '' })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({ user: '', password: PASSWORD })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({ user: USER })).toBe('notConfigured')
    expect(selectComfortCloudAdapter({})).toBe('notConfigured')
  })

  test('unavailable(code) fails every call with an admin message naming no value', async () => {
    const cases = [
      [
        'not_configured',
        'Comfort Cloud client is not configured (set it under Charging → Settings or as PANASONIC_USER / PANASONIC_PASSWORD)',
      ],
      [
        'credentials_unreadable',
        'Stored Comfort Cloud credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Charging → Settings',
      ],
    ] as const
    for (const [code, message] of cases) {
      for (const call of calls(unavailable(code))) {
        const err = await call().catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ComfortCloudError)
        expect(err).toMatchObject({ name: 'ComfortCloudError', code, op: 'login', message })
      }
    }
    await expect(notConfigured.units()).rejects.toMatchObject({ code: 'not_configured' })
  })

  test('the exported singleton fails closed as not_configured under VITEST', async () => {
    for (const call of calls(comfortCloudSingleton)) {
      await expect(call()).rejects.toMatchObject({
        name: 'ComfortCloudError',
        code: 'not_configured',
      })
    }
  })
})

describe('the singleton with resolved credentials', () => {
  type Resolved = { values: Record<string, string>; fingerprint: string }
  let resolved: () => Promise<Resolved>
  const built: { user: string; password: string; fetch: unknown }[] = []
  /** The call options each fake method received. */
  const forwarded: unknown[] = []
  const fakeClient: ComfortCloudClient = {
    units: async (o) => {
      forwarded.push(o)
      return [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }]
    },
    dayHours: async (_guid, _day, o) => {
      forwarded.push(o)
      return { registeredOn: '2026-03-01', rows: [] }
    },
    monthDays: async (_guid, _month, o) => {
      forwarded.push(o)
      return { registeredOn: '2026-03-01', rows: [] }
    },
  }

  async function freshFacade() {
    vi.resetModules()
    vi.stubEnv('VITEST', '')
    vi.doMock('~/lib/credentials/resolve', () => ({ resolveCredentials: () => resolved() }))
    // The facade imports the client lazily from ./client: capture the options instead of logging in.
    vi.doMock('./client', () => ({
      createComfortCloudClient: (opts: { user: string; password: string; fetch: unknown }) => {
        built.push(opts)
        return fakeClient
      },
    }))
    return (await import('./comfortCloud')).comfortCloud
  }

  beforeEach(() => {
    built.length = 0
    forwarded.length = 0
    resolved = async () => ({ values: { user: USER, password: PASSWORD }, fingerprint: 'f' })
  })
  afterEach(() => {
    vi.doUnmock('~/lib/credentials/resolve')
    vi.doUnmock('./client')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('builds the client from the resolved fields and the global fetch, and forwards each call with its options', async () => {
    const facade = await freshFacade()
    const o = { signal: new AbortController().signal, stats: newCallStats() }
    expect(await facade.units(o)).toEqual([
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
    ])
    expect(await facade.dayHours('g', '2026-04-01', o)).toEqual({ registeredOn: '2026-03-01', rows: [] })
    expect(await facade.monthDays('g', '2026-03', o)).toEqual({ registeredOn: '2026-03-01', rows: [] })
    expect(forwarded).toEqual([o, o, o])
    expect(built).toEqual([{ user: USER, password: PASSWORD, fetch: globalThis.fetch }])
  })

  test('an unchanged fingerprint keeps the client (and its token); a changed one rebuilds it', async () => {
    const facade = await freshFacade()
    await facade.units()
    await facade.units()
    expect(built).toHaveLength(1)
    resolved = async () => ({ values: { user: USER, password: 'changed' }, fingerprint: 'g' })
    await facade.units()
    expect(built).toHaveLength(2)
    expect(built[1]).toMatchObject({ password: 'changed' })
  })

  test('a missing field fails closed as not_configured without building a client', async () => {
    resolved = async () => ({ values: { user: USER }, fingerprint: 'h' })
    const facade = await freshFacade()
    await expect(facade.units()).rejects.toMatchObject({ code: 'not_configured' })
    expect(built).toHaveLength(0)
  })

  test('unreadable stored credentials fail closed as credentials_unreadable, without a client', async () => {
    const facade = await freshFacade()
    // After resetModules: the class keyedAdapter's instanceof sees.
    const { CredentialsUnreadableError } = await import('~/lib/credentials/crypto')
    resolved = async () => {
      throw new CredentialsUnreadableError('comfortCloud', 'invalid')
    }
    await expect(facade.units()).rejects.toMatchObject({
      name: 'ComfortCloudError',
      code: 'credentials_unreadable',
    })
    expect(built).toHaveLength(0)
  })
})
```

(If `CredentialsUnreadableError`'s constructor differs from `(source, reason)`, copy the call from
`src/lib/effects/emaldo/emaldo.test.ts` "unreadable stored credentials…".)

- [ ] **Step 2: Run it, expect FAIL**

`bunx vitest run src/lib/effects/comfortCloud/facade.test.ts` → FAIL (`selectComfortCloudAdapter` / `comfortCloud` not
exported; `./adapters/notConfigured` not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/effects/comfortCloud/adapters/notConfigured.ts
import type { UnavailableCode } from '../../keyedAdapter'
import type { ComfortCloudClient } from '../comfortCloud'
import { ComfortCloudError } from '../errors'

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured:
    'Comfort Cloud client is not configured (set it under Charging → Settings or as PANASONIC_USER / PANASONIC_PASSWORD)',
  credentials_unreadable:
    'Stored Comfort Cloud credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Charging → Settings',
}

// `not_configured` when either field is missing (and under VITEST),
// `credentials_unreadable` when the stored row can't be decrypted: fails closed
// so health shows the reason, never a fake healthy sync (ADR-0019). `op` is
// `login`: nothing got as far as a call.
export function unavailable(code: UnavailableCode): ComfortCloudClient {
  const fail = async (): Promise<never> => {
    throw new ComfortCloudError(code, 'login', undefined, { message: MESSAGES[code] })
  }
  return { units: fail, dayHours: fail, monthDays: fail }
}

export const notConfigured: ComfortCloudClient = unavailable('not_configured')
```

Append to `src/lib/effects/comfortCloud/comfortCloud.ts` (add the two imports at the top of the file, beside 1a's):

```ts
import type { CredentialValues } from '~/lib/integrationCredentials'
import { keyedAdapter } from '../keyedAdapter'
```

```ts
/**
 * The heat pumps' facade (ADR-0027). Credentials come from the resolver
 * (ADR-0026: stored under Inställningar, else PANASONIC_USER / PANASONIC_PASSWORD),
 * checked on every call. The client — and the access token in its memory — is
 * rebuilt only when they change, so a warm instance reuses its login. An
 * unreadable stored row fails the call as `credentials_unreadable`; under
 * VITEST every call is `not_configured`.
 */
/** `http` only when both fields resolve. */
export function selectComfortCloudAdapter(
  values: CredentialValues<'comfortCloud'>,
): 'notConfigured' | 'http' {
  return values.user && values.password ? 'http' : 'notConfigured'
}

const getAdapter = keyedAdapter({
  source: 'comfortCloud',
  unavailable: async (code) => (await import('./adapters/notConfigured')).unavailable(code),
  build: async (values): Promise<ComfortCloudClient> => {
    const { user, password } = values
    if (selectComfortCloudAdapter(values) === 'http' && user && password) {
      const { createComfortCloudClient } = await import('./client')
      return createComfortCloudClient({ fetch: globalThis.fetch, user, password })
    }
    return (await import('./adapters/notConfigured')).notConfigured
  },
})

// Forwards each call's options ({ signal, stats }) untouched.
export const comfortCloud: ComfortCloudClient = {
  async units(o) {
    return (await getAdapter()).units(o)
  },
  async dayHours(guid, utcDay, o) {
    return (await getAdapter()).dayHours(guid, utcDay, o)
  },
  async monthDays(guid, utcMonth, o) {
    return (await getAdapter()).monthDays(guid, utcMonth, o)
  },
}
```

`src/lib/effects/comfortCloud/index.ts` — add `comfortCloud` and `selectComfortCloudAdapter` to the export list from
`./comfortCloud` (keep 1a's exports). `src/lib/effects/index.ts` — add (alphabetical, first line):

```ts
export { comfortCloud } from './comfortCloud'
```

`errors.ts`: if Task 0 found `suspectFields` typed wider than the source's own fields, tighten it now that the source
exists — `suspectFields?: readonly CredentialField<'comfortCloud'>[]` with
`import type { CredentialField } from '~/lib/integrationCredentials'` (the `EmaldoError` shape).

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/lib/effects/comfortCloud src/lib/effects/keyedAdapter.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/effects/comfortCloud src/lib/effects/index.ts
git commit -m "feat(heat-pumps): add the keyed Comfort Cloud facade" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `runComfortCloudSync` — recent days, catch-up and backfill

**Files:**
- Modify: `src/lib/services/heatPump/heatPump.ts` (add `newestHour`, unless 1a has it)
- Test: `src/lib/services/heatPump/heatPump.test.ts`
- Create: `src/lib/heatPump/sync.ts`
- Test: `src/lib/heatPump/sync.test.ts`

**Interfaces:**
- Consumes: `comfortCloud`, `ComfortCloudClient`, `ComfortCloudCallStats`, `newCallStats`, `ComfortCloudDay`,
  `ComfortCloudHour`, `ComfortCloudHistory`, `ComfortCloudError` (`~/lib/effects/comfortCloud`); `upsertUnits`,
  `listUnits`, `replaceDay`, `oldestDay`, `setRegisteredOn` (clears `history_complete_at` when the day moves earlier),
  `markHistoryComplete`, `HeatPump`, `HeatPumpDomainError` (`~/lib/services/heatPump`); `getLastSuccessStartedAt`
  (`~/lib/services/integrationSync`); `runPulledSync`, `withDeadline`, `RunBase`.
- Produces:
  ```ts
  // service
  export async function newestHour(heatPumpId: string): Promise<Date | null>   // the unit's newest stored hour_start
  // sync
  export type ComfortCloudSyncRun = RunBase & { source: 'comfortCloud'; units: number; daysFetched: number;
    monthsFetched: number; hoursStored: number; emptyDays: number; rejectedDays: number; unitsCompleted: number;
    backfillDaysLeft: number; fetchMs: number; storeMs: number; requests: number; retries: number; logins: number }
  export function recentDays(today: string, lastSuccessStartedAt: Date | null): { days: string[]; skipped: number }
  export function backfillCandidates(rows: readonly ComfortCloudDay[], a: { from: string; registeredOn: string }): string[]
  export async function runComfortCloudSync(opts: { trigger: SyncTrigger; now?: () => Date; deadlineMs?: number;
    deps?: { comfortCloud?: ComfortCloudClient; log?: Logger; sleep?: (ms: number) => Promise<void> } }): Promise<ComfortCloudSyncRun>
  ```
  Task 5 reads `units`, `daysFetched`, `hoursStored`, `backfillDaysLeft`, `fetchMs`, `storeMs`, `durationMs`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: `newestHour` — write the failing service test** (skip Steps 1–3 if Task 0 found it in 1a)

Append to `src/lib/services/heatPump/heatPump.test.ts` (it already calls `setupDatabase()`; reuse its imports, adding
`newestHour` to the `./heatPump` import):

```ts
describe('newestHour', () => {
  const hour = (iso: string) => ({
    hourStart: new Date(iso),
    energyKwh: 0.03,
    heatShare: 1,
    coolShare: 0,
    setpointC: 21,
    insideC: 21.5,
    outsideC: 4,
  })

  test('null without readings, then the newest stored hour of that unit only', async () => {
    const [a, b] = await upsertUnits(
      [
        { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
        { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' },
      ],
      new Date('2026-04-03T10:00:00Z'),
    )
    expect(await newestHour(a.id)).toBeNull()
    await replaceDay(a.id, '2026-04-01', [hour('2026-04-01T05:00:00Z'), hour('2026-04-01T22:00:00Z')])
    await replaceDay(a.id, '2026-03-30', [hour('2026-03-30T23:00:00Z')])
    await replaceDay(b.id, '2026-04-02', [hour('2026-04-02T01:00:00Z')])
    expect(await newestHour(a.id)).toEqual(new Date('2026-04-01T22:00:00Z'))
    expect(await newestHour(b.id)).toEqual(new Date('2026-04-02T01:00:00Z'))
  })
})
```

(If `upsertUnits` returns rows in another order, pick `a`/`b` by `name`.)

- [ ] **Step 2: Run it, expect FAIL, then implement**

`bunx vitest run src/lib/services/heatPump/heatPump.test.ts` → FAIL (`newestHour` is not exported). Add to
`src/lib/services/heatPump/heatPump.ts` (import `max` and `eq` from `drizzle-orm` if not already):

```ts
/**
 * The unit's newest stored hour (`hour_start`), or null with none — one max()
 * over the (heat_pump_id, hour_start) primary key. The sync's offline rule reads it.
 */
export async function newestHour(heatPumpId: string): Promise<Date | null> {
  const [row] = await db
    .select({ newest: max(heatPumpReading.hourStart) })
    .from(heatPumpReading)
    .where(eq(heatPumpReading.heatPumpId, heatPumpId))
  return row?.newest ?? null
}
```

- [ ] **Step 3: Run it, expect PASS**

`bunx vitest run src/lib/services/heatPump/heatPump.test.ts` → PASS.

- [ ] **Step 4: Write the failing sync test**

```ts
// src/lib/heatPump/sync.test.ts
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest'
import { db } from '~/lib/db'
import { heatPumpReading, integrationSyncRun, user } from '~/lib/db/schema'
import { queue } from '~/lib/effects'
import {
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  ComfortCloudError,
  type ComfortCloudHistory,
  type ComfortCloudHour,
} from '~/lib/effects/comfortCloud'
import { createServerLogger } from '~/lib/logger/server'
import { listUnits } from '~/lib/services/heatPump'
import * as integrationSyncService from '~/lib/services/integrationSync'
import { beginAttempt, getHealth, listRecentRuns } from '~/lib/services/integrationSync'
import { setupDatabase } from '~test/setup'
import { backfillCandidates, recentDays, runComfortCloudSync } from './sync'

setupDatabase()

// All days are UTC calendar days; nothing here depends on the local zone.
const NOW = new Date('2026-04-03T10:00:00Z')
const TODAY = '2026-04-03'
const DAY_MS = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const plus = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const daysFrom = (from: string, to: string) => {
  const out: string[] = []
  for (let d = from; d <= to; d = plus(d, 1)) out.push(d)
  return out
}
const daysOfMonth = (month: string) =>
  daysFrom(`${month}-01`, plus(`${plus(`${month}-01`, 31).slice(0, 7)}-01`, -1))

const MATSAL = 'CS-HZ25ZKE+0000000001'
const OVERVANING = 'CS-HZ25ZKE+0000000002'

// Synthetic values only — never real consumption (the repo is public).
function hoursOf(day: string, upTo: Date, kwh = 0.03): ComfortCloudHour[] {
  return Array.from({ length: 24 }, (_, h) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`))
    .filter((hourStart) => hourStart.getTime() <= upTo.getTime())
    .map((hourStart) => ({
      hourStart,
      energyKwh: kwh,
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 21.5,
      outsideC: 4,
    }))
}

type FakeUnit = {
  guid: string
  name: string
  registeredOn: string
  /** Days with data, besides registeredOn ≤ day ≤ today (default: every such day). */
  hasData?: (day: string) => boolean
  kwh?: number
}
type History = ComfortCloudHistory<ComfortCloudHour>

// In-memory Comfort Cloud: data on every day from registeredOn to today unless
// `hasData` says otherwise; `days` scripts one `${guid}:${day}` answer.
function fakeComfortCloud(
  units: FakeUnit[],
  opts: {
    now?: Date
    onCall?: () => void
    days?: Record<string, () => History | Promise<History>>
  } = {},
) {
  const now = opts.now ?? NOW
  const calls: string[] = []
  const byGuid = new Map(units.map((u) => [u.guid, u]))
  const unit = (guid: string) => {
    const u = byGuid.get(guid)
    if (!u) throw new Error(`unknown guid ${guid}`)
    return u
  }
  const hasData = (u: FakeUnit, day: string) =>
    day >= u.registeredOn && day <= dayOf(now.getTime()) && (u.hasData?.(day) ?? true)
  // Like 1a's client: every call counts into the caller's stats sink.
  const count = (o?: { stats?: ComfortCloudCallStats }, login = false) => {
    if (!o?.stats) return
    o.stats.requests += 1
    o.stats.fetchMs += 5
    if (login) o.stats.logins += 1
  }
  const client: ComfortCloudClient = {
    async units(o) {
      calls.push('units')
      count(o, true)
      opts.onCall?.()
      return units.map(({ guid, name }) => ({ guid, name, model: 'CS-HZ25ZKE' }))
    },
    async dayHours(guid, day, o) {
      calls.push(`day:${guid}:${day}`)
      count(o)
      opts.onCall?.()
      const scripted = opts.days?.[`${guid}:${day}`]
      if (scripted) return scripted()
      const u = unit(guid)
      return { registeredOn: u.registeredOn, rows: hasData(u, day) ? hoursOf(day, now, u.kwh) : [] }
    },
    async monthDays(guid, month, o) {
      calls.push(`month:${guid}:${month}`)
      count(o)
      opts.onCall?.()
      const u = unit(guid)
      return {
        registeredOn: u.registeredOn,
        rows: daysOfMonth(month)
          .filter((day) => hasData(u, day))
          .map((day) => ({ day, energyKwh: 0.65 })),
      }
    },
  }
  return { client, calls }
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
const run = (client: ComfortCloudClient, extra: RunExtra = {}) =>
  runComfortCloudSync({
    trigger: 'cron',
    now: extra.now ?? (() => NOW),
    deps: {
      comfortCloud: client,
      log: extra.log ?? capturingLogger().log,
      sleep: extra.sleep ?? (async () => {}),
    },
  })

/** Stored hours of the unit called `name`, optionally on one UTC day. */
async function hoursStored(name: string, day?: string) {
  const unit = (await listUnits()).find((u) => u.name === name)
  if (!unit) return 0
  const rows = await db.select().from(heatPumpReading)
  return rows.filter(
    (r) => r.heatPumpId === unit.id && (!day || r.hourStart.toISOString().startsWith(day)),
  ).length
}
const unitNamed = async (name: string) => (await listUnits()).find((u) => u.name === name)
const backfillCalls = (calls: string[], guid: string) =>
  calls.filter((c) => c.startsWith(`month:${guid}`) || c.startsWith(`day:${guid}`))

const matsal = (registeredOn: string, extra: Partial<FakeUnit> = {}): FakeUnit => ({
  guid: MATSAL,
  name: 'Matsal',
  registeredOn,
  ...extra,
})
const overvaning = (registeredOn: string, extra: Partial<FakeUnit> = {}): FakeUnit => ({
  guid: OVERVANING,
  name: 'Övervåning',
  registeredOn,
  ...extra,
})

let publish: MockInstance<typeof queue.publish>
beforeEach(() => {
  publish = vi.spyOn(queue, 'publish').mockResolvedValue(undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('recentDays', () => {
  test('today and the two days before, without a previous success', () => {
    expect(recentDays(TODAY, null)).toEqual({
      days: ['2026-04-01', '2026-04-02', TODAY],
      skipped: 0,
    })
  })

  test('a recent success keeps the three-day window', () => {
    expect(recentDays(TODAY, new Date('2026-04-03T04:20:00Z')).days).toEqual([
      '2026-04-01',
      '2026-04-02',
      TODAY,
    ])
  })

  test('after an outage it reaches back to the day the last success started', () => {
    expect(recentDays(TODAY, new Date('2026-03-28T18:20:00Z'))).toEqual({
      days: daysFrom('2026-03-28', TODAY),
      skipped: 0,
    })
  })

  test('the catch-up is capped at 14 days and says how many it skipped', () => {
    const result = recentDays(TODAY, new Date('2026-03-04T00:20:00Z'))
    expect(result.days).toEqual(daysFrom('2026-03-21', TODAY))
    expect(result.days).toHaveLength(14)
    expect(result.skipped).toBe(17) // 2026-03-04 … 2026-03-20
  })

  test('a last success in the future changes nothing', () => {
    expect(recentDays(TODAY, new Date('2026-04-09T00:00:00Z')).days).toHaveLength(3)
  })
})

describe('backfillCandidates', () => {
  test('days with data at or before `from` and not before registeredOn, newest first', () => {
    const rows = ['2026-03-01', '2026-03-05', '2026-03-09', '2026-03-12', '2026-03-31'].map(
      (day) => ({ day, energyKwh: 0.6 }),
    )
    expect(backfillCandidates(rows, { from: '2026-03-12', registeredOn: '2026-03-05' })).toEqual([
      '2026-03-12',
      '2026-03-09',
      '2026-03-05',
    ])
  })

  test('nothing listed, nothing to fetch', () => {
    expect(backfillCandidates([], { from: '2026-03-31', registeredOn: '2026-03-01' })).toEqual([])
  })
})

test('a first run stores the recent days of every unit, backfills each to registered_on and completes both', async () => {
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')])

  const result = await run(client)

  const recent = ['2026-04-01', '2026-04-02', TODAY]
  expect(calls).toEqual([
    'units',
    ...recent.map((d) => `day:${MATSAL}:${d}`),
    ...recent.map((d) => `day:${OVERVANING}:${d}`),
    `month:${MATSAL}:2026-03`,
    ...daysFrom('2026-03-25', '2026-03-31')
      .reverse()
      .map((d) => `day:${MATSAL}:${d}`),
    `month:${OVERVANING}:2026-03`,
    ...daysFrom('2026-03-28', '2026-03-31')
      .reverse()
      .map((d) => `day:${OVERVANING}:${d}`),
  ])
  // Today is filled up to 10:00 (11 hours); every past day has 24.
  expect(result).toMatchObject({
    source: 'comfortCloud',
    outcome: 'ok',
    code: null,
    units: 2,
    daysFetched: 17,
    monthsFetched: 2,
    hoursStored: 9 * 24 + 11 + 6 * 24 + 11,
    emptyDays: 0,
    rejectedDays: 0,
    unitsCompleted: 2,
    backfillDaysLeft: 0,
    since: new Date('2026-03-25T00:00:00Z'),
  })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await hoursStored('Matsal', '2026-03-24')).toBe(0)
  expect(await unitNamed('Matsal')).toMatchObject({
    registeredOn: '2026-03-25',
    historyCompleteAt: NOW,
  })
  expect(await unitNamed('Övervåning')).toMatchObject({
    registeredOn: '2026-03-28',
    historyCompleteAt: NOW,
  })
  expect((await getHealth('comfortCloud', { now: NOW, includeAdminDetail: false })).state).toBe('ok')
})

test('a complete unit is not backfilled again: the next run fetches only the recent days', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])

  await run(client)

  expect(calls).toEqual([
    'units',
    `day:${MATSAL}:2026-04-01`,
    `day:${MATSAL}:2026-04-02`,
    `day:${MATSAL}:${TODAY}`,
  ])
})

test('after a five-day outage the next run re-fetches every missed day', async () => {
  await run(fakeComfortCloud([matsal('2026-04-01')]).client) // last success starts at NOW (2026-04-03)
  const later = new Date('2026-04-08T10:00:00Z')
  const { client, calls } = fakeComfortCloud([matsal('2026-04-01')], { now: later })

  await run(client, { now: () => later })

  expect(calls.filter((c) => c.startsWith('day:'))).toEqual(
    daysFrom(TODAY, '2026-04-08').map((d) => `day:${MATSAL}:${d}`),
  )
  for (const day of daysFrom('2026-04-04', '2026-04-07')) expect(await hoursStored('Matsal', day)).toBe(24)
})

test('a catch-up capped at 14 days warns how many days it skipped', async () => {
  await run(fakeComfortCloud([matsal('2026-03-01')]).client)
  const later = new Date('2026-05-03T10:00:00Z')
  const cap = capturingLogger()

  await run(fakeComfortCloud([matsal('2026-03-01')], { now: later }).client, {
    now: () => later,
    log: cap.log,
  })

  expect(cap.entries().find((e) => e.msg === 'comfort cloud catch-up capped')).toMatchObject({
    skippedDays: 17,
  })
})

test('a gap month costs one month call and no day calls', async () => {
  const { client, calls } = fakeComfortCloud([
    matsal('2026-01-20', { hasData: (day) => !day.startsWith('2026-02') }),
  ])

  const result = await run(client)

  expect(calls).toContain(`month:${MATSAL}:2026-02`)
  expect(calls.filter((c) => c.startsWith(`day:${MATSAL}:2026-02`))).toEqual([])
  expect(result).toMatchObject({ outcome: 'ok', monthsFetched: 3, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', '2026-01-20')).toBe(24)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
})

test('at most 60 backfill days per unit a run; the next run resumes below the oldest stored day', async () => {
  const first = fakeComfortCloud([matsal('2025-12-01')])

  const result = await run(first.client)

  const days = backfillCalls(first.calls, MATSAL).filter((c) => c.startsWith('day:'))
  expect(days).toHaveLength(60)
  expect(days.at(-1)).toBe(`day:${MATSAL}:2026-01-31`)
  // 2025-12-01 … 2026-01-30 are still missing.
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 0, backfillDaysLeft: 61 })
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toBeNull()

  const second = fakeComfortCloud([matsal('2025-12-01')])
  await run(second.client)
  expect(backfillCalls(second.calls, MATSAL).slice(0, 2)).toEqual([
    `month:${MATSAL}:2026-01`,
    `day:${MATSAL}:2026-01-30`,
  ])
})

test('no new backfill call once the run is 120 s old; the estimate says what is left', async () => {
  let clock = NOW.getTime()
  const tick = () => {
    clock += 10_000
  }
  const { client, calls } = fakeComfortCloud([matsal('2026-03-01')], { onCall: tick })

  const result = await run(client, { now: () => new Date(clock) })

  // units + 3 recent days + the month = 50 s; then one day per 10 s until 120 s.
  expect(backfillCalls(calls, MATSAL)).toEqual([
    `month:${MATSAL}:2026-03`,
    ...daysFrom('2026-03-25', '2026-03-31')
      .reverse()
      .map((d) => `day:${MATSAL}:${d}`),
  ])
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 0, backfillDaysLeft: 24 })
})

test('a rejected backfill day is skipped, warned without values, and the walk still completes', async () => {
  const bad = '2026-03-28'
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: {
      // 7.654321 kWh in an hour is outside the reading CHECK (< 5): INVALID_READING.
      [`${MATSAL}:${bad}`]: () => ({ registeredOn: '2026-03-25', rows: hoursOf(bad, NOW, 7.654321) }),
    },
  })

  const result = await run(client, { log: cap.log })

  expect(result).toMatchObject({ outcome: 'ok', rejectedDays: 1, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', bad)).toBe(0)
  expect(await hoursStored('Matsal', '2026-03-27')).toBe(24)
  expect(cap.entries().find((e) => e.msg === 'comfort cloud day rejected')).toMatchObject({
    unit: 'Matsal',
    day: bad,
    code: 'INVALID_READING',
  })
  expect(cap.raw()).not.toContain('7.654321')
  expect(cap.raw()).not.toContain(MATSAL)
})

test('a listed day that answers no hours is skipped and the walk still completes', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-03-27`]: () => ({ registeredOn: '2026-03-25', rows: [] }) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', emptyDays: 1, unitsCompleted: 1 })
  expect(await hoursStored('Matsal', '2026-03-26')).toBe(24)
})

test('an empty recent day keeps its stored hours', async () => {
  await run(fakeComfortCloud([matsal('2026-03-25')]).client)
  const { client } = fakeComfortCloud([matsal('2026-03-25')], {
    days: { [`${MATSAL}:2026-04-01`]: () => ({ registeredOn: '2026-03-25', rows: [] }) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'ok', emptyDays: 1 })
  expect(await hoursStored('Matsal', '2026-04-01')).toBe(24)
})

test('yesterday empty fails the run, after the rest has landed', async () => {
  const { client } = fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')], {
    days: { [`${OVERVANING}:2026-04-02`]: () => ({ registeredOn: '2026-03-28', rows: [] }) },
  })

  const result = await run(client)

  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response', unitsCompleted: 2 })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await hoursStored('Övervåning', '2026-04-01')).toBe(24)
  const health = await getHealth('comfortCloud', { now: NOW, includeAdminDetail: true })
  expect(health.adminDetail?.lastErrorMessage).toContain('Övervåning')
  expect(health.adminDetail?.lastErrorMessage).toContain('2026-04-02')
  expect(health.adminDetail?.lastErrorMessage).not.toContain('Matsal')
})

// No false "recovered" email: day after day without data keeps the source failing.
test('an outage keeps the run failing until data returns', async () => {
  const quiet = matsal('2026-03-25', { hasData: (day) => day < '2026-04-01' })
  expect(await run(fakeComfortCloud([quiet]).client)).toMatchObject({
    outcome: 'failed',
    code: 'unexpected_response',
    emptyDays: 3,
  })
  const nextDay = new Date('2026-04-04T10:00:00Z')
  expect(
    await run(fakeComfortCloud([quiet], { now: nextDay }).client, { now: () => nextDay }),
  ).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
  const health = await getHealth('comfortCloud', { now: nextDay, includeAdminDetail: true })
  expect(health.state).toBe('failing')
  expect(health.adminDetail?.lastErrorMessage).toContain('Matsal')

  // Data back (yesterday answered): green again.
  const back = new Date('2026-04-05T10:00:00Z')
  expect(
    await run(fakeComfortCloud([matsal('2026-03-25')], { now: back }).client, { now: () => back }),
  ).toMatchObject({ outcome: 'ok' })
})

// NOW − 14 days = 2026-03-20T10:00Z. The unit's data stops on 2026-03-20; the
// scripted last day decides whether its newest hour is exactly 14 days old or an hour older.
const lastDataUpTo = (upTo: string) =>
  fakeComfortCloud([matsal('2026-03-15', { hasData: (day) => day <= '2026-03-20' })], {
    days: {
      [`${MATSAL}:2026-03-20`]: () => ({
        registeredOn: '2026-03-15',
        rows: hoursOf('2026-03-20', new Date(upTo)),
      }),
    },
  })

test('the newest hour exactly 14 days old still fails the run', async () => {
  const result = await run(lastDataUpTo('2026-03-20T10:00:00Z').client)
  expect(result).toMatchObject({ outcome: 'failed', code: 'unexpected_response' })
})

test('data older than 14 days only warns, every run', async () => {
  const cap = capturingLogger()
  expect(await run(lastDataUpTo('2026-03-20T09:00:00Z').client, { log: cap.log })).toMatchObject({
    outcome: 'ok',
  })
  expect(await run(lastDataUpTo('2026-03-20T09:00:00Z').client, { log: cap.log })).toMatchObject({
    outcome: 'ok',
  })
  const warnings = cap.entries().filter((e) => e.msg === 'comfort cloud unit without data')
  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toMatchObject({ unit: 'Matsal', daysWithoutData: 14 })
})

test('a unit registered today has no yesterday to miss', async () => {
  const { client } = fakeComfortCloud([matsal(TODAY)])
  expect(await run(client)).toMatchObject({ outcome: 'ok', emptyDays: 2 })
})

test('no units listed fails the run as unexpected_response', async () => {
  const { client, calls } = fakeComfortCloud([])
  expect(await run(client)).toMatchObject({ outcome: 'failed', code: 'unexpected_response', units: 0 })
  expect(calls).toEqual(['units'])
})

// setRegisteredOn clears history_complete_at when the day moves earlier (step 1a):
// the sync backfills the newly reported days in the same run.
test('a complete unit whose registered_on moves earlier is backfilled again', async () => {
  await run(fakeComfortCloud([matsal('2026-03-28')]).client)
  expect((await unitNamed('Matsal'))?.historyCompleteAt).toEqual(NOW)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])

  const result = await run(client)

  expect(backfillCalls(calls, MATSAL).filter((c) => !c.includes(':2026-04-'))).toEqual([
    `month:${MATSAL}:2026-03`,
    `day:${MATSAL}:2026-03-27`,
    `day:${MATSAL}:2026-03-26`,
    `day:${MATSAL}:2026-03-25`,
  ])
  expect(result).toMatchObject({ outcome: 'ok', unitsCompleted: 1, backfillDaysLeft: 0 })
  expect(await hoursStored('Matsal', '2026-03-25')).toBe(24)
  expect(await unitNamed('Matsal')).toMatchObject({
    registeredOn: '2026-03-25',
    historyCompleteAt: NOW,
  })
})

test('a later registered_on is stored and keeps the unit complete', async () => {
  await run(fakeComfortCloud([matsal('2026-03-27')]).client)
  const { client, calls } = fakeComfortCloud([matsal('2026-03-28')])
  await run(client)
  expect(calls.filter((c) => c.startsWith('month:'))).toEqual([])
  expect((await unitNamed('Matsal'))?.registeredOn).toBe('2026-03-28')
})

test('a remote failure is failed with its code; admins are alerted on the second in a row', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const client: ComfortCloudClient = {
    units: async () => {
      throw new ComfortCloudError('auth_failed', 'login', 401)
    },
    dayHours: async () => ({ registeredOn: '2026-03-01', rows: [] }),
    monthDays: async () => ({ registeredOn: '2026-03-01', rows: [] }),
  }

  expect(await run(client)).toMatchObject({ outcome: 'failed', code: 'auth_failed', daysFetched: 0 })
  expect(publish).not.toHaveBeenCalled()

  await run(client)
  expect(publish).toHaveBeenCalledWith(
    'email_integration_sync_alert',
    expect.objectContaining({
      source: 'comfortCloud',
      transition: 'started_failing',
      to: 'a@example.com',
    }),
  )
})

test('a call that outlives the deadline fails as unreachable', async () => {
  const client: ComfortCloudClient = {
    units: () => new Promise(() => {}),
    dayHours: () => new Promise(() => {}),
    monthDays: () => new Promise(() => {}),
  }
  const result = await runComfortCloudSync({
    trigger: 'admin',
    now: () => NOW,
    deadlineMs: 20,
    deps: { comfortCloud: client, log: capturingLogger().log, sleep: async () => {} },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'unreachable' })
})

test('a held lease skips the run without calling Comfort Cloud', async () => {
  await beginAttempt('comfortCloud', { now: NOW })
  const { client, calls } = fakeComfortCloud([matsal('2026-03-25')])
  expect((await run(client)).outcome).toBe('skipped')
  expect(calls).toEqual([])
})

test('without credentials (the real facade under VITEST) the run is not_configured and alerts nobody', async () => {
  await db.insert(user).values({ name: 'A', email: 'a@example.com', role: 'admin' })
  const result = await runComfortCloudSync({
    trigger: 'cron',
    now: () => NOW,
    deps: { log: capturingLogger().log },
  })
  expect(result).toMatchObject({ outcome: 'failed', code: 'not_configured' })
  expect(publish).not.toHaveBeenCalled()
})

test('backfill pauses between day calls', async () => {
  const sleeps: number[] = []
  await run(fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')]).client, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  // Matsal 7 backfill days → 6 pauses; Övervåning 4 → 3.
  expect(sleeps).toHaveLength(9)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('progress: recent days plus 60 per unit to backfill, shrunk as units complete, ending at the total', async () => {
  const spy = vi.spyOn(integrationSyncService, 'reportProgress')
  await run(fakeComfortCloud([matsal('2026-03-25'), overvaning('2026-03-28')]).client)
  const reports = spy.mock.calls.map(([, , p]) => p)
  // A constant clock: the 1 s throttle passes the first write and every done === total write.
  // 126 = 2 units × 3 recent days + 2 units × 60; Matsal gives back 53, Övervåning 56.
  expect(reports).toEqual([
    { done: 1, total: 126 },
    { done: 17, total: 17 },
  ])
})

test('one run row and one run line, counts only, never an hourly value', async () => {
  const cap = capturingLogger()
  const { client } = fakeComfortCloud([matsal('2026-04-01', { kwh: 0.123456 })])

  const result = await run(client, { log: cap.log })

  const [row] = await listRecentRuns('comfortCloud', { limit: 5 })
  // Zaptec-era columns: pages = days fetched, sessionsSeen/upserted = hours stored.
  expect(row).toMatchObject({
    outcome: 'ok',
    pages: 3,
    sessionsSeen: result.hoursStored,
    upserted: result.hoursStored,
  })
  const [stored] = await db.select().from(integrationSyncRun)
  expect(stored.timings).toEqual({
    fetchMs: 20, // the fake: 5 ms × 4 calls
    requests: 4,
    retries: 0,
    logins: 1,
    storeMs: expect.any(Number),
    units: 1,
    daysFetched: 3,
    monthsFetched: 0,
    emptyDays: 0,
    rejectedDays: 0,
    unitsCompleted: 1,
    backfillDaysLeft: 0,
  })
  const lines = cap.entries().filter((e) => e.msg === 'integration sync run')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    source: 'comfortCloud',
    units: 1,
    daysFetched: 3,
    hoursStored: 2 * 24 + 11,
    unitsCompleted: 1,
  })
  expect(cap.raw()).not.toContain('0.123456')
  expect(cap.raw()).not.toContain(MATSAL)
})
```

- [ ] **Step 5: Run it, expect FAIL**

`bunx vitest run src/lib/heatPump/sync.test.ts` → FAIL (module `./sync` not found).

- [ ] **Step 6: Implement**

```ts
// src/lib/heatPump/sync.ts
import {
  type ComfortCloudCallStats,
  type ComfortCloudClient,
  type ComfortCloudDay,
  ComfortCloudError,
  comfortCloud,
  newCallStats,
} from '~/lib/effects/comfortCloud'
import type { SyncTrigger } from '~/lib/integrationHealth'
import { type RunBase, runPulledSync, withDeadline } from '~/lib/integrations/runPulledSync'
import type { Logger } from '~/lib/logger'
import { logger } from '~/lib/logger/server'
import {
  type HeatPump,
  HeatPumpDomainError,
  markHistoryComplete,
  newestHour,
  oldestDay,
  replaceDay,
  setRegisteredOn,
  upsertUnits,
} from '~/lib/services/heatPump'
import { getLastSuccessStartedAt } from '~/lib/services/integrationSync'

// Server-only (db, effects). Never import it from client code — and keep
// `src/lib/heatPump/` free of an index barrel, so the client-safe modules that
// steps 4a/4b add beside it stay importable on their own.

/**
 * The Comfort Cloud sync run (ADR-0019, ADR-0027), inside the shared
 * `runPulledSync` lifecycle: list the units, re-fetch every unit's recent UTC
 * days, then backfill each unit newest first until its `registered_on`. No
 * reading ever reaches a log line, an error message or a run row — only counts;
 * units are named, never identified by guid.
 */
export type ComfortCloudSyncRun = RunBase & {
  source: 'comfortCloud'
  /** Air conditioners Comfort Cloud listed. */
  units: number
  /** Day answers (`dayHours`), recent + backfill. */
  daysFetched: number
  /** Month answers (`monthDays`): one per backfilled month, gap months included. */
  monthsFetched: number
  /** Hourly readings written (replaced days only). */
  hoursStored: number
  /** Day answers without hours; what's stored is kept. */
  emptyDays: number
  /** Days whose hours failed validation (INVALID_READING); skipped and warned. */
  rejectedDays: number
  /** Units whose backfill reached registered_on in this run. */
  unitsCompleted: number
  /** Estimate: calendar days between registered_on and each incomplete unit's walk. */
  backfillDaysLeft: number
  /** Summed request time from the client's stats sink (busy time, not latency: that is `durationMs`). */
  fetchMs: number
  storeMs: number
  requests: number
  /** Request retries inside the client's shared `fetchWithRetry`. */
  retries: number
  logins: number
}

const SOURCE = 'comfortCloud'
/** Today and the two previous UTC days: the current hour fills in, the last days settle. */
const RECENT_DAYS = 3
/** After an outage the recent window reaches back to the last success's day, at most this far. */
const CATCH_UP_MAX_DAYS = 14
/** Backfill day calls per unit a run; ≈ 700 days each spread over ≈ 6 runs. */
const BACKFILL_DAYS_PER_UNIT = 60
/** No new backfill call once the run is this old; the next run continues. */
const DAY_BUDGET_MS = 120_000
/** Pause between backfill day calls: an unofficial API, on the owner's own account. */
const BACKFILL_PAUSE_MS = 500
/** Same 240 s as the other pulled sources: under Vercel's 300 s, room for the login. */
const RUN_DEADLINE_MS = 240_000
/**
 * A unit quiet yesterday fails the run while its newest stored hour is at most
 * this old; longer without data (a removed or long-dead unit) it only warns.
 */
const OFFLINE_ALERT_MS = 14 * 86_400_000

const DAY_MS = 86_400_000
const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addUtcDays = (day: string, n: number) =>
  utcDayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const utcDaysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const utcStart = (day: string) => new Date(`${day}T00:00:00Z`)

/**
 * Pure: the UTC days a run re-fetches for every unit, oldest first. Today and
 * the two days before; after an outage, back to the day the last successful
 * run started (the days since then may never have landed), at most 14 days.
 * `skipped` counts the days the cap left out (a hole the backfill won't fill).
 */
export function recentDays(
  today: string,
  lastSuccessStartedAt: Date | null,
): { days: string[]; skipped: number } {
  let from = addUtcDays(today, -(RECENT_DAYS - 1))
  let skipped = 0
  if (lastSuccessStartedAt) {
    const resume = utcDayOf(lastSuccessStartedAt.getTime())
    if (resume < from) {
      const floor = addUtcDays(today, -(CATCH_UP_MAX_DAYS - 1))
      if (resume < floor) {
        skipped = utcDaysBetween(resume, floor)
        from = floor
      } else {
        from = resume
      }
    }
  }
  return {
    days: Array.from({ length: utcDaysBetween(from, today) + 1 }, (_, i) => addUtcDays(from, i)),
    skipped,
  }
}

/** Pure: the listed days with data in [registeredOn, from], newest first. */
export function backfillCandidates(
  rows: readonly ComfortCloudDay[],
  a: { from: string; registeredOn: string },
): string[] {
  return [...new Set(rows.map((r) => r.day))]
    .filter((day) => day <= a.from && day >= a.registeredOn)
    .sort()
    .reverse()
}

export async function runComfortCloudSync(opts: {
  trigger: SyncTrigger
  now?: () => Date
  /** Overrides the 240 s deadline (tests). */
  deadlineMs?: number
  deps?: {
    comfortCloud?: ComfortCloudClient
    log?: Logger
    sleep?: (ms: number) => Promise<void>
  }
}): Promise<ComfortCloudSyncRun> {
  const client = opts.deps?.comfortCloud ?? comfortCloud
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const stats = newCallStats()
  return runPulledSync<ComfortCloudSyncRun>({
    source: SOURCE,
    trigger: opts.trigger,
    now: opts.now ?? (() => new Date()),
    deadlineMs: opts.deadlineMs ?? RUN_DEADLINE_MS,
    log: opts.deps?.log ?? logger,
    init: (base) => ({
      ...base,
      // Already set in `base`; restated to narrow the type to 'comfortCloud'.
      source: SOURCE,
      units: 0,
      daysFetched: 0,
      monthsFetched: 0,
      hoursStored: 0,
      emptyDays: 0,
      rejectedDays: 0,
      unitsCompleted: 0,
      backfillDaysLeft: 0,
      fetchMs: 0,
      storeMs: 0,
      requests: 0,
      retries: 0,
      logins: 0,
    }),
    execute: ({ run, signal, now, log, reportProgress }) =>
      syncUnits(client, run, { signal, stats, now, sleep, log, reportProgress }),
    // Sees `run` before `finalize`: the call stats come from the sink directly.
    toRunStats: (run) => ({
      since: run.since,
      // Zaptec-era column names: pages = days fetched, sessionsSeen/upserted = hours stored.
      pages: run.daysFetched,
      sessionsSeen: run.hoursStored,
      upserted: run.hoursStored,
      voided: 0,
      timings: {
        fetchMs: Math.round(stats.fetchMs),
        requests: stats.requests,
        retries: stats.retries,
        logins: stats.logins,
        storeMs: Math.round(run.storeMs),
        units: run.units,
        daysFetched: run.daysFetched,
        monthsFetched: run.monthsFetched,
        emptyDays: run.emptyDays,
        rejectedDays: run.rejectedDays,
        unitsCompleted: run.unitsCompleted,
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
      units: run.units,
      daysFetched: run.daysFetched,
      monthsFetched: run.monthsFetched,
      hoursStored: run.hoursStored,
      emptyDays: run.emptyDays,
      rejectedDays: run.rejectedDays,
      unitsCompleted: run.unitsCompleted,
      backfillDaysLeft: run.backfillDaysLeft,
      fetchMs: run.fetchMs,
      storeMs: run.storeMs,
      requests: run.requests,
      retries: run.retries,
      logins: run.logins,
    }),
  })
}

type Ctx = {
  signal: AbortSignal
  stats: ComfortCloudCallStats
  now: () => Date
  sleep: (ms: number) => Promise<void>
  log: Logger
  reportProgress: (done: number, total: number) => Promise<void>
}

type Unit = {
  id: string
  guid: string
  name: string
  registeredOn: string | null
  complete: boolean
}

type Progress = { step: () => Promise<void>; shrink: (unused: number) => Promise<void> }

const toUnit = (row: HeatPump): Unit => ({
  id: row.id,
  guid: row.guid,
  name: row.name,
  registeredOn: row.registeredOn,
  complete: row.historyCompleteAt !== null,
})

// Recent days first, for every unit (they matter most, and a long backfill
// must never starve them), then each unit's backfill. Mutates `run` as it goes,
// so a failure part-way still reports — and keeps — what landed.
async function syncUnits(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
): Promise<void> {
  const today = utcDayOf(ctx.now().getTime())
  const yesterday = addUtcDays(today, -1)

  const listed = await call(ctx, 'units', (o) => client.units(o))
  if (listed.length === 0) {
    // An empty list from a changed API must not read as a green sync.
    throw new ComfortCloudError('unexpected_response', 'units', undefined, {
      message: 'Comfort Cloud listed no air conditioners on the account',
    })
  }
  const rows = await upsertUnits(
    listed.map(({ guid, name, model }) => ({ guid, name, model })),
    ctx.now(),
  )
  const units = rows.map(toUnit).sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  run.units = units.length

  const recent = recentDays(today, await getLastSuccessStartedAt(SOURCE))
  if (recent.skipped > 0) {
    ctx.log.warn('comfort cloud catch-up capped', { skippedDays: recent.skipped })
  }
  run.since = utcStart(recent.days[0])
  const initiallyIncomplete = units.filter((u) => !u.complete).length
  const progress = newProgress(
    ctx.reportProgress,
    units.length * recent.days.length + initiallyIncomplete * BACKFILL_DAYS_PER_UNIT,
  )

  // Units that answered no hours for yesterday, the newest complete UTC day.
  // A unit registered after yesterday has no yesterday to miss.
  const quiet: Unit[] = []
  for (const unit of units) {
    let yesterdayHours = 0
    for (const day of recent.days) {
      const hours = await syncDay(client, run, ctx, unit, day)
      if (day === yesterday) yesterdayHours = hours
      await progress.step()
    }
    if (yesterdayHours === 0 && unit.registeredOn !== null && unit.registeredOn <= yesterday) {
      quiet.push(unit)
    }
  }

  // A registered_on that moved earlier reopened a complete unit (setRegisteredOn
  // cleared history_complete_at): it is backfilled in this run too.
  const backfilling = units.filter((u) => !u.complete)
  if (backfilling.length > initiallyIncomplete) {
    await progress.shrink(-(backfilling.length - initiallyIncomplete) * BACKFILL_DAYS_PER_UNIT)
  }
  for (const unit of backfilling) await backfillUnit(client, run, ctx, unit, today, progress)

  // After the backfill, so its progress still lands. Comfort Cloud returns past
  // hours reliably, so a quiet yesterday means the unit (or its Wi-Fi adapter)
  // is offline: the run fails — Comfort Cloud's failure (`failed`), not ours —
  // every run until data returns, so an outage never reads as "recovered". A
  // unit without data for over 14 days (removed, or long dead) only warns, so it
  // stops alerting after two weeks.
  const offline: string[] = []
  for (const unit of quiet) {
    const newest = await newestHour(unit.id)
    const sinceMs = newest ? ctx.now().getTime() - newest.getTime() : Number.POSITIVE_INFINITY
    if (sinceMs <= OFFLINE_ALERT_MS) {
      offline.push(unit.name)
    } else {
      ctx.log.warn('comfort cloud unit without data', {
        unit: unit.name,
        daysWithoutData: newest ? Math.floor(sinceMs / DAY_MS) : null,
      })
    }
  }
  if (offline.length > 0) {
    throw new ComfortCloudError('unexpected_response', 'history', undefined, {
      message: `Comfort Cloud returned no hours for ${yesterday} (UTC) for ${offline.join(' and ')}: the unit or its Wi-Fi adapter may be offline`,
    })
  }
}

// Walks one unit's history newest first from the day before its oldest stored
// day. The month call says which days have data, so empty days and whole empty
// months cost no day call. The walk's position lives in memory: a rejected or
// empty day is passed over in this run (and, being above the next oldest
// stored day, never fetched again). Done once the walk passes registered_on.
async function backfillUnit(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
  unit: Unit,
  today: string,
  progress: Progress,
): Promise<void> {
  const oldest = await oldestDay(unit.id)
  let cursor = oldest ? addUtcDays(oldest, -1) : addUtcDays(today, -RECENT_DAYS)
  let fetched = 0
  let completed = false
  const outOfBudget = () => ctx.now().getTime() - run.startedAt.getTime() >= DAY_BUDGET_MS
  try {
    for (;;) {
      if (unit.registeredOn !== null && cursor < unit.registeredOn) {
        await markHistoryComplete(unit.id, ctx.now())
        run.unitsCompleted++
        completed = true
        await progress.shrink(BACKFILL_DAYS_PER_UNIT - fetched)
        return
      }
      if (fetched >= BACKFILL_DAYS_PER_UNIT || outOfBudget()) return
      const month = cursor.slice(0, 7)
      const listedDays = await call(ctx, 'history', (o) => client.monthDays(unit.guid, month, o))
      run.monthsFetched++
      await noteRegisteredOn(unit, listedDays.registeredOn)
      const registeredOn = unit.registeredOn ?? listedDays.registeredOn
      for (const day of backfillCandidates(listedDays.rows, { from: cursor, registeredOn })) {
        if (fetched >= BACKFILL_DAYS_PER_UNIT || outOfBudget()) return
        if (fetched > 0) await ctx.sleep(BACKFILL_PAUSE_MS)
        await syncDay(client, run, ctx, unit, day)
        fetched++
        cursor = addUtcDays(day, -1)
        if (run.since === null || utcStart(day) < run.since) run.since = utcStart(day)
        await progress.step()
      }
      // The month is done: continue with the last day of the month before.
      cursor = addUtcDays(`${month}-01`, -1)
    }
  } finally {
    if (!completed && unit.registeredOn !== null) {
      run.backfillDaysLeft += Math.max(0, utcDaysBetween(unit.registeredOn, cursor) + 1)
    }
  }
}

// Fetches and stores one UTC day for one unit; returns how many hours Comfort
// Cloud answered. An empty answer, or hours that fail validation, store nothing
// and keep what's stored.
async function syncDay(
  client: ComfortCloudClient,
  run: ComfortCloudSyncRun,
  ctx: Ctx,
  unit: Unit,
  day: string,
): Promise<number> {
  const answer = await call(ctx, 'history', (o) => client.dayHours(unit.guid, day, o))
  run.daysFetched++
  await noteRegisteredOn(unit, answer.registeredOn)
  // An empty answer never deletes what's stored.
  if (answer.rows.length === 0) {
    run.emptyDays++
    return 0
  }
  const started = performance.now()
  try {
    run.hoursStored += (await replaceDay(unit.id, day, answer.rows)).stored
  } catch (error) {
    if (!(error instanceof HeatPumpDomainError) || error.code !== 'INVALID_READING') throw error
    run.rejectedDays++
    // The code and the day only: the domain message could name a value.
    ctx.log.warn('comfort cloud day rejected', { unit: unit.name, day, code: error.code })
  } finally {
    run.storeMs += performance.now() - started
  }
  return answer.rows.length
}

// Every history answer carries the unit's first data day; store it when it
// changes. setRegisteredOn clears history_complete_at when the day moves
// earlier (step 1a); mirror that so the unit is backfilled in this run.
async function noteRegisteredOn(unit: Unit, registeredOn: string): Promise<void> {
  if (unit.registeredOn === registeredOn) return
  const reopens = unit.complete && unit.registeredOn !== null && registeredOn < unit.registeredOn
  await setRegisteredOn(unit.id, registeredOn)
  unit.registeredOn = registeredOn
  if (reopens) unit.complete = false
}

// One remote call with the run's signal and stats sink, also raced against the
// deadline (a client that ignores the signal still can't outlive the run).
function call<T>(
  ctx: Ctx,
  op: 'units' | 'history',
  fn: (o: { signal: AbortSignal; stats: ComfortCloudCallStats }) => Promise<T>,
): Promise<T> {
  return withDeadline(
    fn({ signal: ctx.signal, stats: ctx.stats }),
    ctx.signal,
    () =>
      new ComfortCloudError('unreachable', op, undefined, {
        cause: { name: 'TimeoutError' },
        message: `Comfort Cloud ${op} did not finish within the sync deadline`,
      }),
  )
}

// Days done / days planned for the Datakällor tile. The plan counts 60 backfill
// days per incomplete unit (a reopened unit adds its 60: a negative shrink); a
// unit that completes early gives the rest back, so a finished run ends at
// done === total. A budget stop leaves it below.
function newProgress(report: Ctx['reportProgress'], initialTotal: number): Progress {
  let done = 0
  let total = initialTotal
  return {
    step: () => report(++done, total),
    shrink: (unused) => {
      total -= unused
      return report(done, total)
    },
  }
}
```

If Task 0 found a 1a UTC helper module, replace the five private one-liners with its functions (same semantics:
UTC calendar days as `YYYY-MM-DD`).

- [ ] **Step 7: Run, expect PASS**

```bash
bunx vitest run src/lib/heatPump/sync.test.ts src/lib/services/heatPump
TZ=UTC bunx vitest run src/lib/heatPump/sync.test.ts   # the UTC day maths must not depend on the zone
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/heatPump src/lib/services/heatPump
git commit -m "feat(heat-pumps): add the Comfort Cloud sync run with backfill" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Run it — 6-hourly cron, admin `syncNow`, docs

**Files:**
- Create: `src/lib/heatPump/comfortCloudSyncCron.ts`, `src/routes/api/cron/comfort-cloud-sync.ts`
- Modify: `vite.config.ts:140-150` (crons + their comment), `src/routeTree.gen.ts` (regenerated, never hand-edited),
  `src/lib/orpc/procedures/evCharging.ts:34-40,302` (`chargingSource`, `syncNow`), `CLAUDE.md`, `.env.example`
- Test: `src/lib/heatPump/comfortCloudSyncCron.test.ts`, `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: `runComfortCloudSync` (Task 4), `handleCronRun` (`~/lib/integrations/cron`).
- Produces: `handleComfortCloudSyncCron(request: Request): Promise<Response>`; `GET /api/cron/comfort-cloud-sync` →
  401 without the secret, 200 `{ outcome, code, units, daysFetched, hoursStored, backfillDaysLeft }`, 500 on an
  unexpected throw; `evCharging.syncNow({ source: 'comfortCloud' }) → { outcome, code, upserted }` (admin; `upserted`
  = hours stored); request timings `comfortCloudSyncMs`, `comfortCloudFetchMs`, `comfortCloudStoreMs`.

**Reviewers:** A = `code-reviewer`, B = security reviewer loading `better-auth-security-best-practices` (the cron route
and `syncNow` are permission boundaries: `CRON_SECRET` gate, `adminProcedure`, counts only in every body).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/heatPump/comfortCloudSyncCron.test.ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setupDatabase } from '~test/setup'

const control = vi.hoisted(() => ({ throwFromSync: false, okRun: false }))
vi.mock('./sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sync')>()
  return {
    ...actual,
    runComfortCloudSync: (opts: Parameters<typeof actual.runComfortCloudSync>[0]) => {
      if (control.throwFromSync) return Promise.reject(new Error('sync exploded'))
      if (control.okRun)
        return Promise.resolve({
          outcome: 'ok',
          code: null,
          units: 2,
          daysFetched: 126,
          hoursStored: 3_000,
          backfillDaysLeft: 540,
        })
      return actual.runComfortCloudSync(opts)
    },
  }
})

import { handleComfortCloudSyncCron } from './comfortCloudSyncCron'

setupDatabase()

const SECRET = 'test-cron-secret'
const request = (auth?: string) =>
  new Request('http://localhost/api/cron/comfort-cloud-sync', {
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
  expect((await handleComfortCloudSyncCron(request())).status).toBe(401)
  expect((await handleComfortCloudSyncCron(request('Bearer nope'))).status).toBe(401)
})

test('a not-configured run is still a 200 with its summary', async () => {
  const res = await handleComfortCloudSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'failed',
    code: 'not_configured',
    units: 0,
    daysFetched: 0,
    hoursStored: 0,
    backfillDaysLeft: 0,
  })
})

test('an unexpected throw is a 500', async () => {
  control.throwFromSync = true
  expect((await handleComfortCloudSyncCron(request(`Bearer ${SECRET}`))).status).toBe(500)
})

test('an ok run is a 200 with its counts', async () => {
  control.okRun = true
  const res = await handleComfortCloudSyncCron(request(`Bearer ${SECRET}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    outcome: 'ok',
    code: null,
    units: 2,
    daysFetched: 126,
    hoursStored: 3_000,
    backfillDaysLeft: 540,
  })
})
```

Append to `evCharging.test.ts`:

```ts
test('syncNow with source comfortCloud runs only the heat pump sync and returns counts only', async () => {
  await signIn('admin')
  const timings: Record<string, number> = {}
  const result = await call(
    evChargingRouter.syncNow,
    { source: 'comfortCloud' },
    { context: { ...baseContext(), timings } },
  )
  // Not configured under VITEST.
  expect(result).toEqual({ outcome: 'failed', code: 'not_configured', upserted: 0 })
  for (const key of ['comfortCloudSyncMs', 'comfortCloudFetchMs', 'comfortCloudStoreMs'])
    expect(typeof timings[key]).toBe('number')
  const emaldo = await integrationSyncService.getHealth('emaldo', {
    now: new Date(),
    includeAdminDetail: false,
  })
  expect(emaldo.state).toBe('never_synced')
})

test('syncNow with source comfortCloud is forbidden for a non-admin user', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.syncNow, { source: 'comfortCloud' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

test('syncStatuses and recentRuns report Comfort Cloud’s own health and runs', async () => {
  await signIn('admin')
  await call(evChargingRouter.syncNow, { source: 'comfortCloud' }, { context: baseContext() })
  const health = await call(evChargingRouter.syncStatuses, undefined, { context: baseContext() })
  expect(health.comfortCloud).toMatchObject({ source: 'comfortCloud', state: 'not_configured' })
  const runs = await call(evChargingRouter.recentRuns, {}, { context: baseContext() })
  expect(runs.comfortCloud).toHaveLength(1)
  expect(runs.comfortCloud[0]).toMatchObject({ trigger: 'admin', errorCode: 'not_configured' })
})
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
bunx vitest run src/lib/heatPump/comfortCloudSyncCron.test.ts src/lib/orpc/procedures/evCharging.test.ts
```

Expected: FAIL (module not found; `source: 'comfortCloud'` rejected by the input schema).

- [ ] **Step 3: Implement**

```ts
// src/lib/heatPump/comfortCloudSyncCron.ts
import { handleCronRun } from '~/lib/integrations/cron'
import { runComfortCloudSync } from './sync'

// The 6-hourly (:20) Comfort Cloud cron entrypoint. Kept out of the route file
// so the flow is unit-testable; the secret gate and status mapping are shared
// (`handleCronRun`). The body carries counts only, never readings.
export function handleComfortCloudSyncCron(request: Request): Promise<Response> {
  return handleCronRun(
    request,
    (log) => runComfortCloudSync({ trigger: 'cron', deps: { log } }),
    (run) => ({
      units: run.units,
      daysFetched: run.daysFetched,
      hoursStored: run.hoursStored,
      backfillDaysLeft: run.backfillDaysLeft,
    }),
  )
}
```

```ts
// src/routes/api/cron/comfort-cloud-sync.ts
import { createFileRoute } from '@tanstack/react-router'
import { handleComfortCloudSyncCron } from '~/lib/heatPump/comfortCloudSyncCron'

// Every 6 h at :20 Vercel Cron target (vite.config.ts `vercel.config.crons`).
// Auth is `Authorization: Bearer $CRON_SECRET`, checked by the handler. Outside
// the `_authenticated` guard, like api/cron/emaldo-sync.ts.
export const Route = createFileRoute('/api/cron/comfort-cloud-sync')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleComfortCloudSyncCron(request),
    },
  },
})
```

`vite.config.ts` — after the Emaldo bullet in the crons comment:

```ts
              // - Comfort Cloud heat pumps every 6 h at :20 (00:20, 06:20, 12:20, 18:20 UTC) —
              //   clear of Zaptec's :00, Škoda's :07/:22/:37/:52, elpris's :30 and Emaldo's :45
              //   (src/lib/heatPump/comfortCloudSyncCron.ts).
```

and in `crons`, after the Emaldo entry:

```ts
                { path: '/api/cron/comfort-cloud-sync', schedule: '20 */6 * * *' },
```

`evCharging.ts`:

```ts
import { runComfortCloudSync } from '~/lib/heatPump/sync'
```

```ts
/**
 * The sources the charging settings page tracks: sessions (Zaptec), spot prices
 * (elpris), the car's live state (Škoda), the house's energy flows (Emaldo) and
 * the heat pumps (Comfort Cloud).
 */
const chargingSource = z.enum(['zaptec', 'elpris', 'skoda', 'emaldo', 'comfortCloud'])
```

and at the top of `syncNow`'s handler, before the `emaldo` branch:

```ts
    if (input?.source === 'comfortCloud') {
      const run = await runComfortCloudSync({ trigger: 'admin', deps: { log: context.log } })
      if (context.timings) {
        context.timings.comfortCloudSyncMs = run.durationMs
        context.timings.comfortCloudFetchMs = run.fetchMs
        context.timings.comfortCloudStoreMs = run.storeMs
      }
      // Counts only: hourly readings never leave the server (ADR-0027).
      return { outcome: run.outcome, code: run.code, upserted: run.hoursStored }
    }
```

Regenerate the route tree: `bun run build` (the TanStack router plugin rewrites `src/routeTree.gen.ts`); confirm
`grep -n "comfort-cloud-sync" src/routeTree.gen.ts` finds it.

- [ ] **Step 4: Docs**

`CLAUDE.md` (keep each line's style; skip a part step 1a already wrote):
- Stack, Effects bullet: `Pulled integrations (Zaptec, elpris, Škoda, Emaldo, Comfort Cloud) have **no** devLog adapter`.
- Code map, `api/cron/` line → `… emaldo-sync.ts hourly at :45, comfort-cloud-sync.ts every 6 h at :20, elpris-sync.ts
  12:30+15:30 UTC, grid-tariff-catalogue.ts monthly)`.
- Code map, `effects/` line: if 1a's `comfortCloud` entry lacks it, append "facade via keyedAdapter, fail closed".
- New code-map line after `houseEnergy/` (before `integrations/`):
  `    heatPump/                   Comfort Cloud sync (sync.ts: recent UTC days + catch-up ≤ 14 d + per-unit backfill to registered_on) + cron (ADR-0019, ADR-0027) — no index barrel`
- Environment variables: in the `CREDENTIALS_ENCRYPTION_KEY` bullet's override list add `PANASONIC_USER`/`PANASONIC_PASSWORD`
  (after the four `EMALDO_*`), and a new bullet after the `EMALDO_*` one:
  `- \`PANASONIC_USER\`/\`PANASONIC_PASSWORD\` (the owner's own Panasonic ID — a login doesn't end the app's session; the account must not demand a 2FA code; either unset → \`not_configured\`; Vercel Production only; ADR-0027); synced every 6 h at :20 by \`/api/cron/comfort-cloud-sync\`.`

`.env.example`:
- The `CREDENTIALS_ENCRYPTION_KEY` comment's list → `… the four EMALDO_*, PANASONIC_USER/PANASONIC_PASSWORD; not
  ZAPTEC_ADAPTER)`.
- `CRON_SECRET` comment's first two lines → `# Shared secret for Vercel Cron → /api/cron/* (the Zaptec, elpris, Škoda,
  Emaldo and Comfort Cloud syncs and the grid-tariff check).`
- After the `EMALDO_*` block (if step 1a didn't add one; else extend 1a's comment with the last three lines):

```
# Panasonic Comfort Cloud (ADR-0027): the two air-to-air heat pumps' hourly
# electricity use and temperatures. Unofficial API (port of aio-panasonic-comfort-cloud).
# The owner's own Panasonic ID: a login doesn't log the phone app out. The account
# must sign in with the password alone (a demanded 2FA code fails as auth_failed).
# Either blank = every call fails `not_configured`. Never commit real values.
# Synced every 6 h at :20 by /api/cron/comfort-cloud-sync (hourly rows into
# heat_pump_reading); the first runs backfill each unit to its first data day,
# 60 days per unit a run. Vercel Production only.
PANASONIC_USER=
PANASONIC_PASSWORD=
```

- [ ] **Step 5: Run, expect PASS**

```bash
bunx vitest run src/lib/heatPump src/lib/orpc/procedures/evCharging.test.ts src/lib/integrations
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/heatPump/comfortCloudSyncCron.ts src/lib/heatPump/comfortCloudSyncCron.test.ts \
  src/routes/api/cron/comfort-cloud-sync.ts src/routeTree.gen.ts vite.config.ts \
  src/lib/orpc/procedures/evCharging.ts src/lib/orpc/procedures/evCharging.test.ts CLAUDE.md .env.example
git commit -m "feat(heat-pumps): run the Comfort Cloud sync every six hours" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Datakällor tile and "Synka nu" for Comfort Cloud

**Files:**
- Modify: `src/components/evCharging/SyncNowButton.tsx` (the mutation replaces Task 1's compile-only cases),
  `src/routes/_authenticated/charging/settings.tsx:181-186,255-261`, `messages/sv.json`, `messages/en.json`
- Regenerate: `src/bones/charging-sources.bones.json`
- Test: `src/components/evCharging/SyncNowButton.browser.test.tsx`,
  `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx`

**Interfaces:**
- Consumes: `evCharging.syncNow({ source: 'comfortCloud' })` (Task 5); the source mark, copy and tone (Task 1).
- Produces: `useSyncNow().syncSource('comfortCloud')` runs Comfort Cloud alone with its own toasts and, on an `ok`
  run, invalidates `orpc.energy.key()` and the `heatPump` key prefix `[['heatPump'], {}]` (step 3 switches it to
  `orpc.heatPump.key()`); `isPendingFor('comfortCloud')` follows it; the settings page shows a fifth tile with its
  history and key button.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `web-design-guidelines` + `vercel-react-best-practices`
(also reviews Task 1's icon, tone and copy).

- [ ] **Step 1: Write the failing tests**

`SyncNowButton.browser.test.tsx` — the oRPC mock gains the `energy` router's key (beside `evCharging`):

```ts
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    evCharging: {
      syncNow: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: syncFn }),
      },
      key: () => ['evCharging'],
    },
    energy: { key: () => ['energy'] },
  },
}))
```

widen the local types:

```ts
type Source = 'zaptec' | 'elpris' | 'skoda' | 'emaldo' | 'comfortCloud'
```

```ts
function respond(results: Partial<Record<Source, Result | Error>>) {
```

and append:

```tsx
test('retrying Comfort Cloud alone runs only comfortCloud and confirms success', async () => {
  respond({})
  const { screen } = await renderWithProviders(<Harness only="comfortCloud" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.charging_sync_heat_pumps_ok()),
  )
  expect(syncFn.mock.calls.map((c) => c[0])).toEqual([{ source: 'comfortCloud' }])
})

// Energi (step 2) and Värmepumpar (step 3) read heat pump data: a landed sync refreshes them.
test('a Comfort Cloud success also invalidates the energy and heat pump queries', async () => {
  respond({})
  const queryClient = makeTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { screen } = await renderWithProviders(<Harness only="comfortCloud" />, { queryClient })
  await click(screen)
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] }))
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['energy'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: [['heatPump'], {}] })
})

test('a failed Comfort Cloud sync leaves the energy and heat pump queries alone', async () => {
  respond({ comfortCloud: { outcome: 'failed', code: 'unreachable', upserted: 0 } })
  const queryClient = makeTestQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const { screen } = await renderWithProviders(<Harness only="comfortCloud" />, { queryClient })
  await click(screen)
  await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['evCharging'] }))
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['energy'] })
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: [['heatPump'], {}] })
})

test('a Comfort Cloud retry reports not_configured with its own copy', async () => {
  respond({ comfortCloud: { outcome: 'failed', code: 'not_configured', upserted: 0 } })
  const { screen } = await renderWithProviders(<Harness only="comfortCloud" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_heat_pumps_failed(), {
      description: integrationErrorMessage('not_configured', { source: 'comfortCloud' }),
    }),
  )
})

test('a Comfort Cloud transport error is attributed to Comfort Cloud', async () => {
  respond({ comfortCloud: new Error('boom') })
  const { screen } = await renderWithProviders(<Harness only="comfortCloud" />)
  await click(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_sync_heat_pumps_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'comfortCloud' }),
    }),
  )
})

// A backfill run can take minutes; only its own tile shows it pending.
test('a Comfort Cloud sync is pending on its own, never on the heading', async () => {
  let release: (r: Result) => void = () => {}
  syncFn.mockImplementation(
    () =>
      new Promise<Result>((resolve) => {
        release = resolve
      }),
  )
  function HeatPumpHarness() {
    const { syncSource, isPending, isPendingFor } = useSyncNow()
    return (
      <>
        <button type="button" onClick={() => syncSource('comfortCloud')}>
          heat pumps
        </button>
        <output data-testid="state">{`${isPending}/${isPendingFor('comfortCloud')}`}</output>
      </>
    )
  }
  const { screen } = await renderWithProviders(<HeatPumpHarness />)
  await screen.getByRole('button', { name: 'heat pumps' }).click()
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/true')
  release(OK)
  await expect.element(screen.getByTestId('state')).toMatchTextContent('false/false')
})
```

(The existing first test already pins that `syncAll` calls exactly zaptec, elpris and emaldo — decision 7.)

`-settingsPage.browser.test.tsx`:
- `STATUS.sources`, after `emaldo`: `comfortCloud: { fields: { user: env, password: env }, updatedAt: null, unreadable: false },`
- the runs seed (line 70): `{ zaptec: [], elpris: [], skoda: [], emaldo: [], comfortCloud: [] }`
- `RUN_CODE`: add `comfortCloud: 'unexpected_response',`; and in the history test's seeded runs
  `comfortCloud: [failedRun('comfortCloud')],`
- the key-button loop (line 282): `for (const source of ['zaptec', 'skoda', 'emaldo', 'comfortCloud'] as const)`
- append:

```tsx
test('Comfort Cloud has its own tile in Datakällor', async () => {
  const { screen } = await renderSettings('')
  await expect
    .element(screen.getByRole('heading', { name: 'Comfort Cloud', level: 3 }))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_source_role_comfortCloud())).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_cadence_comfortCloud())).toBeVisible()
})

test('a credentials link to Comfort Cloud opens its dialog with email and password', async () => {
  const { screen } = await renderSettings('?dialog=credentials&source=comfortCloud')
  const dialog = screen.getByRole('dialog', { name: credentialsTitle('comfortCloud') })
  await expect.element(dialog).toBeVisible()
  await expect
    .element(dialog.getByLabelText(m.charging_credentials_field_comfortCloud_user(), { exact: true }))
    .toBeVisible()
  await expect
    .element(dialog.getByLabelText(m.charging_credentials_field_password(), { exact: true }))
    .toBeVisible()
})
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
bunx vitest run --project browser src/components/evCharging/SyncNowButton.browser.test.tsx \
  src/routes/_authenticated/charging/-settingsPage.browser.test.tsx
```

Expected: FAIL (no toast for Comfort Cloud; no fifth tile; `m.charging_sync_heat_pumps_ok` is not a function).

- [ ] **Step 3: Implement**

`SyncNowButton.tsx` — extend the header comment ("…The heat pumps (Comfort Cloud) are synced only on their own (a
tile or an alert): a backfill run can take minutes and the charging pages don't use them. A landed heat pump sync
also refreshes the Energi and Värmepumpar reads.") and add, at module level:

```ts
// oRPC's TanStack keys are `[path, { input?, type? }]`, and TanStack matches a
// key prefix partially, so `[['heatPump'], {}]` matches every `heatPump.*`
// query. Step 3 adds that router: until then nothing matches (harmless), and
// `orpc.heatPump.key()` doesn't type-check yet — switch to it then.
const HEAT_PUMP_QUERY_PREFIX = [['heatPump'], {}]
```

and, after `car`:

```ts
  // The heat pumps: only ever an explicit action (a tile or an alert), so confirm either way.
  const heatPumpsError = () =>
    toast.error(m.charging_sync_heat_pumps_failed(), {
      description: integrationErrorMessage('internal_error', { source: 'comfortCloud' }),
    })
  const heatPumps = useMutation(
    orpc.evCharging.syncNow.mutationOptions({
      onSuccess: (result) => {
        switch (result.outcome) {
          case 'ok':
            toast.success(m.charging_sync_heat_pumps_ok())
            // energy.overview carries heat pump data (step 2); heatPump.* is step 3's page.
            void queryClient.invalidateQueries({ queryKey: orpc.energy.key() })
            void queryClient.invalidateQueries({ queryKey: HEAT_PUMP_QUERY_PREFIX })
            return
          case 'skipped':
            toast.info(m.charging_sync_skipped())
            return
          case 'failed':
          case 'error':
            toast.error(m.charging_sync_heat_pumps_failed(), {
              description: integrationErrorMessage(result.code ?? 'internal_error', {
                source: 'comfortCloud',
              }),
            })
            return
        }
      },
      onError: heatPumpsError,
      onSettled: invalidate,
    }),
  )
```

and replace Task 1's compile-only cases:

```ts
        case 'comfortCloud':
          return heatPumps.mutate({ source: 'comfortCloud' })
```

```ts
        case 'comfortCloud':
          return heatPumps.isPending
```

`settings.tsx` — after `emaldoRuns`:

```ts
  const comfortCloudRuns = useQuery({ ...runsQuery, select: (runs) => runs.comfortCloud })
```

and the fifth entry, after `emaldo`:

```tsx
            {
              source: 'comfortCloud',
              health: sourcesHealth?.comfortCloud,
              runs: comfortCloudRuns,
              credentialsUpdatedAt: savedCredentials?.comfortCloud.updatedAt,
            },
```

(`onChanged` already runs `syncNow.syncSource(s)` for every credential source but `gridTariff`, so a saved Comfort
Cloud login now syncs at once.) Also update the comment above `searchSchema` only if it lists the sources (it doesn't
today).

Messages:

| key | sv | en |
|---|---|---|
| `charging_sync_heat_pumps_ok` | Värmepumparnas data är uppdaterad | The heat pumps' data is up to date |
| `charging_sync_heat_pumps_failed` | Värmepumparnas data kunde inte hämtas | The heat pumps' data couldn't be fetched |
| `charging_sources_description` (changed) | Tjänsterna som laddnings- och energisidorna hämtar data från. | The services the charging and energy pages get their data from. |

Then `bun run i18n:compile`.

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run --project browser src/components/evCharging \
  src/routes/_authenticated/charging/-settingsPage.browser.test.tsx
bun run typecheck
```

- [ ] **Step 5: Re-capture the Datakällor skeleton**

The panel grew a tile, so its bones change:

```bash
bun run dev:up
BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort   # second terminal
bun run bones:capture /charging/settings
```

Confirm `git diff --stat src/bones/` shows `charging-sources.bones.json` (and, if the page's other sections moved,
their bones too); `bunx vitest run test/sectionSkeletonBones.test.ts` passes.

- [ ] **Step 6: Live check** (the layout isn't in browser tests: no app CSS)

With the dev server from Step 5, signed in as an admin, open `/charging/settings` at 1440, 820 and 390 px, light and
dark (`claude-in-chrome` `resize_window`, or the worktree Playwright flow in memory "Live UI check via Playwright"):
the fifth tile wraps cleanly (no horizontal scroll, the tile as tall as its neighbours' row allows), the violet mark
reads on its wash in both themes, the key button opens "Inloggning för Comfort Cloud" with E-post + Lösenord and their
hints, and the tile's "Synka nu" shows "Synkar…" while it runs.

- [ ] **Step 7: Commit**

```bash
git add src/components/evCharging/SyncNowButton.tsx src/components/evCharging/SyncNowButton.browser.test.tsx \
  src/routes/_authenticated/charging/settings.tsx src/routes/_authenticated/charging/-settingsPage.browser.test.tsx \
  src/bones messages/sv.json messages/en.json
git commit -m "feat(heat-pumps): add the Comfort Cloud tile and sync button" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Branch review, pre-PR gate, live run, roadmap row, PR

- [ ] **Step 1: Branch review gates** (feature-workflow Phase 5, on `git diff origin/main...HEAD`)
  - `drizzle/` changed → `migration-guard` **and** the schema-design reviewer (`general-purpose` loading
    `supabase-postgres-best-practices`) on `00NN_comfort_cloud_source.sql`; every finding fixed or ruled on
    (Non-negotiable). Already approved in Task 2: re-run only if the migration changed since.
  - Effects / services changed → `test-completeness` (the facade's `unavailable` codes; every `runComfortCloudSync`
    failure path: zero units, offline yesterday, remote error, deadline, lease, not configured).
  - Always → `code-reviewer` (ADR-0001/0002/0003/0019/0026/0027 adherence) plus a correctness pass over
    `src/lib/heatPump/sync.ts` against Review Focus 1–4 (the walk's cursor, the catch-up window, the progress total).
  - Permission boundaries (cron route, `adminProcedure`) and privacy → `/security-review`, with an explicit check that
    no hourly value, password, token or full guid can reach a log line, error message, run row, cron body or RPC
    response.
  - Fix every confirmed finding in this branch (one hat per commit, e.g. `fix(heat-pumps): <what>`), or write down why
    it is dismissed. Re-run the affected tests.

- [ ] **Step 2: Docs only for what changed during the build.** Decisions 1–12 are already in the spec and ADR-0027
  (the coordinator's amendments; Task 0 Step 4b). If a task in this branch changed a decision or found a new one
  (a reviewer finding, a 1a shape that forced a different approach), amend the spec's "Sync (step 1b)" section and, for
  a real decision, ADR-0027, and add a roadmap Log line `- <build date>: step 1b — <what changed and why>`, in one
  commit `docs(heat-pumps): record the step 1b build decisions`. Nothing changed → skip this step.

- [ ] **Step 3: Pre-PR gate** (from `docs/feature-workflow.md`, verbatim)

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

- **UI changed:** checked responsive at desktop, tablet and mobile widths in a real browser (Task 6 Step 6).
- **PR title:** `<type>(<scope>): <subject>`, ≤72 chars, imperative, and one concern.

- [ ] **Step 4: Live run against the real Comfort Cloud** (the owner's `PANASONIC_*` in `.env.local`, roadmap
  prerequisite; never print them; the probe showed logins don't end the phone app's session)

```bash
bun run dev:up      # db + queue + mail + storage, migrates
bun run dev         # :14600
```

  - Signed in as an admin, `/charging/settings` → the Comfort Cloud tile → **Synka nu**: an OK toast, the tile `ok`
    with a progress bar while it runs, and an OK row in its history with a non-zero "Uppdaterade". Repeat (or curl the
    cron route) until `backfillDaysLeft` is 0 — ≈ 12 runs of 120 day calls for ≈ 1,400 days.
  - Cron route: `curl -s -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" http://localhost:14600/api/cron/comfort-cloud-sync`
    → 200 with `outcome`, `units: 2`, `daysFetched`, `hoursStored`, `backfillDaysLeft`; without the header → 401.
  - The server log's `integration sync run` lines for `source: "comfortCloud"` carry counts only; grep the dev output
    for the password, `Bearer` and the guids (`grep -c`, never print matches) → 0.
  - Run checkpoint 2's queries 1 and 3 (below) against the local DB
    (`docker compose exec -T db psql -U videbacken -d videbacken`): both units complete, 24 hours on the DST days.
    Don't paste the figures anywhere public.

- [ ] **Step 5: Roadmap row** — `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`, row 1b: PR column = the PR link,
  status `PR open` (push the row with `PR open`, then edit the link in once the PR exists). Commit
  `docs(heat-pumps): mark step 1b as PR open`.

- [ ] **Step 6: Push and open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`:
  - **Title:** `feat(heat-pumps): sync heat pump readings from Comfort Cloud`
  - **Why:** step 1b of the heat pumps roadmap (ADR-0027): the units' hourly history lands in `heat_pump_reading`,
    health-tracked; steps 2–4 read it.
  - **What changed:** `comfortCloud` source (vocabulary, credentials, policy 13 h / 2 failures, CHECK migration);
    keyed facade; `runComfortCloudSync` (recent UTC days + catch-up + per-unit backfill to `registered_on`);
    `20 */6 * * *` cron; "Synka nu" + Datakällor tile; health and credential copy.
  - **Decisions:** list "Decisions" 1–12 above (ruled 2026-10-08), plus anything decided during the build.
  - **Verification:** paste the gate output summary and the live checks (no real readings).
  - **Risks / follow-ups:** after merge the owner sets `PANASONIC_USER` / `PANASONIC_PASSWORD` in Vercel **Production
    only** (or in Datakällor) and the backfill runs ≈ 1.5 days of crons (faster with "Synka nu"); a quiet unit keeps
    the source failing until its data returns (up to 14 days, then a warning); step 3 switches the `heatPump` key prefix
    in `SyncNowButton.tsx` to `orpc.heatPump.key()`.
  - Body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Stop here. Don't start step 2 in this session.

---

## Checkpoint 2 — prod verification (for the owner / the next session)

After the PR is merged and deployed and the credentials are set (roadmap row 1b → `merged`), wait for the backfill to
finish (the tile's progress, or query 1), then run checkpoint 2 (copied from the roadmap):

> **After step 1b (prod).**
> - The backfill is complete: Matsal's first stored hour is on 2024-10-31 and Övervåning's on 2024-11-27, both units
>   have `registered_on` (2024-10-31, 2024-11-27) and `history_complete_at` set.
> - For three months (2025-02, 2026-02, 2026-09), each unit's kWh from a read-only prod SELECT equals the monthly
>   figure the Comfort Cloud app shows (the owner reads it off the app).
> - 2025-10-26 and 2026-03-29 have 24 stored hours per unit (UTC); no hour is duplicated.
> - The source has stayed green for 24 h (four cron runs), each `integration sync run` line under 60 s.

Read-only `SELECT`s only, in the Supabase SQL editor for the prod project (or the Supabase MCP `execute_sql`; memory
"Prod reads allowed"). **Never paste result rows into GitHub or any committed file** (the repo is public): record only
the conclusions.

**1. Backfill complete, first days, registration.** Passes when Matsal's `first_utc_day` = `registered_on` =
2024-10-31, Övervåning's = 2024-11-27, and both `history_complete_at` are set.

```sql
SELECT hp.name,
       hp.model,
       hp.registered_on,
       hp.history_complete_at,
       (min(r.hour_start) AT TIME ZONE 'UTC')::date AS first_utc_day,
       max(r.hour_start) AS last_hour,
       count(r.*) AS hours
FROM heat_pump hp
LEFT JOIN heat_pump_reading r ON r.heat_pump_id = hp.id
GROUP BY hp.id
ORDER BY hp.name;
```

**2. Monthly kWh against the app.** The app's month view most likely uses the phone's zone (Stockholm), so compare
`kwh_stockholm` first; `kwh_utc` differs only by the first/last one or two hours. `hours` should equal
`expected_hours` (672 for both Februaries, 720 for September); fewer means missing hours, which the app's figure would
also lack.

```sql
WITH m(month, expected_hours) AS (VALUES ('2025-02', 672), ('2026-02', 672), ('2026-09', 720))
SELECT hp.name,
       m.month,
       round(sum(r.energy_kwh) FILTER (
         WHERE to_char(r.hour_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM') = m.month)::numeric, 2) AS kwh_stockholm,
       count(*) FILTER (
         WHERE to_char(r.hour_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM') = m.month) AS hours,
       m.expected_hours,
       round(sum(r.energy_kwh) FILTER (
         WHERE to_char(r.hour_start AT TIME ZONE 'UTC', 'YYYY-MM') = m.month)::numeric, 2) AS kwh_utc
FROM heat_pump hp
CROSS JOIN m
JOIN heat_pump_reading r ON r.heat_pump_id = hp.id
 AND r.hour_start >= (m.month || '-01')::date - interval '1 day'
 AND r.hour_start <  (m.month || '-01')::date + interval '1 month 1 day'
GROUP BY hp.name, m.month, m.expected_hours
ORDER BY hp.name, m.month;
```

**3. The DST days.** Passes when every row shows `hours = 24` and `distinct_hours = 24` (the primary key already
forbids duplicates; this confirms none slipped in another way and none is missing).

```sql
SELECT hp.name,
       (r.hour_start AT TIME ZONE 'UTC')::date AS utc_day,
       count(*) AS hours,
       count(DISTINCT r.hour_start) AS distinct_hours,
       min(r.hour_start) AS first_hour,
       max(r.hour_start) AS last_hour
FROM heat_pump_reading r
JOIN heat_pump hp ON hp.id = r.heat_pump_id
WHERE (r.hour_start AT TIME ZONE 'UTC')::date IN (DATE '2025-10-26', DATE '2026-03-29')
GROUP BY hp.name, utc_day
ORDER BY hp.name, utc_day;
```

**4. Green for 24 h, four cron runs, each under 60 s.** Passes when the health row has no `error_code`,
`consecutive_failures = 0`, and the last 24 h show four `cron` runs (00:20, 06:20, 12:20, 18:20 UTC), all `ok`, every
`duration_ms < 60000`. Also: Vercel → Project → Settings → Cron Jobs lists `/api/cron/comfort-cloud-sync` at
`20 */6 * * *`, and the Vercel Runtime Logs' `integration sync run` lines for `comfortCloud` show the same durations.

```sql
SELECT source, last_success_at, last_attempt_at, error_code, consecutive_failures, failing_since
FROM integration_sync
WHERE source = 'comfortCloud';

SELECT started_at, trigger, outcome, error_code, duration_ms,
       pages AS days_fetched, upserted AS hours_stored,
       timings->>'monthsFetched' AS months_fetched,
       timings->>'rejectedDays' AS rejected_days,
       timings->>'backfillDaysLeft' AS backfill_days_left
FROM integration_sync_run
WHERE source = 'comfortCloud'
  AND started_at > now() - interval '24 hours'
ORDER BY started_at;
```

**5. (Diagnostic, if query 1 or 2 is off.)** Days with fewer than 24 hours, per unit; a few around Wi-Fi outages are
expected (they become "data saknas" notes in steps 2–3), today is always short.

```sql
SELECT hp.name, (r.hour_start AT TIME ZONE 'UTC')::date AS utc_day, count(*) AS hours
FROM heat_pump_reading r
JOIN heat_pump hp ON hp.id = r.heat_pump_id
GROUP BY hp.name, utc_day
HAVING count(*) < 24
ORDER BY hp.name, utc_day;
```

Record the result in a small `docs(heat-pumps): record checkpoint 2` PR (or the step 2 PR if the owner says so):
roadmap row 1b → `checkpoint passed` with a one-line result (e.g. "backfill to 2024-10-31 / 2024-11-27, three months
match the app, DST days 24 h, four green runs ≤ N s"). Only then does step 2 start, in a new session.
