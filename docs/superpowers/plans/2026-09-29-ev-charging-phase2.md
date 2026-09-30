# EV charging Phase 2 — implementation plan

**Spec (binding authority):** `docs/superpowers/specs/2026-09-29-ev-charging-phase2-design.md`.
Research: `docs/superpowers/specs/2026-09-28-ev-charging-scope-map.md` ("Phase 2"). ADR-0019 for the integration pattern.

Four PRs, in order, each its own branch off the previous one's merge (squash-merge; rebase with `--onto` if stacked):

| PR | Branch | Title |
|---|---|---|
| A | `refactor/pulled-sync-lifecycle` | `refactor(sync): extract the pulled-integration run lifecycle` |
| B | `feat/charging-cost-storage` | `feat(charging): add spot price and tariff storage with cost math` |
| C | `feat/charging-elpris-sync` | `feat(charging): sync SE3 spot prices from elprisetjustnu` |
| D | `feat/charging-cost-ui` | `feat(charging): show charging cost and manage tariffs` |

## Global constraints

- `CLAUDE.md` non-negotiables apply (services own DB access, effects in `src/lib/effects/`, logger only,
  timestamptz, Biome, Paraglide sv + en, responsive UI, `protectedProcedure` reads / `adminProcedure` mutations).
- Client-safe modules (`src/lib/time/`, `src/lib/evCharging/cost/`, `src/lib/spotPrice/{zones,slots}.ts`) import no
  runtime values from services/db; client code uses `import type` only from services.
- Migrations: `bun run db:generate --name=<desc>`; schema-design review (`supabase-postgres-best-practices`)
  + `migration-guard` before anything builds on a new schema.
- Never log credentials or raw payloads. Test fixtures are synthetic. Real tariff values never committed.
- No held connections (ADR-0018).
- **Execution loop (per task):** implement (TDD where testable) → `bun run check` + relevant tests →
  commit → two adversarial reviewers in parallel (task-appropriate agents) → fix confirmed findings → next task.
- Commits: Conventional Commits, ending with the Claude co-author trailer.

---

## PR A — pulled-run lifecycle (behavior-preserving)

### Task A1 — `IntegrationError`, `runPulledSync`, cron helper

Files:
- new `src/lib/effects/integrationError.ts` — `abstract class IntegrationError extends Error { abstract readonly code: IntegrationErrorCode }`.
- `src/lib/effects/zaptec/errors.ts` — `ZaptecError extends IntegrationError` (no other change).
- new `src/lib/integrations/runPulledSync.ts` — `RunBase`, `runPulledSync(spec)`, `withDeadline(p, signal, mkErr)`,
  private `alertAdmins(source, …)`. Moves the lifecycle out of `sync.ts` verbatim: deadline timer, lease,
  `failed`/`error` classification (`instanceof IntegrationError`), record-once rule, best-effort record on `error`,
  alert on transition, and the one `integration sync run` log line with its grading.
- `src/lib/evCharging/sync.ts` — `runZaptecSync` becomes `runPulledSync({ source: 'zaptec', init, execute, toRunStats, logFields, finalize })`;
  `fetchAndImport`/`importWindow` unchanged except they use the generic `withDeadline`. `SyncRun` shape and log field order unchanged.
- new `src/lib/integrations/cron.ts` — `verifyCronSecret` (moved) + `handleCronRun(request, run)`.
  `src/lib/evCharging/zaptecSyncCron.ts` keeps `handleZaptecSyncCron` and re-exports `verifyCronSecret`.
- Retry loop extraction from `zaptec/client.ts`: **deferred** (Škoda is the third consumer); elpris gets its own loop.

Gate: `src/lib/evCharging/sync.test.ts` and `zaptecSyncCron.test.ts` pass **without edits**; new focused
tests for `runPulledSync` (generic spec: ok / IntegrationError → failed / other → error rethrown / skipped / deadline / one log line)
and `handleCronRun`. Reviewers: `code-reviewer` + a behavior-equivalence adversary (diff old vs new lifecycle line by line).

---

## PR B — storage + pure cost math

### Task B1 — schema + migration
`src/lib/db/schema/{spotPrice,electricityTariff}.ts`, re-export; `src/lib/spotPrice/zones.ts`;
`bun run db:generate --name=spot_price_and_electricity_tariff` → `0005`. Reviewers: schema-design reviewer + `migration-guard`.

### Task B2 — Stockholm time helpers + pure cost module
`src/lib/time/stockholm.ts`, `src/lib/spotPrice/slots.ts` (`validateDaySlots`), `src/lib/evCharging/cost/*`
(`SlotIndex`, `priceIntervals`, `tariffAt`, `CostTotals` helpers, `gridShare`). Pure tests incl. DST days (15-min: 92/100
slots; hourly: 23/25 — 2024-03-31, 2024-10-27) and the 2025-10-01 hourly→15-min switch. Extend `clientSafe.browser.test.tsx`. Reviewers: `code-reviewer` + DST/maths adversary.

### Task B3 — services
`services/spotPrice/` (`replaceDay`, `listSlotsOverlapping`, `daysWithSlots`), `services/tariff/` (CRUD + `TariffDomainError`),
`services/evCharging/counted.ts` (moved filter) + `listSessionEnergy` + `earliestCountedStartAt`.
Reviewers: `code-reviewer` + `test-completeness`.
From the B1 schema review: `replaceDay` **replaces the whole Stockholm day** (delete the day's range, then insert, one tx) so
a re-split day can't leave overlapping slots; map 23505 by constraint name `electricity_tariff_valid_from_unique`;
slot reads for many intervals join against `unnest($starts, $ends)` rather than N OR'ed ranges.

---

## PR C — elpris integration

### Task C1 — elpris effect
`src/lib/effects/elpris/` (selector, http client with ADR-0019 retry/timeout, zod parse, errors, notConfigured, fakeFetch tests).
Parser validates units/range (SEK ≈ EUR × EXR; within market limits) → `unexpected_response`, never a DB CHECK error.
Follow-up (not in Phase 2): the Zaptec client reads bodies outside its retry loop too, so a connection dropped
mid-body is `unexpected_response` rather than a retried `unreachable` — port the elpris fix when Škoda lands.
Reviewers: `code-reviewer` + error-mapping/no-payload-leak adversary.

### Task C2 — `runElprisSync` + cron + procedures
`src/lib/spotPrice/sync.ts` (missing-days planner, 404 policy), `elprisSyncCron.ts`, route `api/cron/elpris-sync.ts`,
`vite.config.ts` cron, `syncStatus`→`{zaptec, elpris}`, `recentRuns({source})`, `syncNow` both (allSettled),
`SyncHealthAlerts`, `RecentRunsCard` per source, toasts, i18n. Reviewers: `code-reviewer` + lease/deadline adversary.

---

## PR D — cost read model + UI

### Task D1 — composer + cost/tariff procedures
`src/lib/evCharging/costing.ts`, `costOverview`, `sessionCosts`, `tariff.*` + mappers. Parity test (cost kWh == overview kWh).
`overview.ts` switches to the shared `stockholmYearMonth` from `~/lib/time/stockholm` (drop its private copy) so both bucket months identically.
Reviewers: `code-reviewer` + `test-completeness`.

### Task D2 — form fields + tariff UI
`NumberField`, `DateField`, `TariffCard`, `TariffDialog` (URL state), i18n. Reviewers: `code-reviewer` + `web-design-guidelines`.

### Task D3 — cost display + docs
Cost tiles, chart metric toggle, session cost column, `PriceFootnote`, loader prefetch degrade; ADR-0020, ADR-0019 amendment,
CLAUDE.md, CONTEXT.md. Browser verification of `/charging` (desktop/tablet/mobile). Reviewers: `code-reviewer` + `web-design-guidelines`.

---

## After Phase 2

### PR E — `feat(charging): tell admins when the grid-fee API covers our facility`
Monthly cron: fetch `https://eltariff.se/tariffcatalogue/all`, match the facility ID from an env var
(`GRID_FACILITY_ID`, not committed) against each entry's `meteringPointIdFrom/To` locally, and email admins once it's
covered (then Phase 2b — see the scope map). Fails closed; no personal data leaves the app.

Built as a lightweight watcher (owner's call): no `integration_sync` row, stateless monthly email while covered. See
ADR-0019's watcher amendment.
