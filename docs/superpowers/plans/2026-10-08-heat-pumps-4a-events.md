# Heat pumps step 4a — Händelser (events) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins log heat pump events (date, unit or both, type, note) on Energi › Värmepumpar; everyone signed in
sees the list, newest first, and the events show as markers on the page's day chart.

**Architecture:** A new `heat_pump_event` table beside step 1a's heat pump tables, a client-safe vocabulary module
(`src/lib/heatPump/events.ts`: kinds, the DTO, note rules, the day-marker helper), four service functions in
`src/lib/services/heatPump/heatPumpEvents.ts` with typed `HeatPumpDomainError` codes, and a `heatPump.events`
sub-router (`list` protected, `create` / `update` / `delete` admin) in its own procedures file. The UI is a
`HeatPumpEvents` card on step 3's page, admin dialogs loaded lazily (`React.lazy` + `LazyDialogMount` +
`useIdlePreload(isAdmin, …)`) and driven by URL state (`useUrlDialog`, ADR-0013), a form on `useAppForm` (ADR-0005),
and a small, generic `markers` prop on the shared visx `BarChart` that step 3's `HeatPumpConsumptionChart` passes
(threaded from the route through `HeatPumpConsumption`).

**Tech Stack:** Drizzle ORM (node-postgres), oRPC + TanStack Query, TanStack Start / Router file routes,
`@tanstack/react-form` v1 (`createFormHook`), shadcn/Radix (`ResponsiveDialog`, `AlertDialog`, `DropdownMenu`,
`Select`, `Textarea`), visx, Paraglide, Vitest (node + browser), Biome, boneyard-js skeletons, bun.

**Spec:** [`docs/superpowers/specs/2026-10-08-heat-pumps-design.md`](../specs/2026-10-08-heat-pumps-design.md) —
"Schema" (`heat_pump_event`), "Service" (events), "Heat pump procedures" (`events.*`), "Energi › Värmepumpar" →
"Händelser". ADR: [`docs/adr/0027-heat-pump-energy-data.md`](../../adr/0027-heat-pump-energy-data.md) (decision 10).
Roadmap: [`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`](../roadmaps/2026-10-08-heat-pumps.md) (row 4a,
checkpoint 5). Builds on ADR-0005 (forms), ADR-0013 (dialogs + URL state), ADR-0016 (empty states), ADR-0025 §6
(lazy admin dialogs).

## Global Constraints

- `heat_pump_event`: `id` uuid PK; `occurred_on` date not null (Stockholm calendar day); `heat_pump_id` uuid null,
  FK → `heat_pump` **on delete restrict** (null = all units); `kind` text not null, CHECK in (`service`, `filter`,
  `setting`, `other`); `note` text null, ≤ 500 characters; `created_by` FK → `user` **on delete set null**;
  `created_at`, `updated_at` timestamptz not null; index on `occurred_on`; `.enableRLS()`. Migration
  `bun run db:generate --name=heat_pump_event`.
- Every database change gets `migration-guard` **and** the schema-design review (a subagent loading
  `supabase-postgres-best-practices`) before code builds on it (Non-negotiable).
- Contract names exactly as the shared brief: `HEAT_PUMP_EVENT_KINDS = ['service', 'filter', 'setting', 'other'] as const`,
  `HeatPumpEventKind`, `HeatPumpEventDto = { id; occurredOn /* YYYY-MM-DD */; heatPumpId: string | null; kind; note: string | null }`
  in `src/lib/heatPump/events.ts`; service `listEvents()`, `createEvent(input, userId)`, `updateEvent(id, input)`,
  `deleteEvent(id)`; `HeatPumpDomainError` gains `'FUTURE_DATE' | 'EVENT_NOT_FOUND' | 'NOTE_TOO_LONG'` (step 1a
  already has `'INVALID_READING' | 'UNKNOWN_HEAT_PUMP'`) — SCREAMING_SNAKE like every other service's codes, and the
  same literals as the `.errors()` keys; i18n message keys stay lowercase snake (`heat_pump_event_error_future`); procedures `heatPump.events.list` (protected) / `create` /
  `update` / `delete` (admin). Step 4b reads `HeatPumpEventDto[]` from `heatPump.events.list`.
- Admins mutate, users read (ADR-0017): writes are `adminProcedure` only; a non-admin sees the list and **no**
  add / edit / delete control, and never loads the dialog chunks.
- `src/lib/heatPump/events.ts` is dependency-free (drizzle-kit loads it through the schema; the browser imports it).
  Client code may only `import type` from services.
- Fields (spec): date (default today, not in the future — Stockholm "today"), unit (Båda / each unit), type
  (Service, Filterrengöring, Inställning, Annat), note (optional).
- Only daily sums reach the browser (ADR-0027 decision 6) — this step sends events only, no readings.
- Every user-facing string in `messages/sv.json` (source of truth) **and** `messages/en.json` (key-complete), Swedish
  copy exactly as written here; run `bun run i18n:compile` after editing messages.
- Logging via `context.log` / `~/lib/logger`, never `console.*`; never log a note (free text).
- Responsive at 1440, 820 and 390 px; touch targets 44 px on coarse pointers (`pointer-coarse:`); no fixed widths.
- Browser tests have no app CSS (pin structure, verify layout live); CI runs browser tests in UTC — the day-marker
  tests must pass with `TZ=UTC`.
- Never run two vitest processes at once (shared local DB); reviewers must not run vitest while the implementer does.
- Conventional Commits ≤ 72 chars, one hat per commit, `git add <paths>` (never `-A`), body ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. PR title
  `feat(heat-pumps): log events and mark them on the day chart`.

## Decisions this plan makes where the spec is silent or loose (list them in the PR)

1. **`created_by` is `uuid`** (resolved: the spec now says so too): `user.id` is a uuid (`betterAuth.ts:14`), as
   `integration_credential.updated_by` already does.
2. **A malformed date has no domain code.** The procedure's Zod schema rejects anything that isn't a real
   `YYYY-MM-DD` day (`isStockholmDay`) with `BAD_REQUEST`; the service re-checks and throws a plain `Error`
   (a programming error: the input skipped validation), like `amountOf` in `TariffDialog`.
3. **"500 characters" = Unicode code points** (Postgres `char_length`), so "å" and an emoji are one each. The note is
   trimmed and a blank note is stored as null. A DB CHECK (`char_length(note) BETWEEN 1 AND 500`) backs the
   service rule. The procedure's Zod caps the note at 2000 UTF-16 units only (abuse guard): Zod's `.max(500)` counts
   UTF-16 units and would reject a valid 500-character note containing emoji before the service's typed error.
4. **`createEvent` / `updateEvent` take an optional trailing `now = new Date()`** so the Stockholm-midnight rule is
   testable without fake timers on a DB test. The brief's call shapes still work unchanged.
5. **"Båda" only when there are exactly two units**, "Alla" otherwise — accepted and now in the spec ("Händelser").
6. **`events.list` sorts** by `occurred_on` desc, then `created_at` desc, then `id` desc.
7. **Error statuses:** `EVENT_NOT_FOUND` 404; `UNKNOWN_HEAT_PUMP`, `FUTURE_DATE`, `NOTE_TOO_LONG` 422.
8. **`UNKNOWN_HEAT_PUMP` is mapped from the FK violation** (SQLSTATE 23503 on the `heat_pump_id` FK), not a
   check-first read: one query, and no race. A new `isForeignKeyViolation` sits beside `isUniqueViolation`.
9. **Markers are a ▼ pin above the day's stack, in the unit's colour (`heatPumpColor`); an event for both units also
    draws a dashed line across the column**, in `var(--foreground)` — accepted and now in the spec ("Händelser").
10. **The card gets its units from step 3's period hook**: `h.shown?.units` (the `heatPump.months` payload's units,
    `byHeatPumpName` order = colour order, present in every period view); `events.list` returns events only, as the
    brief fixes.
11. **The note field is a new `TextareaField`** imported directly (not registered in `fieldComponents`), so it
    doesn't grow every form's chunk, `/login`'s included (the phone-field rule, ADR-0025 §6).
12. **A server `EVENT_NOT_FOUND` on save closes the dialog** (the event is gone); every other save error toasts and
    keeps it open.

## Review Focus

1. **Logging an event just after Stockholm midnight** (00:30 on 9 Oct = 22:30 UTC on 8 Oct): "today" is 9 Oct, so
   9 Oct is accepted, 10 Oct is `FUTURE_DATE`, and the dialog defaults to 9 Oct → Task 2 test "Stockholm today, not
   UTC today", Task 5 test "defaults to the Stockholm day, not the UTC day".
2. **A note of exactly 500 characters with å and an emoji** is accepted end to end (its UTF-16 length is 501); 501
   characters is `NOTE_TOO_LONG`; a whitespace-only note is stored as no note → Task 2 test "a note is counted in
   characters, trimmed, and blank is none", Task 3 test "a 500-character note with an emoji passes the input
   boundary", Task 5 test "a note over 500 characters is refused in the form".
3. **A stale edit/delete link or an event another admin just deleted**: `?dialog=eventEdit&eventId=<gone>` is cleaned
   from the URL (replace); saving an edit of a deleted event toasts "Händelsen finns inte längre" and closes → Task 7
   test "a deep link to a deleted event is cleaned", Task 5 test "EVENT_NOT_FOUND toasts and closes".
4. **A member opening an admin deep link** (`?dialog=eventNew`): nothing opens, the URL is cleaned, no admin control
   renders → Task 7 test "a member sees the list but no controls, and an admin link is cleaned".
5. **Markers on the DST day and in UTC CI**: an event on 2026-10-25 (25 h day) marks exactly that day's bar under
   `TZ=UTC` and locally; an event for a unit the chart doesn't show draws nothing → Task 6 test "markers are keyed by
   calendar day strings" (`dayEventMarkers`), run with `TZ=UTC` in Task 6 and Task 7.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/heatPump/events.ts` (+ `events.test.ts`) | create | client-safe vocabulary: kinds, DTO, note rules, `dayEventMarkers` |
| `src/lib/db/schema/heatPump.ts` | modify | `heatPumpEvent` table |
| `drizzle/NNNN_heat_pump_event.sql`, `drizzle/meta/*` | generate | migration |
| `src/lib/db/heatPumpEventSchema.test.ts` | create | constraints, FKs, RLS-by-construction |
| `src/lib/db/pgError.ts` | modify | `isForeignKeyViolation` |
| `src/lib/services/heatPump/errors.ts` | modify | three codes + `HeatPumpEventErrorCode` |
| `src/lib/services/heatPump/heatPumpEvents.ts` (+ `heatPumpEvents.test.ts`) | create | events CRUD + rules |
| `src/lib/services/heatPump/index.ts` | modify | re-export |
| `src/lib/orpc/procedures/heatPumpEvents.ts` (+ `heatPumpEvents.test.ts`) | create | `heatPumpEventsRouter` |
| `src/lib/orpc/procedures/heatPump.ts` | modify | `events: heatPumpEventsRouter` |
| `src/lib/orpc/heatPumpEventErrorMessage.ts` | create | client copy per error code |
| `src/components/heatPump/eventCopy.ts` (+ `eventCopy.test.ts`) | create | kind / unit labels |
| `src/components/heatPump/HeatPumpEvents.tsx` (+ `.browser.test.tsx`) | create | the card |
| `src/components/form/TextareaField.tsx` (+ `.browser.test.tsx`) | create | bound textarea field |
| `src/components/heatPump/HeatPumpEventDialog.tsx` (+ `.browser.test.tsx`) | create | add / edit dialog |
| `src/components/heatPump/DeleteHeatPumpEventDialog.tsx` (+ `.browser.test.tsx`) | create | delete confirmation |
| `src/components/heatPump/HeatPumpEventLines.tsx` | create | event lines in the day tooltip |
| `src/components/chart/BarChart.tsx` (+ `BarChart.browser.test.tsx`) | modify | generic `markers` prop |
| `src/components/heatPump/HeatPumpConsumptionChart.tsx` (+ `.browser.test.tsx`) | modify | `events` prop → markers + tooltip lines (day view) |
| `src/components/heatPump/HeatPumpConsumption.tsx` | modify | thread `events` to the chart |
| `src/routes/_authenticated/energy/heat-pumps.tsx` (+ `-heatPumpsPage.browser.test.tsx`) | modify | `energySearchSchema.extend(…)`, events query, card, dialogs, URL state |
| `src/components/heatPump/clientSafe.browser.test.tsx` | modify | client-safe guard for `events.ts` |
| `src/bones/heat-pumps-events.bones.json` | generate | the card's skeleton |
| `messages/sv.json`, `messages/en.json` | modify | `heat_pump_event*` keys |
| `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md` | modify | row 4a → `PR open` |
| `CLAUDE.md` | modify | code map: `heat_pump_event`, `src/lib/heatPump/events.ts` |

---

### Task 0: Check `main` still matches this plan; worktree

No reviewers (read-only check).

- [ ] **Step 1: Steps 1a–3 are in, and their names are what this plan uses**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "| 3 |" docs/superpowers/roadmaps/2026-10-08-heat-pumps.md                    # checkpoint passed
grep -n "export const heatPump \|export const heatPumpReading\|pgTable(" src/lib/db/schema/heatPump.ts
grep -n "heatPump" src/lib/db/schema/index.ts
grep -n "class HeatPumpDomainError\|constructor\|INVALID_READING\|UNKNOWN_HEAT_PUMP" src/lib/services/heatPump/errors.ts
grep -n "export \* from\|export {" src/lib/services/heatPump/index.ts
grep -n "export async function upsertUnits\|export function upsertUnits\|export async function listUnits" src/lib/services/heatPump/heatPump.ts
grep -n "heatPumpRouter\|months:\|days:" src/lib/orpc/procedures/heatPump.ts
grep -n "heatPump" src/lib/orpc/router.ts
ls src/components/heatPump/ src/lib/heatPump/
grep -n "export function HeatPumpConsumptionChart\|export function HeatPumpConsumption\b\|tooltip=\|row.key\|heatPumpColor" src/components/heatPump/HeatPumpConsumptionChart.tsx src/components/heatPump/HeatPumpConsumption.tsx
grep -n "key: string\|export type HeatPumpChartRow\|export type HeatPumpView" src/components/heatPump/heatPumpView.ts
grep -n "export function heatPumpColor" src/lib/houseEnergy/heatPumpColors.ts
grep -n "shown\|return {" src/components/heatPump/useHeatPumpPeriod.ts
grep -n "validateSearch\|energySearchSchema\|writeSearch\|loadRouteData\|critical\|deferred\|useRouteContext\|HeatPumpEmpty\|<HeatPumpConsumption" src/routes/_authenticated/energy/heat-pumps.tsx
grep -n "export const energySearchSchema" src/components/energy/energySearch.ts
grep -n "export function monthsPayload\|export function daysPayload\|export const MATSAL\|export const OVERVANING" test/fixtures/heatPumpView.ts
ls src/routes/_authenticated/energy/ src/components/heatPump/
grep -n "'/energy/heat-pumps'" scripts/captureBones.ts
ls src/bones/ | grep heat
```

Expected: row 3 is `checkpoint passed`; `heatPump` and `heatPumpReading` exist and are re-exported; the error class
takes the code as its first argument (a second `message` argument, if any, is optional); `upsertUnits` exists;
`heatPumpRouter` has `months` and `days` and is registered as `heatPump`; the page route exists.

- [ ] **Step 2: Step 3's names this plan builds on** (from step 3's plan; confirm each against the greps above):

| This plan uses | Step 3's name |
|---|---|
| the day chart | `HeatPumpConsumptionChart({ view, onSelectMonth })` in `src/components/heatPump/HeatPumpConsumptionChart.tsx`; the day view is `view.kind === 'month'` (one row per Stockholm day, units stacked, series key = unit `id`) |
| what the route renders | only `HeatPumpConsumption({ view, onSelectMonth })` (`src/components/heatPump/HeatPumpConsumption.tsx`: tiles + chart), inside `EnergySummaryCard` |
| a row's day | `row.key` of `HeatPumpChartRow` (`YYYY-MM-DD` in the day view; `YYYY-MM` in the year/all views) |
| a unit's colour | `heatPumpColor(units, id)` from `~/lib/houseEnergy/heatPumpColors` — never a `var(--energy-heat-pump-N)` template (it would break the neutral fourth-unit rule) |
| the units | `h.shown?.units` from `useHeatPumpPeriod` (`HeatPumpUnitDto[]` = `{ id, name }`, `byHeatPumpName` order); the chart uses `view.units` |
| the search | no local schema: `validateSearch: energySearchSchema` (shared with `/energy`, `/energy/battery`); `writeSearch` merges into the previous search |
| the page test | `src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx`, `renderPage(path, prepare, health)`, user `{ role: 'user' }`, fixtures `monthsPayload`, `daysPayload(year, month, withData)`, `MATSAL`, `OVERVANING` from `~test/fixtures/heatPumpView` |
| the client-safe guard | `src/components/heatPump/clientSafe.browser.test.tsx` |
| the empty page | `h.months?.firstReadingDay === null` → `<HeatPumpEmpty />`; the card renders only on the data path |

  If `writeSearch` replaces the search instead of merging (`search: s` rather than `search: (prev) => ({ ...prev, ...s })`),
  a period change would drop `dialog`: stop and raise it with step 3's owner rather than patch around it. Any other
  mismatch → stop and amend this plan first.

- [ ] **Step 3: Worktree**

```bash
git worktree add .claude/worktrees/heat-pumps-4a -b feat/heat-pumps-events origin/main
cd .claude/worktrees/heat-pumps-4a && bun install && bun run db:up && bun run db:migrate
```

Port 14610 is often another session's dev server: run this worktree's on 14611
(`BETTER_AUTH_URL=http://localhost:14611 bun run dev -- --port 14611`) and pass
`BONES_ORIGIN=http://localhost:14611` to `bones:capture`.

---

### Task 1: `heat_pump_event` table and the client-safe vocabulary

**Reviewers:** `migration-guard` + schema-design reviewer (a `general-purpose` subagent that loads
`supabase-postgres-best-practices` and judges the table against the queries that will run: `listEvents` = full scan
ordered by `occurred_on desc, created_at desc` over tens of rows; `INSERT` / `UPDATE … WHERE id` / `DELETE … WHERE id`;
the FK checks on a `heat_pump` delete (restrict) and a `user` delete (set null). Ask it explicitly to rule on: the
spec-mandated `occurred_on` index on a tiny table, the unindexed FK columns `heat_pump_id` / `created_by`, the note
CHECK, `restrict` vs. the readings' `cascade`). Fix or rule on every finding before Task 2.

**Files:**
- Create: `src/lib/heatPump/events.ts`, `src/lib/heatPump/events.test.ts`
- Modify: `src/lib/db/schema/heatPump.ts`
- Generate: `drizzle/NNNN_heat_pump_event.sql` (+ `drizzle/meta/*`)
- Create: `src/lib/db/heatPumpEventSchema.test.ts`

**Interfaces:**
- Consumes: step 1a's `heatPump` table (`id` uuid) and `upsertUnits(units, now): Promise<HeatPump[]>`; `user` from
  `betterAuth.ts`; `sqlList` from `src/lib/db/sqlList.ts`.
- Produces:
```ts
// src/lib/heatPump/events.ts
export const HEAT_PUMP_EVENT_KINDS = ['service', 'filter', 'setting', 'other'] as const
export type HeatPumpEventKind = (typeof HEAT_PUMP_EVENT_KINDS)[number]
export const HEAT_PUMP_EVENT_NOTE_MAX = 500
export type HeatPumpEventDto = { id: string; occurredOn: string; heatPumpId: string | null; kind: HeatPumpEventKind; note: string | null }
export function isHeatPumpEventKind(value: string): value is HeatPumpEventKind
export function noteLength(note: string): number
export function normalizeNote(note: string | null | undefined): string | null
export type DayEventMarker = { day: string; heatPumpId: string | null; kinds: HeatPumpEventKind[] }
export function dayEventMarkers(events: readonly HeatPumpEventDto[], unitIds: readonly string[]): Map<string, DayEventMarker[]>
// src/lib/db/schema/heatPump.ts
export const heatPumpEvent  // pgTable('heat_pump_event', …)
```

- [ ] **Step 1: Write the failing vocabulary test** — `src/lib/heatPump/events.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  dayEventMarkers,
  HEAT_PUMP_EVENT_KINDS,
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  isHeatPumpEventKind,
  normalizeNote,
  noteLength,
} from './events'

const MATSAL = '11111111-1111-4111-8111-111111111111'
const UPSTAIRS = '22222222-2222-4222-8222-222222222222'
const ev = (over: Partial<HeatPumpEventDto>): HeatPumpEventDto => ({
  id: crypto.randomUUID(),
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})

test('the kinds are the four the spec names, and the guard knows them', () => {
  expect(HEAT_PUMP_EVENT_KINDS).toEqual(['service', 'filter', 'setting', 'other'])
  expect(isHeatPumpEventKind('filter')).toBe(true)
  expect(isHeatPumpEventKind('repair')).toBe(false)
})

describe('notes', () => {
  test('length counts characters (code points), not UTF-16 units', () => {
    expect(noteLength('å')).toBe(1)
    expect(noteLength('🙂')).toBe(1)
    expect(noteLength(`${'å'.repeat(HEAT_PUMP_EVENT_NOTE_MAX - 1)}🙂`)).toBe(500)
  })
  test('a note is trimmed, and a blank one is no note', () => {
    expect(normalizeNote('  Årlig service \n')).toBe('Årlig service')
    expect(normalizeNote('   ')).toBeNull()
    expect(normalizeNote('')).toBeNull()
    expect(normalizeNote(null)).toBeNull()
    expect(normalizeNote(undefined)).toBeNull()
  })
})

describe('dayEventMarkers', () => {
  test('one marker per day and unit; both units first, then units in the given order', () => {
    const markers = dayEventMarkers(
      [
        ev({ heatPumpId: UPSTAIRS, kind: 'filter' }),
        ev({ heatPumpId: MATSAL, kind: 'setting' }),
        ev({ heatPumpId: null, kind: 'service' }),
        ev({ heatPumpId: MATSAL, kind: 'other' }),
      ],
      [MATSAL, UPSTAIRS],
    )
    expect(markers.get('2026-10-08')).toEqual([
      { day: '2026-10-08', heatPumpId: null, kinds: ['service'] },
      { day: '2026-10-08', heatPumpId: MATSAL, kinds: ['setting', 'other'] },
      { day: '2026-10-08', heatPumpId: UPSTAIRS, kinds: ['filter'] },
    ])
  })
  test('a kind logged twice on the same day and unit is listed once', () => {
    const markers = dayEventMarkers([ev({ kind: 'service' }), ev({ kind: 'service' })], [MATSAL])
    expect(markers.get('2026-10-08')).toEqual([
      { day: '2026-10-08', heatPumpId: null, kinds: ['service'] },
    ])
  })
  test('an event for a unit the chart does not show draws nothing', () => {
    const markers = dayEventMarkers([ev({ heatPumpId: UPSTAIRS })], [MATSAL])
    expect(markers.size).toBe(0)
  })
  // Review Focus 5: keyed by calendar-day strings, never Dates, so the DST day and a UTC test
  // runner give the same key.
  test('markers are keyed by calendar day strings', () => {
    const markers = dayEventMarkers(
      [ev({ occurredOn: '2026-10-25' }), ev({ occurredOn: '2026-03-29' })],
      [MATSAL],
    )
    expect([...markers.keys()].sort()).toEqual(['2026-03-29', '2026-10-25'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/heatPump/events.test.ts`
Expected: FAIL — `Cannot find module './events'` (or, if step 4b's planner raced ahead, missing exports).

- [ ] **Step 3: Implement `src/lib/heatPump/events.ts`**

```ts
// Client-safe heat pump event vocabulary (ADR-0027 decision 10). Dependency-free on purpose:
// the schema imports it (drizzle-kit loads that without the `~` alias) and so do the browser
// components. Copy (labels) lives in components/heatPump/eventCopy.ts.

export const HEAT_PUMP_EVENT_KINDS = ['service', 'filter', 'setting', 'other'] as const
export type HeatPumpEventKind = (typeof HEAT_PUMP_EVENT_KINDS)[number]

/** The longest note, in characters (Unicode code points, as Postgres' char_length counts). */
export const HEAT_PUMP_EVENT_NOTE_MAX = 500

/** An event as the browser sees it (`heatPump.events.list`); `heatPumpId` null = every unit. */
export type HeatPumpEventDto = {
  id: string
  /** Stockholm calendar day, YYYY-MM-DD. */
  occurredOn: string
  heatPumpId: string | null
  kind: HeatPumpEventKind
  note: string | null
}

export function isHeatPumpEventKind(value: string): value is HeatPumpEventKind {
  return (HEAT_PUMP_EVENT_KINDS as readonly string[]).includes(value)
}

/** A note's length as the database counts it: code points, so "å" and an emoji are one each. */
export function noteLength(note: string): number {
  return [...note].length
}

/** The note as stored: trimmed, and a blank one is no note. */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** One marker on the day chart: a day and a unit (null = every unit), with the kinds logged. */
export type DayEventMarker = { day: string; heatPumpId: string | null; kinds: HeatPumpEventKind[] }

/**
 * The day chart's markers, by Stockholm day: one per unit with events that day, "every unit"
 * first, then units in `unitIds` order (the chart's colour order); each kind once, in the
 * events' order. Events for a unit not in `unitIds` are dropped (the chart has no bar for it).
 */
export function dayEventMarkers(
  events: readonly HeatPumpEventDto[],
  unitIds: readonly string[],
): Map<string, DayEventMarker[]> {
  const rank = (id: string | null) => (id === null ? -1 : unitIds.indexOf(id))
  const byDay = new Map<string, DayEventMarker[]>()
  for (const event of events) {
    if (event.heatPumpId !== null && !unitIds.includes(event.heatPumpId)) continue
    const day = byDay.get(event.occurredOn) ?? []
    let marker = day.find((m) => m.heatPumpId === event.heatPumpId)
    if (!marker) {
      marker = { day: event.occurredOn, heatPumpId: event.heatPumpId, kinds: [] }
      day.push(marker)
      day.sort((a, b) => rank(a.heatPumpId) - rank(b.heatPumpId))
    }
    if (!marker.kinds.includes(event.kind)) marker.kinds.push(event.kind)
    byDay.set(event.occurredOn, day)
  }
  return byDay
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run src/lib/heatPump/events.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing schema test** — `src/lib/db/heatPumpEventSchema.test.ts` (in `src/lib/db/`, not
  `schema/`: drizzle-kit scans `schema/`):

```ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPump, heatPumpEvent, user } from '~/lib/db/schema'
import { upsertUnits } from '~/lib/services/heatPump'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

setupDatabase()

type Insert = typeof heatPumpEvent.$inferInsert
const NOW = new Date('2026-10-08T10:00:00Z')

// Synthetic unit (fake guid), never the owner's real device ids.
async function matsal() {
  const [unit] = await upsertUnits(
    [{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' }],
    NOW,
  )
  return unit
}
const row = (over: Partial<Insert> = {}): Insert => ({
  occurredOn: '2026-10-08',
  kind: 'service',
  ...over,
})

test('an event for every unit has no heat pump', async () => {
  const [stored] = await db.insert(heatPumpEvent).values(row()).returning()
  expect(stored).toMatchObject({ occurredOn: '2026-10-08', heatPumpId: null, kind: 'service', note: null })
  expect(stored.createdAt).toBeInstanceOf(Date)
})

test('an unknown kind is rejected', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ kind: 'repair' as never })),
    'heat_pump_event_kind_check',
  )
})

test('a note is 1 to 500 characters, counted as Postgres counts them', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ note: '' })),
    'heat_pump_event_note_check',
  )
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ note: 'x'.repeat(501) })),
    'heat_pump_event_note_check',
  )
  // 500 code points, 501 UTF-16 units: allowed.
  await db.insert(heatPumpEvent).values(row({ note: `${'å'.repeat(499)}🙂` }))
})

test('a heat pump with events can not be deleted (restrict)', async () => {
  const unit = await matsal()
  await db.insert(heatPumpEvent).values(row({ heatPumpId: unit.id }))
  await expectConstraintViolation(
    db.delete(heatPump).where(eq(heatPump.id, unit.id)),
    'heat_pump_event_heat_pump_id_heat_pump_id_fk',
  )
})

test('an unknown heat pump is rejected', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpEvent).values(row({ heatPumpId: '00000000-0000-4000-8000-000000000000' })),
    'heat_pump_event_heat_pump_id_heat_pump_id_fk',
  )
})

test('deleting the author keeps the event (set null)', async () => {
  const [author] = await db
    .insert(user)
    .values({ name: 'Admin', email: 'admin@test.videbacken.local', role: 'admin' })
    .returning({ id: user.id })
  const [event] = await db.insert(heatPumpEvent).values(row({ createdBy: author.id })).returning()
  await db.delete(user).where(eq(user.id, author.id))
  const [kept] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(kept.createdBy).toBeNull()
})
```

(If the generated FK name differs from `heat_pump_event_heat_pump_id_heat_pump_id_fk`, use the generated one here and
in Task 2's `HEAT_PUMP_FK` — read it from the migration SQL.)

- [ ] **Step 6: Add the table** to `src/lib/db/schema/heatPump.ts`, after `heatPumpReading` (merge the imports into
  the file's existing import lines; relative imports, as `integrationCredential.ts` does):

```ts
import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  HEAT_PUMP_EVENT_KINDS,
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventKind,
} from '../../heatPump/events'
import { sqlList } from '../sqlList'
import { user } from './betterAuth'

// Admin-entered log of what happened to the units (ADR-0027 decision 10): a service, a filter
// cleaning, a changed setting. Marks the day chart and splits the energy signature (step 4b).
// `occurred_on` is a Stockholm calendar day (a `date`, not an instant). `heat_pump_id` null =
// every unit; restrict, so a unit with logged events can't silently vanish (the readings
// cascade, but an event is the owner's own record). The note's 500-character rule is the
// service's; the CHECK is its backstop.
export const heatPumpEvent = pgTable(
  'heat_pump_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    heatPumpId: uuid('heat_pump_id').references(() => heatPump.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<HeatPumpEventKind>().notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check('heat_pump_event_kind_check', sql`${table.kind} IN (${sqlList(HEAT_PUMP_EVENT_KINDS)})`),
    check(
      'heat_pump_event_note_check',
      sql`char_length(${table.note}) BETWEEN 1 AND ${sql.raw(String(HEAT_PUMP_EVENT_NOTE_MAX))}`,
    ),
    index('heat_pump_event_occurred_on_idx').on(table.occurredOn),
  ],
).enableRLS()
```

`heatPump.ts` is already re-exported by the barrel (step 1a); nothing to add to `schema/index.ts`.

- [ ] **Step 7: Generate and apply the migration**

```bash
bun run db:generate --name=heat_pump_event
cat drizzle/*_heat_pump_event.sql
bun run db:migrate
```

Expected SQL: `CREATE TABLE "heat_pump_event"` with the two CHECKs, `ALTER TABLE "heat_pump_event" ENABLE ROW LEVEL
SECURITY`, two `ADD CONSTRAINT … FOREIGN KEY` (`ON DELETE restrict`, `ON DELETE set null`), `CREATE INDEX
"heat_pump_event_occurred_on_idx"`; no statement touching another table. The CHECK reads `BETWEEN 1 AND 500`
(a literal, not `$1`). Never hand-edit `drizzle/meta/`.

- [ ] **Step 8: Run the schema test and the RLS guard**

Run: `bunx vitest run src/lib/db/heatPumpEventSchema.test.ts test/rls.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
bun run typecheck && bun run check
git add src/lib/heatPump/events.ts src/lib/heatPump/events.test.ts src/lib/db/schema/heatPump.ts \
  src/lib/db/heatPumpEventSchema.test.ts drizzle/
git commit -m "feat(heat-pumps): add the heat_pump_event table" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Dispatch both reviewers in parallel** (each told to assume the task is wrong and not up to spec);
  fix or rule on every finding (a schema change → regenerate: drop the unmerged migration with
  `bunx drizzle-kit drop`, edit, generate again under the same `--name`), commit the fixes.

---

### Task 2: The event service

**Reviewers:** `code-reviewer` + `test-completeness` (every `HeatPumpDomainError` code literal this task adds, plus
`UNKNOWN_HEAT_PUMP`, exercised).

**Files:**
- Modify: `src/lib/db/pgError.ts`, `src/lib/services/heatPump/errors.ts`, `src/lib/services/heatPump/index.ts`
- Create: `src/lib/services/heatPump/heatPumpEvents.ts`, `src/lib/services/heatPump/heatPumpEvents.test.ts`

**Interfaces:**
- Consumes: Task 1's `heatPumpEvent`, `HeatPumpEventDto`, `HeatPumpEventKind`, `HEAT_PUMP_EVENT_NOTE_MAX`,
  `normalizeNote`, `noteLength`; `isStockholmDay`, `stockholmDayOf` (`src/lib/time/stockholm.ts:81,86`); step 1a's
  `HeatPumpDomainError`, `upsertUnits`.
- Produces:
```ts
export function isForeignKeyViolation(error: unknown, constraint: string): boolean   // pgError.ts
export type HeatPumpEventErrorCode = 'UNKNOWN_HEAT_PUMP' | 'FUTURE_DATE' | 'EVENT_NOT_FOUND' | 'NOTE_TOO_LONG'
export type HeatPumpEventInput = { occurredOn: string; heatPumpId: string | null; kind: HeatPumpEventKind; note: string | null }
export function listEvents(): Promise<HeatPumpEventDto[]>
export function createEvent(input: HeatPumpEventInput, userId: string, now?: Date): Promise<HeatPumpEventDto>
export function updateEvent(id: string, input: HeatPumpEventInput, now?: Date): Promise<HeatPumpEventDto>
export function deleteEvent(id: string): Promise<void>
```

- [ ] **Step 1: Write the failing test** — `src/lib/services/heatPump/heatPumpEvents.test.ts` (`setupDatabase()` first):

```ts
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { heatPumpEvent, user } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import {
  createEvent,
  deleteEvent,
  HeatPumpDomainError,
  type HeatPumpEventInput,
  listEvents,
  updateEvent,
  upsertUnits,
} from './index'

setupDatabase()

// 12:00 in Stockholm on 2026-10-08 (CEST): "today" is 2026-10-08.
const NOW = new Date('2026-10-08T10:00:00Z')
const MISSING = '00000000-0000-4000-8000-000000000000'
const SERVICE: HeatPumpEventInput = {
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: 'Årlig service',
}

async function admin() {
  const [row] = await db
    .insert(user)
    .values({ name: 'Admin', email: 'admin@test.videbacken.local', role: 'admin' })
    .returning({ id: user.id })
  return row.id
}
// Synthetic units, fake guids.
async function units() {
  const rows = await upsertUnits(
    [
      { guid: 'CS-HZ25ZKE+0000000001', name: 'Matsal', model: 'CS-HZ25ZKE' },
      { guid: 'CS-HZ25ZKE+0000000002', name: 'Övervåning', model: 'CS-HZ25ZKE' },
    ],
    NOW,
  )
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  return { matsal: byName.get('Matsal') as string, upstairs: byName.get('Övervåning') as string }
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof HeatPumpDomainError ? e.code : e),
  )

test('create stores the event, returns its DTO and records the author', async () => {
  const author = await admin()
  const { matsal } = await units()
  const event = await createEvent({ ...SERVICE, heatPumpId: matsal }, author, NOW)
  expect(event).toEqual({
    id: expect.any(String),
    occurredOn: '2026-10-08',
    heatPumpId: matsal,
    kind: 'service',
    note: 'Årlig service',
  })
  const [row] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(row.createdBy).toBe(author)
})

test('list is newest first: by day, then the later entry first', async () => {
  const author = await admin()
  const a = await createEvent({ ...SERVICE, occurredOn: '2026-09-01', kind: 'filter' }, author, NOW)
  const b = await createEvent(SERVICE, author, NOW)
  const c = await createEvent({ ...SERVICE, kind: 'setting' }, author, NOW)
  expect((await listEvents()).map((e) => e.id)).toEqual([c.id, b.id, a.id])
})

// Review Focus 1.
test('Stockholm today, not UTC today', async () => {
  const author = await admin()
  // 00:30 in Stockholm on 2026-10-09 is still 2026-10-08 in UTC.
  const justAfterMidnight = new Date('2026-10-08T22:30:00Z')
  await expect(
    createEvent({ ...SERVICE, occurredOn: '2026-10-09' }, author, justAfterMidnight),
  ).resolves.toMatchObject({ occurredOn: '2026-10-09' })
  expect(
    await codeOf(createEvent({ ...SERVICE, occurredOn: '2026-10-10' }, author, justAfterMidnight)),
  ).toBe('FUTURE_DATE')
})

test('a future day is FUTURE_DATE, on create and on update', async () => {
  const author = await admin()
  expect(await codeOf(createEvent({ ...SERVICE, occurredOn: '2026-10-09' }, author, NOW))).toBe(
    'FUTURE_DATE',
  )
  const event = await createEvent(SERVICE, author, NOW)
  expect(
    await codeOf(updateEvent(event.id, { ...SERVICE, occurredOn: '2027-01-01' }, NOW)),
  ).toBe('FUTURE_DATE')
  expect(await listEvents()).toHaveLength(1)
})

// Review Focus 2.
test('a note is counted in characters, trimmed, and blank is none', async () => {
  const author = await admin()
  const fits = `${'å'.repeat(499)}🙂` // 500 characters, 501 UTF-16 units
  expect((await createEvent({ ...SERVICE, note: fits }, author, NOW)).note).toBe(fits)
  expect(await codeOf(createEvent({ ...SERVICE, note: 'x'.repeat(501) }, author, NOW))).toBe(
    'NOTE_TOO_LONG',
  )
  // Trimmed before counting: 500 characters plus padding fits.
  expect((await createEvent({ ...SERVICE, note: `  ${'x'.repeat(500)}  ` }, author, NOW)).note).toBe(
    'x'.repeat(500),
  )
  expect((await createEvent({ ...SERVICE, note: '   ' }, author, NOW)).note).toBeNull()
  expect((await createEvent({ ...SERVICE, note: '  Filter rengjort ' }, author, NOW)).note).toBe(
    'Filter rengjort',
  )
})

test('an unknown heat pump is UNKNOWN_HEAT_PUMP, on create and on update', async () => {
  const author = await admin()
  expect(await codeOf(createEvent({ ...SERVICE, heatPumpId: MISSING }, author, NOW))).toBe(
    'UNKNOWN_HEAT_PUMP',
  )
  const event = await createEvent(SERVICE, author, NOW)
  expect(await codeOf(updateEvent(event.id, { ...SERVICE, heatPumpId: MISSING }, NOW))).toBe(
    'UNKNOWN_HEAT_PUMP',
  )
  expect((await listEvents()).map((e) => e.heatPumpId)).toEqual([null])
})

test('update replaces the fields and keeps the author', async () => {
  const author = await admin()
  const { upstairs } = await units()
  const event = await createEvent(SERVICE, author, NOW)
  const [before] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  const updated = await updateEvent(
    event.id,
    { occurredOn: '2026-10-07', heatPumpId: upstairs, kind: 'filter', note: null },
    NOW,
  )
  expect(updated).toEqual({
    id: event.id,
    occurredOn: '2026-10-07',
    heatPumpId: upstairs,
    kind: 'filter',
    note: null,
  })
  const [after] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, event.id))
  expect(after.createdBy).toBe(author)
  expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime())
})

test('update and delete of a missing event are EVENT_NOT_FOUND', async () => {
  expect(await codeOf(updateEvent(MISSING, SERVICE, NOW))).toBe('EVENT_NOT_FOUND')
  expect(await codeOf(deleteEvent(MISSING))).toBe('EVENT_NOT_FOUND')
})

test('delete removes the event', async () => {
  const author = await admin()
  const event = await createEvent(SERVICE, author, NOW)
  await deleteEvent(event.id)
  expect(await listEvents()).toEqual([])
})

test('a day that is not a calendar day is a programming error, not a domain error', async () => {
  const author = await admin()
  const error = await createEvent({ ...SERVICE, occurredOn: '2026-02-30' }, author, NOW).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(HeatPumpDomainError)
  expect(await listEvents()).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/services/heatPump/heatPumpEvents.test.ts`
Expected: FAIL — `createEvent` (etc.) is not exported from `./index`.

- [ ] **Step 3: `pgError.ts` — share the unwrapping, add the FK check**

```ts
// Server-only. Recognises a Postgres constraint violation on one named constraint — the
// backstop a service maps to its own domain error. Drizzle wraps the node-postgres error as
// the `cause` of a `DrizzleQueryError`, so both levels are checked.
function isViolation(error: unknown, sqlState: string, constraint: string): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (pg.code === sqlState && pg.constraint === constraint) return true
    e = pg.cause
  }
  return false
}

/** A unique violation (SQLSTATE 23505): a check-first test lost a race. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, '23505', constraint)
}

/** A foreign-key violation (SQLSTATE 23503): the row points at one that doesn't exist. */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, '23503', constraint)
}
```

- [ ] **Step 4: `errors.ts` — add the codes.** Extend step 1a's union (keep its existing members and comments) and
  add the event subset:

```ts
  // An event's date is after today's Stockholm calendar day.
  | 'FUTURE_DATE'
  // An update/delete targeted an event id that does not exist.
  | 'EVENT_NOT_FOUND'
  // An event's note is longer than HEAT_PUMP_EVENT_NOTE_MAX characters (code points), after trimming.
  | 'NOTE_TOO_LONG'
```

```ts
/** The codes the event procedures can surface (`UNKNOWN_HEAT_PUMP`: the event names a unit that doesn't exist). */
export type HeatPumpEventErrorCode = Extract<
  HeatPumpDomainErrorCode,
  'UNKNOWN_HEAT_PUMP' | 'FUTURE_DATE' | 'EVENT_NOT_FOUND' | 'NOTE_TOO_LONG'
>
```

(Use step 1a's union type name if it isn't `HeatPumpDomainErrorCode` — Task 0 printed it.)

- [ ] **Step 5: Implement `src/lib/services/heatPump/heatPumpEvents.ts`**

```ts
import { desc, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { isForeignKeyViolation } from '~/lib/db/pgError'
import { heatPumpEvent } from '~/lib/db/schema'
import {
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  type HeatPumpEventKind,
  normalizeNote,
  noteLength,
} from '~/lib/heatPump/events'
import { isStockholmDay, stockholmDayOf } from '~/lib/time/stockholm'
import { HeatPumpDomainError } from './errors'

/** An event's editable fields; `heatPumpId` null = every unit. */
export type HeatPumpEventInput = {
  occurredOn: string
  heatPumpId: string | null
  kind: HeatPumpEventKind
  note: string | null
}

// The generated name of the heat_pump_id FK (drizzle: <table>_<column>_<ref table>_<ref column>_fk).
const HEAT_PUMP_FK = 'heat_pump_event_heat_pump_id_heat_pump_id_fk'

const DTO = {
  id: heatPumpEvent.id,
  occurredOn: heatPumpEvent.occurredOn,
  heatPumpId: heatPumpEvent.heatPumpId,
  kind: heatPumpEvent.kind,
  note: heatPumpEvent.note,
}

// The rules, checked before any write. The procedure's Zod already rejects a day that isn't
// a calendar day; reaching here with one is a caller's bug, not a user's mistake.
function columns(input: HeatPumpEventInput, now: Date) {
  if (!isStockholmDay(input.occurredOn)) {
    throw new Error(`occurredOn is not a calendar day: ${input.occurredOn}`)
  }
  if (input.occurredOn > stockholmDayOf(now.getTime())) throw new HeatPumpDomainError('FUTURE_DATE')
  const note = normalizeNote(input.note)
  if (note !== null && noteLength(note) > HEAT_PUMP_EVENT_NOTE_MAX) {
    throw new HeatPumpDomainError('NOTE_TOO_LONG')
  }
  return { occurredOn: input.occurredOn, heatPumpId: input.heatPumpId, kind: input.kind, note }
}

// A unit id that doesn't exist fails the FK: one query, no check-first race.
async function mapUnknownHeatPump<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isForeignKeyViolation(error, HEAT_PUMP_FK)) throw new HeatPumpDomainError('UNKNOWN_HEAT_PUMP')
    throw error
  }
}

/** Every event, newest first (by day, then the later entry). Tens of rows: no paging. */
export async function listEvents(): Promise<HeatPumpEventDto[]> {
  return db
    .select(DTO)
    .from(heatPumpEvent)
    .orderBy(desc(heatPumpEvent.occurredOn), desc(heatPumpEvent.createdAt), desc(heatPumpEvent.id))
}

export async function createEvent(
  input: HeatPumpEventInput,
  userId: string,
  now: Date = new Date(),
): Promise<HeatPumpEventDto> {
  const values = { ...columns(input, now), createdBy: userId }
  return mapUnknownHeatPump(async () => {
    const [row] = await db.insert(heatPumpEvent).values(values).returning(DTO)
    return row
  })
}

export async function updateEvent(
  id: string,
  input: HeatPumpEventInput,
  now: Date = new Date(),
): Promise<HeatPumpEventDto> {
  const values = columns(input, now)
  const row = await mapUnknownHeatPump(async () => {
    const [updated] = await db
      .update(heatPumpEvent)
      .set(values)
      .where(eq(heatPumpEvent.id, id))
      .returning(DTO)
    return updated
  })
  if (!row) throw new HeatPumpDomainError('EVENT_NOT_FOUND')
  return row
}

export async function deleteEvent(id: string): Promise<void> {
  const deleted = await db
    .delete(heatPumpEvent)
    .where(eq(heatPumpEvent.id, id))
    .returning({ id: heatPumpEvent.id })
  if (deleted.length === 0) throw new HeatPumpDomainError('EVENT_NOT_FOUND')
}
```

Add `export * from './heatPumpEvents'` to `src/lib/services/heatPump/index.ts`.

- [ ] **Step 6: Run the service tests (and the existing unique-violation users)**

Run: `bunx vitest run src/lib/services/heatPump/ src/lib/services/tariff/`
Expected: PASS (the tariff suite proves `isUniqueViolation` is unchanged).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck && bun run check
git add src/lib/db/pgError.ts src/lib/services/heatPump/
git commit -m "feat(heat-pumps): add the event service" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Reviewers** (`code-reviewer` + `test-completeness`, in parallel, skeptical); fix, commit.

---

### Task 3: The `heatPump.events` procedures

**Reviewers:** `code-reviewer` + a reviewer loading `better-auth-security-best-practices` (the permission boundary:
writes admin-only, `created_by` from the session never from input, no note in logs, no other user's data exposed).

**Files:**
- Create: `src/lib/orpc/procedures/heatPumpEvents.ts`, `src/lib/orpc/procedures/heatPumpEvents.test.ts`
- Modify: `src/lib/orpc/procedures/heatPump.ts`

**Interfaces:**
- Consumes: Task 2's service functions, `HeatPumpDomainError`, `HeatPumpEventErrorCode`; `adminProcedure`,
  `protectedProcedure` (`src/lib/orpc/context.ts`); `context.user.id`.
- Produces: `heatPumpEventsRouter = { list, create, update, delete }`, mounted as `heatPumpRouter.events`, so the
  client calls `orpc.heatPump.events.list.queryOptions()`, `orpc.heatPump.events.create.mutationOptions()` (etc.) and
  invalidates `orpc.heatPump.events.key()`. Inputs: `create` `{ occurredOn, heatPumpId: uuid | null, kind, note: string | null }`,
  `update` the same + `id`, `delete` `{ id }`. Outputs: `HeatPumpEventDto` (`create`, `update`),
  `HeatPumpEventDto[]` (`list`), `void` (`delete`). Typed errors: `UNKNOWN_HEAT_PUMP` 422, `FUTURE_DATE` 422,
  `EVENT_NOT_FOUND` 404, `NOTE_TOO_LONG` 422.

- [ ] **Step 1: Write the failing test** — `src/lib/orpc/procedures/heatPumpEvents.test.ts` (helpers as in
  `tariff.test.ts:15-58`):

```ts
import { call } from '@orpc/server'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { heatPumpEvent, user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import * as heatPumpService from '~/lib/services/heatPump'
import { HeatPumpDomainError } from '~/lib/services/heatPump'
import { addDays, stockholmDayOf } from '~/lib/time/stockholm'
import { setupDatabase } from '~test/setup'
import { appRouter } from '../router'
import { heatPumpRouter } from './heatPump'

setupDatabase()

const events = heatPumpRouter.events
const MISSING = '00000000-0000-4000-8000-000000000000'
const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}
const ctx = () => ({ headers: new Headers(), log: noopLog, requestId: 'test-request' })

function mockSession(row: { id: string; email: string; role: 'user' | 'admin' }) {
  vi.spyOn(auth.api, 'getSession').mockResolvedValue({
    session: {
      id: 'session-id',
      userId: row.id,
      token: 'token',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: row.id,
      email: row.email,
      name: 'Test',
      role: row.role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}
afterEach(() => {
  vi.restoreAllMocks()
})
async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
  mockSession({ id: row.id, email: row.email, role })
  return row
}

// A past day, whatever the real clock says.
const SERVICE = { occurredOn: '2026-10-08', heatPumpId: null, kind: 'service' as const, note: 'Årlig service' }

test('the events router is registered under heatPump', () => {
  expect(appRouter.heatPump.events).toBe(heatPumpRouter.events)
})

test('list rejects anonymous callers and is readable by any signed-in user', async () => {
  await expect(call(events.list, undefined, { context: ctx() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await signIn('user')
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([])
})

test.each(['create', 'update', 'delete'] as const)('%s is forbidden for a non-admin', async (name) => {
  await signIn('user')
  const input =
    name === 'create' ? SERVICE : name === 'update' ? { ...SERVICE, id: MISSING } : { id: MISSING }
  await expect(
    // biome-ignore lint/suspicious/noExplicitAny: one table-driven gate test over three procedures
    call(events[name] as any, input, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(await db.select().from(heatPumpEvent)).toEqual([])
})

test('an admin creates, updates and deletes; the author is the session user', async () => {
  const me = await signIn('admin')
  const created = await call(events.create, SERVICE, { context: ctx() })
  expect(created).toMatchObject(SERVICE)
  const [row] = await db.select().from(heatPumpEvent).where(eq(heatPumpEvent.id, created.id))
  expect(row.createdBy).toBe(me.id)

  const updated = await call(
    events.update,
    { ...SERVICE, id: created.id, kind: 'filter', note: null },
    { context: ctx() },
  )
  expect(updated).toMatchObject({ id: created.id, kind: 'filter', note: null })
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([updated])

  await call(events.delete, { id: created.id }, { context: ctx() })
  expect(await call(events.list, undefined, { context: ctx() })).toEqual([])
})

test('every event domain error surfaces as its typed code and status', async () => {
  await signIn('admin')
  const tomorrow = addDays(stockholmDayOf(Date.now()), 1)
  await expect(
    call(events.create, { ...SERVICE, occurredOn: tomorrow }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'FUTURE_DATE', status: 422 })
  await expect(
    call(events.create, { ...SERVICE, note: 'x'.repeat(501) }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'NOTE_TOO_LONG', status: 422 })
  await expect(
    call(events.create, { ...SERVICE, heatPumpId: MISSING }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_HEAT_PUMP', status: 422 })
  await expect(
    call(events.update, { ...SERVICE, id: MISSING }, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 })
  await expect(call(events.delete, { id: MISSING }, { context: ctx() })).rejects.toMatchObject({
    code: 'EVENT_NOT_FOUND',
    status: 404,
  })
})

// Review Focus 2.
test('a 500-character note with an emoji passes the input boundary', async () => {
  await signIn('admin')
  const note = `${'å'.repeat(499)}🙂`
  expect((await call(events.create, { ...SERVICE, note }, { context: ctx() })).note).toBe(note)
})

test.each([
  ['a day that does not exist', { occurredOn: '2026-02-30' }],
  ['a day in another format', { occurredOn: '8/10/2026' }],
  ['an unknown kind', { kind: 'repair' }],
  ['a heat pump id that is not a uuid', { heatPumpId: 'matsal' }],
  ['an absurdly long note', { note: 'x'.repeat(2001) }],
])('%s is BAD_REQUEST', async (_, override) => {
  await signIn('admin')
  await expect(
    call(events.create, { ...SERVICE, ...override } as never, { context: ctx() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('a non-event domain error or an unexpected error propagates untyped', async () => {
  await signIn('admin')
  vi.spyOn(heatPumpService, 'createEvent').mockRejectedValueOnce(
    new HeatPumpDomainError('INVALID_READING'),
  )
  const domain = await call(events.create, SERVICE, { context: ctx() }).catch((e: unknown) => e)
  expect(domain).not.toHaveProperty('defined', true)
  vi.spyOn(heatPumpService, 'deleteEvent').mockRejectedValueOnce(new Error('db down'))
  await expect(call(events.delete, { id: MISSING }, { context: ctx() })).rejects.toThrow('db down')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/orpc/procedures/heatPumpEvents.test.ts`
Expected: FAIL — `heatPumpRouter.events` is undefined.

- [ ] **Step 3: Implement `src/lib/orpc/procedures/heatPumpEvents.ts`**

```ts
import { z } from 'zod'
import { HEAT_PUMP_EVENT_KINDS } from '~/lib/heatPump/events'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as heatPumpService from '~/lib/services/heatPump'
import { HeatPumpDomainError, type HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { isStockholmDay } from '~/lib/time/stockholm'

const heatPumpEventErrors = {
  UNKNOWN_HEAT_PUMP: { status: 422 },
  FUTURE_DATE: { status: 422 },
  EVENT_NOT_FOUND: { status: 404 },
  NOTE_TOO_LONG: { status: 422 },
} satisfies Record<HeatPumpEventErrorCode, { status: number }>

const isEventCode = (code: string): code is HeatPumpEventErrorCode => code in heatPumpEventErrors

// An abuse guard only: Zod counts UTF-16 units, so the exact 500-character rule (code points,
// trimmed) is the service's, which answers with the typed NOTE_TOO_LONG.
const NOTE_INPUT_MAX = 2000

// The shape is validated here (a real calendar day, a uuid, a known kind); the future-date and
// note rules are the service's, the source of the typed domain errors.
const eventInput = z.object({
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isStockholmDay),
  heatPumpId: z.uuid().nullable(),
  kind: z.enum(HEAT_PUMP_EVENT_KINDS),
  note: z.string().max(NOTE_INPUT_MAX).nullable(),
})

// Maps an event domain error to its typed oRPC error (code only; the client owns the copy, see
// heatPumpEventErrorMessage). Anything else, `INVALID_READING` included, propagates (a 500).
function mapEventError(
  err: unknown,
  errors: { [K in HeatPumpEventErrorCode]: () => Error },
): never {
  if (err instanceof HeatPumpDomainError && isEventCode(err.code)) throw errors[err.code]()
  throw err
}

export const heatPumpEventsRouter = {
  // Everyone signed in sees the log (ADR-0027 decision 10). One small query: no sub-timings.
  list: protectedProcedure.handler(() => heatPumpService.listEvents()),

  create: adminProcedure
    .errors(heatPumpEventErrors)
    .input(eventInput)
    .handler(async ({ input, context, errors }) => {
      try {
        const event = await heatPumpService.createEvent(input, context.user.id)
        // Never the note: free text.
        context.log.info('admin created heat pump event', {
          eventId: event.id,
          occurredOn: event.occurredOn,
          kind: event.kind,
        })
        return event
      } catch (err) {
        mapEventError(err, errors)
      }
    }),

  update: adminProcedure
    .errors(heatPumpEventErrors)
    .input(eventInput.extend({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      const { id, ...fields } = input
      try {
        const event = await heatPumpService.updateEvent(id, fields)
        context.log.info('admin updated heat pump event', {
          eventId: id,
          occurredOn: event.occurredOn,
          kind: event.kind,
        })
        return event
      } catch (err) {
        mapEventError(err, errors)
      }
    }),

  delete: adminProcedure
    .errors(heatPumpEventErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await heatPumpService.deleteEvent(input.id)
        context.log.info('admin deleted heat pump event', { eventId: input.id })
      } catch (err) {
        mapEventError(err, errors)
      }
    }),
}
```

In `src/lib/orpc/procedures/heatPump.ts`: `import { heatPumpEventsRouter } from './heatPumpEvents'` and add
`events: heatPumpEventsRouter,` to `heatPumpRouter` (after `days`). `router.ts` already mounts `heatPump`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run src/lib/orpc/procedures/heatPumpEvents.test.ts src/lib/orpc/procedures/heatPump.test.ts`
Expected: PASS (step 3's procedure tests stay green).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run typecheck && bun run check
git add src/lib/orpc/procedures/heatPumpEvents.ts src/lib/orpc/procedures/heatPumpEvents.test.ts src/lib/orpc/procedures/heatPump.ts
git commit -m "feat(heat-pumps): add the events procedures" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Reviewers**; fix, commit.

---

### Task 4: Copy and the `HeatPumpEvents` card

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`
- Create: `src/components/heatPump/eventCopy.ts`, `src/components/heatPump/eventCopy.test.ts`
- Create: `src/lib/orpc/heatPumpEventErrorMessage.ts`
- Create: `src/components/heatPump/HeatPumpEvents.tsx`, `src/components/heatPump/HeatPumpEvents.browser.test.tsx`

**Interfaces:**
- Consumes: Task 1's `HeatPumpEventDto`, `HeatPumpEventKind`; Task 2's `HeatPumpEventErrorCode` (`import type`).
- Produces:
```ts
// eventCopy.ts
export type HeatPumpUnitRef = { id: string; name: string }
export function eventKindLabel(kind: HeatPumpEventKind): string
export function eventUnitLabel(heatPumpId: string | null, units: readonly HeatPumpUnitRef[]): string
// heatPumpEventErrorMessage.ts
export function heatPumpEventErrorMessage(code: HeatPumpEventErrorCode): string
// HeatPumpEvents.tsx
export type HeatPumpEventsAdmin = { onNew: () => void; onEdit: (id: string) => void; onDelete: (id: string) => void }
export function HeatPumpEvents(props: {
  events: readonly HeatPumpEventDto[]   // newest first, as events.list returns them
  units: readonly HeatPumpUnitRef[]     // name order
  admin?: HeatPumpEventsAdmin           // omitted for members: read-only
}): JSX.Element
```

- [ ] **Step 1: Messages** (all tasks' keys at once; `{…}` are inputs):

| key | sv | en |
|---|---|---|
| `heat_pump_events_title` | Händelser | Events |
| `heat_pump_events_description` | Service, filterrengöring och ändrade inställningar, markerade i dagdiagrammet. | Services, filter cleanings and changed settings, marked on the day chart. |
| `heat_pump_events_add` | Lägg till | Add |
| `heat_pump_events_empty_title` | Inga händelser ännu | No events yet |
| `heat_pump_events_empty_description` | Service och filterrengöring som loggas visas här. | Logged services and filter cleanings show here. |
| `heat_pump_events_empty_description_admin` | Logga en service eller filterrengöring så syns den i dagdiagrammet. | Log a service or filter cleaning to see it on the day chart. |
| `heat_pump_events_error_title` | Händelserna kunde inte läsas | The events couldn't be loaded |
| `heat_pump_event_kind_service` | Service | Service |
| `heat_pump_event_kind_filter` | Filterrengöring | Filter cleaning |
| `heat_pump_event_kind_setting` | Inställning | Setting |
| `heat_pump_event_kind_other` | Annat | Other |
| `heat_pump_event_unit_both` | Båda | Both |
| `heat_pump_event_unit_all` | Alla | All |
| `heat_pump_event_unit_unknown` | Okänd värmepump | Unknown heat pump |
| `heat_pump_event_actions_for` | Åtgärder för {kind} den {date} | Actions for {kind} on {date} |
| `heat_pump_event_dialog_new_title` | Ny händelse | New event |
| `heat_pump_event_dialog_edit_title` | Redigera händelse | Edit event |
| `heat_pump_event_dialog_description` | Händelsen markeras i dagdiagrammet. | The event is marked on the day chart. |
| `heat_pump_event_field_date` | Datum | Date |
| `heat_pump_event_field_unit` | Värmepump | Heat pump |
| `heat_pump_event_field_kind` | Typ | Type |
| `heat_pump_event_field_note` | Anteckning (valfri) | Note (optional) |
| `heat_pump_event_note_count` | {count} av {max} tecken | {count} of {max} characters |
| `heat_pump_event_error_date_required` | Välj ett datum. | Choose a date. |
| `heat_pump_event_error_future` | Datumet kan inte ligga i framtiden. | The date can't be in the future. |
| `heat_pump_event_error_note_too_long` | Anteckningen får vara högst {max} tecken. | The note can be at most {max} characters. |
| `heat_pump_event_error_not_found` | Händelsen finns inte längre. | The event no longer exists. |
| `heat_pump_event_error_unknown_heat_pump` | Värmepumpen finns inte längre. | The heat pump no longer exists. |
| `heat_pump_event_save_error` | Händelsen kunde inte sparas. | The event couldn't be saved. |
| `heat_pump_event_saved` | Händelsen sparad | Event saved |
| `heat_pump_event_delete_title` | Ta bort händelsen? | Delete the event? |
| `heat_pump_event_delete_confirm` | {kind} den {date} ({unit}) tas bort från loggen och diagrammet. | {kind} on {date} ({unit}) is removed from the log and the chart. |
| `heat_pump_event_delete_action` | Ta bort | Delete |
| `heat_pump_event_deleted` | Händelsen borttagen | Event deleted |
| `heat_pump_event_delete_error` | Händelsen kunde inte tas bort. | The event couldn't be deleted. |
| `heat_pump_event_tooltip` | {kinds} · {unit} | {kinds} · {unit} |

Run `bun run i18n:compile`.

- [ ] **Step 2: Write the failing tests**

`src/components/heatPump/eventCopy.test.ts` (node project, base locale sv):

```ts
import { expect, test } from 'vitest'
import { HEAT_PUMP_EVENT_KINDS } from '~/lib/heatPump/events'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel } from './eventCopy'

const TWO = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]

test('every kind has its Swedish label', () => {
  expect(HEAT_PUMP_EVENT_KINDS.map(eventKindLabel)).toEqual([
    'Service',
    'Filterrengöring',
    'Inställning',
    'Annat',
  ])
})

test('a unit event names the unit; every unit is "Båda" with two, "Alla" otherwise', () => {
  expect(eventUnitLabel('b', TWO)).toBe('Övervåning')
  expect(eventUnitLabel(null, TWO)).toBe(m.heat_pump_event_unit_both())
  expect(eventUnitLabel(null, [...TWO, { id: 'c', name: 'Vind' }])).toBe(m.heat_pump_event_unit_all())
  expect(eventUnitLabel(null, [])).toBe(m.heat_pump_event_unit_all())
  expect(eventUnitLabel('zzz', TWO)).toBe(m.heat_pump_event_unit_unknown())
})

test('every event error code has its own message', () => {
  const codes = ['UNKNOWN_HEAT_PUMP', 'FUTURE_DATE', 'EVENT_NOT_FOUND', 'NOTE_TOO_LONG'] as const
  const messages = codes.map(heatPumpEventErrorMessage)
  expect(new Set(messages).size).toBe(codes.length)
  expect(heatPumpEventErrorMessage('FUTURE_DATE')).toBe(m.heat_pump_event_error_future())
})
```

`src/components/heatPump/HeatPumpEvents.browser.test.tsx`:

```tsx
import { expect, test, vi } from 'vitest'
import { formatDay } from '~/components/evCharging/format'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpEvents } from './HeatPumpEvents'

const UNITS = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]
const SERVICE: HeatPumpEventDto = {
  id: 'e1',
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: 'Årlig service',
}
const FILTER: HeatPumpEventDto = {
  id: 'e2',
  occurredOn: '2026-06-01',
  heatPumpId: 'b',
  kind: 'filter',
  note: null,
}
const admin = () => ({ onNew: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() })

test('rows in the given order with date, unit, type and note', async () => {
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE, FILTER]} units={UNITS} />,
  )
  const items = screen.getByRole('listitem').elements()
  expect(items).toHaveLength(2)
  expect(items[0].textContent).toContain(formatDay('2026-10-08'))
  expect(items[0].textContent).toContain(m.heat_pump_event_unit_both())
  expect(items[0].textContent).toContain('Service')
  expect(items[0].textContent).toContain('Årlig service')
  expect(items[1].textContent).toContain('Övervåning')
  expect(items[1].textContent).toContain('Filterrengöring')
})

test('a member gets no add button and no row actions', async () => {
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE, FILTER]} units={UNITS} />,
  )
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})

test('an admin adds from the header and acts on a row from its menu', async () => {
  const actions = admin()
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE]} units={UNITS} admin={actions} />,
  )
  await screen.getByRole('button', { name: m.heat_pump_events_add() }).click()
  expect(actions.onNew).toHaveBeenCalledOnce()
  const menu = () =>
    screen.getByRole('button', {
      name: m.heat_pump_event_actions_for({ kind: 'Service', date: formatDay('2026-10-08') }),
    })
  await menu().click()
  await screen.getByRole('menuitem', { name: m.common_edit() }).click()
  expect(actions.onEdit).toHaveBeenCalledWith('e1')
  await menu().click()
  await screen.getByRole('menuitem', { name: m.heat_pump_event_delete_action() }).click()
  expect(actions.onDelete).toHaveBeenCalledWith('e1')
})

test('empty: the shared empty state; the admin gets the one next action', async () => {
  const member = await renderWithProviders(<HeatPumpEvents events={[]} units={UNITS} />)
  await expect.element(member.screen.getByText(m.heat_pump_events_empty_title())).toBeVisible()
  await expect
    .element(member.screen.getByText(m.heat_pump_events_empty_description()))
    .toBeVisible()
  expect(member.screen.getByRole('button').elements()).toHaveLength(0)

  const actions = admin()
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[]} units={UNITS} admin={actions} />,
  )
  await expect.element(screen.getByText(m.heat_pump_events_empty_description_admin())).toBeVisible()
  // One add button (in the empty state), not a second one in the header.
  const add = screen.getByRole('button', { name: m.heat_pump_events_add() })
  expect(add.elements()).toHaveLength(1)
  await add.click()
  expect(actions.onNew).toHaveBeenCalledOnce()
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run src/components/heatPump/eventCopy.test.ts && bunx vitest run --project browser src/components/heatPump/HeatPumpEvents.browser.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`src/components/heatPump/eventCopy.ts`:

```ts
import type { HeatPumpEventKind } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'

/** A unit as the page knows it (name order = colour order). */
export type HeatPumpUnitRef = { id: string; name: string }

export function eventKindLabel(kind: HeatPumpEventKind): string {
  switch (kind) {
    case 'service':
      return m.heat_pump_event_kind_service()
    case 'filter':
      return m.heat_pump_event_kind_filter()
    case 'setting':
      return m.heat_pump_event_kind_setting()
    case 'other':
      return m.heat_pump_event_kind_other()
  }
}

/** The unit an event is about: its name; every unit is "Båda" with two units, "Alla" otherwise. */
export function eventUnitLabel(heatPumpId: string | null, units: readonly HeatPumpUnitRef[]): string {
  if (heatPumpId === null) {
    return units.length === 2 ? m.heat_pump_event_unit_both() : m.heat_pump_event_unit_all()
  }
  return units.find((u) => u.id === heatPumpId)?.name ?? m.heat_pump_event_unit_unknown()
}
```

`src/lib/orpc/heatPumpEventErrorMessage.ts`:

```ts
import { HEAT_PUMP_EVENT_NOTE_MAX } from '~/lib/heatPump/events'
import type { HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { m } from '~/paraglide/messages'

// The event procedures throw code-only typed errors; the client owns the copy (same pattern as
// tariffErrorMessage). Exhaustive over the event codes.
export function heatPumpEventErrorMessage(code: HeatPumpEventErrorCode): string {
  switch (code) {
    case 'UNKNOWN_HEAT_PUMP':
      return m.heat_pump_event_error_unknown_heat_pump()
    case 'FUTURE_DATE':
      return m.heat_pump_event_error_future()
    case 'EVENT_NOT_FOUND':
      return m.heat_pump_event_error_not_found()
    case 'NOTE_TOO_LONG':
      return m.heat_pump_event_error_note_too_long({ max: String(HEAT_PUMP_EVENT_NOTE_MAX) })
  }
}
```

`src/components/heatPump/HeatPumpEvents.tsx`:

```tsx
import { MoreVerticalIcon, NotebookPenIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { formatDay } from '~/components/evCharging/format'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

export type HeatPumpEventsAdmin = {
  onNew: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

type Props = {
  /** Newest first, as `heatPump.events.list` returns them. */
  events: readonly HeatPumpEventDto[]
  units: readonly HeatPumpUnitRef[]
  /** Admin actions; omitted for everyone else (the card is then read-only, ADR-0017). */
  admin?: HeatPumpEventsAdmin
}

// The heat pumps' event log (ADR-0027 decision 10): what was done and when, newest first.
// Everyone sees it; only admins get add / edit / delete. Empty → the shared Empty (ADR-0016)
// with the one next action for admins.
export function HeatPumpEvents({ events, units, admin }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.heat_pump_events_title()}</h2>
        </CardTitle>
        <CardDescription>{m.heat_pump_events_description()}</CardDescription>
        {admin && events.length > 0 ? (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={admin.onNew}
            >
              <PlusIcon />
              {m.heat_pump_events_add()}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <Empty className="rounded-lg border py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <NotebookPenIcon />
              </EmptyMedia>
              <EmptyTitle>{m.heat_pump_events_empty_title()}</EmptyTitle>
              <EmptyDescription>
                {admin
                  ? m.heat_pump_events_empty_description_admin()
                  : m.heat_pump_events_empty_description()}
              </EmptyDescription>
            </EmptyHeader>
            {admin ? (
              <EmptyContent>
                <Button size="sm" className="pointer-coarse:h-11" onClick={admin.onNew}>
                  <PlusIcon />
                  {m.heat_pump_events_add()}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {events.map((e) => {
              const kind = eventKindLabel(e.kind)
              const date = formatDay(e.occurredOn)
              return (
                <li key={e.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="whitespace-nowrap font-medium tabular-nums">{date}</span>
                      <span aria-hidden className="text-muted-foreground">
                        ·
                      </span>
                      <span>{eventUnitLabel(e.heatPumpId, units)}</span>
                      <Badge variant="secondary">{kind}</Badge>
                    </div>
                    {e.note ? (
                      <p className="whitespace-pre-line break-words text-muted-foreground text-sm">
                        {e.note}
                      </p>
                    ) : null}
                  </div>
                  {admin ? (
                    // Always visible (not hover-revealed): with a handful of rows the menu is the
                    // only edit affordance, and touch has no hover.
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 pointer-coarse:size-11"
                          aria-label={m.heat_pump_event_actions_for({ kind, date })}
                        >
                          <MoreVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => admin.onEdit(e.id)}>
                          <PencilIcon />
                          {m.common_edit()}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => admin.onDelete(e.id)}>
                          <Trash2Icon />
                          {m.heat_pump_event_delete_action()}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
```

(If `NotebookPenIcon` isn't in the installed lucide version, use `ClipboardListIcon`.)

- [ ] **Step 5: Run them to verify they pass**

Run: `bunx vitest run src/components/heatPump/eventCopy.test.ts && bunx vitest run --project browser src/components/heatPump/HeatPumpEvents.browser.test.tsx`
Expected: PASS. Then `bun run typecheck && bun run check`.

- [ ] **Step 6: Commit**

```bash
git add messages/ src/components/heatPump/eventCopy.ts src/components/heatPump/eventCopy.test.ts \
  src/lib/orpc/heatPumpEventErrorMessage.ts src/components/heatPump/HeatPumpEvents.tsx \
  src/components/heatPump/HeatPumpEvents.browser.test.tsx
git commit -m "feat(heat-pumps): add the events card" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Reviewers**; fix, commit.

---

### Task 5: The add / edit dialog and the delete confirmation

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/form/TextareaField.tsx`, `src/components/form/TextareaField.browser.test.tsx`
- Create: `src/components/heatPump/HeatPumpEventDialog.tsx`, `src/components/heatPump/HeatPumpEventDialog.browser.test.tsx`
- Create: `src/components/heatPump/DeleteHeatPumpEventDialog.tsx`, `src/components/heatPump/DeleteHeatPumpEventDialog.browser.test.tsx`

**Interfaces:**
- Consumes: Task 4's copy and `heatPumpEventErrorMessage`; Task 3's `orpc.heatPump.events.{create,update,delete}`.
- Produces:
```ts
export function TextareaField(props: { label: string; description?: ReactNode; placeholder?: string; rows?: number }): JSX.Element
export type HeatPumpEventDialogMode = { kind: 'new' } | { kind: 'edit'; event: HeatPumpEventDto }
export function HeatPumpEventDialog(props: { open: boolean; mode: HeatPumpEventDialogMode | undefined; units: readonly HeatPumpUnitRef[]; onOpenChange: (open: boolean) => void }): JSX.Element
export function DeleteHeatPumpEventDialog(props: { open: boolean; event: HeatPumpEventDto | undefined; units: readonly HeatPumpUnitRef[]; onOpenChange: (open: boolean) => void }): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

`src/components/form/TextareaField.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAppForm } from '~/hooks/form'
import { TextareaField } from './TextareaField'

// Bound like the phone field: rendered inside AppField, not registered in fieldComponents.
function Harness({ description }: { description?: string }) {
  const form = useAppForm({
    defaultValues: { note: '' },
    validators: { onChange: ({ value }) => (value.note.length > 3 ? { fields: { note: 'För lång' } } : undefined) },
  })
  return (
    <form.AppField
      name="note"
      children={() => <TextareaField label="Anteckning" description={description} />}
    />
  )
}

test('the label names the textarea, the description describes it, typing binds', async () => {
  const screen = await render(<Harness description="0 av 500 tecken" />)
  const box = screen.getByRole('textbox', { name: 'Anteckning' })
  await expect.element(box).toHaveAccessibleDescription('0 av 500 tecken')
  expect(box.element().tagName).toBe('TEXTAREA')
  await box.fill('Hej')
  await expect.element(box).toHaveValue('Hej')
})

test('an error marks it invalid and is announced with it', async () => {
  const screen = await render(<Harness />)
  const box = screen.getByRole('textbox', { name: 'Anteckning' })
  // A change marks the field touched and runs the onChange validator.
  await box.fill('Hej då')
  await expect.element(screen.getByText('För lång')).toBeVisible()
  await expect.element(box).toHaveAttribute('aria-invalid', 'true')
})
```

(If the form-level `fields` error shape doesn't surface on the field in this TanStack Form version, put
`validators={{ onChange: … }}` on the `AppField` instead — as `TariffDialog`'s `takenError` does.)

`src/components/heatPump/HeatPumpEventDialog.browser.test.tsx` — oRPC mocked as in `TariffDialog.browser.test.tsx:12-32`:

```tsx
import { ORPCError } from '@orpc/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpEventDialog } from './HeatPumpEventDialog'

const { createFn, updateFn, toastMock } = vi.hoisted(() => ({
  createFn: vi.fn(),
  updateFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    heatPump: {
      events: {
        create: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: createFn }) },
        update: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: updateFn }) },
        key: () => ['heatPump', 'events'],
      },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const UNITS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Matsal' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Övervåning' },
]
const EVENT: HeatPumpEventDto = {
  id: 'e1',
  occurredOn: '2026-10-08',
  heatPumpId: UNITS[1].id,
  kind: 'filter',
  note: 'Filter rengjort',
}
const onOpenChange = vi.fn()
const dialog = (mode: Parameters<typeof HeatPumpEventDialog>[0]['mode']) => (
  <HeatPumpEventDialog open mode={mode} units={UNITS} onOpenChange={onOpenChange} />
)
type Screen = Awaited<ReturnType<typeof renderWithProviders>>['screen']
const save = (screen: Screen) => screen.getByRole('button', { name: m.common_save() }).click()
async function choose(screen: Screen, label: string, option: string) {
  await screen.getByRole('combobox', { name: label }).click()
  await screen.getByRole('option', { name: option }).click()
}

// 12:00 in Stockholm on 2026-10-08; only Date is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  createFn.mockReset().mockResolvedValue({ ...EVENT, id: 'new' })
  updateFn.mockReset().mockResolvedValue(EVENT)
  for (const f of [onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

test('a new event starts today, for both units, as a service, without a note', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await expect.element(screen.getByRole('heading', { name: m.heat_pump_event_dialog_new_title() })).toBeVisible()
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_date())).toHaveValue('2026-10-08')
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_unit() }))
    .toHaveTextContent(m.heat_pump_event_unit_both())
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_kind() }))
    .toHaveTextContent('Service')
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_note())).toHaveValue('')
})

// Review Focus 1.
test('defaults to the Stockholm day, not the UTC day', async () => {
  vi.setSystemTime(new Date('2026-10-08T22:30:00Z')) // 00:30 on 9 Oct in Stockholm
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_date())).toHaveValue('2026-10-09')
})

test('save sends both units as null and a blank note as null, toasts and closes', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await save(screen)
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      { occurredOn: '2026-10-08', heatPumpId: null, kind: 'service', note: null },
      expect.anything(),
    ),
  )
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(toastMock.success).toHaveBeenCalledWith(m.heat_pump_event_saved())
})

test('a chosen unit, type and trimmed note are sent', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('2026-10-01')
  await choose(screen, m.heat_pump_event_field_unit(), 'Matsal')
  await choose(screen, m.heat_pump_event_field_kind(), 'Filterrengöring')
  await screen.getByLabelText(m.heat_pump_event_field_note()).fill('  Filter rengjort  ')
  await save(screen)
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      { occurredOn: '2026-10-01', heatPumpId: UNITS[0].id, kind: 'filter', note: 'Filter rengjort' },
      expect.anything(),
    ),
  )
})

test('a future date is refused in the form, without a request', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('2026-10-09')
  await save(screen)
  await expect.element(screen.getByText(m.heat_pump_event_error_future())).toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

test('an empty date asks for one', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('')
  await save(screen)
  await expect.element(screen.getByText(m.heat_pump_event_error_date_required())).toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

// Review Focus 2.
test('a note over 500 characters is refused in the form; 500 with an emoji is fine', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  const note = screen.getByLabelText(m.heat_pump_event_field_note())
  await note.fill('x'.repeat(501))
  await expect.element(screen.getByText(m.heat_pump_event_note_count({ count: '501', max: '500' }))).toBeVisible()
  await save(screen)
  await expect
    .element(screen.getByText(m.heat_pump_event_error_note_too_long({ max: '500' })))
    .toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
  await note.fill(`${'å'.repeat(499)}🙂`)
  await save(screen)
  await vi.waitFor(() => expect(createFn).toHaveBeenCalledOnce())
})

test('editing pre-fills the event and sends its id', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'edit', event: EVENT }))
  await expect.element(screen.getByRole('heading', { name: m.heat_pump_event_dialog_edit_title() })).toBeVisible()
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_date())).toHaveValue('2026-10-08')
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_unit() }))
    .toHaveTextContent('Övervåning')
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_note())).toHaveValue('Filter rengjort')
  await choose(screen, m.heat_pump_event_field_unit(), m.heat_pump_event_unit_both())
  await save(screen)
  await vi.waitFor(() =>
    expect(updateFn).toHaveBeenCalledWith(
      { id: 'e1', occurredOn: '2026-10-08', heatPumpId: null, kind: 'filter', note: 'Filter rengjort' },
      expect.anything(),
    ),
  )
})

test.each(['NOTE_TOO_LONG', 'UNKNOWN_HEAT_PUMP', 'FUTURE_DATE'] as const)(
  'a server %s toasts its message and keeps the dialog open',
  async (code) => {
    createFn.mockRejectedValue(new ORPCError(code, { defined: true }))
    const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
    await save(screen)
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(heatPumpEventErrorMessage(code)))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  },
)

// Review Focus 3.
test('EVENT_NOT_FOUND toasts and closes', async () => {
  updateFn.mockRejectedValue(new ORPCError('EVENT_NOT_FOUND', { defined: true }))
  const { screen } = await renderWithProviders(dialog({ kind: 'edit', event: EVENT }))
  await save(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_error_not_found()),
  )
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
})

test('an unexpected failure toasts the generic message and keeps the dialog open', async () => {
  createFn.mockRejectedValue(new Error('network'))
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await save(screen)
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_save_error()))
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})
```

`src/components/heatPump/DeleteHeatPumpEventDialog.browser.test.tsx`:

```tsx
import { ORPCError } from '@orpc/client'
import { beforeEach, expect, test, vi } from 'vitest'
import { formatDay } from '~/components/evCharging/format'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { DeleteHeatPumpEventDialog } from './DeleteHeatPumpEventDialog'

const { deleteFn, toastMock } = vi.hoisted(() => ({
  deleteFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    heatPump: {
      events: {
        delete: { mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: deleteFn }) },
        key: () => ['heatPump', 'events'],
      },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const UNITS = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]
const EVENT: HeatPumpEventDto = { id: 'e1', occurredOn: '2026-10-08', heatPumpId: null, kind: 'service', note: null }
const onOpenChange = vi.fn()
beforeEach(() => {
  deleteFn.mockReset().mockResolvedValue(undefined)
  for (const f of [onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})

test('names what it deletes; confirming deletes, toasts and closes', async () => {
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  const confirm = screen.getByRole('alertdialog')
  await expect
    .element(
      confirm.getByText(
        m.heat_pump_event_delete_confirm({ kind: 'Service', date: formatDay('2026-10-08'), unit: 'Båda' }),
      ),
    )
    .toBeVisible()
  await confirm.getByRole('button', { name: m.heat_pump_event_delete_action() }).click()
  await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledWith({ id: 'e1' }, expect.anything()))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(m.heat_pump_event_deleted()))
})

test('cancel deletes nothing', async () => {
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.common_cancel() }).click()
  expect(deleteFn).not.toHaveBeenCalled()
})

test('a failed delete toasts why', async () => {
  deleteFn.mockRejectedValue(new ORPCError('EVENT_NOT_FOUND', { defined: true }))
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.heat_pump_event_delete_action() }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_error_not_found()),
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run --project browser src/components/form/TextareaField.browser.test.tsx src/components/heatPump/HeatPumpEventDialog.browser.test.tsx src/components/heatPump/DeleteHeatPumpEventDialog.browser.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `TextareaField.tsx`**

```tsx
import { useStore } from '@tanstack/react-form'
import type { ReactNode } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '~/components/ui/field'
import { Textarea } from '~/components/ui/textarea'
import { useFieldContext } from '~/hooks/form'

type Props = {
  label: string
  /** Hint announced with the textarea (e.g. a live character count). */
  description?: ReactNode
  placeholder?: string
  rows?: number
}

// A multi-line text field. Not registered in hooks/form.ts's fieldComponents: everything there
// ships in every form's chunk (/login's too). Render it inside AppField; it binds through
// useFieldContext, like the phone field.
export function TextareaField({ label, description, placeholder, rows = 3 }: Props) {
  const field = useFieldContext<string>()
  const isSubmitting = useStore(field.form.store, (s) => s.isSubmitting)
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
  const id = field.name
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy =
    [description ? descriptionId : null, isInvalid ? errorId : null].filter(Boolean).join(' ') ||
    undefined
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        name={id}
        rows={rows}
        placeholder={placeholder}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={isInvalid}
        aria-describedby={describedBy}
        disabled={isSubmitting}
      />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      <FieldError id={errorId} errors={field.state.meta.errors} />
    </Field>
  )
}
```

- [ ] **Step 4: Implement `HeatPumpEventDialog.tsx`**

```tsx
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { TextareaField } from '~/components/form/TextareaField'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import {
  HEAT_PUMP_EVENT_KINDS,
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  type HeatPumpEventKind,
  isHeatPumpEventKind,
  normalizeNote,
  noteLength,
} from '~/lib/heatPump/events'
import { orpc } from '~/lib/orpc/client'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import type { HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { isStockholmDay, stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

/** New, or editing one event. */
export type HeatPumpEventDialogMode = { kind: 'new' } | { kind: 'edit'; event: HeatPumpEventDto }

const modeKey = (mode: HeatPumpEventDialogMode) => (mode.kind === 'edit' ? mode.event.id : 'new')
/** The unit select's value for "every unit": a Radix Select item can't have an empty value. */
const ALL_UNITS = 'all'
const MAX = String(HEAT_PUMP_EVENT_NOTE_MAX)

// Built per form (not at module load) so the messages are in the current locale and "today"
// is the day the form opened (Stockholm, as the service checks it).
function makeFormSchema(today: string) {
  return z.object({
    occurredOn: z
      .string()
      .refine(isStockholmDay, { message: m.heat_pump_event_error_date_required() })
      .refine((day) => !isStockholmDay(day) || day <= today, {
        message: m.heat_pump_event_error_future(),
      }),
    unit: z.string(),
    // A string refined (not z.enum): the schema's input type must match the form's string value.
    kind: z.string().refine(isHeatPumpEventKind),
    note: z
      .string()
      .refine((s) => noteLength(s.trim()) <= HEAT_PUMP_EVENT_NOTE_MAX, {
        message: m.heat_pump_event_error_note_too_long({ max: MAX }),
      }),
  })
}

type Props = {
  open: boolean
  mode: HeatPumpEventDialogMode | undefined
  /** Name order; the unit select lists "Båda" / "Alla" first, then these. */
  units: readonly HeatPumpUnitRef[]
  onOpenChange: (open: boolean) => void
}

// Log or edit an event (ADR-0013 URL-state dialog, ADR-0005 form). Stays open until the save
// succeeds; a server error toasts. An event another admin deleted closes it.
export function HeatPumpEventDialog({ open, mode, units, onOpenChange }: Props) {
  // Keep the last mode while the close animation runs (the URL — and so `mode` — clears first).
  const [shown, setShown] = useState(mode)
  if (mode && (!shown || modeKey(mode) !== modeKey(shown))) setShown(mode)
  const current = mode ?? shown
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {current?.kind === 'edit'
              ? m.heat_pump_event_dialog_edit_title()
              : m.heat_pump_event_dialog_new_title()}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.heat_pump_event_dialog_description()}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {current ? (
          // key re-inits the form when another event (or "new") is opened.
          <EventForm key={modeKey(current)} mode={current} units={units} onDone={() => onOpenChange(false)} />
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function defaults(mode: HeatPumpEventDialogMode, today: string) {
  if (mode.kind === 'edit') {
    const e = mode.event
    return { occurredOn: e.occurredOn, unit: e.heatPumpId ?? ALL_UNITS, kind: e.kind as string, note: e.note ?? '' }
  }
  return { occurredOn: today, unit: ALL_UNITS, kind: 'service' as string, note: '' }
}

function EventForm({
  mode,
  units,
  onDone,
}: {
  mode: HeatPumpEventDialogMode
  units: readonly HeatPumpUnitRef[]
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const today = useMemo(() => stockholmDayOf(Date.now()), [])
  const formSchema = useMemo(() => makeFormSchema(today), [today])
  const reportError = (code: HeatPumpEventErrorCode | undefined) => {
    toast.error(code ? heatPumpEventErrorMessage(code) : m.heat_pump_event_save_error())
    // Gone (another admin deleted it): nothing left to edit.
    if (code === 'EVENT_NOT_FOUND') onDone()
  }
  // The list, the chart's markers and (step 4b) the signature all read this one query.
  const onSettled = () => queryClient.invalidateQueries({ queryKey: orpc.heatPump.events.key() })
  const create = useMutation(
    orpc.heatPump.events.create.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )
  const update = useMutation(
    orpc.heatPump.events.update.mutationOptions({
      onError: (err) => reportError(isDefinedError(err) ? err.code : undefined),
      onSettled,
    }),
  )

  const form = useAppForm({
    defaultValues: defaults(mode, today),
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      const input = {
        occurredOn: value.occurredOn,
        heatPumpId: value.unit === ALL_UNITS ? null : value.unit,
        kind: value.kind as HeatPumpEventKind,
        note: normalizeNote(value.note),
      }
      try {
        if (mode.kind === 'edit') await update.mutateAsync({ id: mode.event.id, ...input })
        else await create.mutateAsync(input)
      } catch {
        return // reported by onError
      }
      toast.success(m.heat_pump_event_saved())
      onDone()
    },
  })
  const note = useStore(form.store, (s) => s.values.note)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField
          name="occurredOn"
          children={(field) => <field.DateField label={m.heat_pump_event_field_date()} autoFocus />}
        />
        <form.AppField
          name="unit"
          children={(field) => (
            <field.SelectField
              label={m.heat_pump_event_field_unit()}
              options={[
                { value: ALL_UNITS, label: eventUnitLabel(null, units) },
                ...units.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          )}
        />
        <form.AppField
          name="kind"
          children={(field) => (
            <field.SelectField
              label={m.heat_pump_event_field_kind()}
              options={HEAT_PUMP_EVENT_KINDS.map((k) => ({ value: k, label: eventKindLabel(k) }))}
            />
          )}
        />
        <form.AppField
          name="note"
          children={() => (
            <TextareaField
              label={m.heat_pump_event_field_note()}
              description={m.heat_pump_event_note_count({
                count: String(noteLength(note.trim())),
                max: MAX,
              })}
            />
          )}
        />
      </div>
      <ResponsiveDialogFooter className="mt-6">
        <form.AppForm>
          <form.CancelButton onClick={onDone}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.common_save()} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
```

- [ ] **Step 5: Implement `DeleteHeatPumpEventDialog.tsx`** (the `DeleteTariffDialog` shape):

```tsx
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { formatDay } from '~/components/evCharging/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { orpc } from '~/lib/orpc/client'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

type Props = {
  open: boolean
  event: HeatPumpEventDto | undefined
  units: readonly HeatPumpUnitRef[]
  onOpenChange: (open: boolean) => void
}

// Confirm before deleting an event: it leaves the log and the day chart (and, from step 4b,
// stops splitting the energy signature).
export function DeleteHeatPumpEventDialog({ open, event: target, units, onOpenChange }: Props) {
  const queryClient = useQueryClient()
  // Keep the last target while the close animation runs (the URL clears first).
  const [shown, setShown] = useState(target)
  if (target && target.id !== shown?.id) setShown(target)
  const event = target ?? shown
  const remove = useMutation(
    orpc.heatPump.events.delete.mutationOptions({
      onSuccess: () => toast.success(m.heat_pump_event_deleted()),
      onError: (err) =>
        toast.error(isDefinedError(err) ? heatPumpEventErrorMessage(err.code) : m.heat_pump_event_delete_error()),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.heatPump.events.key() }),
    }),
  )
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {event ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.heat_pump_event_delete_title()}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.heat_pump_event_delete_confirm({
                  kind: eventKindLabel(event.kind),
                  date: formatDay(event.occurredOn),
                  unit: eventUnitLabel(event.heatPumpId, units),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault()
                  // Instant close; the toast and invalidation reconcile after.
                  remove.mutate({ id: event.id })
                  onOpenChange(false)
                }}
              >
                {m.heat_pump_event_delete_action()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 6: Run them to verify they pass**

Run: `bunx vitest run --project browser src/components/form/TextareaField.browser.test.tsx src/components/heatPump/HeatPumpEventDialog.browser.test.tsx src/components/heatPump/DeleteHeatPumpEventDialog.browser.test.tsx test/formHook.test.ts`
Expected: PASS. `bun run typecheck && bun run check`.

- [ ] **Step 7: Commit**

```bash
git add src/components/form/TextareaField.tsx src/components/form/TextareaField.browser.test.tsx \
  src/components/heatPump/HeatPumpEventDialog.tsx src/components/heatPump/HeatPumpEventDialog.browser.test.tsx \
  src/components/heatPump/DeleteHeatPumpEventDialog.tsx src/components/heatPump/DeleteHeatPumpEventDialog.browser.test.tsx
git commit -m "feat(heat-pumps): add the event dialogs" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Reviewers**; fix, commit.

---

### Task 6: Category markers on the shared `BarChart`

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (both:
the prop must be generic — nothing heat-pump-specific in `src/components/chart/` — and charts that don't pass it
must render byte-identically).

**Files:**
- Modify: `src/components/chart/BarChart.tsx`, `src/components/chart/BarChart.browser.test.tsx`

Step 3 already extended `BarChart` (stack groups, outline series, a right-axis line). Apply this task's edits onto
that version: `stackTop` takes every rect at the index (an outline bar beside the stack included), so a mark never
overlaps a bar.

**Interfaces:**
- Produces (exported from `BarChart.tsx`):
```ts
/** A small mark on one category: on top of the stack in a series' colour, or across the whole column. */
export type BarMarker = {
  /** Unique within its category (a React key and the `data-marker` hook). */
  key: string
  /** A series key: the mark is that series' (told by `color`); undefined: across the column (a dashed line too). */
  seriesKey?: string
  color: string
}
// BarChartProps<Row> gains:
/** Marks on a category (logged events); null or [] draws none. Keep its identity across renders. */
markers?: (row: Row, index: number) => readonly BarMarker[] | null
```

- [ ] **Step 1: Write the failing tests** (append to `BarChart.browser.test.tsx`, using its `render` / `base` /
  `bars`):

```tsx
const markerNodes = (root: ParentNode) => [...root.querySelectorAll<SVGGElement>('[data-marker]')]

test('without markers nothing marker-shaped is drawn', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(4))
  expect(screen.container.querySelector('[data-markers]')).toBeNull()
})

test('markers draw per category: a series mark above the stack, an across mark with its line', async () => {
  const { screen } = await render({
    markers: (r) =>
      r.label === 'apr'
        ? [
            { key: 'all', color: 'black' },
            { key: 'a', seriesKey: 'a', color: 'red' },
          ]
        : r.label === 'feb'
          ? [{ key: 'b', seriesKey: 'b', color: 'blue' }]
          : null,
  })
  await vi.waitFor(() => expect(markerNodes(screen.container)).toHaveLength(3))
  const [across, onA] = markerNodes(screen.container).filter((n) => n.dataset.index === '3')
  expect(across.dataset.marker).toBe('all')
  expect(across.querySelector('line')).not.toBeNull()
  expect(onA.querySelector('line')).toBeNull()
  expect(onA.querySelector('path')?.getAttribute('fill')).toBe('red')
  // Above April's stack: the mark's bottom is at or above the top of April's tallest bar.
  const aprilTop = Math.min(
    ...bars(screen.container)
      .filter((b) => b.getAttribute('data-index') === '3')
      .map((b) => b.getBoundingClientRect().top),
  )
  expect(onA.querySelector('path')!.getBoundingClientRect().bottom).toBeLessThanOrEqual(aprilTop + 0.5)
  // A category without bars (feb, null values) still shows its mark, on the baseline.
  expect(markerNodes(screen.container).filter((n) => n.dataset.index === '1')).toHaveLength(1)
})

test('two marks on one category sit side by side', async () => {
  const { screen } = await render({
    markers: (r) =>
      r.label === 'jan'
        ? [
            { key: 'a', seriesKey: 'a', color: 'red' },
            { key: 'b', seriesKey: 'b', color: 'blue' },
          ]
        : null,
  })
  await vi.waitFor(() => expect(markerNodes(screen.container)).toHaveLength(2))
  const [left, right] = markerNodes(screen.container).map((n) =>
    n.querySelector('path')!.getBoundingClientRect(),
  )
  expect(left.right).toBeLessThanOrEqual(right.left)
})

test('marks leave the bars, axes and tooltip as they were', async () => {
  const plain = await render()
  await vi.waitFor(() => expect(bars(plain.screen.container)).toHaveLength(4))
  const heights = bars(plain.screen.container).map(barHeight)
  plain.screen.unmount()
  const marked = await render({ markers: () => [{ key: 'all', color: 'black' }] })
  await vi.waitFor(() => expect(markerNodes(marked.screen.container)).toHaveLength(4))
  // The plot loses only the marks' headroom: every bar keeps its share of the plot.
  const markedHeights = bars(marked.screen.container).map(barHeight)
  expect(markedHeights.map((h) => h / markedHeights[0])).toEqual(heights.map((h) => h / heights[0]))
  expect(xTickLabels(marked.screen.container)).toEqual(['jan', 'feb', 'mar', 'apr'])
})
```

(`barHeight` / `xTickLabels` come from `~test/browser/chartDom`, already imported by the file. If `screen.unmount`
isn't available in this vitest-browser-react version, render the two charts in separate tests and compare ratios
against literals computed from the first run.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx`
Expected: the three marker tests FAIL (no `[data-marker]`); the rest PASS.

- [ ] **Step 3: Implement.** In `BarChart.tsx`:

```ts
export type BarMarker = { key: string; seriesKey?: string; color: string }   // with the doc comments above

const MARKER_W = 8
const MARKER_H = 6
const MARKER_GAP = 2
```

Add `markers?: (row: Row, index: number) => readonly BarMarker[] | null` to `BarChartProps` (doc comment above) and
to the destructured props. Room above the tallest stack:

```ts
  // A label over the tallest bar, and a marker above it, need room above the plot.
  const marginTop =
    (barLabel ? MARGIN.top + tickPx + 6 : MARGIN.top) + (markers ? MARKER_H + MARKER_GAP : 0)
```

After `const at = …`, a shared helper:

```ts
  // The top of a category's stack (its tallest bar), or the baseline when nothing is drawn.
  const stackTop = (i: number) => {
    if (!geometry) return 0
    const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
    return tops.length > 0 ? Math.min(...tops) : geometry.plotH
  }
```

(`stackTop` must be declared after `geometry`; place it right after the `geometry` memo.) In `anchor`, before the
`return`, keep the card off the marks:

```ts
    if ((markers?.(rows[i], i)?.length ?? 0) > 0) tops.push(stackTop(i) - MARKER_GAP - MARKER_H)
```

Draw the marks after the `barLabel` block and before the `line` block:

```tsx
        {markers ? (
          // Visual only (the svg is aria-hidden): the caller's tooltip names what a mark means.
          <g data-markers pointerEvents="none">
            {range(count).flatMap((i) => {
              const list = markers(rows[i], i) ?? []
              if (list.length === 0) return []
              const tip = stackTop(i) - MARKER_GAP
              const step = MARKER_W + MARKER_GAP
              const centre = geometry.centres[i]
              const first = centre - ((list.length - 1) * step) / 2
              return list.map((mk, j) => {
                const cx = first + j * step
                return (
                  <g
                    key={`${i}-${mk.key}`}
                    data-marker={mk.key}
                    data-index={i}
                    data-across={mk.seriesKey === undefined ? true : undefined}
                  >
                    {mk.seriesKey === undefined ? (
                      <line
                        x1={centre}
                        x2={centre}
                        y1={0}
                        y2={geometry.plotH}
                        stroke={mk.color}
                        strokeOpacity={0.6}
                        strokeDasharray="3 3"
                      />
                    ) : null}
                    {/* ▼ pointing at the day's stack. */}
                    <path
                      d={`M${cx - MARKER_W / 2},${tip - MARKER_H} L${cx + MARKER_W / 2},${tip - MARKER_H} L${cx},${tip} Z`}
                      fill={mk.color}
                      stroke="var(--card)"
                      strokeWidth={1}
                    />
                  </g>
                )
              })
            })}
          </g>
        ) : null}
```

`markers` does not enter the `geometry` memo (marks don't change the scales; only `marginTop`, already a dependency,
does).

- [ ] **Step 4: Run them to verify they pass — locally and in UTC**

Run: `bunx vitest run --project browser src/components/chart/` then
`TZ=UTC bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx`
Expected: PASS both. Every other `BarChart` user's tests stay green:
`bunx vitest run --project browser src/components/energy src/components/evCharging src/components/heatPump`.

- [ ] **Step 5: Commit**

```bash
git add src/components/chart/BarChart.tsx src/components/chart/BarChart.browser.test.tsx
git commit -m "feat(chart): add category markers to the bar chart" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Reviewers**; fix, commit.

---

### Task 7: Events on the Värmepumpar page

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (plus:
the member path loads no dialog chunk; the URL cleanup uses `replace`; the shared `energySearchSchema` is untouched).

**Files:**
- Create: `src/components/heatPump/HeatPumpEventLines.tsx`
- Modify: `src/components/heatPump/HeatPumpConsumptionChart.tsx`, `src/components/heatPump/HeatPumpConsumptionChart.browser.test.tsx`
- Modify: `src/components/heatPump/HeatPumpConsumption.tsx`
- Modify: `src/routes/_authenticated/energy/heat-pumps.tsx`, `src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx`
- Modify: `src/components/heatPump/clientSafe.browser.test.tsx`
- Generate: `src/bones/heat-pumps-events.bones.json`

**Interfaces:**
- Consumes: Tasks 1–6; step 3's `HeatPumpConsumptionChart`, `HeatPumpConsumption`, `HeatPumpView` / `HeatPumpChartRow`
  (`row.key`), `heatPumpColor(units, id)` (`~/lib/houseEnergy/heatPumpColors`), `useHeatPumpPeriod` (`h.shown?.units`),
  `energySearchSchema` (`~/components/energy/energySearch`).
- Produces:
  - `HeatPumpEventLines({ markers, units })`
  - `HeatPumpConsumptionChart` and `HeatPumpConsumption` gain `events?: readonly HeatPumpEventDto[]` (default `[]`);
    markers draw only in the day view (`view.kind === 'month'`).
  - The heat-pumps route's search: `energySearchSchema.extend({ dialog?: 'eventNew' | 'eventEdit' | 'eventDelete', eventId?: string })`
    — on this route only; `/energy` and `/energy/battery` never see the dialog keys.

- [ ] **Step 1: Write the failing tests**

Chart (append to `HeatPumpConsumptionChart.browser.test.tsx`; the view is built from step 3's fixtures, September
2026 with readings on days 1–15):

```tsx
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { daysPayload, MATSAL, monthsPayload, OVERVANING } from '~test/fixtures/heatPumpView'
import { heatPumpView } from './heatPumpView'

const september = () =>
  heatPumpView({
    months: monthsPayload(),
    days: daysPayload(2026, 9, 15),
    period: { kind: 'month', year: 2026, month: 9 },
    now: { year: 2026, month: 9 },
    today: '2026-09-15',
  })!
const markerNodes = (root: ParentNode) => [...root.querySelectorAll<SVGGElement>('[data-marker]')]
const event = (over: Partial<HeatPumpEventDto>): HeatPumpEventDto => ({
  id: crypto.randomUUID(),
  occurredOn: '2026-09-10',
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})
const renderChart = (view: ReturnType<typeof september>, events: HeatPumpEventDto[]) =>
  renderWithProviders(
    <div style={{ width: 720 }}>
      <HeatPumpConsumptionChart view={view} onSelectMonth={() => {}} events={events} />
    </div>,
  )

test('events mark their days: a unit event in its colour, a both-units event across', async () => {
  const view = september()
  const { screen } = await renderChart(view, [
    event({ occurredOn: '2026-09-10' }),
    event({ occurredOn: '2026-09-03', heatPumpId: OVERVANING.id, kind: 'filter' }),
  ])
  await vi.waitFor(() => expect(markerNodes(screen.container)).toHaveLength(2))
  const across = markerNodes(screen.container).find((n) => n.dataset.across)
  expect(across?.dataset.marker).toBe('all')
  expect(across?.dataset.index).toBe('9') // the 10th
  const unit = markerNodes(screen.container).find((n) => !n.dataset.across)
  expect(unit?.dataset.index).toBe('2') // the 3rd
  expect(unit?.querySelector('path')?.getAttribute('fill')).toBe(heatPumpColor(view.units, OVERVANING.id))
})

test("a marked day's tooltip names the event; a day without readings still explains its event", async () => {
  const { screen } = await renderChart(september(), [
    event({ occurredOn: '2026-09-10' }),
    event({ occurredOn: '2026-09-20', heatPumpId: MATSAL.id, kind: 'setting' }),
  ])
  await hoverBar(screen.container, 9)
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(m.heat_pump_event_tooltip({ kinds: 'Service', unit: 'Båda' })),
  )
  await hoverBar(screen.container, 19) // the 20th: no readings yet
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(m.heat_pump_event_tooltip({ kinds: 'Inställning', unit: 'Matsal' })),
  )
})

test('the year view draws no markers', async () => {
  const year = heatPumpView({
    months: monthsPayload(),
    days: null,
    period: { kind: 'year', year: 2026 },
    now: { year: 2026, month: 9 },
    today: '2026-09-15',
  })!
  const { screen } = await renderChart(year, [event({ occurredOn: '2026-09-10' })])
  await vi.waitFor(() => expect(screen.container.querySelector('[data-chart-svg]')).not.toBeNull())
  expect(markerNodes(screen.container)).toHaveLength(0)
})
```

(`hoverBar`, `tooltipText`, `m`, `renderWithProviders`, `vi` are already imported by step 3's file; add any that
aren't. If `hoverBar` targets a category with no drawn bar poorly, use `moveAt` over the 20th category's centre.)

Page (`-heatPumpsPage.browser.test.tsx`): give `renderPage` a fourth parameter `{ role = 'user' }: { role?: 'user' | 'admin' } = {}`
and pass `user: { id: 'u1', role }` into the router context (the existing calls keep `user`); then:

```tsx
import { orpc } from '~/lib/orpc/client'

const eventsKey = orpc.heatPump.events.list.queryOptions().queryKey
const SERVICE = { id: 'e1', occurredOn: '2026-09-10', heatPumpId: null, kind: 'service' as const, note: 'Årlig service' }
const seedPage = (events: unknown) => (qc: QueryClient) => {
  seedYear(qc)
  seedSeptember(qc)
  qc.setQueryData(eventsKey, events as never)
}

test('the events card lists the events', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', seedPage([SERVICE]), {}, { role: 'admin' })
  await expect.element(screen.getByRole('heading', { name: m.heat_pump_events_title() })).toBeVisible()
  await expect.element(screen.getByText('Årlig service')).toBeVisible()
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('[data-marker="all"]')).toHaveLength(1),
  )
})

// Review Focus 4.
test('a member sees the list but no controls, and an admin link is cleaned', async () => {
  const { screen, router } = await renderPage('/energy/heat-pumps?dialog=eventNew', seedPage([SERVICE]))
  await expect.element(screen.getByText('Årlig service')).toBeVisible()
  expect(screen.getByRole('button', { name: m.heat_pump_events_add() }).elements()).toHaveLength(0)
  expect(screen.getByRole('button', { name: /^Åtgärder för/ }).elements()).toHaveLength(0)
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('an admin opens "Lägg till" through the URL', async () => {
  const { screen, router } = await renderPage('/energy/heat-pumps', seedPage([SERVICE]), {}, { role: 'admin' })
  await screen.getByRole('button', { name: m.heat_pump_events_add() }).click()
  await expect.element(screen.getByRole('dialog', { name: m.heat_pump_event_dialog_new_title() })).toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'eventNew' })
})

test('an edit deep link opens that event', async () => {
  const { screen } = await renderPage(
    '/energy/heat-pumps?dialog=eventEdit&eventId=e1',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await expect.element(screen.getByRole('dialog', { name: m.heat_pump_event_dialog_edit_title() })).toBeVisible()
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_note())).toHaveValue('Årlig service')
})

// Review Focus 3.
test('a deep link to a deleted event is cleaned', async () => {
  const { router } = await renderPage(
    '/energy/heat-pumps?dialog=eventDelete&eventId=gone',
    seedPage([SERVICE]),
    {},
    { role: 'admin' },
  )
  await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('dialog'))
  expect(router.state.location.search).not.toHaveProperty('eventId')
})

test('events still loading: the card is a skeleton, never "Inga händelser ännu"', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
    void qc.prefetchQuery({ queryKey: eventsKey, queryFn: () => new Promise(() => {}) })
  })
  await vi.waitFor(() =>
    expect(document.querySelector('[data-boneyard="heat-pumps-events"]')).not.toBeNull(),
  )
  expect(screen.getByText(m.heat_pump_events_empty_title()).elements()).toHaveLength(0)
})

test('events failed: the alert, no empty state', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await expect.element(screen.getByText(m.heat_pump_events_error_title())).toBeVisible()
  expect(screen.getByText(m.heat_pump_events_empty_title()).elements()).toHaveLength(0)
})

test('the dialog keys stay on this route: the shared energy schema has none', async () => {
  const { energySearchSchema } = await import('~/components/energy/energySearch')
  expect(energySearchSchema.parse({ dialog: 'eventNew', eventId: 'e1' })).not.toHaveProperty('dialog')
})
```

(The skeleton selector: check what `SectionSkeleton.tsx` renders for `name` / `bones` and match it. If
`energySearchSchema` passes unknown keys through instead of stripping them, assert on `Object.keys(energySearchSchema.shape)`
not containing `dialog`.)

Client-safe guard — append to step 3's `src/components/heatPump/clientSafe.browser.test.tsx`:

```tsx
test('the event vocabulary is importable client-side', async () => {
  const mod = await import('~/lib/heatPump/events')
  expect(typeof mod.dayEventMarkers).toBe('function')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run --project browser src/components/heatPump/HeatPumpConsumptionChart.browser.test.tsx src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx src/components/heatPump/clientSafe.browser.test.tsx`
Expected: the new cases FAIL (no `events` prop, no card, no dialog state).

- [ ] **Step 3: `HeatPumpEventLines.tsx`**

```tsx
import type { DayEventMarker } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel, type HeatPumpUnitRef } from './eventCopy'

// The day tooltip's event lines: "Service · Båda". The chart's marks are visual only (aria-hidden),
// so this is also what the keyboard walk announces.
export function HeatPumpEventLines({
  markers,
  units,
}: {
  markers: readonly DayEventMarker[] | undefined
  units: readonly HeatPumpUnitRef[]
}) {
  if (!markers || markers.length === 0) return null
  return markers.map((mk) => (
    <div key={mk.heatPumpId ?? 'all'} className="flex items-center gap-1.5">
      <span aria-hidden>▼</span>
      <span>
        {m.heat_pump_event_tooltip({
          kinds: mk.kinds.map(eventKindLabel).join(', '),
          unit: eventUnitLabel(mk.heatPumpId, units),
        })}
      </span>
    </div>
  ))
}
```

- [ ] **Step 4: The chart and its wrapper.** In `HeatPumpConsumptionChart.tsx` add the prop
  `events = []` (`events?: readonly HeatPumpEventDto[]`) and, after `series` / `line`:

```tsx
import { useCallback, useMemo } from 'react'
import { type BarMarker } from '~/components/chart/BarChart'
import { dayEventMarkers, type HeatPumpEventDto } from '~/lib/heatPump/events'
import { HeatPumpEventLines } from './HeatPumpEventLines'

  // Events by Stockholm day (string keys: DST- and timezone-proof), only in the day view, where a row's
  // key is its day. One marker per unit per day; colours as the bars'.
  const markerMap = useMemo(
    () =>
      kind === 'month'
        ? dayEventMarkers(events, units.map((u) => u.id))
        : new Map<string, DayEventMarker[]>(),
    [kind, events, units],
  )
  const markers = useCallback(
    (row: HeatPumpChartRow): BarMarker[] =>
      (markerMap.get(row.key) ?? []).map((mk) =>
        mk.heatPumpId === null
          ? { key: 'all', color: 'var(--foreground)' }
          : { key: mk.heatPumpId, seriesKey: mk.heatPumpId, color: heatPumpColor(units, mk.heatPumpId) },
      ),
    [markerMap, units],
  )
```

  (import `DayEventMarker` as a type from `~/lib/heatPump/events` too). Pass `markers={kind === 'month' ? markers : undefined}`
  to `BarChart`, and change its `tooltip` so an event day without readings still shows its lines:

```tsx
        tooltip={(r) => {
          const lines = markerMap.get(r.key)
          if (r.total === null && r.lastYear === null && r.outdoorC === null) {
            return lines ? <HeatPumpEventLines markers={lines} units={units} /> : null
          }
          return (
            <>
              <HeatPumpTooltip row={r} view={view} lastYear={lastYear} />
              <HeatPumpEventLines markers={lines} units={units} />
            </>
          )
        }}
```

  The "no data in this period" placeholder (every row empty) stays as step 3 has it: a month without readings draws
  no chart, so its events show only in the card.

  In `HeatPumpConsumption.tsx`, add `events?: readonly HeatPumpEventDto[]` to its props and pass
  `events={events}` to `HeatPumpConsumptionChart`.

- [ ] **Step 5: The route** (`heat-pumps.tsx`). Merge into step 3's imports and component:

```tsx
import { lazy, useEffect } from 'react'
import { z } from 'zod'
import heatPumpsEventsBones from '~/bones/heat-pumps-events.bones.json'   // after Step 6's capture
import { HeatPumpEvents } from '~/components/heatPump/HeatPumpEvents'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending } from '~/components/layout/LoadErrorAlert'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { orpc } from '~/lib/orpc/client'

// This route's search: the shared period params plus the event dialogs (ADR-0013; admins only). Extended
// here, never in energySearchSchema, so /energy and /energy/battery never carry dialog keys.
const heatPumpsSearchSchema = energySearchSchema.extend({
  dialog: z.enum(['eventNew', 'eventEdit', 'eventDelete']).optional().catch(undefined),
  eventId: z.string().optional().catch(undefined),
})
type HeatPumpsSearch = z.infer<typeof heatPumpsSearchSchema>
type HeatPumpsDialog = NonNullable<HeatPumpsSearch['dialog']>

// Admin-only: loads on first open (LazyDialogMount), so a member never fetches the form code;
// an admin warms the chunks once the browser is idle (useIdlePreload).
const loadEventDialog = () => import('~/components/heatPump/HeatPumpEventDialog')
const HeatPumpEventDialog = lazy(() =>
  loadEventDialog().then((mod) => ({ default: mod.HeatPumpEventDialog })),
)
const loadDeleteEventDialog = () => import('~/components/heatPump/DeleteHeatPumpEventDialog')
const DeleteHeatPumpEventDialog = lazy(() =>
  loadDeleteEventDialog().then((mod) => ({ default: mod.DeleteHeatPumpEventDialog })),
)
const ADMIN_DIALOG_LOADERS = [loadEventDialog, loadDeleteEventDialog]
const eventsQuery = orpc.heatPump.events.list.queryOptions()
```

  In the route options: `validateSearch: heatPumpsSearchSchema`. The loader keeps parsing the period with
  `energySearchSchema.parse(location.search)` (it reads only the period) and adds `deferred: [eventsQuery]` to its
  `loadRouteData` call (the card and the markers aren't first paint; ADR-0025). `Route.useSearch()` now returns
  `HeatPumpsSearch`, a superset of `EnergySearch`, so `useHeatPumpPeriod(Route.useSearch(), writeSearch)` still
  types; if `EnergySearchWrite`'s parameter rejects the wider search, pass
  `Route.useSearch({ select: ({ dialog, eventId, ...period }) => period })` instead (with structural sharing it stays
  stable).

  In `HeatPumpsPage`, beside step 3's `user` / `isAdmin` / `navigate` / `h` bindings:

```tsx
  useIdlePreload(isAdmin, ADMIN_DIALOG_LOADERS)
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const eventId = Route.useSearch({ select: (s) => s.eventId })
  const { isOpen, open, close } = useUrlDialog<HeatPumpsDialog, HeatPumpsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['eventId'],
  })
  // The units in name order (= colour order): the months payload's, present in every period view.
  const units = h.shown?.units
  const eventsResult = useQuery(eventsQuery)
  const events = eventsResult.data
  const selectedEvent = events?.find((e) => e.id === eventId)
  // A dialog that can't show (a member's admin link; an event that no longer exists, judged once
  // the events are known) is cleared from the URL instead of lingering there.
  const dialogUnavailable =
    dialog !== undefined &&
    (!isAdmin || (dialog !== 'eventNew' && events !== undefined && selectedEvent === undefined))
  useEffect(() => {
    // `replace`, so Back doesn't return to the bad URL (and bounce again).
    if (dialogUnavailable) {
      navigate({
        to: '.',
        replace: true,
        resetScroll: false,
        search: (prev) => ({ ...prev, dialog: undefined, eventId: undefined }),
      })
    }
  }, [dialogUnavailable, navigate])
  const eventDialogOpen =
    isAdmin &&
    units !== undefined &&
    (isOpen('eventNew') || (isOpen('eventEdit') && selectedEvent !== undefined))
  const deleteEventOpen = isAdmin && isOpen('eventDelete') && selectedEvent !== undefined
```

  Pass `events={events}` to `<HeatPumpConsumption … />`. In the data branch (not the `HeatPumpEmpty` one), after
  step 3's two `LoadErrorAlert`s:

```tsx
          <LoadErrorAlert title={m.heat_pump_events_error_title()} query={eventsResult} />
          <SectionSkeleton
            bones={heatPumpsEventsBones}
            loading={firstLoadPending(eventsResult) || units === undefined}
            fallbackHeight="12rem"
          >
            {events && units ? (
              <HeatPumpEvents
                events={events}
                units={units}
                admin={
                  isAdmin
                    ? {
                        onNew: () => open('eventNew'),
                        onEdit: (id) => open('eventEdit', { eventId: id }),
                        onDelete: (id) => open('eventDelete', { eventId: id }),
                      }
                    : undefined
                }
              />
            ) : null}
          </SectionSkeleton>
```

  and, at the end of `PageContainer`:

```tsx
      {isAdmin && units ? (
        <>
          <LazyDialogMount open={eventDialogOpen}>
            <HeatPumpEventDialog
              open={eventDialogOpen}
              mode={
                isOpen('eventEdit') && selectedEvent
                  ? { kind: 'edit', event: selectedEvent }
                  : isOpen('eventNew')
                    ? { kind: 'new' }
                    : undefined
              }
              units={units}
              onOpenChange={(o) => {
                if (!o) close()
              }}
            />
          </LazyDialogMount>
          <LazyDialogMount open={deleteEventOpen}>
            <DeleteHeatPumpEventDialog
              open={deleteEventOpen}
              event={selectedEvent}
              units={units}
              onOpenChange={(o) => {
                if (!o) close()
              }}
            />
          </LazyDialogMount>
        </>
      ) : null}
```

  Until Step 6 captures the bones, use `name="heat-pumps-events"` instead of `bones={…}` (and no bones import).

- [ ] **Step 6: Tests, then the skeleton**

Run: `bunx vitest run --project browser src/components/heatPump/ src/routes/_authenticated/energy/`
then `TZ=UTC bunx vitest run --project browser src/components/heatPump/ src/routes/_authenticated/energy/`.
Expected: PASS both (step 3's and the Energi pages' existing tests included).

With the dev stack up and this worktree's dev server on 14611, sign in as the admin, add one event through the dialog
(the skeleton should be the populated card, not the empty state), then:

```bash
BONES_ORIGIN=http://localhost:14611 bun run bones:capture /energy/heat-pumps
```

Switch the card's `SectionSkeleton` to `bones={heatPumpsEventsBones}` (import added above). Run
`bunx vitest run test/sectionSkeletonBones.test.ts` → PASS.

- [ ] **Step 7: Typecheck, lint, commit (two commits)**

```bash
bun run typecheck && bun run check
git add src/components/heatPump/HeatPumpEventLines.tsx src/components/heatPump/HeatPumpConsumptionChart.tsx \
  src/components/heatPump/HeatPumpConsumptionChart.browser.test.tsx src/components/heatPump/HeatPumpConsumption.tsx \
  src/components/heatPump/clientSafe.browser.test.tsx src/routes/_authenticated/energy/heat-pumps.tsx \
  src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx
git commit -m "feat(heat-pumps): show events on the heat pump page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git add src/bones/heat-pumps-events.bones.json src/routes/_authenticated/energy/heat-pumps.tsx
git commit -m "chore(heat-pumps): capture the events card skeleton" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Reviewers**; fix, commit.

---

### Task 8: Branch review, verification, roadmap, PR

- [ ] **Step 1: Branch review (Phase 5), in parallel; every finding fixed in this PR or explicitly ruled on**
  - `migration-guard` **and** the schema-design reviewer over `src/lib/db/schema/heatPump.ts` + the migration
    (Non-negotiable; same brief as Task 1).
  - `test-completeness` over `src/lib/services/heatPump/` (every `HeatPumpDomainError` code exercised).
  - `code-reviewer` (ADR adherence over the whole diff) + a general correctness pass (`/code-review high`).
  - Security pass (`/security-review` or a reviewer loading `better-auth-security-best-practices`): every write is
    `adminProcedure`; `created_by` only from the session; members get no control and no admin chunk; notes never logged.

- [ ] **Step 2: Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`), verbatim:

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

  Plus: `TZ=UTC bunx vitest run --project browser src/components/chart src/components/heatPump src/routes/_authenticated/energy`
  (CI's timezone), and `bun run bundle:measure`: the `/energy/heat-pumps` line must not include the dialog chunks
  (they load on open), and the `entry:` and `/login` lines are unchanged against ADR-0025 §6's reference (the
  `TextareaField` is not in `hooks/form.ts`).

- [ ] **Step 3: Live (Phase 6)** at 1440, 820 and 390 px, light and dark, locally (Playwright + Mailpit magic link on
  14611 if the Chrome extension is unavailable), with synthetic local readings:
  - As admin: add an event (desktop dialog; a bottom sheet at 390 px), edit it, delete it (confirmation); toasts; the
    list newest first; the menu's 44 px target on touch; a long note wraps without widening the page.
  - The month view's day chart: a both-units event draws the dashed line + ▼; a unit event its colour; the tooltip's
    event line; the keyboard walk announces it.
  - As a member (a second local account): the list, no add button, no row menu; `?dialog=eventNew` is cleaned.
  - No layout shift when the period changes (the card sits below the chart).

- [ ] **Step 4: Docs.**
  - Roadmap row 4a in `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`: PR link and status `PR open`.
  - `CLAUDE.md` code map: in the `db/` line's schema list, `heatPump.ts` names its tables
    `(heat_pump, heat_pump_reading, heat_pump_event)`; in the `lib/heatPump/` entry, add
    "`events.ts`: client-safe event vocabulary (kinds, DTO, note rule, day markers; imported by the schema, so
    dependency-free)".
  - No spec amendment: the ▼ marker and "Båda" / "Alla" are already in the spec (decisions 5 and 9 reference it).

```bash
git add docs/superpowers/roadmaps/2026-10-08-heat-pumps.md CLAUDE.md
git commit -m "docs(heat-pumps): mark step 4a PR open, map the events" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the PR** with `.github/PULL_REQUEST_TEMPLATE.md`: title
  `feat(heat-pumps): log events and mark them on the day chart`; *why* + links to ADR-0027 and the spec; the
  checklist ticked with the Step 2 output; under "Notes for the reviewer" the plan's 12 decisions and Task 0's
  step-3 names table. Body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 6: After merge — checkpoint 5 (prod), run by the next session, not this one**
  1. Once the production deploy is green (the migration ran in `vercel-build`), the owner signs in as admin on
     `/energy/heat-pumps` and enters the **service on 2026-10-08, both units** (Typ *Service*, Värmepump *Båda*, a
     note such as "Årlig service; enheterna på max före, avstängda under servicen").
  2. Switch the period to October 2026: the day chart shows the dashed line and ▼ on 8 October; the tooltip reads
     "Service · Båda".
  3. Read-only prod check (allowed): `SELECT occurred_on, heat_pump_id, kind, created_by IS NOT NULL AS has_author FROM heat_pump_event;`
     → one row `2026-10-08`, `null`, `service`, `true`.
  4. A non-admin account opens the page: sees the event, no add/edit/delete; `?dialog=eventNew` does nothing.
  5. Record the result in the roadmap's row 4a ("checkpoint passed" + date) in a small `docs(heat-pumps): …` PR
     (or step 4b's PR if the owner says so).
