# ADR 0019 — External Data Integrations

- **Status**: Accepted
- **Date**: 2026-09-28
- **Deciders**: Lukas
- **Decision in one line**: Every pulled external integration (Zaptec now; elpris and Škoda later)
  fails closed with no silent no-op adapter, reports through one typed `IntegrationErrorCode` union,
  serializes concurrent sync runs with a lease row (not an advisory lock, because prod sits behind
  Supabase's transaction pooler), and records both a mutable health snapshot and an append-only run
  history — so a broken integration is visible on the page and in one log line, instead of quietly stale.

**Spec**: [EV charging Phase 1 design, "PR C"](../superpowers/specs/2026-09-28-ev-charging-phase1-design.md).
**Plan**: [EV charging Phase 1 implementation plan](../superpowers/plans/2026-09-28-ev-charging-phase1.md).
**Research**: [EV charging scope map](../superpowers/specs/2026-09-28-ev-charging-scope-map.md).
**Glossary**: [`CONTEXT.md`](../../CONTEXT.md).

---

## Context

Phase 1 of EV charging adds the first **pulled** external integration: a Zaptec sync that runs
hourly (Vercel cron) and on demand (an admin "Synka nu" button), reads sessions since the last
successful run, and upserts them. This is a different shape from every effect ADR-0001 covers —
those are all effects the app *pushes* (send an email, presign a storage URL, enqueue a queue
message) inside a request that already has a caller to fail back to. A pulled sync has no caller
waiting on it: it runs unattended on a schedule, and the only way anyone finds out it broke is
either the page going stale or someone reading logs.

Two more integrations are coming (`elpris` spot prices in Phase 2, `skoda` vehicle snapshots in
Phase 5 — see the scope map), and both will hit the same problems Zaptec hits first:

1. **Credentials can be missing, wrong, or revoked.** Zaptec's password grant is undocumented and
   Zaptec has said (no date given) it "will be phased out." An integration needs a state for "not
   set up here" (preview deploys, local dev without secrets) that is clearly different from "was
   working, now isn't."
2. **APIs drift.** Zaptec's session schema, Škoda's public API, and elprisetjustnu.se's JSON shape
   can all change shape without notice. A schema mismatch must surface as a distinguishable failure
   mode, not a raw exception three layers away from the log line that would explain it.
3. **Two runs must never race.** The hourly cron and an admin's manual "Synka nu" can overlap; Vercel
   Queues can also redeliver (no dedup guarantee). A second run must not double-import sessions or
   stomp the first run's result while it's mid-write.
4. **Someone has to notice.** Admins don't watch logs. The one thing worth an email is "this just
   started failing" and "this just recovered" — not a page-view-blocking modal, not one email per
   hourly retry.

This ADR is the seam that answers all four for every current and future pulled integration, so
`elpris` and `skoda` are additions to an existing pattern rather than each inventing their own.

---

## Decision (TL;DR)

**Fail closed. Inject `fetch` as the seam. One error-code union. A lease row, not an advisory lock.
A mutable health snapshot plus an append-only run history. One log line per run. Alert on
transitions only.**

### Fail closed — no devLog adapter

Every other multi-adapter effect in `src/lib/effects/` (email, storage, queue) ships a `devLog`
adapter: print the payload, return success, keep local dev and CI unblocked without real
credentials. A pulled integration **does not get one**. `src/lib/effects/zaptec/` selects:

- `VITEST` → a `notConfigured` client (tests inject their own fake `ZaptecClient` explicitly).
- Credentials present (`ZAPTEC_USERNAME` / `ZAPTEC_PASSWORD`) → the real HTTP adapter.
- Credentials missing → `notConfigured`, whose every method throws `ZaptecError('not_configured')`.
- `ZAPTEC_ADAPTER=fake` (dev-only escape hatch) → synthetic data, for UI work without real Zaptec
  access — deliberately opt-in, never the default, and **ignored in production** (`VERCEL_ENV` or
  `NODE_ENV` = `production`): there selection silently falls through to the credentials check, so
  a stray env var can never serve fake data on the live site.

A `devLog` adapter here would return success for a sync that did nothing, which is
indistinguishable on the health snapshot from a real successful sync. For a push effect (send this
email) a no-op is honest — nothing happened, nothing was owed. For a pull (did we import today's
sessions?) a no-op is a lie: the page would show "Senast synkad" with a fresh timestamp and zero
new data, and nobody would know to look closer. `not_configured` is instead a first-class health
state (see below) precisely so preview deploys (no Zaptec creds — the preview DB is a prod branch)
and local dev show an honest, visible "not set up" rather than a fake green check.

### Injected `fetch` as the test seam

`createZaptecClient({ fetch, creds, now?, sleep? })` takes `fetch` as a constructor argument rather
than importing the global. Tests pass a hand-written `fakeFetch(routes)` that returns real
`Response` objects built from synthetic fixtures (never the real probe JSON captured during the
Phase 0 research, which carries real session data). This is the same shape ADR-0001's effects use
(a real adapter + a substitutable one) but the substitution point is a function argument instead of
a second module, because there is intentionally no second *production* adapter to house it in — see
"fail closed" above. `now` and `sleep` are injected the same way, for deterministic tests of token
expiry and retry backoff.

### The `IntegrationErrorCode` union

`src/lib/integrationHealth.ts` (dependency-free, client-safe — no `db`/`postgres` import, so the
client can import the union for status badges without pulling the db layer's `Buffer` usage into the
browser bundle, the same discipline as `src/lib/sensor/range.ts`):

```ts
export const INTEGRATION_SOURCES = ['zaptec', 'elpris', 'skoda'] as const
export const INTEGRATION_ERROR_CODES = [
  'auth_failed',        // 400/401 from the token endpoint — wrong/changed password, or a
                         // retired grant type (Zaptec's password grant has no deprecation date)
  'forbidden',           // 403 — credentials valid, role/permission lost
  'rate_limited',        // 429
  'unreachable',         // network error, timeout, 5xx
  'unexpected_response', // zod parse failure — the API's shape drifted from what we coded against
  'not_configured',      // no credentials configured for this environment
  'internal_error',      // a bug in our own sync code, not the remote API
] as const
export const SYNC_TRIGGERS = ['cron', 'admin'] as const
export const SYNC_RUN_OUTCOMES = ['ok', 'failed', 'error'] as const
export type HealthTransition = 'none' | 'started_failing' | 'recovered'
export type HealthState = 'never_synced' | 'not_configured' | 'ok' | 'stale' | 'failing'
```

This is the same discipline as `<Entity>DomainError.code` (ADR-0002): a closed, English,
machine-readable union that a `switch` can exhaustively map, here to both an admin-facing message
(`src/lib/integrationHealthMessage.ts`, client-side, `import type` only, reused by the alert email
template) and a CHECK constraint in `integration_sync`/`integration_sync_run` (so a code typo is a
migration-time or insert-time error, never a silent value nobody validates). `not_configured` is a
**code**, not a separate boolean — a row with `errorCode = 'not_configured'` is structurally the same
shape as any other failing row, it's just never alerted on (below) and maps to its own `HealthState`.

Responses are parsed with zod (`src/lib/effects/zaptec/`); a parse failure becomes
`unexpected_response` with a message that lists field paths only, never the payload. Sessions are
parsed **one by one**: a single session that doesn't match the schema (a `null` energy, a missing
flag) is dropped and counted (`stats.rejected`, folded into the run's `skipped`) instead of failing
its page — which, since the watermark only moves past a page that imported, would fail every later
run on the same record. A page where *every* session fails still throws: that's a shape change, not
one odd record, and must not read as a healthy run that imported nothing. Zaptec
sessions carry `sessionSignature` (OCMF, embeds meter readings) and the owner's email/name, and the
client **never logs**, only reports through a `stats` sink (`authMs`, `fetchMs`, `requests`,
`retries`, `pages`) that the sync run folds into its one log line.

### Timeout and retry policy

> Amended 2026-09-29: ky now owns timeouts and retries. See "Amendment (2026-09-29): ky owns the timeout + retry
> policy" below.

Fixed, not configurable per call site — a single documented policy is easier to reason about than
per-integration knobs, and elpris/Škoda are expected to want the same shape:

- Timeouts via `AbortSignal.timeout`: 10 s for data calls, 5 s for the live-state read (a UI tile
  waiting on it, not a batch job).
- Retries: ≤ 2, only on `429` / `502` / `503` / `504` / network errors. Retry-After is honored up to
  10 s; longer than that, fail as `rate_limited` rather than block a cron invocation for a minute.
  Backoff without a Retry-After header: 0.5 s then 1.5 s, plus jitter.
- No retry on a token-endpoint 4xx (a wrong password doesn't get more right on retry) and no retry
  on `liveState` (it's polled again in 60 s anyway; retrying just adds latency to a UI request).
- **Failures are cached, not re-attempted on every poll.** A rejected login (`auth_failed` /
  `forbidden`) blocks new login attempts for 5 minutes — repeated password-grant failures risk
  locking the Zaptec account. A failed `liveState` is cached per charger and rethrown without a
  network call: auth failures for 5 minutes, `unreachable` / `rate_limited` for 60 s (successes keep
  their 15 s TTL). A read cut off by the *caller's own* signal (the 6 s `liveStatus` budget running
  out on a cold login) is not cached — that's the caller's budget, not Zaptec being down.
- The access token is reused until 5 minutes before `expires_in` — or until halfway through its
  lifetime for a token that lives 10 minutes or less, so a short-lived token is still reused
  instead of every call doing a fresh password-grant login. The login is shared by concurrent callers; a caller's `signal` only stops *its*
  wait on it (→ `unreachable`), the login keeps running for the others.
- **`liveStatus` has a 6 s budget.** The procedure passes `AbortSignal.timeout(6_000)` covering the
  whole Zaptec wait (shared login included), so the polled RPC can never hold a Vercel Function open
  longer than that (ADR-0018).
- **The sync run has a 240 s overall deadline.** One deadline signal goes to every Zaptec call via
  `CallOpts.signal`, and each call is also raced against it, so a slow or hung Zaptec fails the run
  as `unreachable` — which still records its outcome and emits its run line — before Vercel's 300 s
  default function limit kills the invocation mid-write.
- **Sessions are fetched in windows of at most 90 days, oldest first**, from 7 days before the
  watermark (`lastSuccessStartedAt`; `2020-01-01` on the first run) to the run's start. Every window
  that fully imports moves the run's `syncedUntil`, and that becomes the next watermark — on success
  *and* on failure. So a multi-year first backfill checkpoints instead of restarting from 2020 each
  time it hits the deadline, and no new window starts after 120 s of run time (the next run
  continues). A window that overflows the 20-page cap (200 sessions a page) is halved and retried
  from the same start, down to 1 hour, so a dense stretch narrows instead of failing every run. An
  hourly run is a single window.
- Status → code mapping is fixed inside the client (`token 400/401` → `auth_failed`; `403` →
  `forbidden`; `429` → `rate_limited`; `5xx`/network/timeout → `unreachable`), so every caller gets
  the same classification without re-deriving it.

### Health snapshot + run history, not one or the other

Two tables, not one:

- **`integration_sync`** — one row per source (`source` is the primary key, CHECK-constrained to
  `INTEGRATION_SOURCES`), **updated in place** by every run. This is what the page reads on every
  view: `lastAttemptAt`, `lastSuccessAt`, `lastSuccessStartedAt` (the fetch watermark: how far every
  session has been imported — the run's start, or the end of the last finished window), `failingSince`,
  `alertedAt` (when this streak's `started_failing` alert went out; null while no alert is open),
  `consecutiveFailures`, `alertableFailures` (the streak's consecutive *alertable* failures —
  `not_configured` excluded and resets it; the alert threshold counts these), `errorCode`,
  `lastErrorMessage` (admin-only, ≤ 500 chars; for a failed
  database query it's the Postgres error, never drizzle's own message, which is the SQL plus its bound
  params — session emails and names; for a data exception, SQLSTATE class 22, only the code, since its
  message quotes the offending value; sanitized before write — control chars
  stripped, `Bearer \S+`/`password=\S+` redacted — a defense-in-depth backstop; the client itself
  never logs credentials, so this guards against a future bug, not today's expected path), plus the
  lease fields below. Cross-column CHECKs keep it internally consistent: `consecutiveFailures = 0`
  iff `errorCode IS NULL` iff `failingSince IS NULL`; `alertedAt` only while `errorCode` is set;
  `runningSince IS NULL` iff `leaseUntil IS NULL` iff `leaseToken IS NULL`; `consecutiveFailures`
  and `alertableFailures` both `>= 0`. `alertableFailures <= consecutiveFailures` holds too, but
  `nextRow` enforces it, not a CHECK: code from before the column (an instant rollback) zeroes
  `consecutive_failures` on success and leaves `alertable_failures` alone.
- **`integration_sync_run`** — append-only, one row per attempt (`id`, `source`, `trigger`,
  `startedAt`/`finishedAt`/`durationMs`, `outcome`, `errorCode`, `errorMessage`, `since`, `pages`,
  `sessionsSeen`, `upserted`, `voided`, `timings` jsonb), indexed on `(source, startedAt desc)` for
  the admin-only "last 20 runs" view. Pruned to 90 days right **after** the transaction that inserts
  the new row and updates the snapshot commits (not inside it, so a failing `DELETE` can never roll
  back or abort the outcome write); a pruning failure is logged as a warning and never fails the run
  — history is diagnostic, not load-bearing, so it degrading gracefully matters more than it being
  perfectly bounded on every single write.

A single mutable row (Alternative C below) can't answer "how often is this actually failing" or
back the admin's run-history view; log lines alone (Alternative D) can't back a fast, structured page
read or a CHECK-constrained invariant. Snapshot answers "is it healthy right now" in one indexed
row read; history answers "what happened, and when" for the admin who needs to debug a streak.
`recordOutcome` writes both in one transaction so they never disagree about the outcome of a given
run.

**The `stale` state's threshold is per-source, not a single constant.** `getHealth` derives `stale`
from `lastSuccessAt` age against a threshold looked up in `policy.ts` (`src/lib/services/integrationSync/`)
by source — a domain rule, not a schema column, so it can change without a migration. Zaptec's
threshold is **3 hours** against its hourly cron: comfortably more than one missed run (covers a
single skipped/failed cron tick plus scheduler jitter) but short enough that "stale" still means
something has actually gone wrong, not "the last run happened to land 61 minutes ago." `elpris` and
`skoda` get their own thresholds in the same file once they land, sized to their own schedules.

### Session import: validate-and-skip, stub parents, allow-listed columns

The Zaptec sync writes rows a human never gets to approve first, on a schedule, from an API whose
shape can drift — so the importer treats every incoming session as untrusted input, not as
pre-validated data. The orchestrator (`src/lib/evCharging/sync.ts`) only pages and hands each page to
`importSessions`; the validate/skip, stub-parent and allow-listed-upsert logic below all lives in the
charging service, `src/lib/services/evCharging/evCharging.ts`:

- **Validate each record against the table's own CHECKs, in JS, before the write** — the same
  constraints `src/lib/db/schema/evCharging.ts` enforces in Postgres (non-negative `energyKwh`,
  `endAt >= startAt`, and the interval equivalents), re-checked in application code so a single bad
  record can be **skipped and counted** rather than aborting the page's transaction. One malformed
  session (a clock glitch, an API bug) must never roll back an otherwise-good page of imports or wedge
  the sync into `failing` forever on every retry — the DB constraint stays as the backstop for
  whatever the JS check misses, per this repo's "check first, constraint as backstop" convention
  (ADR-0002), not as the primary gate.
- **Create a stub `ev_charger` row for an unknown charger id** instead of dropping the session's
  history. Zaptec sessions carry `chargerId`; if the sync sees an id it hasn't recorded yet (a new
  charger added on the Zaptec side between `chargers()` calls, or a delayed metadata sync), inserting
  a minimal placeholder charger row lets the session import proceed and its energy count toward
  totals — the alternative (drop the session until the charger metadata catches up) silently loses
  real kWh from the totals the page shows.
- **Upsert only an explicit allow-list of source-owned columns.** The importer's `ON CONFLICT` update
  touches only the columns Zaptec is the source of truth for (energy, timestamps, `voided`,
  `replacedByZaptecSessionId`, offline/reliableClock flags, …) — never a blanket
  `ON CONFLICT DO UPDATE SET *`. This is what keeps a future admin-owned column (e.g. a manual
  `vehicle` attribution tag, scoped for Phase 5) safe: an hourly re-sync of an already-tagged session
  must not silently overwrite an admin's tag just because the column exists on the same row.

(Session energy (`energyKwh`) is stored as `double precision`, not `real`, in
`src/lib/db/schema/evCharging.ts` — `real`'s ~7 significant digits produced visible drift once many
sessions were summed in SQL for the overview totals, and fixing that after the fact means an
`ALTER … TYPE` that cannot recover precision already lost in rows written as `real`.)

### Lease, not `pg_advisory_xact_lock`

ADR-0002 already sanctions `pg_advisory_xact_lock(hashtext(...))` as the serialization primitive for
a rare admin-count race. That primitive doesn't fit here: **prod runs behind Supabase's transaction
pooler** (pgbouncer in transaction mode), which does not guarantee a session-scoped advisory lock is
released, held, or even visible to the connection that thinks it holds it — a lock acquired in one
transaction can be silently invisible to, or leaked across, a different pooled connection. A
row-based lease sidesteps pooling entirely: it's ordinary MVCC.

```sql
UPDATE integration_sync
SET running_since = now(), lease_until = now() + interval '5 minutes', lease_token = gen_random_uuid()
WHERE source = $1 AND (lease_until IS NULL OR lease_until < now())
RETURNING lease_token
```

Five minutes is comfortably longer than the run's own 240 s deadline (see "Timeout and retry policy")
and Vercel's 300 s default function `maxDuration`, so a lease only survives past its holder if that
holder crashed outright — the next
attempt (cron or admin) reclaims it once `lease_until` passes, self-healing without an operator.

**The lease is a `lease_token uuid` (an attempt id), not a timestamp comparison.** An earlier design
compared `runningSince` (or `leaseUntil`) by value to decide "do I still hold this," which breaks the
instant two attempts' timestamps could coincide (clock granularity, or a retried write recomputing
the same `now()`). The token is generated fresh per `beginAttempt` and is what `recordOutcome`'s
`SELECT … FOR UPDATE` re-reads and compares — if the row's `lease_token` no longer matches the
attempt's own token, this attempt lost the lease (its lock was reclaimed after `lease_until` passed)
and it writes nothing (`transition: 'none'`), rather than clobbering whichever run reclaimed it.

`recordOutcome` runs as one transaction: `SELECT … FOR UPDATE` the row (see ADR-0002 amendment
below), confirm the token, compute the new state with a pure `nextRow(prev, outcome, now)` function
(table-tested in isolation), `UPDATE` the snapshot, clear the lease, and `INSERT` the run row. The row
lock is what makes "at most one alert per transition" hold even if two runs somehow finish within
the same instant: only one can hold the row lock at a time, so only one observes the state change
from "was ok" to "now failing."

### One `integration sync run` log line, alert on transitions only

Every run — regardless of outcome — emits **exactly one** structured log line
(`log.<level>('integration sync run', { source, trigger, outcome, code, transition, since, syncedUntil, durationMs,
authMs, fetchMs, importMs, pages, chargers, sessionsSeen, upserted, voided, skipped })`; the
timings are whole milliseconds), graded `info` for
`ok`/`skipped`, `warn` for `failed`, `error` (with the `error` key, ADR-0003's serialization contract)
for an unexpected `error` outcome. One line per run — not one per page, not one per retry inside the
client — keeps "how did last night's sync go" a single log search away, the same reasoning ADR-0007
applies to its one `queue message` line per delivery.

The **admin alert email** fires only on `HealthTransition` — `started_failing` or `recovered` (the
first success after an alerted streak) — never on every failed run. An alert opens on the
`ALERT_AFTER_FAILURES[source]`-th consecutive *alertable* failure of a streak (`policy.ts`: 1 for
Zaptec and elpris, so their first failure alerts; 3 for Škoda, whose 15-minute poll rides out a
transient blip — see [ADR-0022](./0022-live-vehicle-state-attribution.md)). `not_configured` is not
alertable (an environment that was never set up isn't a regression to page an admin about): it resets
the count, never opens an alert and never closes one. A mid-streak change between alertable codes,
e.g. `auth_failed` → `unreachable`, does not re-alert — it's the same streak — and counts toward the
threshold. Whether the streak alerted is its own column, `alertedAt`, not derived from the current
code: `not_configured` → `auth_failed` (credentials added, but wrong) opens one once
`auth_failed` reaches the threshold (at once for a threshold of 1), and `auth_failed` →
`not_configured` → ok still closes it with `recovered`. Every `recovered` pairs with a
`started_failing`. This is the one place a sync failure reaches a human outside the logs, and it earns
that reach precisely by being rare: an hourly cron with a real outage would otherwise send 24
identical emails a day.

The outcome is written once. If that write itself throws (a database blip), the run rethrows without
recording a second `internal_error` outcome — the fetch may have succeeded, and whether the first
write committed is unknown. The lease expires and the next run redoes the window.

### Cron status codes: 200 for integration failures, 500 for bugs

`src/routes/api/cron/zaptec-sync.ts` returns **200** for `ok`, `failed`, and `skipped` outcomes — the
sync ran to completion and recorded whatever happened, including a Zaptec-side failure. It returns
**500** only when `runZaptecSync` itself throws unexpectedly — a bug in the sync code, not a Zaptec
problem, since `ZaptecError` is caught inside `runZaptecSync` and turned into a normal `failed`
return. This matters because Vercel's cron monitoring (and any uptime check watching the route) alerts
on non-2xx — a Zaptec outage is exactly the case where alerting through the health-snapshot email
(above) is right and a second, cruder "the cron endpoint failed" page-out would be noise on top of
signal. A genuine bug (a `TypeError` in our own code) is the one case that should show up as an
infrastructure-level alarm, because the health-snapshot machinery that would otherwise catch it may
itself be the thing that's broken.

---

## Alternatives considered

### A devLog fallback adapter (mirroring email/storage/queue)

- ➕ Consistent with every other effect; local dev "just works" with zero setup.
- ➖ A no-op success is indistinguishable from a real, empty sync on the health snapshot — the exact
  failure mode this ADR exists to prevent. The whole point of a pull integration's health tracking is
  to answer "did this actually run," and a devLog adapter answers "yes" unconditionally.
- **Verdict**: don't. `notConfigured` (a real, visible health state) replaces it; `ZAPTEC_ADAPTER=fake`
  covers the "I want to see the UI populated locally" need explicitly, opt-in.

### `pg_advisory_xact_lock` (the primitive ADR-0002 sanctions elsewhere)

- ➕ Zero new schema; one line at the top of a transaction; already the documented escape hatch for
  a rare admin-count race.
- ➖ Undefined behavior through Supabase's transaction-mode pooler: the lock's session affinity
  assumption doesn't hold when the pooler can hand a "session" to a different backend connection
  between statements. This isn't a tail-risk edge case for an hourly cron sharing infra with
  interactive traffic — it's the default connection path in prod.
- ➖ No natural place to also carry "how long has this been running" or "when does the lease expire"
  — an advisory lock is boolean, held-or-not; the lease row's `runningSince`/`leaseUntil` timestamps
  double as the "is this actually still healthy or did the holder die" answer for free.
- **Verdict**: don't, specifically because of the pooler. The ADR-0002 use case (a rare same-request
  admin mutation) doesn't share this integration's every-hour, out-of-band execution profile.

### A single mutable health row (no run history)

- ➕ Simplest possible schema — one row per source, nothing else.
- ➖ No debugging trail: an admin looking at "3 consecutive failures" has no way to see *what* failed
  each time without re-deriving it from logs (which rotate and aren't queryable from the UI).
- ➖ Can't back the "last 20 runs" admin view the design calls for.
- **Verdict**: don't. The extra table is cheap (append-only, no invariants beyond CHECKs) and the
  snapshot alone can't serve the admin debugging need.

### Logs-only history (no `integration_sync_run` table, health snapshot only)

- ➕ No second table; "search the logs" is already how ADR-0003 expects debugging to work.
- ➖ Structured log retention is short and log search is not the UI's data source — the admin-only
  run history needs to render as a table on `/charging`, which means a query, not a grep. Vercel's
  own retention (Pro: 1 day; Hobby: 1 hour, per ADR-0003's corrected figures) is far shorter than the
  90-day window this ADR wants for the run table.
- **Verdict**: don't replace the table with logs; keep both — the log line is for live debugging and
  alerting context, the table is for the UI and for retention past what Runtime Logs keep.

---

## Consequences

**Positive**:
- One pattern for every future pulled integration (elpris, Škoda): fail closed, one error-code union,
  a lease instead of a pooler-unsafe lock, snapshot + history, one log line, transition-only alerts.
  Adding `elpris` means extending `INTEGRATION_SOURCES` and writing its own client + sync module
  behind the same seam — no new architecture decision.
- The health snapshot is a genuine safety net: a broken Zaptec login shows up on `/charging` for every
  signed-in user (data "possibly outdated") and pages the admins by email on the transition, instead
  of silently going stale until someone notices the totals stopped moving.
- The lease's row-lock semantics compose cleanly with ADR-0002's existing `SELECT … FOR UPDATE`
  sanction (see the ADR-0002 amendment below) — no new locking primitive for a reviewer to learn.

**Negative**:
- Two new tables and a decent amount of cross-column CHECK ceremony for what is, today, a single
  integration. Justified by "this is the second of three planned integrations, and the third
  (`skoda`) is already scoped" rather than by Zaptec alone.
- `notConfigured` failing closed means local dev without Zaptec credentials shows the integration as
  perpetually unhealthy unless a developer opts into `ZAPTEC_ADAPTER=fake` — a small extra step
  compared to email/storage/queue's zero-config devLog experience.
- The lease's 5-minute window is a magic number tuned to "longer than one function invocation can
  run." If a future integration's sync genuinely needs longer than that per attempt, the lease
  duration (not the pattern) needs revisiting per-source.
- ~~A failure streak whose error code changes to or from `not_configured` can produce an unpaired
  alert email.~~ Accepted in the first version; fixed by the `alertedAt` column (see "alert on
  transitions only"). The first-time setup made it real: credentials start unset (`not_configured`)
  and are then entered wrong, which under the old rule never alerted at all.

**Revisit triggers** — re-open this ADR if any of these change:
- A pulled integration emerges that has a genuine, safe fallback value (unlike Zaptec, where "no
  data" is the only honest empty state) — reconsider whether `devLog` earns a narrower carve-out
  there.
- Supabase's pooler configuration changes (e.g. prod moves to session mode), removing the reason
  advisory locks were ruled out here.
- A third alert channel (Slack, SMS) is wanted alongside email — the transition-only trigger point
  stays the same, only the delivery adapter changes, but it's worth confirming here rather than
  re-deriving "when do we alert" from scratch.

---

## Amendment (2026-09-29): the second source — `elpris`

Adding SE3 spot prices ([ADR-0020](./0020-spot-prices-and-cost-model.md)) confirmed the pattern and settled three
generalizations:

- **One lifecycle, shared.** `src/lib/integrations/runPulledSync.ts` owns the lease, deadline, record-once outcome,
  transition-only alert and the one `integration sync run` log line; a source supplies only `execute` and its
  counters. `IntegrationError` is the base class every client error extends (→ `failed`; anything else → `error`).
  `handleCronRun` (`src/lib/integrations/cron.ts`) is the shared 401/200/500 cron mapping.
- **A keyless API still fails closed.** elprisetjustnu.se needs no credentials, so its `http` adapter is the default
  everywhere (dev and preview included); `notConfigured` exists only under VITEST so no test reaches the network.
  There is still no devLog/fake adapter.
- **A source may have no watermark.** The elpris run plans "the Stockholm days not stored yet" (first counted
  charging day → tomorrow, newest first, capped per run) — self-healing, and a stored day is never re-fetched.
  An unpublished future day is normal; a missing **today/yesterday** fails the run (after the rest has landed), so a
  price outage alerts; an older day that 404s or fails validation is counted and skipped so one bad archive day can't
  wedge the backfill.
- **Validate the source, not just its shape.** Beyond zod, the parser cross-checks `SEK ≈ EUR × EXR` (catches unit
  changes) and derives each slot's end from the next slot's start — the API's own `time_end` is wrong for the slot
  before the clocks go back (02:45+02:00 → "03:00+01:00"), found by review against live data.
- Health copy names its source (`integrationErrorMessage(code, { source })`); "Synka nu" runs one request per source
  so the quick session sync isn't held behind a price backfill. Cron: `/api/cron/elpris-sync` at 12:30 and 15:30 UTC.

## Amendment (2026-09-29): ky owns the timeout + retry policy

Both clients' hand-written retry loops are gone. `fetchWithRetry` (`src/lib/effects/http.ts`) runs every Zaptec and
elpris request through [ky](https://github.com/sindresorhus/ky) and uses ky's own timeout/retry/backoff instead of
matching the old loop exactly. It supersedes these parts of "Timeout and retry policy" above:

- **Timeout:** ky's per-attempt `timeout` (10 s; 5 s for `liveState`). The only custom piece is the `fetch` passed to
  ky. It reads a **2xx** body inside the call, so the timeout covers the download too, and a download that drops or
  stalls is retried like any network failure (`retryOnTimeout`) before it's reported as `unreachable`. This now
  applies to Zaptec as well; before, a failed Zaptec download was not retried. For `liveState` (never retried) a
  dropped download is therefore `unreachable` (it was `unexpected_response`), so it's cached for 60 s like any
  transient failure. **A non-2xx body is not read inside the attempt.** It comes back unread, so a dropped error
  body can't turn a final 4xx into retries (a token 400/401 is still one password-grant POST and still sets the
  login block). The attempt's own timeout signal stays on the response, so reading that body later is bounded too.
- **Retries:** up to 2, for GET and the Zaptec login POST, on the client's status set (data `429/502/503/504`, login
  `502/503/504`, none for `liveState`) and on **any** other failure except the caller's abort (`shouldRetry`), as
  before. Backoff is 0.5 s then 1.5 s, jittered ×0.8–1.2 (ky `delay` + `jitter`).
- **Retry-After:** honored on every retryable status (`afterStatusCodes`), as before, but parsed by ky: whole seconds
  or an HTTP date, and with no Retry-After it also reads `RateLimit-Reset` / `X-RateLimit-*`. **A Retry-After over
  10 s is capped at 10 s and waited out** (`maxRetryAfter`); it no longer fails straight away as `rate_limited`.
  Worst case per request is now about 3 × the timeout plus 2 × 10 s, still well inside the sync run's 240 s deadline.
- Unchanged: status → code mapping (a dropped error body included), a caller abort is final and never retried,
  causes carry only `{ name, code }`, the `stats` counters, and no retry on a token 4xx or on `liveState`.

## Amendment (2026-09-30): a watcher, not a source — the Eltariff catalogue check

The grid-tariff watcher (`src/lib/gridTariff/`, monthly cron `/api/cron/grid-tariff-catalogue`) asks one question
until Phase 2b replaces it: does a grid company publishing machine-readable tariffs (the RISE Eltariff-API catalogue)
cover our facility? If so, it emails every active admin — on every monthly run, statelessly. Its client
(`src/lib/effects/eltariff/`) follows this ADR's client rules: keyless `http` adapter by default, `notConfigured` only
under VITEST, `EltariffError extends IntegrationError`, and `fetchWithRetry`.

**It is deliberately not an integration source.** It has no `integration_sync` row, lease, run history, or transition
alerts. It imports no data, a duplicate run at worst sends a second notice, and a missed month only delays a heads-up.
A source would mean widening the `source` CHECK constraints (a migration and schema review), plus per-source copy and
stale thresholds, all for a temporary feature. If the watcher grows into Phase 2b's grid-fee import, that import
becomes a real source.

What still holds:

- **Fail closed.** An unset or malformed `GRID_FACILITY_ID` is `not_configured`, and nothing is fetched. An
  unreadable catalogue is `failed` with its code. A catalogue with no usable entry, an empty one included,
  is `unexpected_response` (schema drift or an outage), never read as "not covered". A run with no match but some malformed entries dropped is
  `inconclusive` and warned, never read as "not covered". Only the two ID fields are required, so an entry without
  a company name still counts.
- **One log line** per run (`grid tariff catalogue check`): info for `not_covered` and for a `covered` run whose
  notice reached every admin; warn otherwise, including a `covered` run that reached nobody or not everyone; error
  for a bug. Failures surface only in Runtime Logs; that is accepted for this watcher.
- **Cron status codes** as above: 200 for every checked outcome, 500 only for an unexpected throw.
- **The facility ID never leaves the process.** Only `GET /tariffcatalogue/all` is fetched (never `lookup/{mpid}`),
  the match runs locally with `BigInt` (18 digits exceed `Number`), and the ID is never logged, returned, or queued.

---

## Amendment (2026-10-02): a per-source alert threshold

The car's state poll ([ADR-0022](./0022-live-vehicle-state-attribution.md)) runs every 15 minutes, so
alerting on its first failure would page an admin for every transient blip. `ALERT_AFTER_FAILURES`
(`src/lib/services/integrationSync/policy.ts`) sets the threshold per source — Zaptec 1, elpris 1,
Škoda 3 — and `integration_sync.alertable_failures` counts the streak's consecutive alertable
failures (`not_configured` resets it). Zaptec and elpris behave exactly as before. The rule itself is
in "One `integration sync run` log line, alert on transitions only" above.

The key's expiry is tracked generically: `integration_sync.credential_expires_at` (set by a source whose
credential expires, read from the credential itself) and `credential_reminder_days` (the last reminder
threshold sent, reset when the key is renewed). Admins get reminder emails at 30 and 7 days, and `syncStatus`'s
admin-only `adminDetail.credentialExpiry` drives an in-app warning from 30 days out while the source is
healthy. See [ADR-0022](./0022-live-vehicle-state-attribution.md) and the
[runbook](../runbooks/skoda-api-key.md).

---

## Amendment (2026-10-04): sync progress on the health row

A running sync can report progress ("12 av 30 dagar") for its Datakällor tile. `runPulledSync` hands `execute` a
`reportProgress(done, total)` that writes `integration_sync.progress_done` / `progress_total` **under the run's lease
token while the lease is unexpired** (an expired, taken-over or recorded lease writes nothing), throttled to one write
per second (`done = total` always writes) and best effort (a
failed write is a `warn`, never a failed run). `beginAttempt` and `recordOutcome` clear it; `getHealth` exposes it
only while the lease is live, so a leftover is never shown — and no CHECK ties it to the lease, so a rollback's
`recordOutcome` (which doesn't know the columns) can't fail. Emaldo and elpris report days; Zaptec and Škoda finish
before a poll would see them and don't report.

Why the database, not a push or another store: the tile already polls this row (ADR-0018), the run already writes it,
and it works for cron runs and every viewer. Streaming the click's request serves only that tab; process memory
doesn't survive Fluid instance routing; Runtime Cache/Redis add a second store that can disagree with the lease;
Vercel Workflow was parked as a separate re-platforming decision. Design:
[`2026-10-04-sync-progress-design.md`](../superpowers/specs/2026-10-04-sync-progress-design.md).

## Amendments to other ADRs

Full rationale lives in each amended ADR itself (this repo's convention: one substantive copy, not
a duplicate here) — these are pointers, not summaries to read instead of them.

- **[ADR-0001](./0001-side-effects-architecture.md) amended 2026-09-28**: domain orchestrators in
  `src/lib/<domain>/` (e.g. `src/lib/evCharging/sync.ts`) are a sanctioned effect-calling location
  alongside oRPC procedures; `/api/cron/*` and `/api/webhooks/shelly` join the sanctioned non-oRPC
  entrypoint list; hosting plan is Vercel Pro, not Hobby (Hobby's 1/day cron cap is why it matters
  here). See that ADR's 2026-09-28 amendment block.
- **[ADR-0002](./0002-service-domain-architecture.md) amended 2026-09-28**: `SELECT … FOR UPDATE`
  inside a service's own transaction is a sanctioned pattern generally, not only the advisory-lock
  escape hatch; role-shaped reads take an explicit flag (`includeAdminDetail: boolean`), never a
  `role` parameter. See that ADR's "Amendment (2026-09-28)" section.

---

## Critical files

- `src/lib/integrationHealth.ts` — the shared vocabulary (sources, error codes, triggers, outcomes,
  health states, transitions); dependency-free and client-safe.
- `src/lib/effects/zaptec/` — the fail-closed client: `notConfigured` / http / `fake` adapter
  selection, injected `fetch`, zod parsing, retry/timeout policy, login + live-state failure caches, `stats` reporting.
- `src/lib/services/integrationSync/` — `beginAttempt` (lease acquire), `recordOutcome` (transition +
  snapshot + history, `FOR UPDATE`), `getHealth`, `listRecentRuns`.
- `src/lib/db/schema/integrationSync.ts` — `integration_sync` (snapshot + lease) and
  `integration_sync_run` (append-only history) tables and their CHECK constraints.
- `src/lib/db/schema/evCharging.ts` — `ev_charger` / `ev_charge_session` / `ev_charge_interval`; the
  `double precision` energy columns and their CHECKs the importer re-validates in JS before writing.
- `src/lib/effects/elpris/` — the keyless spot-price client (DST-safe slot parsing, unit cross-check);
  `src/lib/spotPrice/sync.ts` — `runElprisSync`, the missing-days planner.
- `src/lib/effects/eltariff/` — the keyless Eltariff catalogue client (drop-and-count parse, no usable entry =
  `unexpected_response`); `src/lib/gridTariff/` — the monthly watcher (`catalogueCheck.ts`) and its local `BigInt`
  matcher. Not a source; see the 2026-09-30 amendment.
- `src/lib/integrations/runPulledSync.ts` — `runPulledSync`, the source-generic run lifecycle
  (lease, deadline, record-once outcome, transition-only alert email, the one `integration sync run`
  log line) and `withDeadline`; `src/lib/integrations/cron.ts` — `verifyCronSecret` + `handleCronRun`
  (the 200/500 mapping). Extracted 2026-09-29 so every source shares it.
- `src/lib/evCharging/sync.ts` — `runZaptecSync`: the Zaptec fetch windows + session import and the
  240 s run deadline, run inside `runPulledSync`.
- `src/lib/services/evCharging/evCharging.ts` — `importSessions` / `upsertChargers`: the
  validate-skip / stub-parent / allow-listed-upsert import behavior.
- `src/lib/integrationHealthMessage.ts` — client-side, code-only → Swedish/English message mapping,
  reused by the alert email template.
