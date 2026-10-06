# House energy, step 1b: the Energi period control — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/energy`, choose any month, any year or all time (a `‹ period ⌄ ›` control with a picker that
never scrolls, or a click on a month in the chart), with no layout shift, a hover outline and tooltip with shares,
validated chart colours and the agreed readable sizes.

**Architecture:** A pure client-safe period module (`period.ts`) owns the `?period=` vocabulary, defaults and
stepping. The service drops the "current periods" tiles for `yearTotal` + `allTime` + `monthsWithReadings`, so a
month switch inside a year costs no request. The page derives the period from the URL, asks for the period's year,
and feeds the tiles from `months[m − 1]`, `yearTotal` or `allTime`. `PeriodTabs` is replaced by `PeriodControl`.

**Tech Stack:** Drizzle (`pg`), oRPC + TanStack Query, TanStack Router search params, Recharts 3.8 via shadcn
`ChartContainer`, shadcn `Popover` (Radix), Tailwind v4 container queries, Paraglide, Vitest (node + browser).

**Spec:** [`docs/superpowers/specs/2026-10-05-energy-period-control-design.md`](../specs/2026-10-05-energy-period-control-design.md)
(amends [`2026-10-05-house-energy-pages-design.md`](../specs/2026-10-05-house-energy-pages-design.md))
· ADR: [`0024`](../../adr/0024-house-energy-pages.md) decision 6 (amended)
· Roadmap: [`2026-10-05-house-energy-pages.md`](../roadmaps/2026-10-05-house-energy-pages.md) (step 1b)
· Mockup the owner approved: <https://claude.ai/artifact/BJF8ZV8vXwH3DhsPRWVtgv> (version 5)

## Global Constraints

- Read-only: `energy.overview` stays a `protectedProcedure`; only period sums leave the server (ADR-0024).
- Client code only `import type` from services; `period.ts` is client-safe (in the `clientSafe` guard).
- One overview request per **year**: switching months inside a year, or to Totalt, sends no request.
- **No layout shift**: changing the period moves no element (arrows, label, tiles card, chart). Reserve space
  instead of rendering conditionally.
- **Sizes (owner, 2026-10-05 — the app-wide scale; this page first):** readout label 14 px medium foreground;
  figure 36 px (28 px in the two-column grid); unit 16 px muted; detail and gap note 14 px muted; period label
  16 px semibold, "(hittills)" 14 px muted; card titles 18 px; chart ticks 13 px; legend 14 px; tooltip 14 px with
  shares 13 px; icons 16–20 px; tap targets ≥ 40 px (≥ 44 px in the picker). No `text-xs` on this page.
- **Colours** (validated, light / dark): solar `#eda100` / `#c98500`, battery `#1baf7a` / `#199e70`, sold
  `#2a78d6` / `#3987e5`, bought `#475569` / `#94a3b8`, house `#eb6834` / `#d95926`, car `#4a3aa7` / `#9085e9`.
- `?period=YYYY-MM | YYYY | all`; the legacy `?year=Y` reads as `?period=Y`; writes use `replace: true,
  resetScroll: false` and drop `year`.
- User-facing text via Paraglide (sv source, en key-complete). Synthetic data only in tests.
- Conventional Commits, one hat per commit. PR title: `feat(energy): choose any month on the Energi page`.

## Review Focus

1. **The first hour of a new month (or year)**: the current month has no readings yet. The default falls back to
   the newest month with readings this year, or Totalt in a new year's first hour; never an empty tiles card.
   Pinned in Task 1 (`defaultPeriod`).
2. **A hand-typed or stale URL** (`?period=2026-13`, `?period=2021-05`, `?period=abc`, `?year=2021`): the default
   period, the current year's chart, no error. Pinned in Task 1 (`parsePeriod`, `resolvePeriod`) and Task 7.
3. **Stepping over gaps and across years** (December 2025 → January 2026, a month without readings): the arrows
   skip to the next month with readings and disable at the ends. Pinned in Task 1 (`stepPeriod`).
4. **A past year's total** (`?period=2025`): its car kWh is that year's sum, not the current year's tile; a month
   without readings inside it counts as missing. Pinned in Task 2 (`yearTotal for a past year`).
5. **Long and short labels** ("september 2026 (hittills)" vs "Totalt"): the label cell keeps the widest width, so
   the arrows never move. Pinned in Task 5 (the stacked-labels test) and measured live in Task 8.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/houseEnergy/period.ts` (create) | Client-safe `EnergyPeriod`, `parsePeriod`, `formatPeriod`, `periodFromSearch`, `resolvePeriod`, `defaultPeriod`, `stepPeriod`, `periodQueryYear` |
| `src/lib/houseEnergy/period.test.ts` (create) | Node tests for every function |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (modify) | Add `period.ts` to the guard |
| `src/lib/services/houseEnergy/energyOverview.ts` (modify) | New `EnergyOverview` shape: `monthsWithReadings`, `yearTotal`, `allTime`; no `tiles` |
| `src/lib/services/houseEnergy/energyOverview.test.ts` (modify) | Tests for the new fields; the tile tests move to `yearTotal` / `allTime` |
| `src/lib/orpc/procedures/energy.ts` (modify) | Comment only (the shape) |
| `src/styles/app.css` (modify) | Validated `--energy-*` values; new `--energy-house`, `--energy-car` (+ `@theme` colours) |
| `src/components/evCharging/TotalsTiles.tsx` (modify) | `Readout` gains `size="lg"` (the agreed sizes, reserved detail lines); default unchanged |
| `src/components/evCharging/ChartFrame.tsx` (modify) | `ChartFrame` gains `className`; `TooltipRow` gains `share` |
| `src/components/energy/EnergyTiles.tsx` (modify) | Readouts for one `PeriodSums | null`, container grid, reserved gap line |
| `src/components/energy/PeriodTabs.tsx` (delete) | Replaced by `PeriodControl` |
| `src/components/energy/PeriodControl.tsx` (+ `.browser.test.tsx`) (create) | Stepper + popover picker, stacked labels |
| `src/components/energy/EnergyMonthlyChart.tsx` (+ test) (modify) | Click/Enter select, hover outline, selected tint, tooltip shares, sizes, colours |
| `src/components/energy/energyTooltip.ts` (+ test) (modify) | `energyTooltipRows` returns shares |
| `src/routes/_authenticated/energy/index.tsx` (+ `-energyPage.browser.test.tsx`) (modify) | `?period=`, period → query year, tiles card header, no year selector |
| `src/bones/energy-tiles.bones.json`, `energy-chart.bones.json` (regenerate) | `bun run bones:capture /energy --force` |
| `messages/sv.json`, `messages/en.json` (modify) | `energy_period_*`, `energy_chart_select_hint` |
| `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` (modify) | Row 1b → `PR open` |

---

### Task 0: Verify `main` still matches this plan

**Files:** none (read-only), then the worktree.

- [ ] **Step 1: Check the seams this plan names**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "export type EnergyOverview\|tiles: { thisMonth" src/lib/services/houseEnergy/energyOverview.ts
grep -n "export function PeriodTabs" src/components/energy/PeriodTabs.tsx
grep -n "export function Readout" src/components/evCharging/TotalsTiles.tsx
grep -n "export function ChartFrame\|export function TooltipRow" src/components/evCharging/ChartFrame.tsx
grep -n "export function stockholmYearMonth\|export function stockholmYearBounds" src/lib/time/stockholm.ts
grep -n '"recharts"' package.json        # 3.x: onClick gets { activeIndex }, useActiveTooltipLabel exists
ls src/components/ui/popover.tsx
grep -n "energy-tiles\|energy-chart" src/routes/_authenticated/energy/index.tsx
grep -n "syncHealthQuery" src/routes/_authenticated/energy/index.tsx   # the shared health read since #98 (client-perf step 3)
```

Expected: every grep prints a line; `EnergyOverview` still has `tiles.{thisMonth,thisYear,allTime}` and
`months`. If step 2 (Batteri) merged first, it also consumes `PeriodTabs` / `tiles`: add its route and
`BatteryTiles` to Tasks 4 and 7 before building.

- [ ] **Step 2: Create the worktree** (no `+` in the path; it hangs Vitest browser mode)

```bash
git worktree add .claude/worktrees/energy-period-control -b feat/energy-period-control origin/main
cd .claude/worktrees/energy-period-control && cp ../../../.env .env 2>/dev/null; bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: The period vocabulary (`period.ts`)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/houseEnergy/period.ts`, `src/lib/houseEnergy/period.test.ts`
- Modify: `src/lib/houseEnergy/clientSafe.browser.test.tsx`

**Interfaces:**
- Produces:
  - `type EnergyPeriod = { kind: 'month'; year: number; month: number } | { kind: 'year'; year: number } | { kind: 'all' }`
  - `parsePeriod(value: string | undefined): EnergyPeriod | null`
  - `formatPeriod(p: EnergyPeriod): string` — `'2026-08'`, `'2026'`, `'all'`
  - `periodFromSearch(search: { period?: string; year?: number }): EnergyPeriod | null` — `period` wins; `year` is legacy
  - `periodQueryYear(p: EnergyPeriod | null): number | undefined` — the year to request (undefined = the service's current year)
  - `defaultPeriod(monthsWithReadings: string[], now: { year: number; month: number }): EnergyPeriod`
  - `resolvePeriod(p: EnergyPeriod | null, monthsWithReadings: string[], now: { year: number; month: number }): EnergyPeriod`
  - `stepPeriod(p: EnergyPeriod, delta: 1 | -1, monthsWithReadings: string[]): EnergyPeriod | null`
  - `monthKey(year: number, month: number): string` — `'2026-08'`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/houseEnergy/period.test.ts
import { describe, expect, test } from 'vitest'
import {
  defaultPeriod,
  formatPeriod,
  monthKey,
  parsePeriod,
  periodFromSearch,
  periodQueryYear,
  resolvePeriod,
  stepPeriod,
} from './period'

const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-04', '2026-10']
const NOW = { year: 2026, month: 10 }

describe('parsePeriod / formatPeriod', () => {
  test.each([
    ['2026-08', { kind: 'month', year: 2026, month: 8 }],
    ['2026-1', null],
    ['2026-13', null],
    ['2026-00', null],
    ['2026', { kind: 'year', year: 2026 }],
    ['all', { kind: 'all' }],
    ['abc', null],
    ['', null],
    [undefined, null],
    ['1999', null],
    ['2101-01', null],
  ] as const)('%s', (value, expected) => {
    expect(parsePeriod(value)).toEqual(expected)
  })

  test('round trip', () => {
    for (const v of ['2026-08', '2025', 'all']) expect(formatPeriod(parsePeriod(v)!)).toBe(v)
  })

  test('monthKey pads the month', () => {
    expect(monthKey(2026, 3)).toBe('2026-03')
  })
})

describe('periodFromSearch', () => {
  test('period wins over the legacy year', () => {
    expect(periodFromSearch({ period: '2026-08', year: 2025 })).toEqual({ kind: 'month', year: 2026, month: 8 })
  })
  test('the legacy ?year= reads as a year period', () => {
    expect(periodFromSearch({ year: 2025 })).toEqual({ kind: 'year', year: 2025 })
  })
  test('nothing → null', () => {
    expect(periodFromSearch({})).toBeNull()
  })
})

describe('periodQueryYear', () => {
  test.each([
    [{ kind: 'month', year: 2025, month: 12 }, 2025],
    [{ kind: 'year', year: 2025 }, 2025],
    [{ kind: 'all' }, undefined],
    [null, undefined],
  ] as const)('%j → %s', (p, year) => {
    expect(periodQueryYear(p)).toBe(year)
  })
})

describe('defaultPeriod', () => {
  test('the current month when it has readings', () => {
    expect(defaultPeriod(MONTHS, NOW)).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
  test("a new month's first hour: the newest month with readings this year", () => {
    expect(defaultPeriod(MONTHS, { year: 2026, month: 11 })).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
  test("a new year's first hour: Totalt (no month this year yet)", () => {
    expect(defaultPeriod(MONTHS, { year: 2027, month: 1 })).toEqual({ kind: 'all' })
  })
  test('no readings at all: Totalt (the page shows the empty state anyway)', () => {
    expect(defaultPeriod([], NOW)).toEqual({ kind: 'all' })
  })
})

describe('resolvePeriod', () => {
  test('a month with readings stays', () => {
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 2 }, MONTHS, NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 2,
    })
  })
  test('a month without readings → the default', () => {
    expect(resolvePeriod({ kind: 'month', year: 2026, month: 3 }, MONTHS, NOW)).toEqual({
      kind: 'month',
      year: 2026,
      month: 10,
    })
  })
  test('a year with readings stays; a year without → the default', () => {
    expect(resolvePeriod({ kind: 'year', year: 2025 }, MONTHS, NOW)).toEqual({ kind: 'year', year: 2025 })
    expect(resolvePeriod({ kind: 'year', year: 2021 }, MONTHS, NOW)).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
  test('all stays; null → the default', () => {
    expect(resolvePeriod({ kind: 'all' }, MONTHS, NOW)).toEqual({ kind: 'all' })
    expect(resolvePeriod(null, MONTHS, NOW)).toEqual({ kind: 'month', year: 2026, month: 10 })
  })
})

describe('stepPeriod', () => {
  test('month steps skip months without readings', () => {
    expect(stepPeriod({ kind: 'month', year: 2026, month: 2 }, 1, MONTHS)).toEqual({ kind: 'month', year: 2026, month: 4 })
    expect(stepPeriod({ kind: 'month', year: 2026, month: 4 }, -1, MONTHS)).toEqual({ kind: 'month', year: 2026, month: 2 })
  })
  test('month steps cross a year boundary', () => {
    expect(stepPeriod({ kind: 'month', year: 2025, month: 12 }, 1, MONTHS)).toEqual({ kind: 'month', year: 2026, month: 1 })
  })
  test('the ends return null', () => {
    expect(stepPeriod({ kind: 'month', year: 2025, month: 11 }, -1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'month', year: 2026, month: 10 }, 1, MONTHS)).toBeNull()
  })
  test('year steps go through the years with readings', () => {
    expect(stepPeriod({ kind: 'year', year: 2025 }, 1, MONTHS)).toEqual({ kind: 'year', year: 2026 })
    expect(stepPeriod({ kind: 'year', year: 2026 }, 1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'year', year: 2025 }, -1, MONTHS)).toBeNull()
  })
  test('Totalt has no steps', () => {
    expect(stepPeriod({ kind: 'all' }, 1, MONTHS)).toBeNull()
    expect(stepPeriod({ kind: 'all' }, -1, MONTHS)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bunx vitest run src/lib/houseEnergy/period.test.ts`
Expected: FAIL, `Cannot find module './period'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/houseEnergy/period.ts
// Client-safe (ADR-0024, step 1b): the Energi pages' period — a month, a year
// or all time — as it lives in the URL (`?period=2026-08 | 2026 | all`), its
// default, and stepping. `monthsWithReadings` ('YYYY-MM', oldest first) comes
// from the overview; nothing here touches the clock or the server.
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'

export type EnergyPeriod =
  | { kind: 'month'; year: number; month: number }
  | { kind: 'year'; year: number }
  | { kind: 'all' }

type YearMonth = { year: number; month: number }

const inRange = (year: number) => year >= OVERVIEW_MIN_YEAR && year <= OVERVIEW_MAX_YEAR

export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`

export function parsePeriod(value: string | undefined): EnergyPeriod | null {
  if (!value) return null
  if (value === 'all') return { kind: 'all' }
  const month = /^(\d{4})-(\d{2})$/.exec(value)
  if (month) {
    const year = Number(month[1])
    const m = Number(month[2])
    return inRange(year) && m >= 1 && m <= 12 ? { kind: 'month', year, month: m } : null
  }
  if (/^\d{4}$/.test(value)) {
    const year = Number(value)
    return inRange(year) ? { kind: 'year', year } : null
  }
  return null
}

export function formatPeriod(p: EnergyPeriod): string {
  if (p.kind === 'all') return 'all'
  return p.kind === 'year' ? String(p.year) : monthKey(p.year, p.month)
}

/** `?period=` wins; the step-1 `?year=Y` still reads as the year Y. */
export function periodFromSearch(search: { period?: string; year?: number }): EnergyPeriod | null {
  return parsePeriod(search.period) ?? (search.year === undefined ? null : parsePeriod(String(search.year)))
}

/** The overview year to request; undefined lets the service pick the current year (Totalt, the default). */
export function periodQueryYear(p: EnergyPeriod | null): number | undefined {
  return p && p.kind !== 'all' ? p.year : undefined
}

/**
 * The current month; in a new month's first hour (no reading yet) the newest
 * month with readings this year; with none this year yet, Totalt.
 */
export function defaultPeriod(monthsWithReadings: string[], now: YearMonth): EnergyPeriod {
  if (monthsWithReadings.includes(monthKey(now.year, now.month))) {
    return { kind: 'month', year: now.year, month: now.month }
  }
  const thisYear = monthsWithReadings.filter((k) => k.startsWith(`${now.year}-`))
  const newest = thisYear[thisYear.length - 1]
  return newest ? (parsePeriod(newest) as EnergyPeriod) : { kind: 'all' }
}

const yearsOf = (monthsWithReadings: string[]) => [
  ...new Set(monthsWithReadings.map((k) => Number(k.slice(0, 4)))),
]

/** The period to show: the requested one when it has readings, else the default. */
export function resolvePeriod(
  p: EnergyPeriod | null,
  monthsWithReadings: string[],
  now: YearMonth,
): EnergyPeriod {
  if (p?.kind === 'all') return p
  if (p?.kind === 'month' && monthsWithReadings.includes(monthKey(p.year, p.month))) return p
  if (p?.kind === 'year' && yearsOf(monthsWithReadings).includes(p.year)) return p
  return defaultPeriod(monthsWithReadings, now)
}

/** The next / previous month (or year) with readings; null at the ends and for Totalt. */
export function stepPeriod(
  p: EnergyPeriod,
  delta: 1 | -1,
  monthsWithReadings: string[],
): EnergyPeriod | null {
  if (p.kind === 'all') return null
  if (p.kind === 'year') {
    const years = yearsOf(monthsWithReadings).sort((a, b) => a - b)
    const next = years[years.indexOf(p.year) + delta]
    return next === undefined || !years.includes(p.year) ? null : { kind: 'year', year: next }
  }
  const sorted = [...monthsWithReadings].sort()
  const i = sorted.indexOf(monthKey(p.year, p.month))
  const next = i === -1 ? undefined : sorted[i + delta]
  return next ? parsePeriod(next) : null
}
```

- [ ] **Step 4: Run to see it pass**

Run: `bunx vitest run src/lib/houseEnergy/period.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Add `period.ts` to the client-safe guard**

In `src/lib/houseEnergy/clientSafe.browser.test.tsx`, add `period.ts` next to `figures.ts` in the same pattern the
file already uses (a dynamic `import('./period')` that must not pull `~/lib/db`). Run:
`bunx vitest run --project browser src/lib/houseEnergy/clientSafe.browser.test.tsx` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/houseEnergy/period.ts src/lib/houseEnergy/period.test.ts src/lib/houseEnergy/clientSafe.browser.test.tsx
git commit -m "feat(energy): add the period vocabulary for ?period="
```

---

### Task 2: The read model's new shape

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Modify: `src/lib/services/houseEnergy/energyOverview.ts`, `energyOverview.test.ts`, `src/lib/orpc/procedures/energy.ts`

**Interfaces:**
- Consumes: `monthKey` (Task 1); the existing `monthRows()`, `withExpected`, `total`, `getChargingOverview`.
- Produces:

```ts
export type EnergyOverview = {
  year: number
  availableYears: number[]
  firstReadingDay: string | null
  /** 'YYYY-MM' of every month with readings, every year, oldest first (the picker and the stepper). */
  monthsWithReadings: string[]
  /** The chart year's total (expected buckets from the year's bounds), or null without readings that year. */
  yearTotal: PeriodSums | null
  allTime: PeriodSums | null
  months: (PeriodSums | null)[]
}
```

- [ ] **Step 1: Rewrite the tile tests as `yearTotal` / `allTime` tests, and add the new ones (failing)**

In `energyOverview.test.ts`:
- `an empty house` → expect `{ year: 2026, availableYears: [2026], firstReadingDay: null, monthsWithReadings: [], yearTotal: null, allTime: null, months: Array(12).fill(null) }`.
- Every `o.tiles.thisYear` → `o.yearTotal` **only where the test's chart year is the current year**; every
  `o.tiles.allTime` → `o.allTime`; delete assertions on `o.tiles.thisMonth` (a month is `o.months[m − 1]` now) and
  replace them with the same expectation on `o.months[m − 1]` where the month lies in the chart year.
- `tiles are the current periods whatever year the chart shows` becomes:

```ts
test('yearTotal follows the chart year; allTime spans years', async () => {
  await storeDay('2025-12-31', { gridImportKwh: 0.1 })
  await storeDay('2026-01-01', { gridImportKwh: 0.2 })
  const o = await getEnergyOverview({ year: 2025, now: new Date('2026-01-01T20:00:00Z') })
  expect(o.year).toBe(2025)
  expect(o.yearTotal?.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(o.allTime?.gridImportKwh).toBeCloseTo(86.4, 9)
  expect(o.allTime?.buckets).toBe(576)
  expect(o.monthsWithReadings).toEqual(['2025-12', '2026-01'])
})
```

- Add:

```ts
test('yearTotal for a past year: its own car kWh, and a month without readings counts as missing', async () => {
  await storeDay('2025-05-10')
  await storeDay('2025-07-10')
  await storeDay('2026-05-10')
  const chargerId = await insertCharger()
  const mk = async (start: string, end: string, kwh: number) => {
    const id = await insertSession({ chargerId, startAt: new Date(start), endAt: new Date(end), energyKwh: kwh })
    await insertInterval(id, new Date(start), new Date(end), kwh)
  }
  await mk('2025-05-10T10:00:00Z', '2025-05-10T11:00:00Z', 4)
  await mk('2025-07-10T10:00:00Z', '2025-07-10T11:00:00Z', 3)
  await mk('2026-05-10T10:00:00Z', '2026-05-10T11:00:00Z', 6)
  const o = await getEnergyOverview({ year: 2025, now: new Date('2026-05-20T12:00:00Z') })
  expect(o.yearTotal?.carKwh).toBe(7)
  // 2025-05-10 00:00 → 2026-01-01 00:00 expected (first reading day → year end), 2 days stored.
  const y = o.yearTotal
  expect(y && y.expectedBuckets - y.buckets).toBe((236 - 2) * 288 + 12) // 236 days; the October DST day has 25 h (+12)
  expect(o.allTime?.carKwh).toBe(13)
})

test('monthsWithReadings lists every month with readings, oldest first, across years', async () => {
  await storeDay('2025-11-02')
  await storeDay('2026-02-14')
  await storeDay('2026-02-15')
  const o = await getEnergyOverview({ now: new Date('2026-03-01T12:00:00Z') })
  expect(o.monthsWithReadings).toEqual(['2025-11', '2026-02'])
})
```

> Note on the expected-buckets arithmetic: from 2025-05-10 00:00 (Stockholm) to 2026-01-01 00:00 is 236 calendar
> days, one of them (2025-10-26) 25 h long, so 236 × 288 + 12 buckets are expected; 2 × 288 are stored. The
> implementer recomputes this with `stockholmDayBounds` if the assertion disagrees and fixes the literal, not the
> code, after checking the code uses the year's bounds clipped to the first reading's day.

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts` → FAIL (`yearTotal` undefined).

- [ ] **Step 2: Implement the shape change**

In `energyOverview.ts`:
- Replace the `EnergyOverview` type with the one in **Interfaces** (doc comments as written there).
- The empty return becomes:

```ts
return {
  year: current.year,
  availableYears: [current.year],
  firstReadingDay: null,
  monthsWithReadings: [],
  yearTotal: null,
  allTime: null,
  months: Array(12).fill(null),
}
```

- Replace the `tiles: { … }` block of the final return with:

```ts
const yearCarKwh = car.months.reduce((sum, mo) => sum + mo.kwh, 0)
return {
  year,
  availableYears,
  firstReadingDay,
  monthsWithReadings: rows.map((row) => monthKey(row.year, row.month)),
  yearTotal: withCar(total(rows.filter((row) => row.year === year), stockholmYearBounds(year)), yearCarKwh),
  allTime: withCar(total(rows, { startMs: coverageStartMs, endMs: newestEndMs }), car.tiles.allTime.kwh),
  months,
}
```

- Remove `stockholmMonthBounds(current…)`-only uses that no longer exist (keep `stockholmMonthBounds` for
  `withExpected`), import `monthKey` from `~/lib/houseEnergy/period`, and update the function's doc comment:
  "monthly sums of the chart's year, that year's total, all time, and the list of months with readings".
- `current` is still needed for the year fallback and `availableYears`.

In `src/lib/orpc/procedures/energy.ts`, change the comment's "plus this month / this year / all time" to "plus the
chart year's total, all time and the months with readings". No code change.

- [ ] **Step 3: Run the service and procedure tests**

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts`
Expected: PASS. If `energy.test.ts` asserts on `tiles`, update it to `yearTotal` / `allTime` in the same way.

- [ ] **Step 4: Typecheck to find every consumer**

Run: `bunx tsc --noEmit 2>&1 | grep -n "tiles\|EnergyOverview" | head -30`
Expected: errors only in `src/routes/_authenticated/energy/index.tsx` and its browser test (Task 7 rewrites
both). Leave them; do not patch the route here.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/houseEnergy src/lib/orpc/procedures/energy.ts
git commit -m "feat(energy): return the chart year's total and the months with readings"
```

> The branch doesn't typecheck between Task 2 and Task 7. Run per-file tests in between; the pre-PR gate runs at
> the end.

---

### Task 3: Validated energy colours

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and the `dataviz` skill (re-runs the
validator).

**Files:**
- Modify: `src/styles/app.css`, `src/components/energy/EnergyMonthlyChart.tsx` (series config only)

- [ ] **Step 1: Replace the token values**

In `src/styles/app.css`, light block (`:root`, around line 138):

```css
  /* Energy series (ADR-0024 step 1b): one meaning per colour, validated with the
     data-viz palette validator (--pairs all, light on #fff / dark on #1c1c1f). */
  --energy-grid: #475569;
  --energy-battery: #1baf7a;
  --energy-solar: #eda100;
  --energy-export: #2a78d6;
  --energy-house: #eb6834;
  --energy-car: #4a3aa7;
```

Dark block (`.dark`, around line 213):

```css
  --energy-grid: #94a3b8;
  --energy-battery: #199e70;
  --energy-solar: #c98500;
  --energy-export: #3987e5;
  --energy-house: #d95926;
  --energy-car: #9085e9;
```

In `@theme inline` (around line 61), next to the existing four:

```css
    --color-energy-house: var(--energy-house);
    --color-energy-car: var(--energy-car);
```

- [ ] **Step 2: Point the consumption series at the new tokens**

In `EnergyMonthlyChart.tsx` `seriesConfig()`:

```ts
    car: { label: m.energy_series_car(), color: 'var(--energy-car)' },
    house: { label: m.energy_series_house(), color: 'var(--energy-house)' },
```

- [ ] **Step 3: Re-validate**

```bash
V=$(ls -d /private/tmp/claude-*/bundled-skills/*/*/dataviz 2>/dev/null | head -1)   # or load the dataviz skill and use its base dir
for set in "light #ffffff #eda100,#475569,#2a78d6,#1baf7a" "dark #1c1c1f #c98500,#94a3b8,#3987e5,#199e70" \
           "light #ffffff #eb6834,#4a3aa7" "dark #1c1c1f #d95926,#9085e9"; do
  bash -c "set -- $set; node $V/scripts/validate_palette.js \"\$3\" --mode \$1 --surface \"\$2\" --pairs all" ; done
```

Expected: no `[FAIL]` (the chroma floor fails for slate by design; the grey is the grid's neutral). A light-mode
contrast `[WARN]` for yellow/aqua is expected: the legend and tooltip carry identity.

- [ ] **Step 4: Check `/charging` still reads** (`EnergySourceBar` uses solar/battery/grid): run
`bunx vitest run --project browser src/components/evCharging/EnergySourceBar.browser.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/styles/app.css src/components/energy/EnergyMonthlyChart.tsx
git commit -m "feat(energy): use validated colours for the energy series"
```

---

### Task 4: Readouts at the agreed sizes, without shift

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`.

**Files:**
- Modify: `src/components/evCharging/TotalsTiles.tsx` (`Readout`), `src/components/energy/EnergyTiles.tsx`,
  `src/components/energy/EnergyTiles.browser.test.tsx`

**Interfaces:**
- Produces: `Readout` prop `size?: 'md' | 'lg'` (default `'md'`, unchanged output); `EnergyReadouts({ sums }: { sums: PeriodSums | null })`
  exported from `EnergyTiles.tsx` (no card, no tabs: the page owns the card and the control).

- [ ] **Step 1: Write the failing tiles tests**

Replace `EnergyTiles.browser.test.tsx`'s period-tab tests (`switching to I år`, `opens on the first period with
data`, `a period without data says so`) with:

```tsx
test('a period without data says so, in the same reserved space', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={null} />)
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('the gap line is always rendered, empty when the period is complete', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={sums()} />)
  const gap = screen.container.querySelector('[data-slot="energy-gap"]')
  expect(gap).not.toBeNull()
  expect(gap?.textContent).toBe('')
})

test('every detail slot is rendered, even without a detail', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts sums={sums({ solarKwh: 0, batteryChargeGridKwh: 0, carKwh: 0 })} />,
  )
  expect(screen.container.querySelectorAll('[data-slot="readout-detail"]')).toHaveLength(5)
})
```

Keep the other tests, changing `<EnergyTiles tiles={{ thisMonth: X, … }} />` to `<EnergyReadouts sums={X} />`.
Run: `bunx vitest run --project browser src/components/energy/EnergyTiles.browser.test.tsx` → FAIL.

- [ ] **Step 2: Add `size="lg"` to `Readout`**

In `TotalsTiles.tsx`, `Readout` takes `size?: 'md' | 'lg'` and, when `lg`, renders (md stays exactly as today):

```tsx
const lg = size === 'lg'
return (
  <div className="flex min-w-0 flex-col gap-1">
    <span
      className={cn(
        'flex items-center gap-1',
        lg ? 'font-medium text-foreground text-sm' : 'text-muted-foreground text-xs',
      )}
    >
      <Icon aria-hidden className={cn('shrink-0', lg ? 'size-4' : 'size-3')} />
      {label}
    </span>
    <span className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
      {/* qualifier as today */}
      <span
        className={cn(
          'font-semibold leading-tight',
          lg ? 'text-[28px] @[35rem]:text-4xl' : 'text-2xl',
          muted && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
      {unit ? (
        <>
          {' '}
          <span className={cn('text-muted-foreground', lg ? 'text-base' : 'text-sm')}>{unit}</span>
        </>
      ) : null}
    </span>
    {/* lg reserves two lines so a period without a detail doesn't shorten the card. */}
    {lg ? (
      <span
        data-slot="readout-detail"
        className="flex min-h-[3em] flex-col text-muted-foreground text-sm leading-normal"
      >
        {detail}
      </span>
    ) : detail ? (
      <span className="flex flex-col text-muted-foreground text-sm">{detail}</span>
    ) : null}
  </div>
)
```

- [ ] **Step 3: Replace `EnergyTiles` with `EnergyReadouts`**

```tsx
// src/components/energy/EnergyTiles.tsx — keep PeriodReadouts' figure logic as is; this is its new shell.
export function EnergyReadouts({ sums }: { sums: PeriodSums | null }) {
  return (
    <div className="@container flex flex-col gap-3">
      {sums ? (
        <PeriodReadouts sums={sums} />
      ) : (
        <p className="min-h-[7.5rem] text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
      )}
    </div>
  )
}
```

In `PeriodReadouts`: pass `size="lg"` to every `Readout`; the grid becomes
`grid grid-cols-2 gap-x-4 gap-y-5 @[35rem]:grid-cols-3 @[61.25rem]:grid-cols-5`; the gap note becomes always
rendered:

```tsx
<p data-slot="energy-gap" className="min-h-[1.5em] text-muted-foreground text-sm leading-normal">
  {gap === null ? null : m.energy_missing_hours({ hours: String(gap) })}
</p>
```

Delete `EnergyTiles` (the tabbed wrapper) and `src/components/energy/PeriodTabs.tsx`; keep `EnergyTilesData` out.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run --project browser src/components/energy/EnergyTiles.browser.test.tsx src/components/evCharging/TotalsTiles.browser.test.tsx`
Expected: PASS (the charging tiles are unchanged: `size` defaults to `md`).

- [ ] **Step 5: Commit**

```bash
git add src/components/evCharging/TotalsTiles.tsx src/components/energy
git commit -m "feat(energy): size the readouts for reading and reserve their lines"
```

---

### Task 5: The period control

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`
(focus: keyboard, focus return, target sizes, the stacked-label width).

**Files:**
- Create: `src/components/energy/PeriodControl.tsx`, `src/components/energy/PeriodControl.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `EnergyPeriod`, `stepPeriod`, `monthKey`, `formatPeriod` (Task 1); `monthName`, `monthLabel` (`~/components/evCharging/format`).
- Produces:

```ts
export function PeriodControl(props: {
  period: EnergyPeriod
  monthsWithReadings: string[]
  /** The current Stockholm month: its label and the picker say "hittills". */
  current: { year: number; month: number }
  onChange: (p: EnergyPeriod) => void
}): JSX.Element
```

- [ ] **Step 1: Add the messages**

`messages/sv.json` (and the English in `en.json`, same keys):

| Key | sv | en |
|---|---|---|
| `energy_period_month` | `{month} {year}` | `{month} {year}` |
| `energy_period_year` | `År {year}` | `Year {year}` |
| `energy_period_whole_year` | `Hela {year}` | `All of {year}` |
| `energy_period_choose` | `Period: {period}. Välj period` | `Period: {period}. Choose period` |
| `energy_period_picker` | `Välj period` | `Choose period` |
| `energy_period_prev_month` | `Föregående månad` | `Previous month` |
| `energy_period_next_month` | `Nästa månad` | `Next month` |
| `energy_period_prev_year` | `Föregående år` | `Previous year` |
| `energy_period_next_year` | `Nästa år` | `Next year` |
| `energy_chart_select_hint` | `Klicka på en månad för att visa den i summeringen.` | `Click a month to show it in the summary.` |

Totalt reuses `charging_tile_all_time`; "hittills" reuses `energy_chart_so_far`. Run `bun run i18n:compile`.

- [ ] **Step 2: Write the failing tests**

```tsx
// src/components/energy/PeriodControl.browser.test.tsx
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { PeriodControl } from './PeriodControl'

const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-04', '2026-10']
const CURRENT = { year: 2026, month: 10 }
const aug: EnergyPeriod = { kind: 'month', year: 2026, month: 2 }

function setup(period: EnergyPeriod = aug) {
  const onChange = vi.fn()
  const r = renderWithProviders(
    <PeriodControl period={period} monthsWithReadings={MONTHS} current={CURRENT} onChange={onChange} />,
  )
  return { ...r, onChange }
}

test('the arrows step to the neighbouring months with readings', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: m.energy_period_next_month() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 4 })
  await userEvent.click(screen.getByRole('button', { name: m.energy_period_prev_month() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 1 })
})

test('the arrows disable at the ends and for Totalt', async () => {
  const first = await setup({ kind: 'month', year: 2025, month: 12 })
  await expect.element(first.screen.getByRole('button', { name: m.energy_period_prev_month() })).toBeDisabled()
  first.screen.unmount()
  const all = await setup({ kind: 'all' })
  const buttons = all.screen.container.querySelectorAll('button[disabled]')
  expect(buttons.length).toBe(2)
})

test('every possible label is stacked in the label cell, only the current one visible', async () => {
  const { screen } = await setup()
  const cell = screen.container.querySelector('[data-slot="period-labels"]')
  // 5 months + 2 years + Totalt
  expect(cell?.children).toHaveLength(8)
  expect(cell?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(7)
})

test('the picker shows the year’s twelve months, disables those without readings, and picks one', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  await expect.element(dialog).toBeVisible()
  const months = dialog.getByRole('button', { name: /^(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)/i })
  expect(months.elements()).toHaveLength(12)
  await expect.element(dialog.getByRole('button', { name: /^mar/i })).toBeDisabled()
  await userEvent.click(dialog.getByRole('button', { name: /^apr/i }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 4 })
})

test('the picker picks the whole year and Totalt, and changes year without closing', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  await userEvent.click(dialog.getByRole('button', { name: m.energy_period_prev_year() }))
  await expect.element(dialog.getByText('2025')).toBeVisible()
  await userEvent.click(dialog.getByRole('button', { name: m.energy_period_whole_year({ year: '2025' }) }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'year', year: 2025 })
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  await userEvent.click(screen.getByRole('button', { name: m.charging_tile_all_time() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'all' })
})

test('the current month says hittills; Escape closes the picker and returns focus', async () => {
  const { screen } = await setup({ kind: 'month', year: 2026, month: 10 })
  const trigger = screen.getByRole('button', { name: /Välj period|Choose period/ })
  await expect.element(trigger).toHaveTextContent(m.energy_chart_so_far())
  await userEvent.click(trigger)
  await userEvent.keyboard('{Escape}')
  await expect.element(trigger).toHaveFocus()
})
```

Run: `bunx vitest run --project browser src/components/energy/PeriodControl.browser.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```tsx
// src/components/energy/PeriodControl.tsx
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { monthLabel, monthName } from '~/components/evCharging/format'
import { Button } from '~/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import {
  type EnergyPeriod,
  formatPeriod,
  monthKey,
  parsePeriod,
  stepPeriod,
} from '~/lib/houseEnergy/period'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type YearMonth = { year: number; month: number }

function labelOf(p: EnergyPeriod, current: YearMonth): { main: string; soFar: boolean } {
  if (p.kind === 'all') return { main: m.charging_tile_all_time(), soFar: false }
  if (p.kind === 'year') return { main: m.energy_period_year({ year: String(p.year) }), soFar: p.year === current.year }
  return {
    main: m.energy_period_month({ month: monthName(p.month), year: String(p.year) }),
    soFar: p.year === current.year && p.month === current.month,
  }
}

// The tiles card's period: ‹ label ⌄ ›. The arrows step within the kind; the
// label opens a picker that never scrolls (spec "The period control"). Every
// label it can show is stacked in one grid cell, so the cell is as wide as the
// widest and the arrows never move (no measuring, SSR-safe).
export function PeriodControl({
  period,
  monthsWithReadings,
  current,
  onChange,
}: {
  period: EnergyPeriod
  monthsWithReadings: string[]
  current: YearMonth
  onChange: (p: EnergyPeriod) => void
}) {
  const [open, setOpen] = useState(false)
  const years = [...new Set(monthsWithReadings.map((k) => Number(k.slice(0, 4))))].sort((a, b) => a - b)
  const all: EnergyPeriod[] = [
    ...monthsWithReadings.map((k) => parsePeriod(k) as EnergyPeriod),
    ...years.map((year) => ({ kind: 'year', year }) as const),
    { kind: 'all' },
  ]
  const prev = stepPeriod(period, -1, monthsWithReadings)
  const next = stepPeriod(period, 1, monthsWithReadings)
  const unit = period.kind === 'year' ? 'year' : 'month'
  const shown = labelOf(period, current)
  const pick = (p: EnergyPeriod) => {
    setOpen(false)
    onChange(p)
  }

  return (
    <div className="flex w-full items-center gap-0.5 sm:w-auto">
      <Button
        variant="ghost"
        size="icon"
        className="size-10 text-muted-foreground"
        disabled={!prev}
        onClick={() => prev && onChange(prev)}
        aria-label={unit === 'year' ? m.energy_period_prev_year() : m.energy_period_prev_month()}
      >
        <ChevronLeftIcon className="size-5" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 flex-1 px-3 font-semibold text-base sm:flex-none"
            aria-label={m.energy_period_choose({ period: `${shown.main}${shown.soFar ? ` ${m.energy_chart_so_far()}` : ''}` })}
          >
            <span data-slot="period-labels" className="grid justify-items-center">
              {all.map((p) => {
                const l = labelOf(p, current)
                const isShown = formatPeriod(p) === formatPeriod(period)
                return (
                  <span
                    key={formatPeriod(p)}
                    aria-hidden={isShown ? undefined : true}
                    className={cn('col-start-1 row-start-1 whitespace-nowrap', !isShown && 'invisible')}
                  >
                    {l.main}
                    {l.soFar ? (
                      <span className="ml-1.5 font-normal text-muted-foreground text-sm">
                        ({m.energy_chart_so_far()})
                      </span>
                    ) : null}
                  </span>
                )
              })}
            </span>
            <ChevronDownIcon aria-hidden className="size-[18px] text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] gap-2 p-2.5" aria-label={m.energy_period_picker()}>
          <Picker
            period={period}
            years={years}
            monthsWithReadings={monthsWithReadings}
            current={current}
            onPick={pick}
          />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="size-10 text-muted-foreground"
        disabled={!next}
        onClick={() => next && onChange(next)}
        aria-label={unit === 'year' ? m.energy_period_next_year() : m.energy_period_next_month()}
      >
        <ChevronRightIcon className="size-5" />
      </Button>
    </div>
  )
}

function Picker({
  period,
  years,
  monthsWithReadings,
  current,
  onPick,
}: {
  period: EnergyPeriod
  years: number[]
  monthsWithReadings: string[]
  current: YearMonth
  onPick: (p: EnergyPeriod) => void
}) {
  const [year, setYear] = useState(period.kind === 'all' ? (years[years.length - 1] ?? current.year) : period.year)
  const i = years.indexOf(year)
  const selected = formatPeriod(period)
  const choice = (p: EnergyPeriod) =>
    cn(
      'min-h-11 rounded-md border border-transparent text-[15px] hover:bg-muted disabled:pointer-events-none disabled:opacity-40',
      formatPeriod(p) === selected && 'border-brand bg-brand/10 font-semibold text-brand',
    )
  return (
    // PopoverContent is the dialog (Radix sets role="dialog"; it carries the label).
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon" className="size-10" disabled={i <= 0} onClick={() => setYear(years[i - 1])} aria-label={m.energy_period_prev_year()}>
          <ChevronLeftIcon className="size-5" />
        </Button>
        <span className="font-semibold text-base">{year}</span>
        <Button variant="ghost" size="icon" className="size-10" disabled={i === -1 || i >= years.length - 1} onClick={() => setYear(years[i + 1])} aria-label={m.energy_period_next_year()}>
          <ChevronRightIcon className="size-5" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 12 }, (_, idx) => {
          const month = idx + 1
          const p: EnergyPeriod = { kind: 'month', year, month }
          const soFar = year === current.year && month === current.month
          return (
            <button
              key={month}
              type="button"
              disabled={!monthsWithReadings.includes(monthKey(year, month))}
              onClick={() => onPick(p)}
              aria-current={formatPeriod(p) === selected ? 'true' : undefined}
              aria-label={`${monthName(month)} ${year}${soFar ? ` ${m.energy_chart_so_far()}` : ''}`}
              className={cn(choice(p), 'flex flex-col items-center justify-center leading-tight')}
            >
              {monthLabel(month)}
              {soFar ? <span className="text-muted-foreground text-xs">{m.energy_chart_so_far()}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-2 gap-1 border-t pt-2">
        <button type="button" disabled={!years.includes(year)} onClick={() => onPick({ kind: 'year', year })} className={cn(choice({ kind: 'year', year }), 'border-border')}>
          {m.energy_period_whole_year({ year: String(year) })}
        </button>
        <button type="button" onClick={() => onPick({ kind: 'all' })} className={cn(choice({ kind: 'all' }), 'border-border')}>
          {m.charging_tile_all_time()}
        </button>
      </div>
    </div>
  )
}
```

> The month buttons' accessible name is the full month ("april 2026"); the test's `/^apr/i` matches it. The
> "hittills" sub-label in the grid is 12 px: it's a caption inside a 44 px button, the one place the scale allows
> 12 px. If a reviewer objects, 13 px.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run --project browser src/components/energy/PeriodControl.browser.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/energy/PeriodControl.tsx src/components/energy/PeriodControl.browser.test.tsx messages src/paraglide
git commit -m "feat(energy): add the period stepper and picker"
```

(If `src/paraglide/` is gitignored, leave it out.)

---

### Task 6: The chart: select, outline, tooltip shares, sizes

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines`, `vercel-react-best-practices` and the
`dataviz` skill (marks, hover layer, tooltip).

**Files:**
- Modify: `src/components/energy/energyTooltip.ts` (+ `energyTooltip.test.ts`), `src/components/energy/EnergyMonthlyChart.tsx`
  (+ `.browser.test.tsx`), `src/components/evCharging/ChartFrame.tsx`

**Interfaces:**
- Consumes: Task 3's tokens.
- Produces: `EnergyMonthlyChart` props become
  `{ year; months; metric; currentMonth; selectedMonth: number | null; onSelectMonth: (month: number) => void }`;
  `energyTooltipRows(metric, p)` parts gain `share: number | null` (share of `totalKwh` for stacked parts; null for
  Nät's export and when the total is 0); `ChartFrame` gains `className?: string`; `TooltipRow` gains `share?: string`.

- [ ] **Step 1: Shares — failing unit test**

In `energyTooltip.test.ts` add:

```ts
test('stacked parts carry their share of the total; Nät export has none', () => {
  const p = sums({ solarKwh: 100, batteryChargeSolarKwh: 20, gridExportKwh: 30, gridImportKwh: 50, batteryChargeGridKwh: 10 })
  const solar = energyTooltipRows('solar', p).parts
  expect(solar.map((r) => r.share)).toEqual([0.5, 0.2, 0.3])
  const grid = energyTooltipRows('grid', p).parts
  expect(grid.find((r) => r.key === 'importBattery')?.share).toBeCloseTo(0.2, 9)
  expect(grid.find((r) => r.key === 'exported')?.share).toBeNull()
})

test('a zero total gives no shares', () => {
  expect(energyTooltipRows('solar', sums({ solarKwh: 0, batteryChargeSolarKwh: 0, gridExportKwh: 0 })).parts.every((r) => r.share === null)).toBe(true)
})
```

(Use the file's existing `sums` helper; add one in the same shape as the tiles test if it has none.)
Run: `bunx vitest run src/components/energy/energyTooltip.test.ts` → FAIL.

- [ ] **Step 2: Implement shares**

In `energyTooltipRows`, change the return to:

```ts
const parts = METRIC_SERIES[metric].map((key) => ({
  key,
  kwh: value[key],
  share: totalKwh > 0 && !isBelowAxis(metric, key) ? value[key] / totalKwh : null,
}))
return { parts, totalKwh }
```

(Move `isBelowAxis` above `energyTooltipRows` if needed.) Run the test → PASS.

- [ ] **Step 3: `ChartFrame` and `TooltipRow` options**

```tsx
// ChartFrame: className merged after the default
<ChartContainer config={config} className={cn('aspect-auto w-full', className)} style={{ height: CHART_HEIGHT }}>
```

```tsx
// TooltipRow: an optional share column (smaller, muted, right-aligned)
{share === undefined ? null : (
  <span className="w-10 text-right text-[13px] text-muted-foreground tabular-nums">{share}</span>
)}
```

placed after the value span, inside the row's flex container. Defaults leave `/charging` unchanged.

- [ ] **Step 4: Chart behaviour — failing browser tests**

Add to `EnergyMonthlyChart.browser.test.tsx` (render with `selectedMonth={2}` and an `onSelectMonth` spy):

```tsx
test('clicking a month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  const bars = screen.container.querySelectorAll('.recharts-bar-rectangle')
  await userEvent.click(bars[3] as Element) // a bar of April (index 3)
  expect(onSelectMonth).toHaveBeenCalledWith(4)
})

test('the selected month is marked: a tinted area and a bold tick', async () => {
  const { screen } = await renderChart({ selectedMonth: 2 })
  expect(screen.container.querySelector('[data-slot="selected-month"]')).not.toBeNull()
  const bold = screen.container.querySelector('.recharts-cartesian-axis-tick text[font-weight="600"]')
  expect(bold?.textContent).toBe(monthLabel(2))
})

test('a tooltip row shows the share of the total', async () => {
  const { screen } = await renderChart({ metric: 'solar' })
  await userEvent.hover(screen.container.querySelectorAll('.recharts-bar-rectangle')[0] as Element)
  await expect.element(screen.getByText(/^\d+\s%$/).first()).toBeVisible()
})

test('Enter on the keyboard-focused month selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await renderChart({ onSelectMonth })
  const surface = screen.container.querySelector('.recharts-surface') as HTMLElement
  surface.focus()
  await userEvent.keyboard('{ArrowRight}{Enter}')
  expect(onSelectMonth).toHaveBeenCalledTimes(1)
})
```

(`renderChart` = the file's existing render helper, extended with `selectedMonth` / `onSelectMonth` props that
default to `null` / `vi.fn()`.) Run → FAIL.

- [ ] **Step 5: Implement the chart changes**

In `EnergyMonthlyChart.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react'
import { BarChart, CartesianGrid, ReferenceArea, ReferenceLine, Bar, XAxis, YAxis, useActiveTooltipLabel, useChartWidth } from 'recharts'

// The hovered (or keyboard-focused) month: an outline round the whole column,
// its label included (the tick band below the plot).
function HoverColumn(props: { x?: number; y?: number; width?: number; height?: number }) {
  const { x = 0, y = 0, width = 0, height = 0 } = props
  return <rect x={x + 2} y={y} width={Math.max(0, width - 4)} height={height + 30} rx={6} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} />
}

// Tells the page which month the keyboard (or pointer) is on, for Enter.
function ActiveLabel({ onChange }: { onChange: (label: string | undefined) => void }) {
  const label = useActiveTooltipLabel()
  useEffect(() => {
    onChange(label === undefined ? undefined : String(label))
  }, [label, onChange])
  return null
}

function MonthTick(props: { x?: number; y?: number; payload?: { value: string; index: number }; selectedLabel?: string }) {
  const width = useChartWidth() ?? 0
  const { x = 0, y = 0, payload, selectedLabel } = props
  if (!payload) return null
  const narrow = width / 12 < 36
  const selected = payload.value === selectedLabel
  return (
    <text x={x} y={y + 14} textAnchor="middle" fontSize={13} fill={selected ? 'var(--foreground)' : 'var(--muted-foreground)'} fontWeight={selected ? 600 : 400}>
      {narrow ? payload.value.charAt(0).toUpperCase() : payload.value}
    </text>
  )
}
```

`ActiveLabel` writes into a ref through a stable `onChange` (`useCallback`), so no re-render. In the component:

```tsx
const activeLabel = useRef<string | undefined>(undefined)
const setActiveLabel = useCallback((l: string | undefined) => {
  activeLabel.current = l
}, [])
const selectByLabel = (label: string | undefined) => {
  const row = data.find((r) => r.label === label)
  if (row?.sums) onSelectMonth(row.month)
}
const selectedLabel = selectedMonth === null ? undefined : monthLabel(selectedMonth)
```

Wrap the `ChartFrame` in a `div` with `onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectByLabel(activeLabel.current) } }}`
and `className="[&_.recharts-surface]:cursor-pointer"`. Then:

```tsx
<ChartFrame config={config} className="text-[13px] [&_.recharts-legend-wrapper]:text-sm">
  <BarChart
    data={data}
    stackOffset={metric === 'grid' ? 'sign' : 'none'}
    margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
    onClick={(state) => {
      const i = Number(state?.activeIndex)
      if (Number.isInteger(i) && data[i]?.sums) onSelectMonth(i + 1)
    }}
  >
    <CartesianGrid vertical={false} />
    {selectedLabel ? (
      <ReferenceArea data-slot="selected-month" x1={selectedLabel} x2={selectedLabel} fill="var(--brand)" fillOpacity={0.12} strokeOpacity={0} ifOverflow="visible" />
    ) : null}
    <XAxis dataKey="label" tickLine={false} tickMargin={8} interval={0} tick={<MonthTick selectedLabel={selectedLabel} />} />
    {/* YAxis, ReferenceLine as before */}
    <ChartTooltip cursor={<HoverColumn />} content={/* as before, EnergyTooltip */} />
    <ActiveLabel onChange={setActiveLabel} />
    {/* ChartLegend as before */}
    {series.map((key) => (
      <Bar key={key} dataKey={key} stackId="kwh" fill={`var(--color-${key})`}
        radius={isBelowAxis(metric, key) ? [0, 0, 2, 2] : key === top ? [2, 2, 0, 0] : 0}
        stroke="var(--card)" strokeWidth={2} isAnimationActive={false} />
    ))}
  </BarChart>
</ChartFrame>
<p className="mt-2 text-muted-foreground text-sm">{m.energy_chart_select_hint()}</p>
```

> `data-slot` on `ReferenceArea`: if Recharts doesn't forward it to the `rect`, use `className="selected-month"`
> and change the test's selector to `.selected-month`. Verify z-order live (Task 8): the tint must sit behind
> the bars; if it draws above, give it `zIndex={0}` (Recharts 3 layers) or lower `fillOpacity` to 0.08.

`EnergyTooltip`: container `grid min-w-56 gap-1 rounded-lg border bg-background px-3 py-2 text-sm shadow-xl`; the
header `font-semibold text-[15px]`; each part row passes `share={part.share === null ? undefined : formatShare(part.share)}`;
the total row and Såld (Nät) pass no share; **remove the self-sufficiency row** (the spec's tooltip lists the parts,
the total, Såld and the gap note). Set the existing `seam` const aside (replaced by the `stroke`/`strokeWidth` above).

- [ ] **Step 6: Run the chart tests**

Run: `bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx src/components/energy/energyTooltip.test.ts`
Expected: PASS. Update the step-1 tooltip test that asserted the self-sufficiency row (drop that assertion). Read
legend names from `.recharts-legend-wrapper`, not page-wide `getByText` (CI strict-mode flake).

- [ ] **Step 7: Commit**

```bash
git add src/components/energy src/components/evCharging/ChartFrame.tsx
git commit -m "feat(energy): select a month from the chart, with an outline and shares"
```

---

### Task 7: The page: `?period=`, the control, the chart year

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and `vercel-react-best-practices`
(focus: no layout shift, loading/dimming, the URL).

**Files:**
- Modify: `src/routes/_authenticated/energy/index.tsx`, `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`periodFromSearch`, `periodQueryYear`, `resolvePeriod`, `formatPeriod`), Task 2's shape,
  Task 4 (`EnergyReadouts`), Task 5 (`PeriodControl`), Task 6 (`EnergyMonthlyChart` props).

- [ ] **Step 1: Rewrite the page tests (failing)**

In `-energyPage.browser.test.tsx`: `withData` / `empty` take the new shape —

```ts
const withData = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: '2026-01-20',
  monthsWithReadings: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  yearTotal: sums({ solarKwh: 5000 }),
  allTime: sums({ solarKwh: 6000 }),
  months: Array.from({ length: 12 }, (_, i) => (i < 9 ? sums({ solarKwh: 100 + i }) : null)),
}
const empty = { year: 2026, availableYears: [2026], firstReadingDay: null, monthsWithReadings: [], yearTotal: null, allTime: null, months: Array(12).fill(null) }
```

Pin the clock so the default month is September 2026: in a `beforeEach`,
`vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))` (only `Date`, so
TanStack Query and the router keep real timers); `vi.useRealTimers()` in `afterEach`. Replace the tab/year-selector tests with:

```tsx
test('defaults to the current month; its figures fill the tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  await expect.element(screen.getByText('108,0 kWh')).toBeVisible() // months[8].solarKwh
})

test('?period=2026-02 shows February; ?period=2026 the year; ?period=all all time', async () => {
  for (const [path, figure] of [
    ['/energy?period=2026-02', '101,0 kWh'],
    ['/energy?period=2026', /^5\s000,0 kWh$/],
    ['/energy?period=all', /^6\s000,0 kWh$/],
  ] as const) {
    const { screen } = await renderPage(Overview, path, (qc) => {
      seedOverview(withData)(qc)
      qc.setQueryData(energyOverviewQuery(2026).queryKey, withData as never)
    })
    await expect.element(screen.getByText(figure)).toBeVisible()
    screen.unmount()
  }
})

test('the legacy ?year=2026 reads as the year', async () => {
  const { screen } = await renderPage(Overview, '/energy?year=2026', (qc) => {
    qc.setQueryData(energyOverviewQuery(2026).queryKey, withData as never)
  })
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
})

test('a stale ?period= falls back to the default month', async () => {
  const { screen } = await renderPage(Overview, '/energy?period=2026-11', (qc) => {
    qc.setQueryData(energyOverviewQuery(2026).queryKey, withData as never)
  })
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
})

test('stepping writes ?period= and replaces the history entry; a month switch sends no request', async () => {
  const { screen, router, qc } = await renderPage(Overview, '/energy', seedOverview(withData))
  const before = router.history.length
  const fetches = vi.spyOn(qc, 'fetchQuery')
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.poll(() => (router.state.location.search as { period?: string }).period).toBe('2026-08')
  expect(router.history.length).toBe(before)
  expect(fetches).not.toHaveBeenCalled()
})

test('another year: one request; the old figures stay, dimmed, while it loads', async () => {
  const twoYears = { ...withData, availableYears: [2026, 2025], monthsWithReadings: ['2025-12', ...withData.monthsWithReadings] }
  const { screen, qc } = await renderPage(Overview, '/energy?period=2026-01', (qc) => {
    qc.setQueryData(energyOverviewQuery(2026).queryKey, twoYears as never)
  })
  let release: (v: unknown) => void = () => {}
  const gate = new Promise((r) => { release = r })
  const held = qc.fetchQuery({ queryKey: energyOverviewQuery(2025).queryKey, queryFn: () => gate as never })
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  const chart = screen.getByRole('region', { name: m.energy_chart_title() }).element()
  await expect.poll(() => chart.querySelector('[aria-busy="true"]')).not.toBeNull()
  release({ ...twoYears, year: 2025 })
  await held
  await expect.poll(() => chart.querySelector('[aria-busy="true"]')).toBeNull()
})
```

Keep the empty-state, skeleton, health, Nät, and failed-read tests (they assert `region` / `heading`, not tabs;
change any `getByRole('tablist')` to `getByRole('button', { name: /Välj period|Choose period/ })`). The test for "a
failed read of another year keeps the year selector" becomes "keeps the period control": after a failed year read,
the control (from `lastShown`) is still there and stepping back to the loaded year works.

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/-energyPage.browser.test.tsx` → FAIL.

- [ ] **Step 2: Rewrite the route**

Search schema and loader:

```tsx
const searchSchema = z.object({
  period: z.string().max(10).optional().catch(undefined),
  /** Step-1 links: read as `?period=Y`, dropped on the next write. */
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

loader: ({ context: { queryClient }, location }) => {
  const year = periodQueryYear(periodFromSearch(searchSchema.parse(location.search)))
  return loadRouteData(queryClient, { critical: [energyOverviewQuery(year), syncHealthQuery] })
},
```

(The year stays out of `loaderDeps`, as in step 1: the page's own query dims the old year while the new loads.)

In `EnergyOverviewPage`:

```tsx
const search = Route.useSearch()
const requested = periodFromSearch(search)
const result = useQuery({ ...energyOverviewQuery(periodQueryYear(requested)), placeholderData: keepPreviousData })
// … overview / pending / lastShown exactly as in step 1 …
const now = stockholmYearMonth(Date.now())
const period = tiles ? resolvePeriod(requested, tiles.monthsWithReadings, now) : null
const setPeriod = useCallback(
  (p: EnergyPeriod) =>
    navigate({ to: '.', search: { period: formatPeriod(p) }, replace: true, resetScroll: false }),
  [navigate],
)
const periodSums =
  !tiles || !period ? null
  : period.kind === 'all' ? tiles.allTime
  : period.kind === 'year' ? tiles.yearTotal
  : period.year === tiles.year ? tiles.months[period.month - 1]
  : null
```

While another year loads, `tiles` is the placeholder (the old year), so a month of the new year resolves to
`null` for a moment. Keep showing the figures the card showed last (the `lastShown` set-during-render pattern),
dimmed with the chart:

```tsx
const [lastSums, setLastSums] = useState<PeriodSums | null>(periodSums)
if (!stale && periodSums !== lastSums) setLastSums(periodSums)
const tileSums = stale ? lastSums : periodSums
```

and render `<EnergyReadouts sums={tileSums} />`. The tiles card dims (`opacity-60`, `aria-busy`) while `stale`.

The tiles section becomes:

```tsx
<section aria-labelledby={tilesHeadingId}>
  <Card className={cn('transition-opacity', stale && 'opacity-60')} aria-busy={stale || undefined}>
    <CardHeader className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={tilesHeadingId} className="font-semibold text-lg">{m.energy_tiles_heading()}</h2>
      {period ? (
        <PeriodControl period={period} monthsWithReadings={tiles.monthsWithReadings} current={now} onChange={setPeriod} />
      ) : null}
    </CardHeader>
    <CardContent>
      <EnergyReadouts sums={tileSums} />
    </CardContent>
  </Card>
</section>
```

The chart card: the heading `font-semibold text-lg` reads "{m.energy_chart_title()} · {overview.year}"; remove the
`YearSelector` (and the failed-read `YearSelector` fallback: the period control in the tiles card stays, from
`lastShown`); pass `selectedMonth={period?.kind === 'month' && period.year === overview.year ? period.month : null}`
and `onSelectMonth={(month) => setPeriod({ kind: 'month', year: overview.year, month })}`. Drop the now-unused
imports (`YearSelector`, `setYear`).

- [ ] **Step 3: Run the page tests and the typecheck**

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/-energyPage.browser.test.tsx && bunx tsc --noEmit`
Expected: PASS, no type errors (the branch typechecks again from here).

- [ ] **Step 4: Re-capture the skeletons**

With the dev stack up: `BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort` in one
terminal, then `bun run bones:capture /energy --force`. Commit `src/bones/energy-*.bones.json` and the registry.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_authenticated/energy src/bones
git commit -m "feat(energy): choose the period from the URL, the control or the chart"
```

---

### Task 8: Verify live, record the step

**Reviewers:** none (evidence task); the branch review (feature-workflow Phase 5) follows.

- [ ] **Step 1: No-shift measurement** (Playwright on the local dev server, signed in through the Mailpit magic
link as in the bones capture). For each viewport 1440, 820, 390 px and each theme, visit
`/energy?period=2026-07`, then click through `2026-08` (gap note), `2026-02`, the current month, Hela 2026 and
Totalt; after each, record `getBoundingClientRect()` of the previous-arrow, the period label button, the tiles
card and the chart card. Expected: identical rects across the periods (±0 px) per viewport. Save the script in the
scratchpad, not the repo; paste the table in the PR.

- [ ] **Step 2: Look at it**: screenshots at the three widths, light and dark, with the picker open and a month
hovered. Check: the hover outline encloses the month label; the tooltip shows shares; the selected tint sits
behind the bars; month initials at 390 px; no `text-xs` left on the page (`grep -n "text-xs" src/components/energy src/routes/_authenticated/energy/index.tsx` → only the picker's "hittills" caption).

- [ ] **Step 3: Figures**: `/energy?period=2026-08` locally equals a plain SQL sum for August (step 1's checkpoint
query); Hela 2026 equals the year's sum.

- [ ] **Step 4: Pre-PR gate** ([feature-workflow](../../feature-workflow.md#pre-pr-gate)): `bun run check`,
`check:ci`, `build`, `test`, the sv/en key check.

- [ ] **Step 5: Roadmap**: row 1b → PR link, `PR open`; a log line with the measurements.

```bash
git add docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md
git commit -m "docs(energy): record step 1b"
```
