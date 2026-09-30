# EV charging Phase 3 — when we charge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `/charging/patterns` page showing when we charge: weekday × hour heatmap, hour-of-day
histogram, a year calendar of daily kWh, and a per-session plug-in → charging → plug-out timeline.

**Architecture:** Narrow Drizzle fetch of counted sessions + intervals → a pure, client-safe aggregation module
(`src/lib/evCharging/patterns/`, built on `d3-time` / `d3-array` / `@date-fns/tz`) → two `protectedProcedure`
reads → React views drawn with **visx** (d3-based primitives) and, for the histogram, Recharts like `MonthlyChart`.

**Tech stack:** TanStack Start + Router, oRPC + TanStack Query, Drizzle (node-postgres), Vitest (node + browser),
d3-time / d3-array / d3-scale, `@date-fns/tz`, `@visx/{heatmap,axis,shape,group,responsive,tooltip}` 4.0, Recharts 3
via shadcn `ChartContainer`, Paraglide.

**Spec (binding):** `docs/superpowers/specs/2026-09-30-ev-charging-phase3-design.md`.
Visual reference: the local mockup `.superpowers/brainstorm/22167-1790758957/content/patterns-page.html` (not committed).

### Delivery

| PR | Branch | Title | Tasks |
|---|---|---|---|
| A | `refactor/charging-route-dir` | `refactor(charging): move the charging page under charging/` | A1 |
| B | `feat/charging-pattern-read-models` | `feat(charging): add charging pattern and timeline read models` | B1–B5 |
| C | `feat/charging-patterns-page` | `feat(charging): show when we charge on /charging/patterns` | C1–C6 |

The spec commit (`docs/charging-phase3-design`, 1 commit) rides in PR A. Each PR branches off `main` after the
previous one is squash-merged (or stacks with `git rebase --onto` if reviewing ahead). Work in a git worktree per PR
(`superpowers:using-git-worktrees`).

### Deviations from the spec (decided while mapping seams — flag in PR B's description)

1. **Daily/monthly kWh bucket each interval whole by its own `start_at` Stockholm day/month**, not split pro rata.
   That is exactly the overview's rule (`monthlyTotals` in `services/evCharging/overview.ts`), so the spec's
   "calendar months == overview months" invariant holds by construction. Intervals are hour-aligned and Stockholm
   midnight is on the hour, so in practice nothing crosses a day. The **hourly** views still split pro rata.
2. **Peak kW uses intervals ≥ 10 min**, the same rule as `listSessions`' `peakKw` (the session list's "Topp kW"),
   not "≥ 50 min". One definition of peak across the page pair; the constant moves to client-safe `counting.ts`.

## Global constraints

- CLAUDE.md non-negotiables: all DB access in `src/lib/services/`; reads are `protectedProcedure`; logging via
  `~/lib/logger` only (never `console.*`); every screen responsive; user-facing text via Paraglide (sv source of
  truth, en key-complete); route paths English (`/charging/patterns`); components PascalCase in
  `src/components/evCharging/`; `src/components/ui/` untouched except via `bunx shadcn@latest add`.
- **Client code may only `import type` from services.** `src/lib/evCharging/patterns/` imports no `db`/services/
  effects — guarded by `clientSafe.browser.test.tsx`.
- **No schema change, no migration.** If a task seems to need one, stop and ask.
- **Reuse before hand-rolling (owner's explicit instruction for this phase: lean on d3 and its ecosystem):**
  - time splitting: `d3-time` `utcHour` (Stockholm's UTC offset is always a whole number of hours, so Stockholm hour
    boundaries are UTC hour boundaries — DST-safe splitting in absolute time); local labels via `date-fns`
    getters with `{ in: tz('Europe/Stockholm') }` / the helpers in `src/lib/time/stockholm.ts`;
  - aggregation: `d3-array` (`rollup`, `sum`, `max`, `group`, `range`, `transpose`);
  - scales: `d3-scale` (`scaleSqrt`, `scaleBand`, `scaleLinear`);
  - drawing: `@visx/heatmap` (heatmap + calendar cells), `@visx/axis` + `@visx/shape` + `@visx/group` (timeline),
    `@visx/responsive` `useParentSize` (width), `@visx/tooltip` `useTooltip` + `TooltipWithBounds` (tooltips);
    the histogram stays Recharts through `~/components/ui/chart` like `MonthlyChart`.
  - Hand-rolled only: the colour mapping value → CSS `color-mix(in oklch, var(--brand) p%, var(--card))`
    (d3-color can't read CSS custom properties or oklch; this keeps light/dark theming from the tokens).
- SVG fills that use CSS variables go in `style={{ fill }}` — presentation attributes (`fill="var(--x)"`) don't
  resolve `var()`.
- No polling (`refetchInterval`) — focus refetch + `useSyncNow` (it invalidates `orpc.evCharging.key()`) (ADR-0018).
- Heavier RPCs record `context.timings` sub-timings.
- Commits: Conventional Commits ≤ 72 chars, imperative, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Per-task loop:** implement (TDD for B*) → `bun run check` + the task's tests → commit → two skeptical reviewers
  in parallel (pairs named per task, told to *assume the task is wrong and off-spec*) → fix or rule on each finding
  → next task. Never collapse into one autonomous run.
- Pre-PR gate before each PR: `docs/feature-workflow.md#pre-pr-gate` (check, check:ci, build, db:up+migrate, test,
  sv/en key diff).

## Review Focus

Inputs the spec implies that a person will hit and that are easy to get wrong — each is pinned by a test in the
named task:

1. **DST nights** — the fall-back night has two `02` hours, spring-forward has none; an overnight session on those
   nights must neither lose nor double an hour of plugged-in time (B1, B2).
2. **Sessions that don't fit a 12:00 → 12:00 row** — plugged in before noon and out after noon, or plugged in > 24 h:
   clipped with chevrons, label still shows real times, never a negative/overflowing bar (B3 origin, C5).
3. **New Year spill-over** — a session plugged in 31 Dec evening: its January intervals show in next year's
   heatmap/calendar, its session count stays in the old year, and the new year appears in `years` (B4).
4. **Degenerate interval data** — all-zero intervals on a counted session, only sub-10-minute intervals, intervals
   poking outside the session window (clock quirks): segments stay contiguous, inside the window, never NaN (B3).
5. **URL state with no data** — `?month=` naming a month without sessions, a year with nothing at all, garbage
   `?metric=`: an empty state (stepper kept), not a crash or a blank card (C1 search schema, C6).

---

## PR A — move the charging page (behavior-preserving)

### Task A1: `charging.tsx` → `charging/index.tsx`

**Reviewers:** `code-reviewer` + a reviewer loading `vercel-react-best-practices` (route/UI pairing).

**Files:**
- Move: `src/routes/_authenticated/charging.tsx` → `src/routes/_authenticated/charging/index.tsx`
- Regenerated: `src/routeTree.gen.ts` (never hand-edited)
- Modify: `src/lib/evCharging/clientSafe.browser.test.tsx` (import path)

**Interfaces:** Produces route id `'/_authenticated/charging/'`; `to: '/charging'` keeps working (the router maps
the index route to `/charging`, as `/account` → `account/index.tsx` already does).

- [ ] **Step 1: Branch + bring the spec commit**

```bash
git switch main && git pull --ff-only
git switch -c refactor/charging-route-dir
git cherry-pick docs/charging-phase3-design   # the spec commit 0c041d5
```

- [ ] **Step 2: Move the file and fix its route id**

```bash
mkdir -p src/routes/_authenticated/charging
git mv src/routes/_authenticated/charging.tsx src/routes/_authenticated/charging/index.tsx
```

In `charging/index.tsx` change the one line:

```ts
export const Route = createFileRoute('/_authenticated/charging/')({
```

- [ ] **Step 3: Update the client-safe guard's import**

In `src/lib/evCharging/clientSafe.browser.test.tsx`:

```ts
test('the /charging route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/charging/index')
  expect(mod.Route).toBeDefined()
})
```

- [ ] **Step 4: Regenerate + verify nothing else referenced the old id**

Run: `bun run build` (regenerates `routeTree.gen.ts`, runs `tsc --noEmit`).
Expected: success. Then `grep -rn "'/_authenticated/charging'" src test` → only `routeTree.gen.ts` hits for
`/charging/` ids, none elsewhere.

- [ ] **Step 5: Tests**

Run: `bunx vitest run --project browser src/lib/evCharging src/components/evCharging` and
`bun run test:node -- src/lib/orpc/procedures/evCharging.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 6: Commit**

```bash
git add -A src/routes src/routeTree.gen.ts src/lib/evCharging/clientSafe.browser.test.tsx
git commit -m "refactor(charging): move the charging page under charging/"
```

- [ ] **Step 7: Live smoke** — `bun run dev`, open `/charging`: page renders as before; sidebar item active.

---

## PR B — read models (no UI caller yet)

### Task B1: Stockholm hour pieces

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `package.json` (deps)
- Modify: `src/lib/time/stockholm.ts` (+ `stockholmMonthBounds`, `stockholmNoonOnOrBefore`)
- Create: `src/lib/evCharging/patterns/pieces.ts`
- Test: `src/lib/evCharging/patterns/pieces.test.ts`, `src/lib/time/stockholm.test.ts` (extend if it exists, else create)

**Interfaces — Produces:**
```ts
// src/lib/time/stockholm.ts
export function stockholmMonthBounds(year: number, month: number): { startMs: number; endMs: number } // month 1–12
export function stockholmNoonOnOrBefore(ms: number): { startMs: number; endMs: number } // [noon, next local noon)
// src/lib/evCharging/patterns/pieces.ts
export const HOUR_MS = 3_600_000
export type HourPiece = { startMs: number; endMs: number; weekday: number /* 0 = Mon … 6 = Sun */; hour: number; day: string }
export function splitByStockholmHour(startMs: number, endMs: number): HourPiece[]
```

- [ ] **Step 1: Add dependencies**

```bash
bun add d3-time@3.1.0 @visx/heatmap@4.0.0 @visx/axis@4.0.0 @visx/shape@4.0.0 @visx/group@4.0.0 @visx/responsive@4.0.0 @visx/tooltip@4.0.0
bun add -d @types/d3-time@3.0.4
```
(`d3-time` is already present transitively via `d3-scale`; pin it explicitly since we import it. visx is added now
so PR B's lockfile carries all new deps once; nothing imports visx until PR C.) Pin exact versions like the existing
`d3-*` entries.

- [ ] **Step 2: Write the failing tests**

`src/lib/evCharging/patterns/pieces.test.ts`:

```ts
import { expect, test } from 'vitest'
import { HOUR_MS, splitByStockholmHour } from './pieces'

const t = (iso: string) => Date.parse(iso)

test('an hour-aligned span yields one piece per Stockholm hour with local labels', () => {
  // 2026-09-27 is a Sunday; 19:30Z = 21:30 CEST.
  const pieces = splitByStockholmHour(t('2026-09-27T19:30:00Z'), t('2026-09-27T22:00:00Z'))
  expect(pieces.map((p) => [p.hour, p.weekday, p.day, (p.endMs - p.startMs) / HOUR_MS])).toEqual([
    [21, 6, '2026-09-27', 0.5],
    [22, 6, '2026-09-27', 1],
    [23, 6, '2026-09-27', 1],
  ])
})

test('a span crossing Stockholm midnight changes day and weekday', () => {
  const pieces = splitByStockholmHour(t('2026-09-27T21:00:00Z'), t('2026-09-27T23:00:00Z'))
  expect(pieces.map((p) => [p.day, p.weekday, p.hour])).toEqual([
    ['2026-09-27', 6, 23],
    ['2026-09-28', 0, 0],
  ])
})

test('fall-back night: two pieces are labelled hour 2, none is lost', () => {
  // 2026-10-25: 03:00 CEST → 02:00 CET. 00:00Z = 02:00 CEST, 01:00Z = 02:00 CET.
  const pieces = splitByStockholmHour(t('2026-10-24T23:00:00Z'), t('2026-10-25T02:00:00Z'))
  expect(pieces.map((p) => p.hour)).toEqual([1, 2, 2])
  expect(pieces.reduce((ms, p) => ms + p.endMs - p.startMs, 0)).toBe(3 * HOUR_MS)
})

test('spring-forward night: there is no hour 2', () => {
  // 2026-03-29: 02:00 CET → 03:00 CEST. 00:00Z = 01:00 CET, 01:00Z = 03:00 CEST.
  const pieces = splitByStockholmHour(t('2026-03-29T00:00:00Z'), t('2026-03-29T02:00:00Z'))
  expect(pieces.map((p) => p.hour)).toEqual([1, 3])
})

test('an empty or inverted span yields no pieces', () => {
  expect(splitByStockholmHour(1000, 1000)).toEqual([])
  expect(splitByStockholmHour(2000, 1000)).toEqual([])
})

test('pieces are contiguous and cover the span exactly', () => {
  const start = t('2026-09-27T19:12:34Z')
  const end = t('2026-09-28T05:47:00Z')
  const pieces = splitByStockholmHour(start, end)
  expect(pieces[0].startMs).toBe(start)
  expect(pieces.at(-1)?.endMs).toBe(end)
  for (let i = 1; i < pieces.length; i++) expect(pieces[i].startMs).toBe(pieces[i - 1].endMs)
})
```

Extend `src/lib/time/stockholm.test.ts` (create with this content if absent):

```ts
import { expect, test } from 'vitest'
import { stockholmMonthBounds, stockholmNoonOnOrBefore } from './stockholm'

test('stockholmMonthBounds spans local midnight to local midnight', () => {
  expect(stockholmMonthBounds(2026, 3)).toEqual({
    startMs: Date.parse('2026-02-28T23:00:00Z'), // 1 Mar 00:00 CET
    endMs: Date.parse('2026-03-31T22:00:00Z'), // 1 Apr 00:00 CEST
  })
  expect(stockholmMonthBounds(2026, 12).endMs).toBe(Date.parse('2026-12-31T23:00:00Z'))
})

test('stockholmNoonOnOrBefore picks the same day after noon, the previous day before', () => {
  expect(stockholmNoonOnOrBefore(Date.parse('2026-09-27T19:00:00Z'))).toEqual({
    startMs: Date.parse('2026-09-27T10:00:00Z'),
    endMs: Date.parse('2026-09-28T10:00:00Z'),
  })
  expect(stockholmNoonOnOrBefore(Date.parse('2026-09-28T05:00:00Z')).startMs).toBe(
    Date.parse('2026-09-27T10:00:00Z'),
  )
})

test('a noon-to-noon row over the fall-back night is 25 hours', () => {
  const { startMs, endMs } = stockholmNoonOnOrBefore(Date.parse('2026-10-24T18:00:00Z'))
  expect((endMs - startMs) / 3_600_000).toBe(25)
})
```

- [ ] **Step 3: Run to see them fail**

Run: `bunx vitest run src/lib/evCharging/patterns/pieces.test.ts src/lib/time/stockholm.test.ts`
Expected: FAIL — module / exports not found.

- [ ] **Step 4: Implement**

Append to `src/lib/time/stockholm.ts`:

```ts
/** `[startMs, endMs)` of Stockholm calendar month `month` (1–12) of `year`. */
export function stockholmMonthBounds(year: number, month: number): { startMs: number; endMs: number } {
  return {
    startMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year, month - 1, 1).getTime(),
    endMs: TZDate.tz(STOCKHOLM_TIME_ZONE, year, month, 1).getTime(),
  }
}

/**
 * The Stockholm noon-to-noon window containing the instant: from 12:00 on its
 * day (the previous day if it is before 12:00) to 12:00 the next day — 23, 24
 * or 25 h over a DST night. The session timeline's row axis.
 */
export function stockholmNoonOnOrBefore(ms: number): { startMs: number; endMs: number } {
  const day = toDay(ms)
  const noonOf = (d: string) => {
    const midnight = midnightOf(d)
    return TZDate.tz(
      STOCKHOLM_TIME_ZONE,
      midnight.getFullYear(),
      midnight.getMonth(),
      midnight.getDate(),
      12,
    ).getTime()
  }
  const start = ms >= noonOf(day) ? day : addDays(day, -1)
  return { startMs: noonOf(start), endMs: noonOf(addDays(start, 1)) }
}
```

Create `src/lib/evCharging/patterns/pieces.ts`:

```ts
// Client-safe. Splits a span into Stockholm clock hours. Stockholm's UTC
// offset has been a whole number of hours since 1900, so its hour boundaries
// are UTC hour boundaries: splitting in absolute time with d3-time's utcHour
// is DST-safe by construction (the fall-back night simply yields two pieces
// labelled 02, spring-forward none). Local labels come from date-fns in the
// Stockholm zone — no offset arithmetic here.
import { tz } from '@date-fns/tz'
import { utcHour } from 'd3-time'
import { getHours, getISODay } from 'date-fns'
import { STOCKHOLM_TIME_ZONE, stockholmDayOf } from '~/lib/time/stockholm'

export const HOUR_MS = 3_600_000
const inStockholm = tz(STOCKHOLM_TIME_ZONE)

export type HourPiece = {
  startMs: number
  endMs: number
  /** ISO weekday − 1: 0 = Monday … 6 = Sunday (Stockholm). */
  weekday: number
  /** Stockholm clock hour 0–23 the piece starts in. */
  hour: number
  /** Stockholm 'YYYY-MM-DD' the piece starts in. */
  day: string
}

export function splitByStockholmHour(startMs: number, endMs: number): HourPiece[] {
  if (!(endMs > startMs)) return []
  // Every hour boundary strictly inside the span, plus the span's own ends.
  const inner = utcHour
    .range(new Date(startMs), new Date(endMs))
    .map((d) => d.getTime())
    .filter((ms) => ms > startMs)
  const edges = [startMs, ...inner, endMs]
  const pieces: HourPiece[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const at = edges[i]
    pieces.push({
      startMs: at,
      endMs: edges[i + 1],
      weekday: getISODay(at, { in: inStockholm }) - 1,
      hour: getHours(at, { in: inStockholm }),
      day: stockholmDayOf(at),
    })
  }
  return pieces
}
```

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run src/lib/evCharging/patterns/pieces.test.ts src/lib/time/stockholm.test.ts`
Expected: PASS.

- [ ] **Step 6: Check + commit**

```bash
bun run check
git add package.json bun.lock src/lib/time/stockholm.ts src/lib/time/stockholm.test.ts src/lib/evCharging/patterns/pieces.ts src/lib/evCharging/patterns/pieces.test.ts
git commit -m "feat(charging): split spans into Stockholm clock hours"
```

### Task B2: `buildPatterns` (heatmap, histogram, calendar aggregates)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/evCharging/patterns/types.ts`, `src/lib/evCharging/patterns/patterns.ts`, `src/lib/evCharging/patterns/index.ts`
- Test: `src/lib/evCharging/patterns/patterns.test.ts`

**Interfaces:**
- Consumes: `splitByStockholmHour`, `HOUR_MS` (B1); `stockholmYearBounds`, `stockholmDayOf`, `stockholmYearMonth` (`src/lib/time/stockholm.ts`).
- Produces:
```ts
// types.ts
export type PatternInterval = { startAt: Date; endAt: Date; energyKwh: number }
export type PatternSession = { id: string; startAt: Date; endAt: Date; energyKwh: number; intervals: PatternInterval[] }
export type Slot = { kwh: number; pluggedHours: number }
export type DayTotal = { day: string; kwh: number; sessions: number }
export type MonthTotal = { month: number; kwh: number; sessions: number }
export type PatternAggregates = {
  weekdayHour: Slot[][] // [7][24], Monday first
  hourOfDay: Slot[]     // [24]
  daily: DayTotal[]     // ascending by day; only days with kWh > 0 or a session start
  months: MonthTotal[]  // 12 rows, month 1–12
  unhourlySessions: number
}
export type ChargingPatterns = PatternAggregates & { year: number; years: number[] }
// patterns.ts
export function buildPatterns(sessions: PatternSession[], year: number): PatternAggregates
```

Rules (from the spec + deviation 1):
- **Hourly kWh:** each interval split by `splitByStockholmHour`, kWh pro rata by time; keep pieces whose `startMs`
  is inside the Stockholm year.
- **Plugged hours:** the *session window* split the same way (covers interval-less sessions and idle hours); keep
  pieces inside the year.
- **Daily / monthly kWh:** each interval whole, by its own `startAt` Stockholm day/month, if that `startAt` is in the
  year (the overview's rule). Interval-less session: its `energyKwh` on its `startAt` day, if in the year.
- **Session counts:** by the session's own `startAt` day/month, if in the year.
- **`unhourlySessions`:** sessions with no intervals whose `startAt` is in the year.

- [ ] **Step 1: Write the failing tests** — `src/lib/evCharging/patterns/patterns.test.ts`:

```ts
import { expect, test } from 'vitest'
import { buildPatterns } from './patterns'
import type { PatternSession } from './types'

const d = (iso: string) => new Date(iso)
let n = 0
function session(
  startIso: string,
  endIso: string,
  intervals: [string, string, number][],
  energyKwh = intervals.reduce((s, [, , k]) => s + k, 0),
): PatternSession {
  n += 1
  return {
    id: `s${n}`,
    startAt: d(startIso),
    endAt: d(endIso),
    energyKwh,
    intervals: intervals.map(([a, b, k]) => ({ startAt: d(a), endAt: d(b), energyKwh: k })),
  }
}

test('returns full zero grids for no sessions', () => {
  const p = buildPatterns([], 2026)
  expect(p.weekdayHour).toHaveLength(7)
  expect(p.weekdayHour.every((row) => row.length === 24)).toBe(true)
  expect(p.hourOfDay).toHaveLength(24)
  expect(p.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(p.daily).toEqual([])
  expect(p.unhourlySessions).toBe(0)
})

test('kWh lands in the Stockholm weekday × hour of each interval; idle hours count as plugged', () => {
  // Sun 2026-09-27 21:30–00:00 CEST plugged; charges 21:30–23:00, idle 23:00–00:00.
  const s = session('2026-09-27T19:30:00Z', '2026-09-27T22:00:00Z', [
    ['2026-09-27T19:30:00Z', '2026-09-27T20:00:00Z', 5.5],
    ['2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11],
    ['2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 0],
  ])
  const p = buildPatterns([s], 2026)
  const sun = p.weekdayHour[6]
  expect(sun[21]).toEqual({ kwh: 5.5, pluggedHours: 0.5 })
  expect(sun[22]).toEqual({ kwh: 11, pluggedHours: 1 })
  expect(sun[23]).toEqual({ kwh: 0, pluggedHours: 1 })
  expect(p.hourOfDay[22]).toEqual({ kwh: 11, pluggedHours: 1 })
})

test('an interval that is not hour-aligned is split pro rata across the hours it spans', () => {
  // Offline-session quirk: one 2 h interval 21:30–23:30 CEST with 10 kWh.
  const s = session('2026-09-27T19:30:00Z', '2026-09-27T21:30:00Z', [
    ['2026-09-27T19:30:00Z', '2026-09-27T21:30:00Z', 10],
  ])
  const sun = buildPatterns([s], 2026).weekdayHour[6]
  expect(sun[21].kwh).toBeCloseTo(2.5)
  expect(sun[22].kwh).toBeCloseTo(5)
  expect(sun[23].kwh).toBeCloseTo(2.5)
})

test('an overnight session splits daily kWh by interval start day and counts once, on its start day', () => {
  const s = session('2026-09-27T20:00:00Z', '2026-09-28T00:00:00Z', [
    ['2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11], // 22–23 on the 27th
    ['2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 11], // 23–00 on the 27th
    ['2026-09-27T22:00:00Z', '2026-09-27T23:00:00Z', 7], // 00–01 on the 28th
    ['2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', 0],
  ])
  const p = buildPatterns([s], 2026)
  expect(p.daily).toEqual([
    { day: '2026-09-27', kwh: 22, sessions: 1 },
    { day: '2026-09-28', kwh: 7, sessions: 0 },
  ])
  expect(p.months[8]).toEqual({ month: 9, kwh: 29, sessions: 1 })
})

test('fall-back night: plugged hours are neither lost nor doubled', () => {
  // Plugged 2026-10-24T22:00Z–2026-10-25T03:00Z = 5 real hours (00–04 local with 02 twice).
  const s = session('2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', [
    ['2026-10-24T22:00:00Z', '2026-10-25T03:00:00Z', 20],
  ])
  const p = buildPatterns([s], 2026)
  const total = p.hourOfDay.reduce((h, slot) => h + slot.pluggedHours, 0)
  expect(total).toBeCloseTo(5)
  expect(p.hourOfDay[2].pluggedHours).toBeCloseTo(2) // both 02 hours
  expect(p.hourOfDay.reduce((k, slot) => k + slot.kwh, 0)).toBeCloseTo(20)
})

test('an interval-less session counts plugged hours and daily kWh but no hourly kWh', () => {
  const s = session('2026-09-27T19:00:00Z', '2026-09-27T21:00:00Z', [], 12)
  const p = buildPatterns([s], 2026)
  expect(p.unhourlySessions).toBe(1)
  expect(p.hourOfDay.reduce((k, slot) => k + slot.kwh, 0)).toBe(0)
  expect(p.hourOfDay[21].pluggedHours).toBe(1)
  expect(p.hourOfDay[22].pluggedHours).toBe(1)
  expect(p.daily).toEqual([{ day: '2026-09-27', kwh: 12, sessions: 1 }])
})

test('New Year: January hours of a 31 Dec session belong to the new year, its count to the old', () => {
  // Plugged 31 Dec 22:00 CET → 1 Jan 02:00 CET.
  const s = session('2025-12-31T21:00:00Z', '2026-01-01T01:00:00Z', [
    ['2025-12-31T21:00:00Z', '2025-12-31T22:00:00Z', 11],
    ['2025-12-31T22:00:00Z', '2025-12-31T23:00:00Z', 11],
    ['2025-12-31T23:00:00Z', '2026-01-01T00:00:00Z', 11],
    ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 0],
  ])
  const old = buildPatterns([s], 2025)
  const next = buildPatterns([s], 2026)
  expect(old.months[11]).toEqual({ month: 12, kwh: 22, sessions: 1 })
  expect(next.months[0]).toEqual({ month: 1, kwh: 11, sessions: 0 })
  expect(next.hourOfDay[1].pluggedHours).toBe(1)
  expect(next.hourOfDay[0].kwh).toBe(11)
  expect(old.hourOfDay[0].kwh).toBe(0)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bunx vitest run src/lib/evCharging/patterns/patterns.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

`src/lib/evCharging/patterns/types.ts` — the types from **Interfaces** above, verbatim, each with a one-line doc
comment.

`src/lib/evCharging/patterns/patterns.ts`:

```ts
// Client-safe: when-we-charge aggregates for one Stockholm year, from counted
// sessions and their intervals. Hourly views split pro rata by time; daily and
// monthly kWh bucket each interval whole by its own start (the overview's
// rule, so the calendar and /charging's monthly chart can never disagree).
import { range, rollup, sum } from 'd3-array'
import { stockholmDayOf, stockholmYearBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { HOUR_MS, type HourPiece, splitByStockholmHour } from './pieces'
import type { DayTotal, MonthTotal, PatternAggregates, PatternSession, Slot } from './types'

type HourContribution = { weekday: number; hour: number; kwh: number; plugged: number }
type DayContribution = { day: string; month: number; kwh: number; sessions: number }

export function buildPatterns(sessions: PatternSession[], year: number): PatternAggregates {
  const { startMs, endMs } = stockholmYearBounds(year)
  const inYear = (ms: number) => ms >= startMs && ms < endMs
  const hours: HourContribution[] = []
  const days: DayContribution[] = []
  const dayContribution = (ms: number, kwh: number, count: number) =>
    days.push({ day: stockholmDayOf(ms), month: stockholmYearMonth(ms).month, kwh, sessions: count })
  const hourContribution = (p: HourPiece, kwh: number, plugged: number) =>
    hours.push({ weekday: p.weekday, hour: p.hour, kwh, plugged })
  let unhourlySessions = 0

  for (const s of sessions) {
    const sessionStart = s.startAt.getTime()
    for (const p of splitByStockholmHour(sessionStart, s.endAt.getTime())) {
      if (inYear(p.startMs)) hourContribution(p, 0, (p.endMs - p.startMs) / HOUR_MS)
    }
    if (inYear(sessionStart)) dayContribution(sessionStart, 0, 1)

    if (s.intervals.length === 0) {
      if (inYear(sessionStart)) {
        unhourlySessions += 1
        dayContribution(sessionStart, s.energyKwh, 0)
      }
      continue
    }
    for (const i of s.intervals) {
      const a = i.startAt.getTime()
      const b = i.endAt.getTime()
      if (inYear(a)) dayContribution(a, i.energyKwh, 0)
      for (const p of splitByStockholmHour(a, b)) {
        if (inYear(p.startMs)) hourContribution(p, (i.energyKwh * (p.endMs - p.startMs)) / (b - a), 0)
      }
    }
  }

  const slotOf = (rows: HourContribution[] | undefined): Slot => ({
    kwh: sum(rows ?? [], (r) => r.kwh),
    pluggedHours: sum(rows ?? [], (r) => r.plugged),
  })
  const byWeekdayHour = rollup(hours, (rows) => rows, (r) => r.weekday, (r) => r.hour)
  const weekdayHour = range(7).map((w) => range(24).map((h) => slotOf(byWeekdayHour.get(w)?.get(h))))
  const hourOfDay = range(24).map(
    (h): Slot => ({
      kwh: sum(weekdayHour, (row) => row[h].kwh),
      pluggedHours: sum(weekdayHour, (row) => row[h].pluggedHours),
    }),
  )

  const totals = (rows: DayContribution[]) => ({
    kwh: sum(rows, (r) => r.kwh),
    sessions: sum(rows, (r) => r.sessions),
  })
  const byDay = rollup(days, totals, (r) => r.day)
  const daily: DayTotal[] = [...byDay]
    .map(([day, t]) => ({ day, ...t }))
    .filter((t) => t.kwh > 0 || t.sessions > 0)
    .sort((x, y) => (x.day < y.day ? -1 : 1))
  const byMonth = rollup(days, totals, (r) => r.month)
  const months: MonthTotal[] = range(1, 13).map((month) => ({
    month,
    ...(byMonth.get(month) ?? { kwh: 0, sessions: 0 }),
  }))

  return { weekdayHour, hourOfDay, daily, months, unhourlySessions }
}
```

`src/lib/evCharging/patterns/index.ts`:

```ts
export * from './patterns'
export * from './pieces'
export type * from './types'
```

- [ ] **Step 4: Run the tests** — `bunx vitest run src/lib/evCharging/patterns` → PASS.
- [ ] **Step 5: Check + commit**

```bash
bun run check
git add src/lib/evCharging/patterns
git commit -m "feat(charging): aggregate when-we-charge patterns per year"
```

### Task B3: timeline segments

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/evCharging/counting.ts` (+ `PEAK_MIN_INTERVAL_MS`, `IDLE_INTERVAL_KWH`)
- Modify: `src/lib/services/evCharging/overview.ts` (use the shared constant; behavior identical)
- Create: `src/lib/evCharging/patterns/timeline.ts`; modify `patterns/types.ts`, `patterns/index.ts`
- Test: `src/lib/evCharging/patterns/timeline.test.ts`

**Interfaces:**
- Consumes: `PatternSession` (B2), `stockholmNoonOnOrBefore` (B1).
- Produces:
```ts
// counting.ts
export const PEAK_MIN_INTERVAL_MS = 600_000
export const IDLE_INTERVAL_KWH = 0.05
// types.ts
export type TimelineSegment = { startAt: Date; endAt: Date; kind: 'charging' | 'idle' }
export type TimelineSession = {
  id: string; startAt: Date; endAt: Date; energyKwh: number
  chargingHours: number; hourly: boolean; segments: TimelineSegment[]
}
export type ChargingTimeline = { year: number; month: number; months: number[]; sessions: TimelineSession[] }
// timeline.ts
export function sessionPeakKw(intervals: PatternInterval[]): number | null
export function toTimelineSession(session: PatternSession): TimelineSession
```

Segment rules (spec "Segment rules", with deviation 2):
1. Peak kW = max `kWh / hours` over intervals ≥ `PEAK_MIN_INTERVAL_MS`; none → max over all intervals; ≤ 0 → null.
2. Interval clipped to the session window; empty after clipping → skipped.
3. `kWh < IDLE_INTERVAL_KWH` or peak null → `idle` for the clipped interval.
4. Else `c = min(intervalMs, kWh / peak × HOUR_MS)`; `c ≥ 0.95 × intervalMs` → all `charging`; else `charging`
   for `[start, start + c)`, `idle` for the rest (clipped to the window).
5. Gaps before, between or after intervals → `idle`.
6. Merge adjacent same-kind segments. `chargingHours` = sum of charging durations / `HOUR_MS`.
7. No intervals → `hourly: false`, one `idle` segment over the window, `chargingHours: 0`.

- [ ] **Step 1: Move the peak constant** — in `counting.ts` add:

```ts
// Intervals shorter than this are Zaptec sampling noise, not a sustained rate —
// excluded from a session's peak kW (the session list and the timeline agree).
export const PEAK_MIN_INTERVAL_MS = 600_000
// An interval delivering less than this is plugged-in-but-idle, not charging.
export const IDLE_INTERVAL_KWH = 0.05
```

In `overview.ts` replace `const PEAK_MIN_DURATION_SEC = 600` and its comment with
`const PEAK_MIN_DURATION_SEC = PEAK_MIN_INTERVAL_MS / 1000` (import from `~/lib/evCharging/counting`).
Run `bun run test:node -- src/lib/services/evCharging/overview.test.ts` → PASS (unchanged).

- [ ] **Step 2: Write the failing tests** — `src/lib/evCharging/patterns/timeline.test.ts`:

```ts
import { expect, test } from 'vitest'
import { sessionPeakKw, toTimelineSession } from './timeline'
import type { PatternSession } from './types'

const d = (iso: string) => new Date(iso)
const iv = (a: string, b: string, k: number) => ({ startAt: d(a), endAt: d(b), energyKwh: k })
const kinds = (s: ReturnType<typeof toTimelineSession>) =>
  s.segments.map((g) => [g.kind, g.startAt.toISOString().slice(11, 16), g.endAt.toISOString().slice(11, 16)])

function base(intervals: PatternSession['intervals'], start = '2026-09-27T19:30:00Z', end = '2026-09-28T05:00:00Z'): PatternSession {
  return { id: 's1', startAt: d(start), endAt: d(end), energyKwh: intervals.reduce((s, i) => s + i.energyKwh, 0), intervals }
}

test('peak ignores sub-10-minute intervals and falls back to all intervals when none is long enough', () => {
  expect(sessionPeakKw([iv('2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11), iv('2026-09-27T21:00:00Z', '2026-09-27T21:05:00Z', 2)])).toBeCloseTo(11)
  expect(sessionPeakKw([iv('2026-09-27T21:00:00Z', '2026-09-27T21:05:00Z', 0.5)])).toBeCloseTo(6)
  expect(sessionPeakKw([iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 0)])).toBeNull()
  expect(sessionPeakKw([])).toBeNull()
})

test('charge at plug-in, taper inside the last hour, then idle until plug-out', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-27T19:30:00Z', '2026-09-27T20:00:00Z', 5.5),
      iv('2026-09-27T20:00:00Z', '2026-09-27T21:00:00Z', 11),
      iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 5.5), // half an hour at 11 kW
      iv('2026-09-27T22:00:00Z', '2026-09-28T05:00:00Z', 0),
    ]),
  )
  expect(kinds(s)).toEqual([
    ['charging', '19:30', '21:30'],
    ['idle', '21:30', '05:00'],
  ])
  expect(s.chargingHours).toBeCloseTo(2)
  expect(s.hourly).toBe(true)
})

test('scheduled charging: idle first, then charging on the hour', () => {
  const s = toTimelineSession(
    base([
      iv('2026-09-27T19:30:00Z', '2026-09-27T23:00:00Z', 0),
      iv('2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', 11),
      iv('2026-09-28T00:00:00Z', '2026-09-28T01:00:00Z', 11),
      iv('2026-09-28T01:00:00Z', '2026-09-28T05:00:00Z', 0),
    ]),
  )
  expect(kinds(s)).toEqual([
    ['idle', '19:30', '23:00'],
    ['charging', '23:00', '01:00'],
    ['idle', '01:00', '05:00'],
  ])
})

test('gaps and intervals outside the window are idle and clipped; segments cover the window exactly', () => {
  const s = toTimelineSession(
    base(
      [
        iv('2026-09-27T19:00:00Z', '2026-09-27T20:00:00Z', 11), // starts before plug-in (clock quirk)
        iv('2026-09-27T21:00:00Z', '2026-09-27T22:00:00Z', 11), // gap 20–21 before it
      ],
      '2026-09-27T19:30:00Z',
      '2026-09-27T23:00:00Z',
    ),
  )
  expect(s.segments[0].startAt).toEqual(d('2026-09-27T19:30:00Z'))
  expect(s.segments.at(-1)?.endAt).toEqual(d('2026-09-27T23:00:00Z'))
  for (let i = 1; i < s.segments.length; i++) expect(s.segments[i].startAt).toEqual(s.segments[i - 1].endAt)
  expect(kinds(s)).toEqual([
    ['charging', '19:30', '20:00'],
    ['idle', '20:00', '21:00'],
    ['charging', '21:00', '22:00'],
    ['idle', '22:00', '23:00'],
  ])
})

test('all-zero intervals on a counted session are idle throughout, never NaN', () => {
  const s = toTimelineSession(base([iv('2026-09-27T19:30:00Z', '2026-09-28T05:00:00Z', 0)]))
  expect(kinds(s)).toEqual([['idle', '19:30', '05:00']])
  expect(s.chargingHours).toBe(0)
})

test('an interval-less session is one idle bar with hourly = false', () => {
  const s = toTimelineSession({ ...base([]), energyKwh: 12 })
  expect(s.hourly).toBe(false)
  expect(kinds(s)).toEqual([['idle', '19:30', '05:00']])
  expect(s.energyKwh).toBe(12)
})
```

- [ ] **Step 3: Run to see it fail** — `bunx vitest run src/lib/evCharging/patterns/timeline.test.ts` → FAIL.

- [ ] **Step 4: Implement** — add the timeline types to `types.ts` (verbatim from **Interfaces**), export
`./timeline` from `index.ts`, and create `src/lib/evCharging/patterns/timeline.ts`:

```ts
// Client-safe: a session's plug-in → charging → plug-out segments. Zaptec
// reports energy per (clock-hour) interval, so *where inside an hour* charging
// ran is estimated: an interval delivering less than the session's peak rate
// charged for kWh ÷ peak kW, placed at the interval's start (matches the car's
// end-of-charge taper and a scheduled start on the hour). The page says so.
import { max } from 'd3-array'
import { IDLE_INTERVAL_KWH, PEAK_MIN_INTERVAL_MS } from '~/lib/evCharging/counting'
import { HOUR_MS } from './pieces'
import type { PatternInterval, PatternSession, TimelineSegment, TimelineSession } from './types'

const FULL_HOUR_SHARE = 0.95
const ms = (i: PatternInterval) => i.endAt.getTime() - i.startAt.getTime()
const rateKw = (i: PatternInterval) => (i.energyKwh / ms(i)) * HOUR_MS

export function sessionPeakKw(intervals: PatternInterval[]): number | null {
  const valid = intervals.filter((i) => ms(i) > 0)
  const long = valid.filter((i) => ms(i) >= PEAK_MIN_INTERVAL_MS)
  const peak = max(long.length > 0 ? long : valid, rateKw)
  return peak !== undefined && peak > 0 ? peak : null
}

export function toTimelineSession(session: PatternSession): TimelineSession {
  const winStart = session.startAt.getTime()
  const winEnd = session.endAt.getTime()
  const raw: { a: number; b: number; kind: TimelineSegment['kind'] }[] = []
  const push = (a: number, b: number, kind: TimelineSegment['kind']) => {
    const lo = Math.max(a, winStart)
    const hi = Math.min(b, winEnd)
    if (hi > lo) raw.push({ a: lo, b: hi, kind })
  }

  const peak = sessionPeakKw(session.intervals)
  const sorted = [...session.intervals].sort((x, y) => x.startAt.getTime() - y.startAt.getTime())
  let cursor = winStart
  for (const i of sorted) {
    const a = Math.max(i.startAt.getTime(), cursor)
    const b = i.endAt.getTime()
    if (b <= a) continue
    push(cursor, a, 'idle')
    if (peak === null || i.energyKwh < IDLE_INTERVAL_KWH) {
      push(a, b, 'idle')
    } else {
      const charged = Math.min(ms(i), (i.energyKwh / peak) * HOUR_MS)
      if (charged >= FULL_HOUR_SHARE * ms(i)) {
        push(a, b, 'charging')
      } else {
        const chargeStart = i.startAt.getTime()
        push(a, chargeStart + charged, 'charging')
        push(Math.max(a, chargeStart + charged), b, 'idle')
      }
    }
    cursor = Math.max(cursor, b)
  }
  push(cursor, winEnd, 'idle')

  const merged: typeof raw = []
  for (const seg of raw) {
    const last = merged.at(-1)
    if (last && last.kind === seg.kind && last.b === seg.a) last.b = seg.b
    else merged.push({ ...seg })
  }
  const segments = merged.map((g) => ({ startAt: new Date(g.a), endAt: new Date(g.b), kind: g.kind }))
  const chargingMs = merged.filter((g) => g.kind === 'charging').reduce((t, g) => t + g.b - g.a, 0)

  return {
    id: session.id,
    startAt: session.startAt,
    endAt: session.endAt,
    energyKwh: session.energyKwh,
    chargingHours: chargingMs / HOUR_MS,
    hourly: session.intervals.length > 0,
    segments,
  }
}
```

- [ ] **Step 5: Run** — `bunx vitest run src/lib/evCharging/patterns` → PASS.
- [ ] **Step 6: Check + commit**

```bash
bun run check
git add src/lib/evCharging src/lib/services/evCharging/overview.ts
git commit -m "feat(charging): derive plug-in, charging and idle segments"
```

### Task B4: service `patterns.ts`

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/services/evCharging/patterns.ts`, `src/lib/services/evCharging/patterns.test.ts`
- Modify: `src/lib/services/evCharging/overview.ts` (`export` `distinctCountedYears`), `src/lib/services/evCharging/index.ts`

**Interfaces:**
- Consumes: `buildPatterns`, `toTimelineSession`, types (B2/B3); `countedSessionFilter()` (`./counted`);
  `stockholmYearBounds`, `stockholmMonthBounds`, `stockholmYearMonth`; `distinctCountedYears()`.
- Produces:
```ts
export type PatternTimings = { fetchMs?: number; aggregateMs?: number }
export async function getChargingPatterns(input: { year?: number; now?: Date; timings?: PatternTimings }): Promise<ChargingPatterns>
export async function getChargingTimeline(input: { year?: number; month?: number; now?: Date; timings?: PatternTimings }): Promise<ChargingTimeline>
```

Fetch rule: counted sessions with `start_at >= rangeStart − 7 days AND start_at < rangeEnd AND end_at > rangeStart`
(sargable on `ev_charge_session_start_at_idx`; the 7-day lookback admits a session plugged in before the range —
sessions are hours long; a >7-day session is accepted as a gap), then their intervals via
`inArray(session_id, ids)` (served by the `(session_id, start_at)` PK), grouped with d3-array `group`.
Timeline sessions: `start_at` inside the month (rows are by plug-in month). Timeline `months`: distinct Stockholm
months of counted `start_at` within the year (range filter + `extract` in the select only).

- [ ] **Step 1: Write the failing tests** — `patterns.test.ts`, reusing the `insertCharger`/`insertSession`/
`insertInterval` helpers **copied verbatim** from `overview.test.ts` (lines 9–40) at the top, then:

```ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { setupDatabase } from '~test/setup'
import { getOverview } from './overview'
import { getChargingPatterns, getChargingTimeline } from './patterns'

setupDatabase()
// …insertCharger / insertSession / insertInterval from overview.test.ts…

const H = 3_600_000
async function overnight(startIso: string, kwhPerHour: number[], idleHoursAfter = 0) {
  const start = new Date(startIso)
  const end = new Date(start.getTime() + (kwhPerHour.length + idleHoursAfter) * H)
  const id = await insertSession({ startAt: start, endAt: end, energyKwh: kwhPerHour.reduce((a, b) => a + b, 0) })
  for (const [i, kwh] of kwhPerHour.entries()) {
    await insertInterval(id, new Date(start.getTime() + i * H), new Date(start.getTime() + (i + 1) * H), kwh)
  }
  if (idleHoursAfter > 0) {
    const a = start.getTime() + kwhPerHour.length * H
    await insertInterval(id, new Date(a), new Date(a + idleHoursAfter * H), 0)
  }
  return id
}

test('an empty database gives zero grids, 12 zero months and the current year', async () => {
  const p = await getChargingPatterns({ now: new Date('2026-06-15T12:00:00Z') })
  expect(p.year).toBe(2026)
  expect(p.years).toEqual([2026])
  expect(p.hourOfDay.every((s) => s.kwh === 0 && s.pluggedHours === 0)).toBe(true)
  expect(p.months.every((m) => m.kwh === 0 && m.sessions === 0)).toBe(true)
})

test('noise, voided and replaced sessions are excluded', async () => {
  await insertSession({ energyKwh: 0.49 })
  await insertSession({ energyKwh: 5, voided: true })
  await insertSession({ energyKwh: 5, replacedByZaptecSessionId: 'zap-x' })
  const p = await getChargingPatterns({ year: 2026 })
  expect(p.months[0].sessions).toBe(0)
  expect(p.unhourlySessions).toBe(0)
})

test('calendar months equal the overview months for the same data (the two pages never disagree)', async () => {
  await overnight('2026-01-31T20:00:00Z', [11, 11, 6], 3) // spans Jan → Feb in Stockholm
  await overnight('2026-03-28T22:00:00Z', [11, 4], 5) // spans the spring-forward night
  await insertSession({ startAt: new Date('2026-05-02T10:00:00Z'), endAt: new Date('2026-05-02T12:00:00Z'), energyKwh: 7 }) // no intervals
  const [p, o] = await Promise.all([getChargingPatterns({ year: 2026 }), getOverview({ year: 2026 })])
  for (const [i, m] of p.months.entries()) {
    expect(m.kwh).toBeCloseTo(o.months[i].kwh, 9)
    expect(m.sessions).toBe(o.months[i].sessions)
  }
  expect(p.unhourlySessions).toBe(1)
})

test('a session plugged in on 31 Dec shows its January hours in the new year and adds it to years', async () => {
  await overnight('2026-12-31T21:00:00Z', [11, 11, 11], 1) // 22:00 CET → 02:00 CET
  const next = await getChargingPatterns({ year: 2027, now: new Date('2027-01-02T12:00:00Z') })
  expect(next.years).toEqual([2027, 2026])
  expect(next.months[0]).toEqual({ month: 1, kwh: 11, sessions: 0 })
  expect(next.hourOfDay[1].pluggedHours).toBe(1)
})

test('timeline: rows are the month’s sessions by plug-in, oldest first, with months to step through', async () => {
  await overnight('2026-08-31T19:00:00Z', [11], 2) // 31 Aug 21:00 CEST: an August plug-in, not in September's rows
  await overnight('2026-09-05T18:00:00Z', [11, 5.5], 8)
  await overnight('2026-09-01T17:00:00Z', [11], 10)
  const t = await getChargingTimeline({ year: 2026, month: 9 })
  expect(t.months).toEqual([8, 9])
  expect(t.sessions.map((s) => s.startAt.toISOString())).toEqual([
    '2026-09-01T17:00:00.000Z',
    '2026-09-05T18:00:00.000Z',
  ])
  expect(t.sessions[1].segments.map((g) => g.kind)).toEqual(['charging', 'idle'])
})

test('timeline defaults to the latest month with sessions, else the current month', async () => {
  await overnight('2026-07-10T18:00:00Z', [11], 1)
  expect((await getChargingTimeline({ year: 2026, now: new Date('2026-09-30T12:00:00Z') })).month).toBe(7)
  expect((await getChargingTimeline({ year: 2025, now: new Date('2026-09-30T12:00:00Z') })).month).toBe(9)
})

test('timeline for a month without sessions is empty, not an error', async () => {
  await overnight('2026-07-10T18:00:00Z', [11], 1)
  const t = await getChargingTimeline({ year: 2026, month: 12 })
  expect(t.sessions).toEqual([])
  expect(t.months).toEqual([7])
})

test('timings are recorded', async () => {
  const timings = {}
  await getChargingPatterns({ year: 2026, timings })
  expect(timings).toEqual({ fetchMs: expect.any(Number), aggregateMs: expect.any(Number) })
})
```

- [ ] **Step 2: Run to see it fail** — `bun run test:node -- src/lib/services/evCharging/patterns.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `overview.ts` change `async function distinctCountedYears()` to
`export async function distinctCountedYears()`. Create `src/lib/services/evCharging/patterns.ts`:

```ts
import { group } from 'd3-array'
import { and, asc, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { evChargeInterval, evChargeSession } from '~/lib/db/schema'
import {
  buildPatterns,
  type ChargingPatterns,
  type ChargingTimeline,
  type PatternSession,
  toTimelineSession,
} from '~/lib/evCharging/patterns'
import { stockholmMonthBounds, stockholmYearBounds, stockholmYearMonth } from '~/lib/time/stockholm'
import { countedSessionFilter } from './counted'
import { distinctCountedYears } from './overview'

export type PatternTimings = { fetchMs?: number; aggregateMs?: number }

// A session plugged in up to this long before a range still contributes its
// hours inside the range (sessions are hours long; the lookback keeps the
// start_at filter sargable instead of scanning on end_at).
const LOOKBACK_MS = 7 * 24 * 3_600_000

async function fetchSessions(where: ReturnType<typeof and>): Promise<PatternSession[]> {
  const sessions = await db
    .select({
      id: evChargeSession.id,
      startAt: evChargeSession.startAt,
      endAt: evChargeSession.endAt,
      energyKwh: evChargeSession.energyKwh,
    })
    .from(evChargeSession)
    .where(and(countedSessionFilter(), where))
    .orderBy(asc(evChargeSession.startAt))
  if (sessions.length === 0) return []
  const intervals = await db
    .select({
      sessionId: evChargeInterval.sessionId,
      startAt: evChargeInterval.startAt,
      endAt: evChargeInterval.endAt,
      energyKwh: evChargeInterval.energyKwh,
    })
    .from(evChargeInterval)
    .where(inArray(evChargeInterval.sessionId, sessions.map((s) => s.id)))
    .orderBy(asc(evChargeInterval.sessionId), asc(evChargeInterval.startAt))
  const bySession = group(intervals, (i) => i.sessionId)
  return sessions.map((s) => ({
    ...s,
    intervals: (bySession.get(s.id) ?? []).map(({ startAt, endAt, energyKwh }) => ({ startAt, endAt, energyKwh })),
  }))
}

function overlapping(startMs: number, endMs: number) {
  return and(
    gte(evChargeSession.startAt, new Date(startMs - LOOKBACK_MS)),
    lt(evChargeSession.startAt, new Date(endMs)),
    gt(evChargeSession.endAt, new Date(startMs)),
  )
}

async function timed<T>(timings: PatternTimings | undefined, key: keyof PatternTimings, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now()
  try {
    return await run()
  } finally {
    if (timings) timings[key] = Math.round(performance.now() - started)
  }
}

export async function getChargingPatterns(input: {
  year?: number
  now?: Date
  timings?: PatternTimings
}): Promise<ChargingPatterns> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime()).year
  const year = input.year ?? current
  const { startMs, endMs } = stockholmYearBounds(year)
  const [sessions, years] = await timed(input.timings, 'fetchMs', () =>
    Promise.all([fetchSessions(overlapping(startMs, endMs)), distinctCountedYears()]),
  )
  const aggregates = await timed(input.timings, 'aggregateMs', () => buildPatterns(sessions, year))
  years.add(current)
  return { year, years: [...years].sort((a, b) => b - a), ...aggregates }
}

export async function getChargingTimeline(input: {
  year?: number
  month?: number
  now?: Date
  timings?: PatternTimings
}): Promise<ChargingTimeline> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const year = input.year ?? current.year
  const { startMs: yearStart, endMs: yearEnd } = stockholmYearBounds(year)
  const monthOf = sql<number>`extract(month from ${evChargeSession.startAt} AT TIME ZONE 'Europe/Stockholm')::int`
  const { months, month, sessions } = await timed(input.timings, 'fetchMs', async () => {
    const monthRows = await db
      .selectDistinct({ month: monthOf })
      .from(evChargeSession)
      .where(
        and(
          countedSessionFilter(),
          gte(evChargeSession.startAt, new Date(yearStart)),
          lt(evChargeSession.startAt, new Date(yearEnd)),
        ),
      )
    const months = monthRows.map((r) => r.month).sort((a, b) => a - b)
    const month = input.month ?? months.at(-1) ?? current.month
    const { startMs, endMs } = stockholmMonthBounds(year, month)
    const sessions = await fetchSessions(
      and(gte(evChargeSession.startAt, new Date(startMs)), lt(evChargeSession.startAt, new Date(endMs))),
    )
    return { months, month, sessions }
  })
  const rows = await timed(input.timings, 'aggregateMs', () => sessions.map(toTimelineSession))
  return { year, month, months, sessions: rows }
}
```

Add `export * from './patterns'` to `src/lib/services/evCharging/index.ts`.

- [ ] **Step 4: Run** — `bun run test:node -- src/lib/services/evCharging` → PASS (new + existing overview tests).
- [ ] **Step 5: Check + commit**

```bash
bun run check
git add src/lib/services/evCharging
git commit -m "feat(charging): read charging patterns and timelines from the DB"
```

### Task B5: procedures

**Reviewers:** `code-reviewer` + a reviewer loading `better-auth-security-best-practices` (procedure/auth pairing).

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts`, `src/lib/orpc/procedures/evCharging.test.ts`

**Interfaces:**
- Consumes: `getChargingPatterns`, `getChargingTimeline`, `PatternTimings` (B4).
- Produces: `evCharging.patterns({ year? })` → `ChargingPatterns`; `evCharging.timeline({ year?, month? })` →
  `ChargingTimeline`. Timing labels `patternsFetchMs`, `patternsAggregateMs`, `timelineFetchMs`, `timelineAggregateMs`.

- [ ] **Step 1: Failing tests** — append to `evCharging.test.ts`:

```ts
test('patterns and timeline reject an unauthenticated caller', async () => {
  await expect(call(evChargingRouter.patterns, {}, { context: baseContext() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(call(evChargingRouter.timeline, {}, { context: baseContext() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('patterns returns zero grids for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.patterns, {}, { context: baseContext() })
  expect(result.weekdayHour).toHaveLength(7)
  expect(result.hourOfDay).toHaveLength(24)
})

test('timeline returns an empty month for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.timeline, { year: 2026, month: 3 }, { context: baseContext() })
  expect(result).toMatchObject({ year: 2026, month: 3, months: [], sessions: [] })
})

test('patterns and timeline reject out-of-range input', async () => {
  await signIn('user')
  await expect(call(evChargingRouter.patterns, { year: 2019 }, { context: baseContext() })).rejects.toBeDefined()
  await expect(call(evChargingRouter.timeline, { year: 2026, month: 0 }, { context: baseContext() })).rejects.toBeDefined()
  await expect(call(evChargingRouter.timeline, { year: 2026, month: 13 }, { context: baseContext() })).rejects.toBeDefined()
})

test('patterns records its sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.patterns, {}, { context: { ...baseContext(), timings } })
  expect(timings).toMatchObject({ patternsFetchMs: expect.any(Number), patternsAggregateMs: expect.any(Number) })
})
```

(If `baseContext` doesn't accept `timings`, check how `context.timings` is set in `src/lib/orpc/context.ts` and
pass it the same way; drop the last test only if the context can't carry it in tests, and say so in the review.)

- [ ] **Step 2: Run to see it fail** — `bun run test:node -- src/lib/orpc/procedures/evCharging.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `evChargingRouter`, after `sessionCosts`:

```ts
  // When-we-charge views (/charging/patterns). Two queries + pure aggregation
  // each → sub-timings (timing rule).
  patterns: protectedProcedure
    .input(z.object({ year: yearInput }))
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingPatterns({ year: input.year, timings })
      recordPrefixedTimings(context.timings, 'patterns', timings)
      return result
    }),

  timeline: protectedProcedure
    .input(z.object({ year: yearInput, month: z.number().int().min(1).max(12).optional() }))
    .handler(async ({ input, context }) => {
      const timings: PatternTimings = {}
      const result = await evChargingService.getChargingTimeline({ ...input, timings })
      recordPrefixedTimings(context.timings, 'timeline', timings)
      return result
    }),
```

Hoist the repeated year schema above the router and use it in `overview`/`costOverview` too:

```ts
const yearInput = z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional()
```

Generalize the existing `recordCostTimings` into `recordPrefixedTimings(timings, prefix, sub)` (same body with
`prefix` instead of `'cost'`) and call it as `recordPrefixedTimings(context.timings, 'cost', timings)` at its two
existing call sites. Import `type PatternTimings` from `~/lib/services/evCharging`.

- [ ] **Step 4: Run** — `bun run test:node -- src/lib/orpc/procedures/evCharging.test.ts` → PASS.
- [ ] **Step 5: Pre-PR gate** (see Global constraints) → open PR B with the deviations section in the body.
- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/orpc/procedures
git commit -m "feat(charging): expose pattern and timeline procedures"
```

---

## PR C — `/charging/patterns`

Shared UI conventions for C2–C5:
- Width via `useParentSize` from `@visx/responsive` (`const { parentRef, width } = useParentSize({ debounceTime: 100 })`);
  render nothing until `width > 0` (SSR renders the card shell only — no hydration mismatch).
- Tooltips via one shared `ChartPopover` (C1) wrapping visx `useTooltip` + `TooltipWithBounds`
  (`unstyled`, `applyPositionStyle`, token classes). Positions come from the mark's own scaled x/y (not the pointer),
  so the same call serves `onPointerEnter` and `onFocus`.
- Colour via `intensity(value, max)` (C1): `scaleSqrt().domain([0, max]).range([0.12, 1]).clamp(true)` → the CSS
  string `color-mix(in oklch, var(--brand) ${p}%, var(--card))`; zero → `var(--muted)`. Applied as `style={{ fill }}`.
- Charts are `aria-hidden` SVGs with an sr-only `<table>` of the same numbers next to them.

### Task C1: route, tabs, shared chart helpers, i18n base

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/routes/_authenticated/charging/patterns.tsx`
- Create: `src/components/evCharging/ChargingTabs.tsx` (+ `.browser.test.tsx`)
- Create: `src/components/evCharging/patternChart.ts` (colour scale, metric type) and `src/components/evCharging/ChartPopover.tsx`
- Modify: `src/components/evCharging/format.ts` (+ `weekdayLabel`, `hourRangeLabel`, `monthName`)
- Modify: `src/routes/_authenticated/charging/index.tsx` (render `ChargingTabs` under `ChargingHeading`)
- Modify: `src/components/command/commands.ts`, `messages/sv.json`, `messages/en.json`
- Modify: `src/lib/evCharging/clientSafe.browser.test.tsx` (+ patterns module, + patterns route)

**Interfaces — Produces:**
```ts
// patternChart.ts
export type PatternMetric = 'kwh' | 'plugged'
export function slotValue(slot: Slot, metric: PatternMetric): number
export function intensity(max: number): (value: number) => string  // CSS fill string
// ChartPopover.tsx
export function useChartPopover<T>(): { show(d: T, left: number, top: number): void; hide(): void; open: boolean; data?: T; left?: number; top?: number }
export function ChartPopover(props: { state: ReturnType<typeof useChartPopover>; children: React.ReactNode }): JSX.Element | null
// format.ts
export function weekdayLabel(weekday: number /* 0 = Mon */, width?: 'short' | 'long'): string
export function hourRangeLabel(hour: number): string // "21–22"
export function monthName(month: number): string // "september"
// ChargingTabs.tsx
export function ChargingTabs(props: { current: 'overview' | 'patterns' }): JSX.Element
```
Route search: `{ year?: int in bounds, metric?: 'kwh' | 'plugged', month?: 1–12 }`, each `.optional().catch(undefined)`.

- [ ] **Step 1: i18n keys** — add to `messages/sv.json` (and the English values to `en.json`, same keys):

| key | sv | en |
|---|---|---|
| `charging_tabs_label` | Laddningsvyer | Charging views |
| `charging_tab_overview` | Översikt | Overview |
| `charging_tab_patterns` | Mönster | Patterns |
| `meta_charging_patterns_title` | Laddmönster | Charging patterns |
| `meta_charging_patterns_description` | När vi laddar bilen – timmar, dagar och sessioner. | When we charge the car – hours, days and sessions. |
| `cmd_kw_charging_patterns` | mönster heatmap kalender tidslinje när | patterns heatmap calendar timeline when |
| `nav_charging_patterns` | Laddmönster | Charging patterns |
| `charging_patterns_metric_label` | Mått | Measure |
| `charging_patterns_metric_kwh` | kWh | kWh |
| `charging_patterns_metric_plugged` | Inkopplad | Plugged in |
| `charging_patterns_heatmap_title_kwh` | Veckodag × timme · kWh | Weekday × hour · kWh |
| `charging_patterns_heatmap_title_plugged` | Veckodag × timme · timmar inkopplad | Weekday × hour · hours plugged in |
| `charging_patterns_hour_title_kwh` | Per timme på dygnet · kWh | By hour of day · kWh |
| `charging_patterns_hour_title_plugged` | Per timme på dygnet · timmar inkopplad | By hour of day · hours plugged in |
| `charging_patterns_calendar_title` | Dag för dag · kWh | Day by day · kWh |
| `charging_patterns_timeline_title` | Sessioner | Sessions |
| `charging_patterns_legend_less` | mindre | less |
| `charging_patterns_legend_more` | mer | more |
| `charging_patterns_value_kwh` | {value} kWh | {value} kWh |
| `charging_patterns_value_plugged` | {value} h inkopplad | {value} h plugged in |
| `charging_patterns_day_sessions` | {count} sessioner | {count} sessions |
| `charging_patterns_unhourly_note` | {count} sessioner saknar timdata och ingår inte i timvyerna. | {count} sessions have no hourly data and are left out of the hourly views. |
| `charging_patterns_timeline_prev` | Föregående månad | Previous month |
| `charging_patterns_timeline_next` | Nästa månad | Next month |
| `charging_patterns_timeline_charging` | Laddar | Charging |
| `charging_patterns_timeline_idle` | Inkopplad, laddar inte | Plugged in, not charging |
| `charging_patterns_timeline_clipped` | ‹ › fortsätter utanför 12–12 | ‹ › continues outside 12–12 |
| `charging_patterns_timeline_estimate` | Zaptec rapporterar energi per timme; när laddningen startar och slutar inom en timme är uppskattat. | Zaptec reports energy per hour; when charging starts and stops within an hour is estimated. |
| `charging_patterns_timeline_summary` | laddar {charging} h av {plugged} h inkopplad | charging {charging} h of {plugged} h plugged in |
| `charging_patterns_timeline_no_hourly` | ingen timdata | no hourly data |
| `charging_patterns_timeline_empty` | Inga laddningar i {month}. | No charging in {month}. |
| `charging_patterns_empty_title` | Inga laddningar {year} | No charging in {year} |
| `charging_patterns_empty_description` | När bilen har laddats visas mönstren här. | Patterns show up here once the car has charged. |

Run `bun run i18n:compile`.

- [ ] **Step 2: Shared helpers** — `format.ts` additions (use the active Paraglide locale the same way the existing
`monthLabel` in this file does — read it first and mirror its `Intl.DateTimeFormat` + locale call):

```ts
// 2024-01-01 was a Monday — a fixed UTC anchor for weekday names.
export function weekdayLabel(weekday: number, width: 'short' | 'long' = 'short'): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 1 + weekday, 12)),
  )
}
export function hourRangeLabel(hour: number): string {
  const pad = (h: number) => String(h % 24).padStart(2, '0')
  return `${pad(hour)}–${pad(hour + 1)}`
}
export function monthName(month: number): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 15, 12)),
  )
}
```
(`intlLocale()` = whatever `monthLabel` already uses; if it inlines the locale, extract that into a private
`intlLocale()` in this file and use it in all three.)

`src/components/evCharging/patternChart.ts`:

```ts
import { scaleSqrt } from 'd3-scale'
import type { Slot } from '~/lib/evCharging/patterns'

export type PatternMetric = 'kwh' | 'plugged'

export function slotValue(slot: Slot, metric: PatternMetric): number {
  return metric === 'kwh' ? slot.kwh : slot.pluggedHours
}

// Value → CSS fill. sqrt so small values stay visible next to the evening peak;
// colour-mix on the theme tokens so light/dark follow the design system
// (d3-color can't read CSS variables or oklch). Zero is the muted cell colour.
export function intensity(max: number): (value: number) => string {
  const share = scaleSqrt().domain([0, Math.max(max, Number.EPSILON)]).range([12, 100]).clamp(true)
  return (value) =>
    value > 0 ? `color-mix(in oklch, var(--brand) ${Math.round(share(value))}%, var(--card))` : 'var(--muted)'
}
```

`src/components/evCharging/ChartPopover.tsx`:

```tsx
import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import type * as React from 'react'

export function useChartPopover<T>() {
  const t = useTooltip<T>()
  return {
    open: t.tooltipOpen,
    data: t.tooltipData,
    left: t.tooltipLeft,
    top: t.tooltipTop,
    show: (data: T, left: number, top: number) => t.showTooltip({ tooltipData: data, tooltipLeft: left, tooltipTop: top }),
    hide: t.hideTooltip,
  }
}

// Positioned relative to the nearest `relative` ancestor (the chart wrapper).
export function ChartPopover({
  state,
  children,
}: {
  state: { open: boolean; left?: number; top?: number }
  children: React.ReactNode
}) {
  if (!state.open) return null
  return (
    <TooltipWithBounds
      unstyled
      applyPositionStyle
      left={state.left}
      top={state.top}
      className="pointer-events-none z-10 rounded-md bg-foreground px-2 py-1 text-background text-xs shadow-md"
    >
      {children}
    </TooltipWithBounds>
  )
}
```

- [ ] **Step 3: `ChargingTabs` test first** — `ChargingTabs.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ChargingTabs } from './ChargingTabs'

test('marks the current view with aria-current and links both pages', async () => {
  const { screen } = await renderWithProviders(<ChargingTabs current="patterns" />)
  const patterns = screen.getByRole('link', { name: 'Mönster' })
  await expect.element(patterns).toHaveAttribute('aria-current', 'page')
  await expect.element(screen.getByRole('link', { name: 'Översikt' })).not.toHaveAttribute('aria-current')
  await expect.element(screen.getByRole('link', { name: 'Översikt' })).toHaveAttribute('href', '/charging')
})
```
(Check `test/browser/render.tsx` for whether it provides a router; if not, render inside the router harness it
offers, as other route-link components' tests do.)

`src/components/evCharging/ChargingTabs.tsx`:

```tsx
import { Link } from '@tanstack/react-router'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

const TABS = [
  { key: 'overview', to: '/charging', label: m.charging_tab_overview },
  { key: 'patterns', to: '/charging/patterns', label: m.charging_tab_patterns },
] as const

// Route links styled as tabs — they switch pages, so not Radix Tabs.
export function ChargingTabs({ current }: { current: 'overview' | 'patterns' }) {
  return (
    <nav aria-label={m.charging_tabs_label()} className="flex gap-1 border-b">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          search={(prev: { year?: number }) => ({ year: prev.year })}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 font-medium text-sm transition-colors',
            tab.key === current
              ? 'border-brand text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label()}
        </Link>
      ))}
    </nav>
  )
}
```
(The `search` carry-over keeps the selected year across tabs. If TanStack's types reject the `prev` shape across
the two routes, drop the carry-over rather than casting.)

- [ ] **Step 4: Route skeleton** — `src/routes/_authenticated/charging/patterns.tsx` with search schema, loader and
heading only (views arrive in C2–C6):

```tsx
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { ChargingTabs } from '~/components/evCharging/ChargingTabs'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { PageContainer } from '~/components/layout/PageContainer'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
  metric: z.enum(['kwh', 'plugged']).optional().catch(undefined),
  month: z.number().int().min(1).max(12).optional().catch(undefined),
})

const patternsQuery = (year?: number) => orpc.evCharging.patterns.queryOptions({ input: { year } })
const timelineQuery = (year?: number, month?: number) =>
  orpc.evCharging.timeline.queryOptions({ input: { year, month } })

export const Route = createFileRoute('/_authenticated/charging/patterns')({
  head: () => ({
    meta: seo({ title: m.meta_charging_patterns_title(), description: m.meta_charging_patterns_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year, month: search.month }),
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(patternsQuery(deps.year)),
      queryClient.ensureQueryData(timelineQuery(deps.year, deps.month)),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
    ])
  },
  component: PatternsPage,
})

function PatternsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({ ...orpc.evCharging.syncStatus.queryOptions(), refetchInterval: 60_000 })
  return (
    <PageContainer>
      <ChargingHeading
        lastSuccessAt={health.lastSuccessAt}
        action={isAdmin ? <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} /> : null}
      />
      <ChargingTabs current="patterns" />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('zaptec')}
        retrying={syncNow.isPendingFor('zaptec')}
      />
    </PageContainer>
  )
}
```
(The `syncStatus` `refetchInterval: 60_000` mirrors `/charging` exactly — it's the existing health poll, not new
polling. C6 adds `useQuery` + `keepPreviousData` to the react-query import when it wires the views.)

In `charging/index.tsx`, render `<ChargingTabs current="overview" />` right after `<ChargingHeading … />`.

- [ ] **Step 5: Command palette** — in `commands.ts` after the `/charging` entry:

```ts
  {
    to: '/charging/patterns',
    label: m.nav_charging_patterns,
    keywords: m.cmd_kw_charging_patterns,
    icon: CalendarClockIcon,
    adminOnly: false,
  },
```
(import `CalendarClockIcon` from `lucide-react`).

- [ ] **Step 6: Client-safe guard** — append to `clientSafe.browser.test.tsx`:

```ts
test('the patterns module and the /charging/patterns route evaluate client-side', async () => {
  const patterns = await import('~/lib/evCharging/patterns')
  expect(typeof patterns.buildPatterns).toBe('function')
  const route = await import('~/routes/_authenticated/charging/patterns')
  expect(route.Route).toBeDefined()
})
```

- [ ] **Step 7: Run** — `bun run build` (route tree + types), `bunx vitest run --project browser src/components/evCharging/ChargingTabs.browser.test.tsx src/lib/evCharging/clientSafe.browser.test.tsx` → PASS.
- [ ] **Step 8: Check + commit**

```bash
bun run check
git add -A src messages
git commit -m "feat(charging): add the patterns route and charging tabs"
```

### Task C2: `WeekdayHourHeatmap`

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** Create `src/components/evCharging/WeekdayHourHeatmap.tsx` + `.browser.test.tsx`.

**Interfaces:** Consumes `Slot` (B2), `PatternMetric`, `slotValue`, `intensity`, `useChartPopover`, `ChartPopover`,
`weekdayLabel`, `hourRangeLabel`, `formatOneDecimal` (C1). Produces
`WeekdayHourHeatmap(props: { grid: Slot[][]; metric: PatternMetric })`.

Layout: `sm` and up → 24 columns (hours) × 7 rows (weekdays); below `sm` (container width < 640 px, decided from
`useParentSize` width so tests can drive it) → transposed with d3-array `transpose`: 7 columns × 24 rows. visx
`HeatmapRect` treats each **datum as a column** and its `bins` as rows.

- [ ] **Step 1: Failing test**

```tsx
import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { WeekdayHourHeatmap } from './WeekdayHourHeatmap'

const grid = Array.from({ length: 7 }, (_, w) =>
  Array.from({ length: 24 }, (_, h) => ({ kwh: w === 1 && h === 21 ? 38.4 : 0, pluggedHours: h >= 18 ? 2 : 0 })),
)

test('draws 168 cells and exposes the numbers in an sr-only table', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}><WeekdayHourHeatmap grid={grid} metric="kwh" /></div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-cell]').length).toBe(168)
  await expect.element(screen.getByRole('cell', { name: /38,4 kWh/ })).toBeInTheDocument()
})

test('is 24 columns wide on desktop and transposed to 7 columns on a phone', async () => {
  const wide = await renderWithProviders(<div style={{ width: 900 }}><WeekdayHourHeatmap grid={grid} metric="kwh" /></div>)
  await expect.poll(() => wide.screen.container.querySelector('svg')?.dataset.orientation).toBe('hours-across')
  const narrow = await renderWithProviders(<div style={{ width: 360 }}><WeekdayHourHeatmap grid={grid} metric="kwh" /></div>)
  await expect.poll(() => narrow.screen.container.querySelector('svg')?.dataset.orientation).toBe('weekdays-across')
})

test('the plugged-in metric shows hours plugged in', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}><WeekdayHourHeatmap grid={grid} metric="plugged" /></div>,
  )
  await expect.element(screen.getByRole('cell', { name: /2,0 h inkopplad/ }).first()).toBeInTheDocument()
})

test('hovering a cell shows its weekday, hour and value', async () => {
  const { screen, user } = await renderWithProviders(
    <div style={{ width: 900 }}><WeekdayHourHeatmap grid={grid} metric="kwh" /></div>,
  )
  const cell = screen.container.querySelector('rect[data-cell="1-21"]')
  if (!cell) throw new Error('cell missing')
  await user.hover(cell)
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
})
```
(Match `renderWithProviders`' actual return — see `test/browser/render.tsx`; if it doesn't return `user`, import
`userEvent` from `vitest/browser` as other browser tests do.)

- [ ] **Step 2: Run to see it fail** — `bunx vitest run --project browser src/components/evCharging/WeekdayHourHeatmap.browser.test.tsx`.

- [ ] **Step 3: Implement**

```tsx
import { Group } from '@visx/group'
import { HeatmapRect } from '@visx/heatmap'
import { useParentSize } from '@visx/responsive'
import { max, range, transpose } from 'd3-array'
import { scaleBand } from 'd3-scale'
import type { Slot } from '~/lib/evCharging/patterns'
import { m } from '~/paraglide/messages'
import { ChartPopover, useChartPopover } from './ChartPopover'
import { formatOneDecimal, hourRangeLabel, weekdayLabel } from './format'
import { intensity, type PatternMetric, slotValue } from './patternChart'

const NARROW_PX = 640
const LABEL_W = 34
const LABEL_H = 16
type Cell = { weekday: number; hour: number; value: number }

export function valueLabel(value: number, metric: PatternMetric): string {
  return metric === 'kwh'
    ? m.charging_patterns_value_kwh({ value: formatOneDecimal(value) })
    : m.charging_patterns_value_plugged({ value: formatOneDecimal(value) })
}

export function WeekdayHourHeatmap({ grid, metric }: { grid: Slot[][]; metric: PatternMetric }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const popover = useChartPopover<Cell>()
  const cells: Cell[][] = grid.map((row, weekday) =>
    row.map((slot, hour) => ({ weekday, hour, value: slotValue(slot, metric) })),
  )
  const fill = intensity(max(cells.flat(), (c) => c.value) ?? 0)
  const narrow = width > 0 && width < NARROW_PX
  // HeatmapRect: each datum is a column, its bins the rows.
  const columns: Cell[][] = narrow ? cells : transpose(cells)
  const nCols = narrow ? 7 : 24
  const nRows = narrow ? 24 : 7
  const plotW = Math.max(0, width - LABEL_W)
  const step = plotW / nCols
  const rowStep = narrow ? step / 2.2 : step
  const x = scaleBand<number>().domain(range(nCols)).range([0, plotW])
  const y = scaleBand<number>().domain(range(nRows)).range([0, rowStep * nRows])
  const colLabel = (i: number) => (narrow ? weekdayLabel(i) : i % 3 === 0 ? String(i).padStart(2, '0') : '')
  const rowLabel = (i: number) => (narrow ? String(i).padStart(2, '0') : weekdayLabel(i))

  return (
    <div ref={parentRef} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={LABEL_H + rowStep * nRows}
          aria-hidden
          data-orientation={narrow ? 'weekdays-across' : 'hours-across'}
          onPointerLeave={popover.hide}
        >
          <Group left={LABEL_W}>
            {range(nCols).map((i) => (
              <text key={i} x={(x(i) ?? 0) + step / 2} y={11} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                {colLabel(i)}
              </text>
            ))}
          </Group>
          <Group top={LABEL_H}>
            {range(nRows).map((i) => (
              <text key={i} x={0} y={(y(i) ?? 0) + rowStep / 2} dominantBaseline="middle" className="fill-muted-foreground text-[11px]">
                {rowLabel(i)}
              </text>
            ))}
          </Group>
          <Group left={LABEL_W} top={LABEL_H}>
            <HeatmapRect<Cell[], Cell>
              data={columns}
              bins={(col) => col}
              count={(c) => c.value}
              xScale={(i) => x(i) ?? 0}
              yScale={(i) => y(i) ?? 0}
              binWidth={step}
              binHeight={rowStep}
              gap={2}
            >
              {(heatmap) =>
                heatmap.flat().map((b) => (
                  <rect
                    key={`${b.bin.weekday}-${b.bin.hour}`}
                    data-cell={`${b.bin.weekday}-${b.bin.hour}`}
                    x={b.x}
                    y={b.y}
                    width={b.width}
                    height={b.height}
                    rx={3}
                    style={{ fill: fill(b.bin.value) }}
                    onPointerEnter={() => popover.show(b.bin, LABEL_W + b.x + b.width / 2, LABEL_H + b.y)}
                  />
                ))
              }
            </HeatmapRect>
          </Group>
        </svg>
      ) : null}
      <ChartPopover state={popover}>
        {popover.data
          ? `${weekdayLabel(popover.data.weekday)} ${hourRangeLabel(popover.data.hour)} · ${valueLabel(popover.data.value, metric)}`
          : null}
      </ChartPopover>
      <table className="sr-only">
        <thead>
          <tr>
            <th />
            {range(24).map((h) => (<th key={h} scope="col">{hourRangeLabel(h)}</th>))}
          </tr>
        </thead>
        <tbody>
          {cells.map((row, w) => (
            <tr key={w}>
              <th scope="row">{weekdayLabel(w, 'long')}</th>
              {row.map((c) => (<td key={c.hour}>{valueLabel(c.value, metric)}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```
(Verify `HeatmapRect`'s generic parameters against `node_modules/@visx/heatmap/lib/heatmaps/HeatmapRect.d.ts`
before relying on `<HeatmapRect<Cell[], Cell>>`; adjust to its declared generics without `any`. The `xScale`/`yScale`
props take a `(index) => number`, confirmed in the 4.0.0 source: `const x = xScale(column)`.)

- [ ] **Step 4: Run** → PASS. Add a legend ramp below the SVG in C6 (page-level, shared with the calendar).
- [ ] **Step 5: Check + commit**

```bash
bun run check
git add src/components/evCharging/WeekdayHourHeatmap.tsx src/components/evCharging/WeekdayHourHeatmap.browser.test.tsx
git commit -m "feat(charging): draw the weekday × hour heatmap"
```

### Task C3: `HourOfDayChart`

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** Create `src/components/evCharging/HourOfDayChart.tsx` + `.browser.test.tsx`.

**Interfaces:** Consumes `Slot`, `PatternMetric`, `slotValue`, `valueLabel` (C2), `hourRangeLabel`. Produces
`HourOfDayChart(props: { hours: Slot[]; metric: PatternMetric })`.

Read `MonthlyChart.tsx`'s `EnergyChart` + `ChartFrame` first and mirror them (same `ChartContainer` config shape,
margins, grid, axis styling). Differences: 24 bars from `hours.map((s, hour) => ({ label: String(hour).padStart(2,
'0'), value: slotValue(s, metric) }))`, bar colour `var(--brand)`, x ticks every 3 h (`interval={2}`), tooltip
content `${hourRangeLabel(hour)} · ${valueLabel(value, metric)}`.

- [ ] **Step 1: Failing test**

```tsx
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { HourOfDayChart } from './HourOfDayChart'

const hours = Array.from({ length: 24 }, (_, h) => ({ kwh: h * 2, pluggedHours: h }))

test('renders one bar per hour', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 220 }}><HourOfDayChart hours={hours} metric="kwh" /></div>,
  )
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(23) // hour 0 is 0 → no rect
  })
})
```
(Recharts omits zero-height rectangles; if it renders 24, assert 24 — pin whichever Recharts 3.8 does and comment why.)

- [ ] **Step 2–4:** run (fail) → implement → run (pass).
- [ ] **Step 5: Commit** — `git commit -m "feat(charging): chart charging by hour of day"`

### Task C4: `ChargingCalendar`

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/lib/evCharging/patterns/calendar.ts` (+ `calendar.test.ts`, node project) — the month grid layout
- Create: `src/components/evCharging/ChargingCalendar.tsx` + `.browser.test.tsx`

**Interfaces:**
- Produces (client-safe, exported from `patterns/index.ts`):
```ts
export type CalendarDay = { day: string; date: number; weekday: number /* 0 = Mon */; week: number /* row within the month, 0-based */ }
export function monthGrid(year: number, month: number): CalendarDay[]
```
- `ChargingCalendar(props: { year: number; daily: DayTotal[]; months: MonthTotal[]; today: string; onPickMonth: (month: number) => void })`

- [ ] **Step 1: Failing layout tests** — `calendar.test.ts`:

```ts
import { expect, test } from 'vitest'
import { monthGrid } from './calendar'

test('September 2026 starts on a Tuesday and spans 5 week rows', () => {
  const g = monthGrid(2026, 9)
  expect(g).toHaveLength(30)
  expect(g[0]).toEqual({ day: '2026-09-01', date: 1, weekday: 1, week: 0 })
  expect(g.at(-1)).toEqual({ day: '2026-09-30', date: 30, weekday: 2, week: 4 })
})

test('a month starting on Sunday puts day 2 on the next row', () => {
  const g = monthGrid(2026, 3) // 1 March 2026 is a Sunday
  expect(g[0]).toMatchObject({ weekday: 6, week: 0 })
  expect(g[1]).toMatchObject({ weekday: 0, week: 1 })
})

test('the DST month still has every day exactly once', () => {
  expect(monthGrid(2026, 10).map((d) => d.date)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
})
```

- [ ] **Step 2: Implement `calendar.ts`** (date-fns + the Stockholm helpers; no hand-rolled weekday math):

```ts
import { tz } from '@date-fns/tz'
import { differenceInCalendarWeeks, eachDayOfInterval, getDate, getISODay } from 'date-fns'
import { STOCKHOLM_TIME_ZONE, stockholmDayOf, stockholmMonthBounds } from '~/lib/time/stockholm'

const inStockholm = tz(STOCKHOLM_TIME_ZONE)
export type CalendarDay = { day: string; date: number; weekday: number; week: number }

// A Monday-first month grid in Stockholm calendar days.
export function monthGrid(year: number, month: number): CalendarDay[] {
  const { startMs, endMs } = stockholmMonthBounds(year, month)
  const first = inStockholm(startMs)
  return eachDayOfInterval({ start: startMs, end: endMs - 1 }, { in: inStockholm }).map((d) => ({
    day: stockholmDayOf(d.getTime()),
    date: getDate(d),
    weekday: getISODay(d) - 1,
    week: differenceInCalendarWeeks(d, first, { weekStartsOn: 1, in: inStockholm }),
  }))
}
```
Run `bunx vitest run src/lib/evCharging/patterns/calendar.test.ts` → PASS.

- [ ] **Step 3: Component test first** — `ChargingCalendar.browser.test.tsx`:

```tsx
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ChargingCalendar } from './ChargingCalendar'

const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, kwh: i === 8 ? 120 : 0, sessions: i === 8 ? 3 : 0 }))
const daily = [{ day: '2026-09-05', kwh: 32.1, sessions: 1 }]

test('renders 12 month grids with every day and hatches future days', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1000 }}>
      <ChargingCalendar year={2026} daily={daily} months={months} today="2026-09-30" onPickMonth={() => {}} />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  await expect.poll(() => screen.container.querySelectorAll('rect[data-future]').length).toBe(92) // 1 Oct–31 Dec
})

test('a month heading picks that month for the timeline', async () => {
  const onPickMonth = vi.fn()
  const { screen } = await renderWithProviders(
    <div style={{ width: 1000 }}>
      <ChargingCalendar year={2026} daily={daily} months={months} today="2026-09-30" onPickMonth={onPickMonth} />
    </div>,
  )
  await screen.getByRole('button', { name: /september/i }).click()
  expect(onPickMonth).toHaveBeenCalledWith(9)
})

test('the day total is readable without hovering', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1000 }}>
      <ChargingCalendar year={2026} daily={daily} months={months} today="2026-09-30" onPickMonth={() => {}} />
    </div>,
  )
  await expect.element(screen.getByRole('cell', { name: /32,1 kWh/ })).toBeInTheDocument()
})
```

- [ ] **Step 4: Implement** — a CSS grid of 12 cards (`grid grid-cols-2 gap-4 min-[480px]:grid-cols-3 md:grid-cols-4
xl:grid-cols-6`); each month: heading row = `<button>` (month name, `onPickMonth(month)`) + muted month kWh; body =
one small SVG per month sized by `useParentSize` on the month wrapper, drawn with `@visx/heatmap` `HeatmapRect`
over 7 weekday columns whose bins are the week rows (0–5), cells looked up from `monthGrid(year, month)`; a slot with
no day renders nothing; `day > today` → `data-future` and a hatched `style={{ fill: 'url(#future-hatch)' }}` pattern
(one `<pattern>` per SVG, stroke `var(--border)`); others `style={{ fill: fill(kwh) }}` with one shared
`intensity(max(daily, d => d.kwh))`. Tooltip via `ChartPopover`: `${weekdayLabel(weekday)} ${date} ${monthLabel(month)}
· ${valueLabel(kwh,'kwh')} · ${m.charging_patterns_day_sessions({ count })}`. Weekday initials row above the grid
(`weekdayLabel(i, 'short').charAt(0).toUpperCase()`). sr-only `<table>` per month listing days with kWh > 0.
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** — `git commit -m "feat(charging): show a year calendar of daily kWh"`

### Task C5: `SessionTimeline`

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** Create `src/components/evCharging/SessionTimeline.tsx` + `.browser.test.tsx`.

**Interfaces:** Consumes `TimelineSession` (B3), `stockholmNoonOnOrBefore` (B1), `formatDate`, `formatTime`,
`formatOneDecimal`, `monthName`, `weekdayLabel`, `useChartPopover`/`ChartPopover` (C1). Produces
`SessionTimeline(props: { sessions: TimelineSession[]; year: number; month: number; months: number[]; onMonth: (month: number) => void })`.

Drawing: one shared `@visx/axis` `AxisTop` over a `scaleLinear().domain([0, 1]).range([0, trackW])` with
`tickValues={range(9).map(i => i / 8)}` and `tickFormat={(v) => String((12 + Number(v) * 24) % 24).padStart(2, '0')}`.
Per row: `const { startMs, endMs } = stockholmNoonOnOrBefore(s.startAt.getTime())`, row scale
`scaleLinear().domain([startMs, endMs]).range([0, trackW]).clamp(true)` (a DST row is 23/25 h, mapped onto the same
width — ≤ 1 h drift at the far end, accepted); a faint night band 22:00–06:00; each segment a `@visx/shape` `Bar`
(`charging` → `style={{ fill: 'var(--brand)' }}`, `idle` → brand at 18 % via `color-mix`, 1 px brand-35 % stroke).
`clippedLeft = s.startAt < startMs` (never true by construction, but guard), `clippedRight = s.endAt > endMs` →
`‹`/`›` glyphs at the track edges. Label (HTML, not SVG): `${weekdayLabel(wd)} ${formatDate(start)} ·
${formatTime(start)}–${formatTime(end)} · ${valueLabel(energyKwh,'kwh')}` + muted `timeline_summary` (or
`timeline_no_hourly` when `!hourly`). ≥ sm: label column 200 px beside the track; < sm: label above.
Month stepper: buttons disabled at `months[0]` / `months.at(-1)` (both disabled when `months` is empty);
`aria-label`s from `timeline_prev`/`timeline_next`; the label is `${monthName(month)} ${year}`.

- [ ] **Step 1: Failing tests**

```tsx
import { expect, test, vi } from 'vitest'
import type { TimelineSession } from '~/lib/evCharging/patterns'
import { renderWithProviders } from '~test/browser/render'
import { SessionTimeline } from './SessionTimeline'

const d = (iso: string) => new Date(iso)
const overnight: TimelineSession = {
  id: 'a', startAt: d('2026-09-05T19:10:00Z'), endAt: d('2026-09-06T05:02:00Z'), energyKwh: 32.1,
  chargingHours: 3, hourly: true,
  segments: [
    { startAt: d('2026-09-05T19:10:00Z'), endAt: d('2026-09-05T22:10:00Z'), kind: 'charging' },
    { startAt: d('2026-09-05T22:10:00Z'), endAt: d('2026-09-06T05:02:00Z'), kind: 'idle' },
  ],
}
const long: TimelineSession = { // plugged Fri 18:00 → Sun 10:00: past the row's 12:00 edge
  id: 'b', startAt: d('2026-09-11T16:00:00Z'), endAt: d('2026-09-13T08:00:00Z'), energyKwh: 20,
  chargingHours: 2, hourly: true,
  segments: [
    { startAt: d('2026-09-11T16:00:00Z'), endAt: d('2026-09-11T18:00:00Z'), kind: 'charging' },
    { startAt: d('2026-09-11T18:00:00Z'), endAt: d('2026-09-13T08:00:00Z'), kind: 'idle' },
  ],
}
const noHourly: TimelineSession = { ...overnight, id: 'c', hourly: false, chargingHours: 0,
  segments: [{ startAt: overnight.startAt, endAt: overnight.endAt, kind: 'idle' }] }

const render = (props: Partial<Parameters<typeof SessionTimeline>[0]> = {}) =>
  renderWithProviders(
    <div style={{ width: 900 }}>
      <SessionTimeline sessions={[overnight, long, noHourly]} year={2026} month={9} months={[8, 9]} onMonth={() => {}} {...props} />
    </div>,
  )

test('one row per session with real local times and the charging summary', async () => {
  const { screen } = await render()
  await expect.element(screen.getByText(/21:10–07:02/).first()).toBeInTheDocument()
  await expect.element(screen.getByText(/laddar 3,0 h av 9,9 h inkopplad/)).toBeInTheDocument()
})

test('a session past the 12:00 edge is clipped with a chevron, never overflowing the track', async () => {
  const { screen } = await render()
  await expect.poll(() => screen.container.querySelectorAll('[data-clipped="right"]').length).toBe(1)
  for (const bar of screen.container.querySelectorAll<SVGRectElement>('rect[data-segment]')) {
    const x = Number(bar.getAttribute('x'))
    const w = Number(bar.getAttribute('width'))
    expect(x).toBeGreaterThanOrEqual(0)
    expect(w).toBeGreaterThanOrEqual(0)
  }
})

test('an interval-less session says it has no hourly data', async () => {
  const { screen } = await render()
  await expect.element(screen.getByText('ingen timdata')).toBeInTheDocument()
})

test('the stepper moves between months with sessions and stops at the ends', async () => {
  const onMonth = vi.fn()
  const { screen } = await render({ onMonth })
  await expect.element(screen.getByRole('button', { name: 'Nästa månad' })).toBeDisabled()
  await screen.getByRole('button', { name: 'Föregående månad' }).click()
  expect(onMonth).toHaveBeenCalledWith(8)
})

test('an empty month shows the empty line and keeps the stepper', async () => {
  const { screen } = await render({ sessions: [], month: 12, months: [8, 9] })
  await expect.element(screen.getByText(/Inga laddningar i december/)).toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: 'Föregående månad' })).toBeEnabled()
})
```
(Stepper semantics for a month outside `months` (e.g. 12 with `[8, 9]`): "previous" goes to the latest listed month
before it (9), "next" to the first after it (none → disabled). Implement with d3-array `bisectLeft` on `months`.)

- [ ] **Step 2–4:** run (fail) → implement per the drawing notes → run (pass).
- [ ] **Step 5: Commit** — `git commit -m "feat(charging): draw the plug-in to plug-out session timeline"`

### Task C6: assemble the page

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:** Modify `src/routes/_authenticated/charging/patterns.tsx`; create
`src/components/evCharging/PatternLegend.tsx`; create `src/routes/_authenticated/charging/patterns.browser.test.tsx`
only if the repo already has route-level browser tests (check `find src/routes -name '*.test.tsx'`); otherwise the
component tests + the live check cover it.

- [ ] **Step 1: `PatternLegend`** — "mindre [5 swatches] mer" using `intensity(1)` over `[0.05, 0.2, 0.45, 0.7, 1]`
as small `<span>`s with `style={{ background }}` (+ an optional `max` label for the calendar: "0 … 48 kWh").

- [ ] **Step 2: Wire the page** — in `PatternsPage` below `SyncHealthAlert`:

```tsx
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const metric = search.metric ?? 'kwh'
  const { data: patterns } = useQuery({ ...patternsQuery(search.year), placeholderData: keepPreviousData })
  const { data: timeline } = useQuery({ ...timelineQuery(search.year, search.month), placeholderData: keepPreviousData })
  const set = (next: Partial<typeof search>) =>
    navigate({ to: '.', search: (s) => ({ ...s, ...next }), replace: true, resetScroll: false })
  const hasData = patterns ? patterns.months.some((mo) => mo.sessions > 0 || mo.kwh > 0) : false
```
Then, in order: a controls row (`ToggleGroup` kWh / Inkopplad — reuse `ChartMetricToggle`'s markup pattern, with
`charging_patterns_metric_*` labels; `YearSelector years={patterns.years} value={patterns.year} onChange={(y) =>
set({ year: y, month: undefined })}`); if `!hasData` → one `<Empty>` with `charging_patterns_empty_title/description`
(`EmptyHeader`/`EmptyTitle`/`EmptyDescription` from `~/components/ui/empty`, as other pages use it); else four
`Card`s (`~/components/ui/card`), each with an `<h2 className="font-medium text-sm">` title:
1. heatmap (`title_kwh`/`title_plugged` by metric) + `PatternLegend` + `unhourly_note` when `unhourlySessions > 0`;
2. `HourOfDayChart`;
3. `ChargingCalendar` with `today = stockholmDayOf(Date.now())` and `onPickMonth={(mo) => set({ month: mo })}` plus a
   scroll of the timeline card into view (`ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })`,
   respecting `prefers-reduced-motion` → `behavior: 'auto'`);
4. `SessionTimeline` with `onMonth={(mo) => set({ month: mo })}`, legend (`timeline_charging`, `timeline_idle`,
   `timeline_clipped`) and the `timeline_estimate` footnote.
Dim the cards (`opacity-60`, `aria-busy`) while `isPlaceholderData`, as `/charging` does for its chart.

- [ ] **Step 3: Pre-PR gate** — full gate from `docs/feature-workflow.md#pre-pr-gate`.
- [ ] **Step 4: Live verification (Phase 6)** — `bun run dev:up`, `ZAPTEC_ADAPTER=fake bun run dev`, sign in as the
seeded admin, "Synka nu" to import fake sessions, open `/charging/patterns`; check desktop (1280), tablet (768) and
phone (375) in a real browser against the mockup: heatmap transposes on the phone, no horizontal page scroll, timeline
clipping, month link from the calendar, dark mode, year switch keeps the page stable. Screenshots into the PR.
- [ ] **Step 5: Commit** — `git commit -m "feat(charging): assemble the charging patterns page"` → open PR C.

---

## Self-review (done while writing)

- **Spec coverage:** routing + tabs + palette (A1, C1); pure module (B1–B3); service + `months` parity + New Year +
  lookback (B4); procedures + timings (B5); the four views (C2–C5); feedback/empty/unhourly/health (C1, C6);
  i18n (C1); tests per spec "Testing" (each task); live check (C6). Deviations 1–2 recorded above.
- **Types:** `Slot`, `DayTotal`, `MonthTotal`, `PatternSession`, `TimelineSession`, `ChargingPatterns`,
  `ChargingTimeline`, `PatternMetric` are defined once (B2/B3/C1) and consumed by those names.
- **Library use:** d3-time (hour split), d3-array (rollup/sum/max/group/range/transpose/bisect), d3-scale
  (scaleSqrt/scaleBand/scaleLinear), date-fns + `@date-fns/tz` (local labels, month grid), visx
  (heatmap/axis/shape/group/responsive/tooltip), Recharts (histogram). Hand-rolled: only the token colour mix.
