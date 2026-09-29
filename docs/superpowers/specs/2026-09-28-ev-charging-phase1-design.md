# EV charging Phase 1 — design

Status: agreed 2026-09-28. Scope + research: [scope map](./2026-09-28-ev-charging-scope-map.md).
Produced by an architecture review (candidates 01–07) of two architect blueprints; each
candidate was evaluated against the real code. Terms: see `CONTEXT.md`.

## Delivery: three PRs, in order

| PR | Scope | Touches |
|---|---|---|
| **A** `fix(logger): serialize errors and grade rpc error logs` | Candidate 04 | existing code only |
| **B** `refactor(queue): dispatch messages through one module` | Candidate 06 | existing code only |
| **C** `feat(charging): sync Zaptec sessions and show totals` | Candidates 01, 02, 03, 05, 07 + ADR-0019 | new feature |

A and B are prerequisites: C's run log line and alert queue topic depend on both.

---

## PR A — logger error serialization (existing code)

Verified bug: `log.error('…', { error })` serializes to `"error": {}` (pino only
serializes `err`); the browser forward has the same bug (`JSON.stringify(Error)` → `{}`).

- **`src/lib/logger/serializeError.ts`** (new, pure, shared by both adapters): Error →
  `{ type, name?, message, stack, code?, status?, defined?, data?, cause?, errors? }` —
  **allow-list only** (never copies arbitrary enumerable props, so an attached
  `request`/`response` can't leak headers/bodies). `cause` recursive, depth ≤ 5, cycle-safe;
  `AggregateError.errors`; DOMException → `{type,name,message}`; non-Errors pass through.
- **`server.ts`**: `serializers: { error: serializeError, err: serializeError }` in pino
  options (children inherit; redaction runs after serialization — verified).
- **`browser.ts`**: `forward()` serializes top-level Error values with the shared function.
- **`types.ts`**: JSDoc contract — errors go at top-level `error`; nested errors aren't serialized.
- **`redact.ts`**: + `password`, `*.password`, `access_token`, `*.access_token`,
  `refresh_token`, `*.refresh_token`.
- **`src/routes/api/rpc/$.ts`** + new `src/lib/orpc/logRpcError.ts`: `onError` uses the
  request-scoped `context.log` (gains `requestId`, `path`). Grading: ORPCError with
  status 401 → `debug`; other ORPCError < 500 → `info('rpc rejected', {code,status,defined})`;
  anything else → `error('orpc handler error', { error })`.
- Tests via `createServerLogger(destination)`: error/err keys, cause chain + depth/cycle,
  ORPCError fields, AggregateError, DOMException, non-Errors, dropped extra props, child
  inheritance, redaction paths, browser forward body, `logRpcError` grading.
- **ADR-0003 amendment**: serialization contract, graded request-scoped `onError`, redaction
  paths, corrected retention (Vercel Pro Runtime Logs: 1 day; Hobby: 1 hour).

## PR B — queue dispatch (existing code)

Facts: `@vercel/queue` has no max-deliveries/DLQ — a thrown message retries until expiry
(default 24 h); Nitro's hook acks only on normal return; prod consumer logs nothing and
silently acks unknown topics; dev BullMQ gives up after 3 attempts (prod/dev disagree).

- **`src/lib/queue/dispatch.ts`**: `createQueueDispatcher(table, { log, maxDeliveries, now? })`;
  `QueueHandlerTable = { [T in QueueTopic]: Handler<T> }` (missing topic = compile error);
  `Handler<T> = { handle(msg, meta, log), logFields?(msg) }`; `PermanentQueueError(message, code)`.
- Semantics: return → `ok`; `PermanentQueueError` → `dropped` (error, ack); other throw →
  `retry` (warn, rethrow) until `deliveryCount >= QUEUE_MAX_DELIVERIES` (**5**) → `dropped`
  `reason: 'exhausted'` (error, ack); unknown topic → `dropped` `reason: 'unknown_topic'` (error, ack).
- One **`queue message`** line per message: topic, messageId, deliveryCount, outcome, reason,
  durationMs, handler `logFields`, error. Never the payload (contains emails).
- `queueConsumer.ts` → one call; `devQueueWorker.ts` → one worker per table key via the same
  dispatcher; `bullmqQueue.ts` `attempts = QUEUE_MAX_DELIVERIES`. Handlers receive the child
  logger; one shared `QueueMessageMeta`. Existing topic behavior preserved.
- Tests: dispatcher against a fake table + captured logger (ok / retry / permanent /
  exhausted / unknown topic / durationMs).
- **ADR-0007 amendment**: handler contract, 3-step "add a topic" recipe, Vercel Queues
  has no DLQ/max-deliveries, drop stale "producer is Better Auth" line.

---

## PR C — Phase 1 charging

### Zaptec client module (`src/lib/effects/zaptec/`) — candidate 01

```ts
class ZaptecError extends Error { code: IntegrationErrorCode; op: 'token'|'chargers'|'sessions'|'state'; status?: number }
interface ZaptecCallStats { authMs; fetchMs; requests; retries; pages }       // mutable sink
interface CallOpts { signal?: AbortSignal; stats?: ZaptecCallStats }
interface ZaptecClient {
  chargers(o?): Promise<ZaptecCharger[]>                                       // {id,name,installationId,isOnline}
  sessionsEndedSince(since: Date, o: CallOpts & { installationId }): AsyncIterable<ZaptecSession[]> // one yield per page
  liveState(chargerId, o?): Promise<ZaptecLiveState>                           // {mode,powerKw,sessionKwh,observedAt}
}
createZaptecClient({ fetch, creds, now?, sleep? }): ZaptecClient
export const zaptec: ZaptecClient                                              // lazy-selected
```
- Behind the seam: shared in-flight login, token cached until `expires_in − 5 min`, one
  re-login on a data-call 401; zod parsing (failure → `unexpected_response`, message lists
  field paths only); energyDetails → `[start,end)` intervals (drop 0-kWh start marker, check
  sum); state ids 710/513/553 → domain type, 15 s TTL cache; status mapping (token 400/401 →
  `auth_failed` — `unsupported_grant_type` adds "grant retired" to the admin message; 403 →
  `forbidden`; 429 → `rate_limited`; 5xx/network/timeout → `unreachable`); timeouts
  `AbortSignal.timeout` 10 s (5 s live); ≤ 2 retries on 429/502/503/504/network honoring
  `Retry-After` ≤ 10 s (else fail `rate_limited`), backoff 0.5/1.5 s + jitter; no retry on
  token 4xx or liveState. Password grant isolated in one private `obtainToken()`.
- **Does not log.** Reports via `stats`; never exposes password, token, form body, or raw
  payloads (they carry `sessionSignature`, owner email/name). `cause` keeps network error name/code only.
- Selection: VITEST → `notConfigured`; creds present → http; creds missing → `notConfigured`
  (throws `not_configured`); `ZAPTEC_ADAPTER=fake` → synthetic data for local UI work.
  **No devLog adapter** — a silent no-op would read as a healthy sync. Preview deploys get
  no creds (preview DB is a prod branch).
- Tests: `createZaptecClient` + hand-written `fakeFetch(routes)` returning real `Response`s
  from synthetic fixtures (never the probe JSON). Token sharing/refresh/401 re-login, each
  status mapping, Retry-After paths, timeouts, cursor paging + query params, interval
  normalization, payload drift, live-state mapping + TTL, stats, no secrets in messages.

### Integration health (`src/lib/services/integrationSync/`) — candidates 02 + 05

Vocabulary (client-safe, no imports) `src/lib/integrationHealth.ts`:
`INTEGRATION_SOURCES = ['zaptec','elpris','skoda']`,
`INTEGRATION_ERROR_CODES = ['auth_failed','forbidden','rate_limited','unreachable','unexpected_response','not_configured','internal_error']`.

```ts
beginAttempt(source, { trigger, now }) → { acquired: true; attemptId } | { acquired: false; runningSince }
recordOutcome(source, outcome, { attemptId, run, now }) → { transition: 'none'|'started_failing'|'recovered'; health }
getHealth(source, { now, includeAdminDetail }) → IntegrationHealth
listRecentRuns(source, { limit }) → RunRow[]                       // admin procedure only
```
`IntegrationHealth` state: `never_synced | not_configured | ok | stale | failing`, plus
`running`, `lastAttemptAt`, `lastSuccessAt`, `failingSince`, `consecutiveFailures`, `code`,
`adminDetail: { lastErrorMessage } | null`.

- **`integration_sync`** (snapshot + lease; source PK, CHECK in sources): `last_attempt_at`,
  `last_success_at`, `last_success_started_at`, `failing_since`, `running_since`, `lease_until`,
  `consecutive_failures`, `error_code`, `last_error_message` (≤ 500), `updated_at`; cross-column
  CHECKs (failures=0 ⇔ no code ⇔ no failing_since; running_since ⇔ lease_until). Row created lazily.
- **`integration_sync_run`** (history, inserted in the same `recordOutcome` tx): id, source,
  trigger (`cron|admin`), started_at, finished_at, duration_ms, outcome (`ok|failed|error`),
  error_code, error_message (≤ 500), since, pages, sessions_seen, upserted, voided,
  timings jsonb; index `(source, started_at desc)`; pruned > 90 days inside `recordOutcome`
  (failure → warn, never fails the run).
- **Lease** (not advisory locks — prod runs behind the Supabase transaction pooler):
  `UPDATE … SET running_since=now, lease_until=now+5min WHERE source=$1 AND (lease_until IS NULL OR lease_until < now) RETURNING`.
  Lease > function maxDuration.
- **Transition** in one tx: `SELECT … FOR UPDATE` → lease lost (`running_since ≠ attemptId`) →
  `none`, write nothing → pure `nextRow(prev, outcome, now)` (`transition.ts`, table-tested) →
  UPDATE + clear lease + insert run row. Row lock serializes concurrent finishers → one alert max.
- `not_configured`: own state, **no alert email**. A code change mid-streak does **not** re-alert.
- Stale policy (domain rule, `policy.ts`): Zaptec **3 h**.
- Message sanitizing before write: strip control chars, redact `Bearer \S+` / `password=\S+`, truncate 500.
- Localization: client-side `src/lib/integrationHealthMessage.ts` (exhaustive switch → `m.*`),
  `import type` only; reused by the email template.

### Sync run (`src/lib/evCharging/sync.ts`) — candidate 03

```ts
runZaptecSync({ trigger: 'cron'|'admin', now?, deps?: { zaptec?, log? } }): Promise<SyncRun>
SyncRun = { source, trigger, outcome: 'ok'|'failed'|'skipped'|'error', code, transition,
            startedAt, since, durationMs, authMs, fetchMs, importMs, pages, chargers,
            sessionsSeen, upserted, voided }
```
1. `beginAttempt` → not acquired ⇒ `skipped` (no Zaptec calls; also absorbs Vercel duplicate deliveries).
2. `chargers()` → upsert chargers.
3. `since = lastSuccessStartedAt − 7 d` (first run: 2020-01-01; `to = now`, Zaptec filters on end time, To exclusive) — catches late/offline sessions; upserts are idempotent.
4. Per page (cap 20; repeated cursor ⇒ `unexpected_response`): one tx — upsert sessions, delete+reinsert their intervals. The watermark only advances on full success.
5. `recordOutcome` → on `started_failing`/`recovered`: publish `email_integration_sync_alert` **one message per admin** (tier-2 `.catch` + warn).
6. `finally`: exactly one **`integration sync run`** log line — source, trigger, outcome, code,
   transition, since, durationMs, authMs, fetchMs, importMs, pages, chargers, sessionsSeen,
   upserted, voided (+ requestId/userId from the child logger). info ok/skipped, warn failed, error error.
- `ZaptecError` ⇒ `failed` (returns). Anything else ⇒ best-effort `recordOutcome(internal_error)`, log error, **rethrow**.
- **Cron**: `src/lib/evCharging/zaptecSyncCron.ts` + thin `src/routes/api/cron/zaptec-sync.ts` (GET).
  `Authorization: Bearer $CRON_SECRET`, constant-time, fail closed → 401. ok/failed/skipped → 200
  `{outcome, code, upserted}`; unexpected → 500. Logger via `createRequestLogger(request)`.
  `vite.config.ts`: `vercel.config.crons: [{ path: '/api/cron/zaptec-sync', schedule: '0 * * * *' }]`.
- **`syncNow`** (adminProcedure): returns `Pick<SyncRun,'outcome'|'code'|'upserted'>`, never throws
  for failed/skipped; records `context.timings.zaptec{Sync,Fetch,Import}Ms`.
- Tests: in-memory fake `ZaptecClient` + real test DB + spied `queue.publish` + captured
  logger: 2-page backfill, idempotent rerun, late session caught, void flips in place, one
  email per streak start/recovery, page-2 failure keeps page 1 and watermark, lease skip/stale
  takeover, unknown error rethrown, repeated cursor, exactly one log line per run, cron 401/200/500.

### Charging overview (`src/lib/services/evCharging/`) — candidate 07

```ts
getOverview({ year?, now? }): Promise<{ year; years: number[];
  tiles: { thisMonth: Totals; thisYear: Totals; allTime: Totals }; months: (Totals & { month })[] /* 12 */ }>
listSessions({ limit }): Promise<{ sessions: SessionRow[]; hasMore: boolean }>   // limit+1, zod max 500
Totals = { kwh: number; sessions: number }   // Phase 2 adds cost; Phase 5 adds byVehicle
```
- One private **counted session** SQL fragment: `NOT voided AND replaced_by IS NULL AND energy_kwh >= $threshold`;
  `NOISE_THRESHOLD_KWH = 0.5` in client-safe `src/lib/evCharging/counting.ts`.
- **kWh per interval** bucketed by `start_at AT TIME ZONE 'Europe/Stockholm'` (exact: intervals are
  hour-aligned); **session count by start_at**; sessions without intervals fall back to start month.
  Calendar months; 12 zero-filled; `years` always includes the current Stockholm year.
- `peakKw = max(kwh / hours)` over intervals ≥ 10 min; null without intervals.
- Noise, voided and replaced sessions hidden from both stats and list.
- Tests: empty DB, threshold edge, voided/replaced, overnight month split, DST edges, year
  boundary, `now` month, no-interval fallback, empty year, sum invariants, list order/hasMore/peakKw.

### Procedures (`src/lib/orpc/procedures/evCharging.ts`)
`overview({year?})`, `sessions({limit})`, `syncStatus` (`getHealth` with
`includeAdminDetail = role === 'admin'`), `liveStatus` (catches `ZaptecError` → `null`, never
touches health), all `protectedProcedure`; `recentRuns` + `syncNow` → `adminProcedure`.

### UI `/charging`
Heading + "Senast synkad" · health alert (by `state`; admin: raw message + "Försök igen") ·
LiveStatusTile (60 s poll) · TotalsTiles · YearSelector + MonthlyChart (first Recharts bar
chart) · SessionList ("Visa fler") · admin-only collapsible "Senaste körningar" (last 20 runs) ·
SyncNowButton. No polling on overview/list (hourly data; focus refetch). `syncNow` invalidates
`orpc.evCharging.key()`. Sidebar + command palette entries. sv + en.

### Alert email
Queue topic `email_integration_sync_alert` (one message per admin, via PR B's table);
`EmailEffects.sendIntegrationSyncAlert`; `src/emails/IntegrationSyncAlertEmail.tsx`.

### ADRs
- **New ADR-0019 "External data integrations"**: fail closed (`not_configured`, no devLog),
  injected `fetch` as the seam, error-code union, retry/timeout policy, health snapshot +
  run history, lease over advisory locks, one run log line.
- ADR-0001 amendment: domain orchestrators in `src/lib/<domain>/` as sanctioned effect callers;
  `/api/cron/*` (and the already-missing `/api/webhooks/shelly`) as non-oRPC entrypoints; Pro plan.
- ADR-0002 amendment: row locking (`FOR UPDATE`) in services; role-shaped reads via a flag, not a role.

### Accepted gaps / deferred
- A cron that never fires only shows as `stale` on the page (no email).
- Zaptec changes to sessions older than 7 days are missed (add a deep resync if ever observed).
- Alert publish failure after commit is logged, not retried (no outbox).
