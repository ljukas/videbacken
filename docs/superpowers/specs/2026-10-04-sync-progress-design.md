# Datakällor — sync progress bar — design

Status: agreed 2026-10-04. Builds on: [ADR-0019](../../adr/0019-external-data-integrations.md) (pulled-sync
lifecycle, lease, health snapshot), [ADR-0018](../../adr/0018-polled-sync-replaces-realtime-sse.md) (polled, never pushed), the Datakällor
panel (#71).

## Intent

A Datakällor tile says "Synkar…" while a run is in flight, but nothing about how far it has got — and an Emaldo
backfill run can take ≈2 minutes, an elpris backfill tens of seconds. Show a **real** progress bar ("12 av 30
dagar") on the tile while a run is in flight, for every run (cron, a click in this tab, another tab, another admin).

**Success:** during an Emaldo or elpris backfill, the tile shows a bar that advances every ≈5 s and disappears when the
run ends; a crashed run never leaves a bar behind; no connection is held open to deliver it.

## Scope

- **In:** progress reporting for **Emaldo** and **elpris** (day-based, total known up front); the tile's bar; polling
  the tile at 5 s from the moment an admin clicks sync.
- **Out (explicitly):**
  - **Zaptec** (windows; usually ≈1 s, and its window count changes mid-run when a window halves) and **Škoda** (one
    call, < 1 s): they finish before a 5 s poll sees them. They keep the spinner only. The seam allows adding them
    later.
  - An indeterminate bar before the first report: the spinning "Synkar…" icon already says a run is in flight.
  - Moving syncs onto Vercel Workflow / making "Synka nu" enqueue instead of holding its request: a possible
    follow-up with its own ADR (considered and parked 2026-10-04, see Alternatives).

## Measurements (local run history, 2026-10-04)

| Source | p50 run | Unit of work | Total known up front? |
|---|---|---|---|
| Škoda | ≈0.7 s | one call | — |
| Zaptec | ≈1.3 s | time window × installation | no (windows halve on a page cap) |
| elpris | ≈21 s | a planned missing day (≤ 120 per run) | yes: `planned.length` |
| Emaldo | ≈33 s (≈2 min in a prod backfill) | yesterday, today, then ≤ 30 backfill days | yes: `2 + plan.backfill.length` |

## Design

### Where progress lives

Two nullable columns on `integration_sync` (the per-source health + lease row the tile already polls):

- `progress_done integer`, `progress_total integer`.
- CHECKs: both null or both set; `progress_total > 0`; `0 <= progress_done <= progress_total`.
- **No** CHECK tying progress to `lease_token`: code from before this change (an instant rollback) clears the lease in
  `recordOutcome` without clearing progress, and such a CHECK would make its outcome write fail. Reads gate on
  `running` instead (below), so a leftover value is never shown.

Transient state, overwritten in place; no history. `integration_sync_run` is unchanged.

### Service (`src/lib/services/integrationSync/`)

- `beginAttempt` — when it acquires the lease, also sets both progress columns to null (a takeover of an expired
  lease must not inherit the dead run's bar).
- `recordOutcome` — the update that clears the lease also clears progress.
- **New** `reportProgress(source, attemptId, { done, total }, { now })`: one `UPDATE … SET progress_done,
  progress_total WHERE source = $1 AND lease_token = $attemptId AND lease_until > now`. A lost lease (expired, taken over, or already
  recorded) matches no row and writes nothing — a late write can never re-set a finished run's progress or touch a
  newer run's. Returns nothing.
- `IntegrationHealth` gains `progress: { done: number; total: number } | null` — set only when `running` is true and
  both columns are set; otherwise null. Exposed to every caller of `syncStatus` (it carries nothing sensitive).

No domain error: the values come from our own sync code, never from input. `runPulledSync` normalizes them (below);
the CHECKs are the backstop.

### Lifecycle (`src/lib/integrations/runPulledSync.ts`)

`execute`'s context gains `reportProgress(done: number, total: number): Promise<void>`, built by `runPulledSync`:

- **Normalizes:** `total <= 0` → no write; `done` clamped to `[0, total]`; integers.
- **Throttles:** writes when ≥ 1 s has passed since the last write (by `spec.now`), or when `done === total`. elpris
  can step through 120 days in ≈30 s; this caps it at ≈1 write/s. (The UI polls every 5 s anyway.)
- **Best effort:** a failed write is logged at `warn` (`integration sync progress write failed`, source + error) and
  never fails or aborts the run. Awaited, so writes stay ordered.
- The `integration sync run` log line gains `progressWrites` (count), so the cost is visible in Runtime Logs.

### Sources

- **Emaldo** (`src/lib/houseEnergy/sync.ts`, `syncDays`): `total = 2 + plan.backfill.length`. Report after
  yesterday, after today, and after each backfill day. A run that stops on the 120 s day budget simply ends short of
  the total; the bar disappears with the run.
- **elpris** (`src/lib/spotPrice/sync.ts`, `fetchMissingDays`): `total = planned.length`. Report after **every**
  planned day the loop handles, including the `continue` paths (rejected, not published, gap) — progress counts days
  handled, not days stored. Zero planned days → no report.

### UI

- **`SyncSourceTile`:** while `pending` and `health.progress` is set, render shadcn `Progress` (already installed,
  Radix) as a top-edge strip (absolutely positioned; the Card clips it), with a visible caption
  `m.charging_source_progress({ done, total })` ("12 av 30 dagar" / "12 of 30 days"; singular "1 av 1 dag"),
  `tabular-nums`, that replaces the cadence line while a run reports — so the tile never changes height.
  - Accessibility: the bar's `aria-label` names the source (`m.charging_source_progress_label({ source })`, "Synkförlopp,
    Emaldo"); `aria-valuetext` = the caption, so a screen reader says days, not a percentage. The caption itself is
    not a live region (a 5 s update would be noisy); the existing pending state already announces the run.
  - Motion: the indicator's width transition gets `motion-reduce:transition-none`.
  - Responsive: full tile width; the tile is its own container (works at the 1/2/4-column breakpoints).
- **Polling (`src/routes/_authenticated/charging/index.tsx`):** today `healthPoll` polls at 5 s only once the server
  says `running` — after a click the next poll can be up to 60 s away. Each admin health query's `refetchInterval`
  becomes 5 s while `running` **or** while this tab's sync mutation for that source is pending, so the bar appears
  within ≈5 s of a click.
- **i18n:** `charging_source_progress`, `charging_source_progress_label` in `messages/sv.json` (source of truth) and
  `en.json`.

### Testing

- **Service (node, per-test schema):** `reportProgress` writes under the held lease; writes nothing with a stale /
  other attemptId and after `recordOutcome`; `beginAttempt` clears progress on acquire (incl. takeover of an expired
  lease); `recordOutcome` clears it; `getHealth` returns progress only while running; the CHECKs reject
  `total = 0`, `done > total`, `done < 0`, one-of-two set.
- **`runPulledSync`:** normalization (total 0 → no write, clamping), throttle (fake `now`), last item always
  written, a throwing write doesn't fail the run and is logged.
- **Sources:** Emaldo and elpris tests assert the reported `(done, total)` sequence, including elpris's `continue`
  paths.
- **UI (browser):** tile shows the bar + caption only when pending and progress is set; `aria-valuetext`; no bar when
  progress is null. Layout verified live at desktop / tablet / mobile widths (browser tests have no app CSS).

### Docs

- ADR-0019: an **amendment** ("sync progress on the health row"): the columns, the lease-token guard, best-effort
  writes, why the database (below).
- CLAUDE.md: nothing changes in the rules; no update needed beyond the ADR.

## Alternatives considered

- **Stream progress on the "Synka nu" request (oRPC event iterator).** Reuses an already-open request, but only the
  clicking tab sees it — cron runs (the long backfills) and other viewers get nothing — and it reintroduces a streamed
  response, against ADR-0018.
- **In-process memory.** A run and the poll that reads it land on different Fluid instances; each cron run is its own
  invocation. Doesn't work on Vercel.
- **A shared ephemeral store (Vercel Runtime Cache, Redis).** New effect + adapters for two numbers; no Redis in prod;
  Runtime Cache is best effort; and "running?" (DB lease) and "how far?" (cache) would come from two stores that can
  disagree.
- **Supabase Realtime.** Pushed — reverses the "no realtime" stack decision.
- **Vercel Workflow (steps = days; progress via `world.steps.list`, `streams.getChunks`, or the experimental run
  attributes).** Better for *running* long backfills (no deadline juggling, per-day retries, a click needn't hold a
  request), but the tile would still need the current run ID from our DB row, plus an extra Workflow API call per
  poll; and it means re-platforming ADR-0019's lifecycle (lease, single outcome write, alerts) onto a new compiler
  plugin over a locked TanStack Start RC + Nitro beta, with a 7-day run-data retention on Pro. Parked as a possible
  separate follow-up; these columns would survive it (steps would be what calls `reportProgress`).
- **A separate progress table / a single percentage column.** A table adds a join for no gain; a percentage loses
  the "12 av 30 dagar" caption.
