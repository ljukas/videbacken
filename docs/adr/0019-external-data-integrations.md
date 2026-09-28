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
  access — deliberately opt-in, never the default.

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
`unexpected_response` with a message that lists field paths only, never the payload — Zaptec
sessions carry `sessionSignature` (OCMF, embeds meter readings) and the owner's email/name, and the
client **never logs**, only reports through a `stats` sink (`authMs`, `fetchMs`, `requests`,
`retries`, `pages`) that the sync run folds into its one log line.

### Timeout and retry policy

Fixed, not configurable per call site — a single documented policy is easier to reason about than
per-integration knobs, and elpris/Škoda are expected to want the same shape:

- Timeouts via `AbortSignal.timeout`: 10 s for data calls, 5 s for the live-state read (a UI tile
  waiting on it, not a batch job).
- Retries: ≤ 2, only on `429` / `502` / `503` / `504` / network errors. Retry-After is honored up to
  10 s; longer than that, fail as `rate_limited` rather than block a cron invocation for a minute.
  Backoff without a Retry-After header: 0.5 s then 1.5 s, plus jitter.
- No retry on a token-endpoint 4xx (a wrong password doesn't get more right on retry) and no retry
  on `liveState` (it's polled again in 60 s anyway; retrying just adds latency to a UI request).
- Status → code mapping is fixed inside the client (`token 400/401` → `auth_failed`; `403` →
  `forbidden`; `429` → `rate_limited`; `5xx`/network/timeout → `unreachable`), so every caller gets
  the same classification without re-deriving it.

### Health snapshot + run history, not one or the other

Two tables, not one:

- **`integration_sync`** — one row per source (`source` is the primary key, CHECK-constrained to
  `INTEGRATION_SOURCES`), **updated in place** by every run. This is what the page reads on every
  view: `lastAttemptAt`, `lastSuccessAt`, `lastSuccessStartedAt`, `failingSince`, `consecutiveFailures`,
  `errorCode`, `lastErrorMessage` (admin-only, ≤ 500 chars, sanitized before write — control chars
  stripped, `Bearer \S+`/`password=\S+` redacted — a defense-in-depth backstop; the client itself
  never logs credentials, so this guards against a future bug, not today's expected path), plus the
  lease fields below. Cross-column CHECKs keep it internally consistent: `consecutiveFailures = 0`
  iff `errorCode IS NULL` iff `failingSince IS NULL`; `runningSince IS NULL` iff `leaseUntil IS NULL`
  iff `leaseToken IS NULL`.
- **`integration_sync_run`** — append-only, one row per attempt (`id`, `source`, `trigger`,
  `startedAt`/`finishedAt`/`durationMs`, `outcome`, `errorCode`, `errorMessage`, `since`, `pages`,
  `sessionsSeen`, `upserted`, `voided`, `timings` jsonb), indexed on `(source, startedAt desc)` for
  the admin-only "last 20 runs" view. Pruned to 90 days inside the same transaction that inserts the
  new row and updates the snapshot; a pruning failure is logged as a warning and never fails the run
  — history is diagnostic, not load-bearing, so it degrading gracefully matters more than it being
  perfectly bounded on every single write.

A single mutable row (Alternative C below) can't answer "how often is this actually failing" or
back the admin's run-history view; log lines alone (Alternative D) can't back a fast, structured page
read or a CHECK-constrained invariant. Snapshot answers "is it healthy right now" in one indexed
row read; history answers "what happened, and when" for the admin who needs to debug a streak.
`recordOutcome` writes both in one transaction so they never disagree about the outcome of a given
run.

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

Five minutes is comfortably longer than the sync's own timeout/retry budget and the Vercel function's
`maxDuration`, so a lease only survives past its holder if that holder crashed outright — the next
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
(`log.<level>('integration sync run', { source, trigger, outcome, code, transition, since, durationMs,
authMs, fetchMs, importMs, pages, chargers, sessionsSeen, upserted, voided })`), graded `info` for
`ok`/`skipped`, `warn` for `failed`, `error` (with the `error` key, ADR-0003's serialization contract)
for an unexpected `error` outcome. One line per run — not one per page, not one per retry inside the
client — keeps "how did last night's sync go" a single log search away, the same reasoning ADR-0007
applies to its one `queue message` line per delivery.

The **admin alert email** fires only on `HealthTransition` — `started_failing` (the first failure of
a streak) or `recovered` (the first success after one) — never on every failed run and never for
`not_configured` (an environment that was never set up isn't a regression to page an admin about; a
mid-streak error-code change, e.g. `auth_failed` → `unreachable`, also does not re-alert — it's the
same streak). This is the one place a sync failure reaches a human outside the logs, and it earns
that reach precisely by being rare: an hourly cron with a real outage would otherwise send 24
identical emails a day.

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
- **A failure streak whose error code changes to or from `not_configured` can produce an unpaired
  alert email.** The snapshot row keeps only the *current* code, not the sequence of codes a streak
  passed through, and `not_configured` is deliberately never alerted on (see "fail closed" and "one
  log line, alert on transitions only" above). So: `auth_failed` → `not_configured` (an admin removes
  the credentials mid-outage) → `ok` sends the original `started_failing` email but no `recovered`
  email, because `not_configured`'s own transition into `ok` doesn't alert; `not_configured` →
  `auth_failed` (an admin adds wrong credentials) → `ok` sends a `recovered` email with no preceding
  `started_failing` one, because the streak's first alertable code appeared partway through. Accepted:
  both paths require an admin action (removing or adding Zaptec credentials) to occur *during* an
  active outage, which is already the moment an admin is looking at the integration directly — the
  email is a convenience notification, not the source of truth (the `/charging` page and
  `listRecentRuns` are). Fixing this precisely would mean tracking "has this streak ever sent a
  start-of-streak email" as its own column (independent of `errorCode`/`consecutiveFailures`) rather
  than deriving it from the current code — worth adding if a real streak like this is ever observed
  in practice, not worth the schema complexity speculatively.

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

## Amendments to other ADRs

### ADR-0001 (Side-Effects Architecture)

- **Domain orchestrators in `src/lib/<domain>/` are a sanctioned effect-calling location alongside
  oRPC procedures.** `src/lib/evCharging/sync.ts` (`runZaptecSync`) calls `zaptec.chargers()` /
  `zaptec.sessionsEndedSince()` directly and publishes `queue.publish('email_integration_sync_alert',
  …)` on transitions — it is not itself an oRPC procedure (both the cron route and the `syncNow`
  admin procedure call into it), but it is the same kind of caller ADR-0001 already sanctions:
  validate → service/effect → side effect, in order, with no hidden listener. Read "oRPC procedures"
  in ADR-0001's caller-class list as including "or the domain orchestrator an oRPC procedure and a
  cron route both call into," not literally only files under `orpc/procedures/`.
- **`/api/cron/*` and `/api/webhooks/shelly` are non-oRPC entrypoints**, alongside the existing list
  in the 2026-06-10 amendment (`/api/files/*`, `/api/log`, the `vercel:queue` consumer plugin). Both
  are unauthenticated-by-transport routes that verify a shared secret themselves (`CRON_SECRET`,
  `SHELLY_WEBHOOK_TOKEN`) because their callers (Vercel Cron, a Shelly device) are not oRPC clients
  and cannot carry a session.
- **The hosting plan is Vercel Pro, not Hobby.** ADR-0001's Context paragraph and non-negotiables
  section describe a Hobby-plan app; the project has since moved to Pro (see the CLAUDE.md and
  ADR-0018 cross-references this ADR updates below). This matters here specifically because Hobby
  cron is capped at once per day — this feature's hourly Zaptec sync requires Pro's unlimited cron
  schedules.

### ADR-0002 (Service + Domain-Error Architecture)

- **Row locking (`SELECT … FOR UPDATE`) inside a service's own transaction is a sanctioned pattern**,
  not just the advisory-lock escape hatch the "Check first" section already describes.
  `integrationSync`'s `recordOutcome` (`src/lib/services/integrationSync/`) takes the row lock as its
  first statement specifically to serialize concurrent *finishers* of a sync run (the lease already
  prevents concurrent *starts*) — two attempts racing to write the transition at the same instant
  must not both observe "was healthy" and both fire a `started_failing` alert. This is a different
  problem from the `LAST_ADMIN` race ADR-0002 already accepts as unserialized-by-default: there, a
  lost race is a rare manual-recovery inconvenience; here, an unserialized race would double-send an
  admin alert email on every transition, which is exactly the noise this feature exists to avoid.
  `FOR UPDATE` inside the same transaction as the lease check and the write is the minimal fix, still
  with no SQLSTATE translation and no SERIALIZABLE retries.
- **Role-shaped reads take an explicit flag, never the caller's role.** `getHealth(source, { now,
  includeAdminDetail })` takes `includeAdminDetail: boolean` rather than a `role: 'user' | 'admin'`
  parameter. The service has no business knowing about auth roles — ADR-0002 already keeps
  `~/lib/auth` out of services entirely — so the procedure (`syncStatus` in
  `src/lib/orpc/procedures/evCharging.ts`) computes `includeAdminDetail = context.user.role ===
  'admin'` and passes the boolean down. This is the same shape as an existing convention (a service
  taking a plain data flag, never a transport concept) made explicit because it's the first service
  whose read shape actually varies by caller.

---

## Critical files

- `src/lib/integrationHealth.ts` — the shared vocabulary (sources, error codes, triggers, outcomes,
  health states, transitions); dependency-free and client-safe.
- `src/lib/effects/zaptec/` — the fail-closed client: `notConfigured` / http / `fake` adapter
  selection, injected `fetch`, zod parsing, retry/timeout policy, `stats` reporting.
- `src/lib/services/integrationSync/` — `beginAttempt` (lease acquire), `recordOutcome` (transition +
  snapshot + history, `FOR UPDATE`), `getHealth`, `listRecentRuns`.
- `src/lib/db/schema/integrationSync.ts` — `integration_sync` (snapshot + lease) and
  `integration_sync_run` (append-only history) tables and their CHECK constraints.
- `src/lib/evCharging/sync.ts` — `runZaptecSync`, the domain orchestrator that ties the client, the
  service, and the alert email together; the one `integration sync run` log line.
- `src/lib/integrationHealthMessage.ts` — client-side, code-only → Swedish/English message mapping,
  reused by the alert email template.
