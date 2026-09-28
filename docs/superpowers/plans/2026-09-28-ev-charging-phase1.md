# EV charging Phase 1 — implementation plan

**Spec (binding authority):** `docs/superpowers/specs/2026-09-28-ev-charging-phase1-design.md` (section "PR C").
Glossary: `CONTEXT.md`. Research + probe facts: `docs/superpowers/specs/2026-09-28-ev-charging-scope-map.md`.
Branch: `feat/ev-charging-sessions` → one PR `feat(charging): sync Zaptec sessions and show totals`.

## Global Constraints

- Follow `CLAUDE.md` non-negotiables: all DB access through `src/lib/services/*` (ADR-0002);
  effects in `src/lib/effects/*` (ADR-0001); logging only via `~/lib/logger/` — never `console.*`;
  errors logged at top-level `error` key (ADR-0003 2026-09-28 amendment); all timestamps
  `timestamp(..., { withTimezone: true })`; Biome clean; Paraglide sv (source of truth) + en for
  all user-facing text; route paths English; file naming per CLAUDE.md; responsive UI.
- **Client-safe imports:** client code may only `import type` from `~/lib/services/*`; runtime
  constants the client needs live in dependency-free modules (pattern: `src/lib/sensor/range.ts`).
- **Migrations:** `bun run db:generate --name=<desc>` (never without `--name`), then `bun run db:migrate`.
  Never hand-edit `src/lib/db/schema/betterAuth.ts`.
- Reads use `protectedProcedure`; every mutation uses `adminProcedure`.
- Never log Zaptec credentials, tokens, form bodies or raw Zaptec payloads (they contain
  `sessionSignature` and owner email/name). Test fixtures are **synthetic** — never copy
  `…/scratchpad/zaptec-probe/*.json`.
- No held connections (ADR-0018): polling via TanStack Query only.
- Tests: services with `setupDatabase()` (`~test/setup`); pure logic as plain unit tests; UI as
  `*.browser.test.tsx` with `renderWithProviders`. No new mocking libraries.
- Commit per task with Conventional Commits; end commit messages with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Shared interfaces (pinned — every task uses these exact names)

```ts
// src/lib/integrationHealth.ts  (Task 1; dependency-free, client-safe)
export const INTEGRATION_SOURCES = ['zaptec', 'elpris', 'skoda'] as const
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number]
export const INTEGRATION_ERROR_CODES = ['auth_failed', 'forbidden', 'rate_limited', 'unreachable',
  'unexpected_response', 'not_configured', 'internal_error'] as const
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number]
export const SYNC_TRIGGERS = ['cron', 'admin'] as const
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number]
export const SYNC_RUN_OUTCOMES = ['ok', 'failed', 'error'] as const
export type SyncRunOutcome = (typeof SYNC_RUN_OUTCOMES)[number]
export type HealthTransition = 'none' | 'started_failing' | 'recovered'
export type HealthState = 'never_synced' | 'not_configured' | 'ok' | 'stale' | 'failing'

// src/lib/evCharging/counting.ts  (Task 1; dependency-free, client-safe)
export const NOISE_THRESHOLD_KWH = 0.5

// src/lib/evCharging/types.ts  (Task 1; types only — the contract between the Zaptec client,
// the evCharging service and the sync run)
export type ZaptecCharger = { id: string; name: string; installationId: string; isOnline: boolean }
export type ChargeInterval = { startAt: Date; endAt: Date; energyKwh: number }
export type ZaptecSession = {
  id: string; chargerId: string; startAt: Date; endAt: Date; energyKwh: number
  intervals: ChargeInterval[]
  authorizedUser: { email: string | null; name: string | null } | null
  tokenName: string | null; voided: boolean; replacedBySessionId: string | null
  offline: boolean; reliableClock: boolean
}
export type LiveMode = 'disconnected' | 'connected_requesting' | 'charging' | 'connected_finished' | 'unknown'
export type ZaptecLiveState = { mode: LiveMode; powerKw: number | null; sessionKwh: number | null; observedAt: Date }
```

## Waves

| Wave | Tasks | Mode |
|---|---|---|
| 1 | Task 1 | sequential |
| 2 | Tasks 2, 3, 4, 5, 6 | parallel (separate worktrees, disjoint files) |
| 3 | Task 7 | sequential |
| 4 | Task 8 | sequential |
| 5 | Task 9 | sequential |
| 6 | Task 10 | sequential (verification) |

---

### Task 1: Schema, migration and shared vocabulary

**Files:** create `src/lib/db/schema/evCharging.ts`, `src/lib/db/schema/integrationSync.ts`,
`src/lib/integrationHealth.ts`, `src/lib/evCharging/counting.ts`, `src/lib/evCharging/types.ts`;
modify `src/lib/db/schema/index.ts`; generated `drizzle/0003_*.sql` + meta.

Implement the shared interfaces above verbatim. Schema (copy conventions from `src/lib/db/schema/sensor.ts`):

`ev_charger`: `id text PK` (Zaptec charger id), `name text not null`, `installation_id text not null`,
`created_at`, `updated_at` (timestamptz, default now, not null).

`ev_charge_session`: `id uuid PK defaultRandom`, `zaptec_session_id text not null unique`,
`charger_id text not null FK → ev_charger.id`, `start_at`, `end_at` (timestamptz not null),
`energy_kwh real not null`, `authorized_user_email text`, `authorized_user_name text`,
`token_name text`, `voided boolean not null default false`, `replaced_by_zaptec_session_id text`,
`offline boolean not null default false`, `reliable_clock boolean not null default true`,
`created_at`, `updated_at`. Indexes: `ev_charge_session_start_at_idx (start_at)`,
`ev_charge_session_end_at_idx (end_at)`. CHECKs: `energy_kwh >= 0`, `end_at >= start_at`.

`ev_charge_interval`: `id uuid PK`, `session_id uuid not null FK → ev_charge_session.id on delete cascade`,
`start_at`, `end_at` (timestamptz not null), `energy_kwh real not null`. Unique index
`ev_charge_interval_session_start_uq (session_id, start_at)`. CHECKs: `end_at > start_at`, `energy_kwh >= 0`.

`integration_sync` (snapshot + lease): `source text PK` with CHECK in `INTEGRATION_SOURCES`;
`last_attempt_at`, `last_success_at`, `last_success_started_at`, `failing_since`, `running_since`,
`lease_until` (timestamptz, nullable); `consecutive_failures integer not null default 0` (CHECK ≥ 0);
`error_code text` (CHECK null or in `INTEGRATION_ERROR_CODES`); `last_error_message text`
(CHECK null or `char_length <= 500`); `updated_at` not null default now. Cross-column CHECKs:
`(consecutive_failures = 0) = (error_code IS NULL)`, `(error_code IS NULL) = (failing_since IS NULL)`,
`last_error_message IS NULL OR error_code IS NOT NULL`, `(running_since IS NULL) = (lease_until IS NULL)`.
Note: `not_configured` is a code like the others (a failing row with that code).

`integration_sync_run` (history): `id uuid PK`, `source text not null` (CHECK in sources),
`trigger text not null` (CHECK in `SYNC_TRIGGERS`), `started_at`, `finished_at` (timestamptz not null),
`duration_ms integer not null` (CHECK ≥ 0), `outcome text not null` (CHECK in `'ok','failed','error'`),
`error_code text` (CHECK null or in codes), `error_message text` (CHECK null or ≤ 500 chars),
`since timestamptz`, `pages integer not null default 0`, `sessions_seen integer not null default 0`,
`upserted integer not null default 0`, `voided integer not null default 0`, `timings jsonb not null default '{}'`.
CHECK `(outcome = 'ok') = (error_code IS NULL)`. Index `integration_sync_run_source_started_idx (source, started_at desc)`.

Build CHECK `IN (...)` lists from the exported const arrays (not duplicated literals). Add
`relations()` like `sensor.ts`. Generate with `bun run db:generate --name=add_ev_charging_and_integration_sync`,
then `bun run db:migrate`. Verify the SQL (no `ALTER … TYPE` on existing tables; only CREATEs).

**Tests:** `src/lib/integrationHealth.test.ts` is not needed; instead add
`src/lib/db/schema/evCharging.test.ts` with `setupDatabase()` asserting (via `db.insert`, which is
sanctioned in test files) that: a session with `end_at < start_at` is rejected; an interval with
`energy_kwh < 0` is rejected; deleting a session cascades its intervals; an `integration_sync` row
with `consecutive_failures = 1` and `error_code = null` is rejected; an `integration_sync_run` with
`outcome = 'ok'` and an `error_code` is rejected; every `INTEGRATION_ERROR_CODES` value is accepted
by `integration_sync.error_code` (drift guard).

**Done when:** `bun run check`, `bunx tsc --noEmit`, and `bun run test:node` pass; one commit
`feat(db): add ev charging and integration sync tables`.

---

### Task 2: Zaptec client module

**Files:** create `src/lib/effects/zaptec/{index.ts, zaptec.ts, client.ts, parse.ts, errors.ts,
adapters/notConfigured.ts, adapters/fake.ts, testing/fakeFetch.ts, zaptec.test.ts, fixtures.ts}`;
modify `src/lib/effects/index.ts` (export `zaptec`), `.env.example` (ZAPTEC_USERNAME,
ZAPTEC_PASSWORD, ZAPTEC_ADAPTER with comments in the file's style).

Implement the spec's "Zaptec client module (candidate 01)" section exactly. Interface:

```ts
export class ZaptecError extends Error {
  constructor(readonly code: IntegrationErrorCode, readonly op: 'token' | 'chargers' | 'sessions' | 'state',
              readonly status?: number, options?: { cause?: unknown })
}
export interface ZaptecCallStats { authMs: number; fetchMs: number; requests: number; retries: number; pages: number }
export function newCallStats(): ZaptecCallStats
export interface CallOpts { signal?: AbortSignal; stats?: ZaptecCallStats }
export interface ZaptecClient {
  chargers(o?: CallOpts): Promise<ZaptecCharger[]>
  sessionsEndedSince(since: Date, o: CallOpts & { installationId: string; until?: Date }): AsyncIterable<ZaptecSession[]>
  liveState(chargerId: string, o?: CallOpts): Promise<ZaptecLiveState>
}
export function createZaptecClient(deps: { fetch: typeof fetch; creds: { username: string; password: string };
  now?: () => Date; sleep?: (ms: number) => Promise<void>; random?: () => number }): ZaptecClient
export const zaptec: ZaptecClient // lazily selected
```

API facts (verified live 2026-09-28): base `https://api.zaptec.com`. Token: `POST /oauth/token`,
`application/x-www-form-urlencoded` body `grant_type=password&username&password&scope=openid` →
`{ access_token, expires_in }` (≈ 86400). Chargers: `GET /api/chargers` →
`{ Pages, TotalCount, Data: [{ Id, Name, InstallationId, IsOnline, ... }] }` (PascalCase).
Sessions: `GET /api/sessions/archived?From=<iso>&To=<iso>&InstallationId=<id>&PageSize=200[&Cursor=<c>]`
→ `{ sessions: [...], cursor, hasMore }` (camelCase); From/To filter on **end** time, To exclusive.
Session fields: `id, chargerId, startDateTime, endDateTime, energy, energyDetails: [{timestamp, energy}],
authorizedUser: {id,email,fullName} | null, tokenName, voided, replacedBySessionId, offline, reliableClock`.
`energyDetails` is per-interval, hour-aligned: first point is a 0-kWh start marker at session start, then
`:00:00` points, last at session end; each point's `energy` is the kWh delivered in the interval ending
at that point; points sum to `energy`. Normalize to `ChargeInterval[]` by pairing consecutive points
(interval i = [p[i].timestamp, p[i+1].timestamp) with energy p[i+1].energy), sorted, clamp negative
float noise to 0, drop zero-length intervals and duplicate timestamps (the result must satisfy the
`ev_charge_interval` CHECKs: `end_at > start_at`, `energy_kwh >= 0`, unique `start_at` per session).
Session-level `energy` / `endAt` are passed through as-is (the importer validates them). State: `GET /api/chargers/{id}/state` →
`[{ StateId, ValueAsString, Timestamp? }]`; 710 = mode (1 disconnected, 2 connected_requesting,
3 charging, 5 connected_finished, else unknown), 513 = charge power **kW**, 553 = session kWh.
Send header `User-Agent: videbacken/1.0 (private home dashboard)`.

Behavior: shared in-flight login; token cached until `expires_in − 300 s`; one re-login on a data-call
401; status mapping token 400/401 → `auth_failed` (if body `error` is `unsupported_grant_type`, message
includes "grant retired"), 403 → `forbidden`, 429 → `rate_limited`, 5xx/network/timeout → `unreachable`,
zod failure → `unexpected_response` (message lists field paths only, no values); timeouts
`AbortSignal.timeout(10_000)` (liveState 5_000) combined with caller signal via `AbortSignal.any`;
≤ 2 retries on 429/502/503/504/network honoring `Retry-After` ≤ 10 s (longer → fail `rate_limited`
without sleeping), else backoff 500 ms then 1500 ms × (0.8–1.2 jitter); never retry token 4xx or
liveState; liveState 15 s TTL cache per charger (successful reads only). Password grant isolated in
one private `obtainToken()`. The client **does not log**; it fills `stats`. `cause` keeps only a
network error's `name`/`code`.

Selection (`zaptec.ts`, via `lazy()` from `../lazy`): `VITEST === 'true'` → notConfigured;
`ZAPTEC_ADAPTER === 'fake'` → fake (synthetic sessions/state for local UI work); username+password set
→ http client (`createZaptecClient({ fetch: globalThis.fetch, creds })`); else notConfigured.
notConfigured throws `new ZaptecError('not_configured', op)` from every method.

**Tests (`zaptec.test.ts`, through `createZaptecClient` + `fakeFetch(routes)` returning real
`Response`s from synthetic fixtures; injected `sleep`/`now`/`random`):** concurrent calls share one
login; token reused before expiry and refreshed after (injected now); data-call 401 → one re-login then
success; second 401 → `auth_failed`; token 400 → `auth_failed`; `unsupported_grant_type` → message
contains "grant retired"; 403 → `forbidden`; 429 + `Retry-After: 2` → sleeps 2000 then succeeds;
`Retry-After: 60` → `rate_limited`, no sleep; 503×3 → `unreachable` with `stats.retries === 2`;
timeout → `unreachable`; paging follows cursor until `hasMore` false with correct query params;
energyDetails normalization (pairs, sum ≈ energy, offsets parsed); payload drift → `unexpected_response`
whose message contains no payload values; live-state mode mapping incl. unknown + TTL cache; stats
filled; no password/token string appears in any thrown error message or cause; notConfigured throws
`not_configured`.

**Done when:** check/tsc/tests pass; one commit `feat(zaptec): add zaptec api client effect`.

---

### Task 3: Integration health service

**Files:** create `src/lib/services/integrationSync/{index.ts, integrationSync.ts, transition.ts,
policy.ts, sanitize.ts, integrationSync.test.ts, transition.test.ts}`.

Implement the spec's "Integration health (candidates 02 + 05)" section. Interface:

```ts
export type SyncOutcome =
  | { ok: true; stats: RunStats }
  | { ok: false; kind: 'failed' | 'error'; code: IntegrationErrorCode; message: string; stats: RunStats }
export type RunStats = { since: Date | null; pages: number; sessionsSeen: number; upserted: number; voided: number;
  timings: Record<string, number> }
export type IntegrationHealth = {
  source: IntegrationSource; state: HealthState; running: boolean
  lastAttemptAt: Date | null; lastSuccessAt: Date | null; failingSince: Date | null
  consecutiveFailures: number; code: IntegrationErrorCode | null
  adminDetail: { lastErrorMessage: string | null } | null
}
export type RunRow = { id: string; trigger: SyncTrigger; startedAt: Date; finishedAt: Date; durationMs: number;
  outcome: 'ok' | 'failed' | 'error'; errorCode: IntegrationErrorCode | null; errorMessage: string | null;
  upserted: number; sessionsSeen: number; pages: number }

beginAttempt(source, { now }): Promise<{ acquired: true; attemptId: string } | { acquired: false; runningSince: Date }>
recordOutcome(source, outcome: SyncOutcome, { attemptId, trigger, startedAt, now }):
  Promise<{ transition: HealthTransition; health: IntegrationHealth }>
getHealth(source, { now, includeAdminDetail }): Promise<IntegrationHealth>
getLastSuccessStartedAt(source): Promise<Date | null>
listRecentRuns(source, { limit }): Promise<RunRow[]>
```

Rules: row created lazily (`INSERT … ON CONFLICT DO NOTHING`). Lease: `UPDATE integration_sync SET
running_since = $now, lease_until = $now + interval '5 minutes' WHERE source = $1 AND (lease_until IS
NULL OR lease_until < $now) RETURNING lease_token` also setting `lease_token = gen_random_uuid()`;
`attemptId` = that `lease_token` (a uuid string — never compare timestamps).
`recordOutcome` in ONE transaction: `SELECT … FOR UPDATE`; if `lease_token ≠ attemptId` → return
`transition: 'none'`, write nothing (lease lost; log warn); else compute with pure
`nextRow(prev, outcome, now)` (`transition.ts`), UPDATE (clear lease: running_since, lease_until, lease_token → null; set last_attempt_at; on ok set
last_success_at/last_success_started_at = startedAt, consecutive_failures 0, error_code/failing_since/
last_error_message null; on failure increment, set code, failing_since if newly failing, message),
INSERT the `integration_sync_run` row, then prune runs older than 90 days for the source (DELETE; on
error log warn, never fail). Transition: 0→≥1 failures = `started_failing` **unless the code is
`not_configured`** (then `none`); ≥1→0 = `recovered` (unless the streak was `not_configured` only →
`none`); a code change mid-streak = `none`. Derived state: no row or no attempt → `never_synced`;
error_code `not_configured` → `not_configured`; any other error_code → `failing`; last_success_at older
than the source's stale policy → `stale`; else `ok`. `running` = lease_until > now.
`policy.ts`: `STALE_AFTER_MS: Record<IntegrationSource, number>` with zaptec = 3 h (others 26 h placeholder).
`sanitize.ts`: strip control chars, replace `Bearer \S+` → `Bearer <redacted>` and
`password=\S+` → `password=<redacted>` (case-insensitive), truncate to 500 chars — applied before
writing both `last_error_message` and `integration_sync_run.error_message`.
`includeAdminDetail: false` → `adminDetail: null`.

**Tests:** `transition.test.ts` table-driven over `nextRow` + state derivation (never→fail = started_failing,
ok→fail, fail→fail = none with counter++, fail→ok = recovered, not_configured start = none,
not_configured→ok = none, code change mid-streak = none, stale boundary exact). `integrationSync.test.ts`
with `setupDatabase()`: lease acquire, second acquire → not acquired, expired lease taken over and the
old attempt's outcome ignored (`transition: 'none'`, no run row); two concurrent `recordOutcome`
failures (Promise.all, same attemptId) → exactly one `started_failing`; run rows written with stats;
pruning removes a 91-day-old run and keeps an 89-day-old one; 2 KB message with a Bearer token stored
redacted + truncated; `includeAdminDetail: false` hides message; `getLastSuccessStartedAt`.

**Done when:** check/tsc/tests pass; one commit `feat(health): add integration health service`.

---

### Task 4: Charging service (import + overview)

**Files:** create `src/lib/services/evCharging/{index.ts, evCharging.ts, overview.ts,
evCharging.test.ts, overview.test.ts}`.

Implement the spec's "Charging overview (candidate 07)" section plus the import side:

```ts
upsertChargers(chargers: ZaptecCharger[]): Promise<void>
listChargers(): Promise<{ id: string; name: string; installationId: string }[]>
importSessions(sessions: ZaptecSession[], ctx: { installationId: string }):
  Promise<{ upserted: number; voided: number; skipped: number }>
  // ONE transaction for the batch (the sync run calls it once per page). First validate each session
  // in JS against the table CHECK predicates (energyKwh >= 0, endAt >= startAt, every interval
  // endAt > startAt and energyKwh >= 0): invalid → skip, count in `skipped`, log warn with the Zaptec
  // session id only (a bad row must never roll back the page — the DB CHECKs stay as a backstop).
  // Unknown charger_id → upsert a stub ev_charger row (id = charger id, name = charger id,
  // installation_id = ctx.installationId) instead of skipping; `upsertChargers` later fills real
  // names for chargers Zaptec still lists. Upsert by zaptec_session_id updating ONLY an explicit
  // allow-list of Zaptec-owned columns (start_at, end_at, energy_kwh, authorized_user_*, token_name,
  // voided, replaced_by_zaptec_session_id, offline, reliable_clock, charger_id, updated_at) — later
  // phases add admin-owned columns that must never be overwritten. Then delete and re-insert that
  // session's intervals. `voided` = count of imported sessions with voided = true.
getOverview({ year?, now? }): Promise<ChargingOverview>
listSessions({ limit }): Promise<{ sessions: SessionRow[]; hasMore: boolean }>

type Totals = { kwh: number; sessions: number }
type ChargingOverview = { year: number; years: number[];
  tiles: { thisMonth: Totals; thisYear: Totals; allTime: Totals }; months: (Totals & { month: number })[] }
type SessionRow = { id: string; startAt: Date; endAt: Date; energyKwh: number; peakKw: number | null;
  offline: boolean; reliableClock: boolean }
```

Rules: one private "counted session" SQL fragment: `NOT voided AND replaced_by_zaptec_session_id IS NULL
AND energy_kwh >= NOISE_THRESHOLD_KWH` (import the constant from `~/lib/evCharging/counting`), used
by every read. kWh per month from **intervals** bucketed by
`extract(year|month from start_at AT TIME ZONE 'Europe/Stockholm')`; sessions with no intervals fall back
to their `energy_kwh` in the month of `start_at`; session **count** by the session's `start_at` month.
`year` defaults to the current Stockholm year of `now`; `months` always 12, zero-filled, month 1–12;
`years` descending and always including the current Stockholm year; tiles: this month/this year = current
Stockholm month/year of `now` (not the selected year); `allTime` all counted. Numbers from `real`/
aggregates coerced to JS numbers (see `toNumber` in `src/lib/services/sensor/sensor.ts`).
`peakKw` = max(interval kWh ÷ interval hours) over intervals ≥ 10 minutes, null when none.
`listSessions`: newest `start_at` first, counted sessions only, fetch `limit + 1` for `hasMore`.

**Tests (`setupDatabase()`, injected `now`):** empty DB → 12 zero months, `years = [currentYear]`, zero
tiles; 0.49 kWh excluded / 0.5 counted; voided and replaced excluded; overnight session 2026-01-31
22:00 → 2026-02-01 02:00 Stockholm splits kWh Jan/Feb but counts once in Jan; DST: interval starting
`2026-03-31T22:30Z` → April, `2026-10-31T23:30Z` → November; `2026-12-31T23:30Z` → 2027 and 2027 in
`years`; `now = 2026-09-30T22:30Z` → thisMonth is October; session without intervals falls back to
start month; empty selected year → zeros; invariant: months sum = thisYear for the current year,
allTime ≥ thisYear; `listSessions` order/hasMore/peakKw (1 kWh over 1 h + 3 kWh over 1 h → 3; a
0.5 kWh 15-min interval → 2); `importSessions` idempotent re-import, void flip updates in place,
changed intervals replaced (no duplicates), unknown charger → stub charger created and the session
imported; one invalid session (end before start, or negative energy) in a batch of three → the other
two imported, `skipped = 1`, no throw. Year filtering uses a `start_at` range in Stockholm time
(not `extract(year) =`).

**Done when:** check/tsc/tests pass; one commit `feat(charging): add charging service`.

---

### Task 5: Sync alert email + health messages

**Files:** create `src/lib/integrationHealthMessage.ts` (+ `.test.ts`),
`src/emails/IntegrationSyncAlertEmail.tsx`, `src/lib/queue/handlers/emailIntegrationSyncAlert.ts`
(+ `.test.ts`); modify `src/lib/effects/queue/queue.ts` (topic + payload),
`src/lib/queue/index.ts` (handler table entry), `vite.config.ts` (`queues.triggers` entry only),
`src/lib/effects/email/email.ts` + its three adapters, `messages/sv.json`, `messages/en.json`.

- Queue topic `email_integration_sync_alert`, payload
  `{ to: string; source: IntegrationSource; transition: 'started_failing' | 'recovered';
  code: IntegrationErrorCode | null; failingSince: string | null /* ISO */; locale: Locale }`.
  One message per admin recipient (the producer — Task 7 — fans out).
- Handler (follow `src/lib/queue/handlers/emailUserInvited.ts` + the dispatcher contract in
  `src/lib/queue/dispatch.ts`): calls `email.sendIntegrationSyncAlert(...)`; `logFields` =
  `{ to, source, transition }`.
- `EmailEffects.sendIntegrationSyncAlert(input: { to; source; transition; code; failingSince; locale })`
  implemented in devLog / smtp / resend adapters like `sendUserInvited`.
- Template `IntegrationSyncAlertEmail` follows `src/emails/InviteUserEmail.tsx` (BrandEmailLayout,
  `render…` helper returning `{ subject, html, text }`), button → `${BETTER_AUTH_URL}/charging`.
  Copy: failing → subject "Zaptec-synkningen fungerar inte", body names the source and the
  code-specific explanation; recovered → "Zaptec-synkningen fungerar igen".
- `src/lib/integrationHealthMessage.ts` (client-safe: imports only `~/paraglide/messages` and
  `import type` from `~/lib/integrationHealth`): `integrationSourceName(source)`,
  `integrationErrorMessage(code, { locale? })`, `integrationHealthTitle(state)` — exhaustive
  `switch`es without `default` (a new code/state is a compile error). Messages for every
  `IntegrationErrorCode` (sv + en), e.g. `auth_failed` → "Inloggningen mot Zaptec fungerar inte längre.
  En admin behöver uppdatera Zaptec-lösenordet.", `not_configured` → "Zaptec är inte konfigurerat
  (inloggningsuppgifter saknas).". Keys prefixed `integration_health_*` / `email_integration_sync_*`.
- Run `bun run i18n:compile` after editing messages.

**Tests:** handler contract test (resolves under devLog, like `emailUserInvited.test.ts`);
template renders subject/text for both transitions and contains the `/charging` link;
`integrationHealthMessage` returns a non-empty string for every code and state in both locales.

**Done when:** check/tsc/tests pass; one commit `feat(charging): add integration sync alert email`.

---

### Task 6: ADR-0019 and doc updates

**Files:** create `docs/adr/0019-external-data-integrations.md`; modify
`docs/adr/0001-side-effects-architecture.md`, `docs/adr/0002-service-domain-architecture.md`,
`CLAUDE.md`.

- ADR-0019 in the repo's ADR format (read 0017/0018 for shape): decision for pulled external data
  integrations — fail closed (`not_configured`, no devLog adapter), injected `fetch` as the test seam,
  the `IntegrationErrorCode` union, timeout/retry policy, health snapshot + run history, lease instead of
  advisory locks (Supabase transaction pooler), one `integration sync run` log line, alert on
  transitions only, cron returns 200 for integration failures / 500 for bugs. Alternatives considered
  (devLog fallback; advisory locks; single mutable health row; logs-only history). Cite spec + scope map.
- ADR-0001 amendment: domain orchestrators in `src/lib/<domain>/` (e.g. `src/lib/evCharging/sync.ts`)
  are sanctioned effect callers; `/api/cron/*` and `/api/webhooks/shelly` are non-oRPC entrypoints; plan
  is Vercel Pro.
- ADR-0002 amendment: row locking (`SELECT … FOR UPDATE`) inside a service transaction is allowed;
  role-shaped reads take a flag (`includeAdminDetail`), never a role.
- `CLAUDE.md`: ADR index row for 0019; code map lines for `services/evCharging`, `services/integrationSync`,
  `effects/zaptec`, `lib/evCharging`, `routes/_authenticated/charging.tsx`, `routes/api/cron/`; env vars
  `ZAPTEC_USERNAME`, `ZAPTEC_PASSWORD`, `ZAPTEC_ADAPTER`, `CRON_SECRET`; replace "Hobby" plan wording
  with Pro where it describes the current plan (keep the historical SSE incident text accurate).
  Keep CLAUDE.md a router — terse lines.

**Done when:** `bun run check` passes; one commit `docs(charging): add ADR-0019 and amend ADRs`.

---

### Task 7: Sync run + cron route

**Files:** create `src/lib/evCharging/sync.ts` (+ `sync.test.ts`), `src/lib/evCharging/zaptecSyncCron.ts`
(+ `.test.ts`), `src/routes/api/cron/zaptec-sync.ts`; modify `vite.config.ts` (`vercel.config.crons`),
`.env.example` (`CRON_SECRET`).

Implement the spec's "Sync run (candidate 03)" section:

```ts
export type SyncRun = { source: 'zaptec'; trigger: SyncTrigger; outcome: 'ok' | 'failed' | 'skipped' | 'error';
  code: IntegrationErrorCode | null; transition: HealthTransition; startedAt: Date; since: Date | null;
  durationMs: number; authMs: number; fetchMs: number; importMs: number; pages: number; chargers: number;
  sessionsSeen: number; upserted: number; voided: number }
export function runZaptecSync(opts: { trigger: SyncTrigger; now?: () => Date;
  deps?: { zaptec?: ZaptecClient; log?: Logger } }): Promise<SyncRun>
```

Flow: `beginAttempt` (not acquired → `skipped`, no Zaptec calls); `zaptec.chargers()` →
`upsertChargers`; `since = (getLastSuccessStartedAt) − 7 days`, first run `2020-01-01T00:00:00Z`;
for each charger installation (dedupe installationIds) iterate `sessionsEndedSince(since, { installationId,
until: now, stats })` → `importSessions(page, { installationId })` per page (add its `skipped` to a `skipped` count on
the run and in the log line) (cap 20 pages → `unexpected_response`);
`recordOutcome` with stats; on `started_failing`/`recovered` publish `email_integration_sync_alert`
**one message per active admin** (`userService.listAll()` filtered `role === 'admin' && !deletedAt`,
locale `baseLocale` from `~/paraglide/runtime`) with the tier-2 pattern
`queue.publish(...).catch((error) => log.warn(...))`. `ZaptecError` → outcome `failed` with its code
(return normally). Any other throw → best-effort `recordOutcome` as `{ kind: 'error', code: 'internal_error' }`
(catch its own failure), then rethrow. In `finally` emit exactly one log line
`log.<level>('integration sync run', { source, trigger, outcome, code, transition, since, durationMs,
authMs, fetchMs, importMs, pages, chargers, sessionsSeen, upserted, voided })` — info for ok/skipped,
warn for failed, error (with `error`) for error. Default log: `logger` from `~/lib/logger/server`.

Cron: `zaptecSyncCron.ts` exports `verifyCronSecret(header: string | null, expected: string | undefined)`
(Bearer parse, constant-time `timingSafeEqual`, fail closed — mirror `verifyWebhookToken` in
`src/lib/sensor/shellyWebhook.ts`) and `handleZaptecSyncCron(request: Request): Promise<Response>`:
401 on bad/missing secret; else `runZaptecSync({ trigger: 'cron', deps: { log: createRequestLogger(request).log } })`
→ 200 `Response.json({ outcome, code, upserted })`; unexpected throw → 500. Route file
`src/routes/api/cron/zaptec-sync.ts` is a thin `GET` binding (copy `src/routes/api/webhooks/shelly.ts`).
`vite.config.ts`: add `crons: [{ path: '/api/cron/zaptec-sync', schedule: '0 * * * *' }]` inside
`nitro.vercel.config` (sibling of `images`/`queues`) with a short comment.

**Tests (`sync.test.ts`, `setupDatabase()`, an in-memory fake `ZaptecClient` that filters by end time
with exclusive until and pages by 2, a spied `queue.publish`, a capturing logger via
`createServerLogger(destination)`):** 2-page backfill imports all; rerun idempotent; late session
(end before last success start but within 7 d) picked up; void flip updated; `auth_failed` twice →
exactly one alert publish per admin, then success → one "recovered" publish per admin; page-2 failure
keeps page 1 and doesn't advance `getLastSuccessStartedAt`; held lease → `skipped` with zero client calls;
unknown error → rethrown, health recorded `internal_error`, error log line; exactly one
`integration sync run` line per run in every case. `zaptecSyncCron.test.ts`: verifyCronSecret cases;
handler 401 without/with wrong secret, 200 with correct secret (run against test DB with the default
notConfigured client → outcome `failed`/`not_configured`, status 200).

**Done when:** check/tsc/tests pass; one commit `feat(charging): sync zaptec sessions on an hourly cron`.

---

### Task 8: Procedures

**Files:** create `src/lib/orpc/procedures/evCharging.ts` (+ `.test.ts`); modify `src/lib/orpc/router.ts`.

Procedures under `evCharging` (mirror `src/lib/orpc/procedures/sensor.ts`, test like its `.test.ts`):
- `overview` (protected) input `{ year?: z.number().int().min(2020).max(2100) }` → `getOverview`.
- `sessions` (protected) input `{ limit: z.number().int().min(1).max(500) }` → `listSessions`.
- `syncStatus` (protected) → `getHealth('zaptec', { now: new Date(), includeAdminDetail: context.user.role === 'admin' })`.
- `liveStatus` (protected): first charger from `listChargers()`; none → `null`; else
  `zaptec.liveState(id)`; catches `ZaptecError` → `null` (debug log); never touches health.
- `recentRuns` (admin) input `{ limit: 1..50, default 20 }` → `listRecentRuns('zaptec', …)`.
- `syncNow` (admin) → `runZaptecSync({ trigger: 'admin', deps: { log: context.log } })`, returns
  `{ outcome, code, upserted }`; records `context.timings.zaptecSyncMs` / `zaptecFetchMs` / `zaptecImportMs`
  when `context.timings` exists; never throws for failed/skipped.
Register as `evCharging` in `router.ts`.

**Tests:** auth gating per procedure (UNAUTHORIZED signed-out, FORBIDDEN non-admin for admin ones),
`syncStatus` hides `adminDetail` for non-admin and shows it for admin, `liveStatus` returns null when no
charger / under the notConfigured client, `syncNow` returns `{ outcome: 'failed', code: 'not_configured' }`
under VITEST.

**Done when:** check/tsc/tests pass; one commit `feat(charging): add charging procedures`.

---

### Task 9: `/charging` UI

**Files:** create `src/routes/_authenticated/charging.tsx`, `src/components/evCharging/*`
(`ChargingHeading`, `SyncHealthAlert`, `LiveStatusTile`, `TotalsTiles`, `YearSelector`, `MonthlyChart`,
`SessionList`, `RecentRunsCard`, `SyncNowButton` + `*.browser.test.tsx`), `src/lib/evCharging/clientSafe.browser.test.tsx`;
modify `src/components/AppSidebar.tsx`, `src/components/command/commands.ts`, `messages/sv.json`, `messages/en.json`.

Mirror `src/routes/_authenticated/sensors.tsx` + `src/components/sensor/*`. Search params
`{ year?: number }`; loader `Promise.all` ensureQueryData for `overview({ year })`, `sessions({ limit: 20 })`,
`syncStatus`; admin additionally `recentRuns`. No `refetchInterval` on overview/sessions; `liveStatus`
client-only `useQuery` with `refetchInterval: 60_000`; `syncStatus` `refetchInterval: 60_000`.
`keepPreviousData` when year changes. `syncNow` mutation (admin) shows a toast by outcome
(ok / failed with `integrationErrorMessage(code)` / skipped "En synkning pågår redan") and invalidates
`orpc.evCharging.key()`. `SyncHealthAlert` switches on `state` only (never_synced / not_configured /
ok (renders nothing) / stale / failing) using `src/lib/integrationHealthMessage.ts`; admin sees
`adminDetail.lastErrorMessage` + "Försök igen" (same mutation). Heading shows "Senast synkad {time}"
(`suppressHydrationWarning` like `CurrentReadingTiles`). `MonthlyChart` = Recharts `BarChart` inside
`ChartContainer` (`src/components/ui/chart.tsx`), 12 month labels via `Intl` in the user locale.
`SessionList` = `Table` (date, start–end, duration, kWh, peak kW) + "Visa fler" (growing `limit` by 20
while `hasMore`); empty → `Empty` (ADR-0016) with admin-only "Synka nu" CTA. `RecentRunsCard` admin-only,
collapsible, last 20 runs (time in Europe/Stockholm, trigger, outcome badge, duration, upserted, code).
Page copy mentions sessions under `NOISE_THRESHOLD_KWH` are not counted (import from
`~/lib/evCharging/counting`). Sidebar + command palette entry `/charging` with `ZapIcon`, label
"Laddning"/"Charging". Responsive at phone/tablet/desktop. All text sv + en; run `bun run i18n:compile`.

**Tests:** one browser test per component (states: health states × admin/non-admin; live modes;
tiles; chart renders 12 bars; list empty/admin CTA/populated/"Visa fler"); `clientSafe.browser.test.tsx`
importing the route module, `~/lib/evCharging/counting`, `~/lib/integrationHealth`,
`~/lib/integrationHealthMessage` in the browser without error (copy `src/lib/sensor/clientSafe.browser.test.tsx`).

**Done when:** `bun run check`, `bun run build`, `bun run test` pass; one commit `feat(charging): add charging page`.

---

### Task 10: End-to-end verification

No new product code. With the local stack (`bun run dev:up`) and real Zaptec credentials in
`.env.local` (never printed): run the sync once through a throwaway `bun -e` script calling
`runZaptecSync({ trigger: 'admin' })` against the **local** DB (verify `DATABASE_URL` is local first);
report `SyncRun` counts, then query `getOverview()` and compare totals with the probe facts
(~183 sessions since 2026-01-27; ~1 600 kWh Feb–Sep excluding noise). Run the cron handler locally with
and without `CRON_SECRET` (401/200). Start `bun run dev`, confirm `/charging` renders (curl for 200 +
key text) and one `integration sync run` log line per run. Fix nothing silently: report findings. Any
bug found → commit a fix with a test, `fix(charging): …`.
