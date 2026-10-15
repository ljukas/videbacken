# Heat pumps, step 3: Energi › Värmepumpar (consumption): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended by step 2b (2026-10-15).** The heat pump sums now read the `heat_pump_day` materialized view
> (`heatPumpDay` in `schema/heatPump.ts`; ADR-0027 decision 6, amended). Task 2 builds `daySums` as a select from
> `heat_pump_day`, not a GROUP BY over `heat_pump_reading`: means = `*_c_sum / nullif(*_c_hours, 0)`, join
> `heat_pump` (a unit deleted since the last refresh must not show), key days and months as dates. Its tests store
> through the `storeHours` fixture (which refreshes the view) or call `refreshDaySums()`. `lastYearSoFar` calls
> `monthSums({ from, to })` with the mid-day cut; `monthSums` handles the partial day. The task code blocks below
> predate this; Task 1's "check main" step catches the rest. See the roadmap's 2026-10-15 log entry.

**Goal:** A third Energi sub-page, `/energy/heat-pumps`, whose Förbrukning card shows the chosen period's heat pump
consumption: tiles (kWh per unit, the change against the same period a year earlier, the mean outdoor temperature),
and a chart of the units' stacked kWh per month (a year, or the whole history) or per day (a month), with last year
as an outline beside each month and the outdoor temperature as a line on a right-hand axis.

**Architecture:** Two new reads. The service gains `daySums` and `readingSpans` in `daySums.ts` (plain grouped SQL
over `heat_pump_reading`, beside step 2's `monthSums.ts`), and a read model `heatPumpRead.ts` (`getHeatPumpMonths`,
`getHeatPumpDays`) adds expected hours (DST-aware via `src/lib/time/stockholm.ts`, clipped to each unit's first hour
and to the coverage end, the newest stored hour or `now`, with step 2's 13-hour trailing-lag rule) and fills gaps. Two protected procedures expose them (`heatPump.months`, `heatPump.days`); only month and day sums leave the
server. The page reuses the Energi period plumbing (`?period=`, `PeriodControl`, `EnergySummaryCard`, the shared URL
rewrite rule) and the visx `BarChart`, which gains two generic, opt-in options (a line on its own right-hand axis, an
outline series). A pure, client-safe view model (`heatPumpView.ts`) turns the two reads into chart rows and tiles.

**Tech Stack:** TanStack Start / Router file routes, TanStack Query, oRPC, Drizzle (`pg`), Zod 4, date-fns +
`@date-fns/tz`, visx (`@visx/axis` `AxisRight`), lucide-react, Paraglide, Vitest (node + browser), Biome,
boneyard-js skeletons.

**Spec:** [`docs/superpowers/specs/2026-10-08-heat-pumps-design.md`](../specs/2026-10-08-heat-pumps-design.md)
("Read model › Heat pump procedures", "Energi › Värmepumpar › Förbrukning")
· ADR: [`docs/adr/0027-heat-pump-energy-data.md`](../../adr/0027-heat-pump-energy-data.md) (decisions 6, 8)
· Roadmap: [`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`](../roadmaps/2026-10-08-heat-pumps.md) (step 3, checkpoint 4)
· Builds on: ADR-0024 (Energi pages, expected-bucket clipping), ADR-0025 (deferred loading, bones, §6 bundle),
ADR-0016 (empty states), ADR-0018 (no held connections: focus refetch only).

## Global Constraints

- Only month and day sums reach the browser; no hourly row and no timestamp in any procedure output (ADR-0027 decision 6; a procedure test pins it).
- Every figure is a plain SQL sum over `heat_pump_reading` (spec "Success"); heating kWh = Σ kWh × heat share, cooling the same, means hour-weighted (each reading is one hour).
- Stockholm days and months from UTC hours: convert each hour, then sum; Stockholm offsets are whole hours (ADR-0024 way). DST days are 23 / 25 hours (2026-03-29, 2025-10-26), never flagged as missing.
- Expected hours: from `stockholmDayBounds` / `stockholmMonthBounds`, clipped to the unit's first stored hour and to the **coverage end = max(end of the newest stored hour of any unit, `now` floored to the hour)**, with step 2's trailing-lag rule: the hours after a unit's own newest stored hour, measured to the coverage end, count as missing only when that trailing gap is **≥ 13 h** (the stale threshold, `STALE_AFTER_MS.comfortCloud`); inner gaps always count. So a Comfort Cloud stall for both units shows as missing hours.
- `heatPump.days` accepts at most **800** days (`HEAT_PUMP_DAYS_MAX`), `from ≤ to`, real `YYYY-MM-DD` days; anything else is `BAD_REQUEST`, never a 500.
- Both procedures are `protectedProcedure` (reads); timings `heatPumpMonthsMs`, `heatPumpDaysMs`.
- The change tile shows only when both periods have ≥ 99 % of their expected hours (`COVERAGE_COMPLETE`); a running period compares with the same span a year earlier, cut at the same Stockholm wall-clock hour.
- Unit order and colours: step 2's `byHeatPumpName` (Swedish collation, then id) wherever units are listed, never SQL ordering; colours from step 2's `heatPumpColor(units, id)` (its `--energy-heat-pump-1` … `-3` tokens); never a new token here.
- Outdoor temperature across units: each unit's mean weighted by its hour count (an approximation when a unit has hours without an outdoor value; stated in a code comment).
- `?period=` exactly as `/energy` (`energySearchSchema`); the sidebar carries it between the three Energi sub-pages. The page's period writes **merge** into the current search (`(prev) => ({ ...prev, period })`), so step 4a's extra keys survive.
- Client code only `import type` from `~/lib/services/heatPump` (a `clientSafe` browser test guards it).
- kWh only, read only: no kronor, no control.
- Paraglide sv (source) + en key-complete; Swedish copy exactly as written here. Route URL path English.
- Tests that touch time pass under `TZ=UTC` too (CI runs browser tests in UTC; local is Stockholm).
- Conventional Commits; `git add <paths>`, never `-A`; every commit body ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. PR title `feat(heat-pumps): add the heat pump consumption page`.
- Private data: fixtures use synthetic numbers and fake guids (`CS-HZ25ZKE+0000000001`); never the owner's figures.

## Review Focus

1. **A running period against last year** (October 2026 *hittills*, or 2026 *hittills*): the change must compare with
   the same span a year earlier (to the same hour), not last year's whole month or year, or it reads as −75 %.
   Pinned in Task 3 (`lastYearSoFar` cut at 2025-03-01 12:00 Z) and Task 6 (tiles use `lastYear` months before the
   newest month plus `lastYearSoFar`, never the full newest month).
2. **A unit offline at the end of the data, or for a whole day** (its Wi-Fi adapter down): once its trailing gap
   reaches 13 h its missing hours must show ("Data saknas för N h"), not vanish because the clipping used that unit's
   own newest hour; a shorter lag (one unit's sync a few hours behind) must not read as missing. And when Comfort
   Cloud stalls for **both** units, the coverage runs to `now`, so the stall shows too (Översikt would show it against
   the house data). Pinned in Task 3 (Övervåning offline 24 h: 23 of 24 hours missing on 2025-10-27, 0 of 1 on 10-28;
   a 5-hour lag: complete; both units silent 2 days: 48 h missing each) and Task 6 (the missing-hours note takes the
   worst unit; a 48-hour stall hides the change tile through the 99 % gate).
3. **The DST days in the day chart**: 2025-10-26 has 25 hours and 2026-03-29 has 23, both complete; no "data saknas",
   no hour counted twice or dropped at a Stockholm midnight. Pinned in Task 2 (daySums) and Task 3 (expected hours).
4. **A period before one unit existed** (October 2024: Matsal only): that unit's tile says "—" without a change, the
   other unit keeps its colour, and the change never divides by a last year with no data. Pinned in Task 6 and Task 7
   (tiles test).
5. **Switching period kind** (month ↔ year ↔ Totalt, or a stale link to a month without readings): the old view stays
   dimmed until the new read lands, a period without readings rewrites the URL to the default, and the card keeps its
   height. Pinned in Task 8 (page tests: rewrite, stale) and verified live in Task 9 (card rect at 1440/820/390).

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/energy/energySearch.ts` (+ `energySearch.test.ts`) (modify / create) | `periodRewrite`: the shared "where should `?period=` go" rule |
| `src/components/energy/useEnergyPeriod.ts` (modify) | Uses `periodRewrite`; behaviour unchanged |
| `src/components/energy/EnergySummaryCard.tsx` (modify) | Optional `title` (default Summering) |
| `src/lib/services/heatPump/daySums.ts` (+ `.test.ts`) (create), `index.ts` (modify) | `daySums`, `readingSpans`, `HeatPumpDayRow` (sibling of step 2's `monthSums.ts`) |
| `test/fixtures/heatPumpHours.ts` (step 2's, reused unchanged) | `seedUnits(...names)`, `storeHours(id, fromIso, toIso, at?)` |
| `src/components/evCharging/SyncNowButton.tsx` (+ `.browser.test.tsx`) (modify) | Step 1b's literal `[['heatPump'], {}]` → `orpc.heatPump.key()` (Task 4) |
| `src/lib/time/stockholm.ts` (+ test) (modify) | `stockholmYearBefore(ms)` |
| `src/lib/services/heatPump/heatPumpRead.ts` (+ `.test.ts`) (create) | `getHeatPumpMonths`, `getHeatPumpDays`, `expectedHours`, output types |
| `src/lib/services/heatPump/index.ts` (modify) | Re-export `heatPumpRead` |
| `src/lib/heatPump/period.ts` (+ `.test.ts`) (create) | Client-safe `HEAT_PUMP_DAYS_MAX`, `monthDays` |
| `src/lib/orpc/procedures/heatPump.ts` (+ `.test.ts`) (create), `src/lib/orpc/router.ts` (modify) | `heatPump.months`, `heatPump.days` |
| `src/components/chart/BarChart.tsx`, `barLayout.ts`, `ChartParts.tsx` (+ `BarChart.browser.test.tsx`) (modify) | `LineSeries.axis: 'right'` + `tickFormat` + `strokeWidth`; `BarSeries.outline`; outlined legend / tooltip swatches |
| `src/components/heatPump/heatPumpView.ts` (+ `.test.ts`) (create) | Pure view model: chart rows + tiles per period |
| `src/components/heatPump/format.ts` (+ `.test.ts`) (create) | `formatChange`, `formatCelsius`, `formatCelsiusTick`, `formatKwh` |
| `test/fixtures/heatPumpView.ts` (create) | Synthetic `heatPump.months` / `heatPump.days` payloads |
| `src/components/heatPump/heatPumpQueries.ts` (create) | Query options per period |
| `src/components/heatPump/useHeatPumpPeriod.ts` (create) | The page's period + reads + view state |
| `src/components/heatPump/HeatPumpTiles.tsx`, `HeatPumpConsumptionChart.tsx`, `HeatPumpConsumption.tsx`, `HeatPumpEmpty.tsx` (+ browser tests) (create) | The card body and the empty state |
| `src/routes/_authenticated/energy/heat-pumps.tsx` (+ `-heatPumpsPage.browser.test.tsx`) (create) | The page |
| `src/components/AppSidebar.tsx` (+ test), `src/components/command/commands.ts` (modify) | Sub-item after Batteri; palette entry |
| `src/components/heatPump/clientSafe.browser.test.tsx` (create) | Client-safe guards (route, view model, period helpers) |
| `scripts/captureBones.ts`, `scripts/measureBundle.ts`, `src/bones/heat-pump-consumption.bones.json` (modify / generate) | Skeleton capture; bundle measurement |
| `messages/sv.json`, `messages/en.json` (modify) | `heat_pump_*`, `nav_energy_heat_pumps`, `meta_energy_heat_pumps_*`, `cmd_kw_energy_heat_pumps` |
| `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md` (modify) | Row 3 → `PR open` (the spec only if a decision changes during the build) |

---

### Task 0: Verify `main` still matches this plan; worktree

- [ ] **Step 1: Check what the plan builds on**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "| 2 |" docs/superpowers/roadmaps/2026-10-08-heat-pumps.md            # checkpoint passed
grep -n "export const heatPump\b\|export const heatPumpReading\|hourStart\|energyKwh\|heatShare\|coolShare\|setpointC\|insideC\|outsideC" src/lib/db/schema/heatPump.ts
grep -n "export async function \(upsertUnits\|listUnits\|replaceDay\)\|export type \(HeatPump\|HeatPumpHourInput\)\b" src/lib/services/heatPump/heatPump.ts
grep -n "export async function monthSums\|export type HeatPumpMonthRow\|coalesce" src/lib/services/heatPump/monthSums.ts   # step 2; how it weights a null share
grep -n "export \* from './monthSums'" src/lib/services/heatPump/index.ts
grep -n "export async function seedUnits\|export async function storeHours" test/fixtures/heatPumpHours.ts   # step 2's fixture
grep -n "HEAT_PUMP_QUERY_PREFIX\|\[\['heatPump'\], {}\]" src/components/evCharging/SyncNowButton.tsx src/components/evCharging/SyncNowButton.browser.test.tsx
grep -n "comfortCloud" src/lib/integrationHealth.ts src/components/evCharging/SyncNowButton.tsx src/lib/integrationHealthMessage.ts
grep -n "energy-heat-pump-[123]" src/styles/app.css
grep -rn "export function byHeatPumpName\|export const byHeatPumpName" src/lib/houseEnergy/figures.ts src/lib/heatPump/units.ts 2>/dev/null
grep -rn "export function heatPumpColor\|export const heatPumpColor" src/lib/houseEnergy/heatPumpColors.ts src/lib/heatPump/units.ts 2>/dev/null
grep -rn "TRAILING\|trailing" src/lib/houseEnergy/figures.ts src/lib/services/houseEnergy/energyOverview.ts src/lib/heatPump/units.ts 2>/dev/null
grep -n "comfortCloud" src/lib/services/integrationSync/policy.ts                    # STALE_AFTER_MS.comfortCloud = 13 h
grep -n "rewriteTo\|export function useEnergyPeriod" src/components/energy/useEnergyPeriod.ts
grep -n "export function EnergySummaryCard\|energy_tiles_heading" src/components/energy/EnergySummaryCard.tsx
grep -n "export type LineSeries\|line?: LineSeries\|AxisLeft\|function ChartLegend\|export function TooltipRow" src/components/chart/BarChart.tsx src/components/chart/ChartParts.tsx
grep -n "energySubItems\|'/energy/battery'" src/components/AppSidebar.tsx src/components/command/commands.ts
grep -n "'/energy/battery'" scripts/captureBones.ts; grep -n "'/energy':" scripts/measureBundle.ts
grep -n "heatPump" src/lib/orpc/router.ts; ls src/routes/_authenticated/energy/
ls node_modules/lucide-react/dist/esm/icons/air-vent.mjs
```

Expected: row 2 is `checkpoint passed`; the schema and service names print as the brief's contract names them
(`monthSums({ from, to }: { from: Date; to: Date })` returning `HeatPumpMonthRow[]`, filtering `hour_start` to
`[from, to)`); `comfortCloud` is an integration source with a Sync now entry and health copy; the three tokens exist
in light and dark; the router has no `heatPump` yet; the energy folder has `index.tsx`, `battery.tsx` and
`-energyPage.browser.test.tsx` only.

Decision rules if `main` differs:
- **`monthSums` weights a null share differently** from `coalesce(share, 0)`: make `daySums` (Task 2) use the same
  expression, so a day sum and a month sum always agree.
- **`byHeatPumpName` / `heatPumpColor` live elsewhere** than the plan's imports (step 2's plan puts them in
  `~/lib/houseEnergy/figures` and `~/lib/houseEnergy/heatPumpColors`; `~/lib/heatPump/units` is the alternative):
  change the import paths in Tasks 3, 6 and 7 to wherever the greps found them. The plan assumes
  `byHeatPumpName(a: { id: string; name: string }, b: { id: string; name: string }): number` and
  `heatPumpColor(units: readonly { id: string }[], id: string): string`; a different signature: adapt the call sites.
- **Step 2 exports a named trailing-lag constant** (the `TRAILING` grep finds one): import it in Task 3 instead of
  `STALE_AFTER_MS.comfortCloud`, so both pages share one source; the value must be 13 h either way.
- **`monthSums` has a different signature or bound** (inclusive `to`, Stockholm days) or file: adapt the two
  `monthSums` calls and the `./monthSums` import in Task 3 and note it in the PR.
- **Step 2's fixture differs** from `seedUnits(...names): Promise<Record<string, string>>` /
  `storeHours(id, fromIso, toIso, at?)`: adapt the test seeding in Tasks 2–4 (add any missing helper to
  `test/fixtures/heatPumpHours.ts`, not a new fixture file).
- Any other name moved: adapt the tasks' imports first and note it in the PR.

- [ ] **Step 2: Worktree**

```bash
git worktree add .claude/worktrees/heat-pumps-3 -b feat/heat-pumps-page origin/main
cd .claude/worktrees/heat-pumps-3 && bun install && bun run db:up && bun run db:migrate
```

Port 14610 is often another session's dev server: run this worktree's dev server on 14611
(`BETTER_AUTH_URL=http://localhost:14611 bun run dev -- --port 14611`) and pass `BONES_ORIGIN=http://localhost:14611`
to `bones:capture`. Never run vitest while a reviewer does (shared local DB; memory "concurrent vitest collides").

---

### Task 1 (refactor): Share the period rewrite rule; a title for the period card

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (both told:
the commit must not change behaviour; Översikt's and Batteri's tests pass unchanged).

**Files:**
- Modify: `src/components/energy/energySearch.ts`, `src/components/energy/useEnergyPeriod.ts`,
  `src/components/energy/EnergySummaryCard.tsx`
- Create: `src/components/energy/energySearch.test.ts`
- Test (run, **not edited**): `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`, `src/components/energy/`

**Interfaces:**
- Produces:
  - `periodRewrite(search: EnergySearch, requested: EnergyPeriod | null, shown: EnergyPeriod | null, settled: boolean): string | number | null | undefined`
    (`undefined`: leave the URL; `null`: drop the period params; else the shown period's URL value)
  - `EnergySummaryCard` gains `title?: string` (default `m.energy_tiles_heading()`)

- [ ] **Step 1: Baseline**

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/energy/`
Expected: PASS. Note the count.

- [ ] **Step 2: Write the failing test**

```ts
// src/components/energy/energySearch.test.ts
import { expect, test } from 'vitest'
import { periodRewrite } from './energySearch'

const sep = { kind: 'month', year: 2026, month: 9 } as const
const nov = { kind: 'month', year: 2026, month: 11 } as const

test('nothing valid asked for: an invalid ?period= is dropped, an empty search stays', () => {
  expect(periodRewrite({}, null, sep, true)).toBeUndefined()
  expect(periodRewrite({ period: 'junk' }, null, sep, true)).toBeNull()
  expect(periodRewrite({ period: 'junk' }, null, null, false)).toBeNull()
})

test('a period the data can show stays', () => {
  expect(periodRewrite({ period: '2026-09' }, sep, sep, true)).toBeUndefined()
  expect(periodRewrite({ period: 'all' }, { kind: 'all' }, { kind: 'all' }, true)).toBeUndefined()
})

test('a period the data cannot show moves to the shown one once the read has settled', () => {
  expect(periodRewrite({ period: '2026-11' }, nov, sep, true)).toBe('2026-09')
  expect(periodRewrite({ period: 2024 }, { kind: 'year', year: 2024 }, { kind: 'year', year: 2026 }, true)).toBe(2026)
})

test('nothing moves while the read is a placeholder or has no readings', () => {
  expect(periodRewrite({ period: '2026-11' }, nov, sep, false)).toBeUndefined()
  expect(periodRewrite({ period: '2026-11' }, nov, null, true)).toBeUndefined()
})
```

Run: `bunx vitest run src/components/energy/energySearch.test.ts` → FAIL (`periodRewrite` is not exported).

- [ ] **Step 3: Implement.** Append to `energySearch.ts`:

```ts
/**
 * Where `?period=` should go (the Energi pages' rule, step 1b). A period the data can't show (a stale link, a year
 * without readings, a legacy ?year=) resolves to the default: once the read for it has settled, the URL follows.
 * Nothing valid asked for (an invalid ?period= or ?year=) is the default already: the URL drops the params.
 * `settled`: the read is in, not a placeholder, and has readings.
 * Returns undefined to leave the URL, null to drop the period params, else the shown period's URL value.
 */
export function periodRewrite(
  search: EnergySearch,
  requested: EnergyPeriod | null,
  shown: EnergyPeriod | null,
  settled: boolean,
): string | number | null | undefined {
  if (!requested) return search.period !== undefined || search.year !== undefined ? null : undefined
  if (!settled || !shown) return undefined
  return formatPeriod(requested) !== formatPeriod(shown) ? periodSearchValue(shown) : undefined
}
```

In `useEnergyPeriod.ts`, replace the `const rewriteTo: string | number | null | undefined = requested ? … : undefined`
expression (keep its comment block above it, shortened to "See `periodRewrite`.") with:

```ts
  const rewriteTo = periodRewrite(
    search,
    requested,
    period,
    Boolean(overview && !stale && overview.firstReadingDay !== null),
  )
```

and import `periodRewrite` from `./energySearch` (drop `formatPeriod` from the `period` import if now unused).

In `EnergySummaryCard.tsx` add the prop (first in the destructuring and the type) and use it in the `<h2>`:

```tsx
  title = m.energy_tiles_heading(),
  …
  /** The card's heading (default Summering). */
  title?: string
  …
          <h2 id={headingId} className="font-semibold text-lg">
            {title}
          </h2>
```

Update the card's comment: "The Energi pages' period card (Summering on Översikt and Batteri, Förbrukning on
Värmepumpar): …".

- [ ] **Step 4: Run the new test, the baseline unchanged, typecheck**

Run: `bunx vitest run src/components/energy/energySearch.test.ts && bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/energy/ && bun run typecheck`
Expected: PASS with Step 1's count; `git diff --stat -- '*.browser.test.*'` prints nothing.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/energySearch.ts src/components/energy/energySearch.test.ts \
  src/components/energy/useEnergyPeriod.ts src/components/energy/EnergySummaryCard.tsx
git commit -m "refactor(energy): share the period rewrite and the card title" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `daySums` and `readingSpans` (service, test-first)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/services/heatPump/daySums.ts`, `src/lib/services/heatPump/daySums.test.ts` (the sibling of step
  2's `monthSums.ts`)
- Modify: `src/lib/services/heatPump/index.ts` (`export * from './daySums'`)

**Interfaces:**
- Consumes (step 1a): `heatPumpReading` (`heatPumpId`, `hourStart`, `energyKwh`, `heatShare`, `coolShare`,
  `setpointC`, `insideC`, `outsideC`); step 2's test fixture `test/fixtures/heatPumpHours.ts`:
  `seedUnits(...names: string[]): Promise<Record<string, string>>` (name → id) and
  `storeHours(heatPumpId, fromIso, toIso, at?)` (every UTC hour in `[fromIso, toIso)`: 0,1 kWh, all heating, 21 °C
  set and inside, 0 °C outside, unless `at(hourStartMs, i)` overrides; `null` from `at` skips the hour).
- Produces:
  - `type HeatPumpDayRow = { heatPumpId: string; day: string; kwh: number; heatKwh: number; coolKwh: number; insideC: number | null; outsideC: number | null; setpointC: number | null; hours: number }`
  - `daySums({ from, to }: { from: string; to: string }): Promise<HeatPumpDayRow[]>` (Stockholm days, inclusive;
    days without readings absent; ordered by day, then unit id)
  - `readingSpans(): Promise<{ heatPumpId: string; firstHour: Date; lastHour: Date }[]>` (units without readings absent)

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/services/heatPump/daySums.test.ts
import { expect, test } from 'vitest'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { daySums, type HeatPumpDayRow, readingSpans } from './daySums'

setupDatabase()

const find = (rows: HeatPumpDayRow[], heatPumpId: string, day: string) =>
  rows.find((r) => r.heatPumpId === heatPumpId && r.day === day)

test('the autumn DST day (2025-10-26) holds 25 hours; the day before 22 (from the first hour), the day after 24', async () => {
  const ids = await seedUnits('Matsal')
  // 2025-10-25 00:00 Z … 10-27 23:00 Z. Stockholm 2025-10-26 = [10-25 22:00 Z, 10-26 23:00 Z).
  await storeHours(ids.Matsal, '2025-10-25T00:00:00Z', '2025-10-28T00:00:00Z')
  const rows = await daySums({ from: '2025-10-25', to: '2025-10-27' })
  expect(rows.map((r) => [r.day, r.hours])).toEqual([
    ['2025-10-25', 22],
    ['2025-10-26', 25],
    ['2025-10-27', 24],
  ])
  expect(find(rows, ids.Matsal, '2025-10-26')?.kwh).toBeCloseTo(2.5, 9)
})

test('the spring DST day (2026-03-29) holds 23 hours', async () => {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')
  const [row] = await daySums({ from: '2026-03-29', to: '2026-03-29' })
  expect(row).toMatchObject({ heatPumpId: ids.Matsal, day: '2026-03-29', hours: 23 })
  expect(row.kwh).toBeCloseTo(2.3, 9)
})

test('a day is its Stockholm hours only; shares weight the kWh; means skip hours without a value', async () => {
  const ids = await seedUnits('Matsal')
  // Stockholm 2026-01-15 = [2026-01-14 23:00 Z, 2026-01-15 23:00 Z). Hours 2026-01-14 22:00 Z (i 0) … 01-15 23:00 Z
  // (i 25); only i 0–3 and 25 are stored.
  await storeHours(ids.Matsal, '2026-01-14T22:00:00Z', '2026-01-16T00:00:00Z', (_t, i) => {
    if (i === 0 || i === 25) return { energyKwh: 1 } // 23:00 on the 14th / 00:00 on the 16th: outside the day
    if (i === 1)
      return { energyKwh: 0.4, heatShare: 0.5, coolShare: 0.25, insideC: 20, outsideC: -4, setpointC: 22 }
    if (i <= 3)
      return { energyKwh: 0.2, heatShare: null, coolShare: null, insideC: null, outsideC: -2, setpointC: null }
    return null
  })
  const [row] = await daySums({ from: '2026-01-15', to: '2026-01-15' })
  expect(row.hours).toBe(3)
  expect(row.kwh).toBeCloseTo(0.8, 9)
  expect(row.heatKwh).toBeCloseTo(0.2, 9) // 0,4 × 0,5; a null share counts as 0
  expect(row.coolKwh).toBeCloseTo(0.1, 9)
  expect(row.insideC).toBeCloseTo(20, 9)
  expect(row.outsideC).toBeCloseTo(-8 / 3, 9)
  expect(row.setpointC).toBeCloseTo(22, 9)
})

test('one row per unit and day; readingSpans gives each unit its first and newest hour', async () => {
  const ids = await seedUnits('Matsal', 'Övervåning')
  expect(await readingSpans()).toEqual([])
  expect(await daySums({ from: '2026-01-15', to: '2026-01-15' })).toEqual([])
  await storeHours(ids.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T05:00:00Z')
  await storeHours(ids.Övervåning, '2026-01-15T03:00:00Z', '2026-01-15T05:00:00Z')
  const rows = await daySums({ from: '2026-01-15', to: '2026-01-15' })
  expect(rows).toHaveLength(2)
  expect(find(rows, ids.Matsal, '2026-01-15')?.hours).toBe(5)
  expect(find(rows, ids.Övervåning, '2026-01-15')?.hours).toBe(2)
  const spans = await readingSpans()
  expect(spans).toHaveLength(2)
  expect(spans.find((s) => s.heatPumpId === ids.Övervåning)).toEqual({
    heatPumpId: ids.Övervåning,
    firstHour: new Date('2026-01-15T03:00:00Z'),
    lastHour: new Date('2026-01-15T04:00:00Z'),
  })
})
```

Run: `bunx vitest run src/lib/services/heatPump/daySums.test.ts` → FAIL (`./daySums` is missing).

- [ ] **Step 2: Implement**

```ts
// src/lib/services/heatPump/daySums.ts
// Heat pump day sums (heat pumps step 3, ADR-0027 decision 6): the sibling of step 2's monthSums.ts. Sums only;
// the hours never leave the service.
import { and, asc, gte, lt, max, min, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { heatPumpReading } from '~/lib/db/schema'
import { stockholmDayBounds } from '~/lib/time/stockholm'

/** One unit's sums for one Stockholm day. Means are hour-weighted (each reading is one hour); null without a value. */
export type HeatPumpDayRow = {
  heatPumpId: string
  /** Stockholm 'YYYY-MM-DD'. */
  day: string
  kwh: number
  heatKwh: number
  coolKwh: number
  insideC: number | null
  outsideC: number | null
  setpointC: number | null
  hours: number
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/**
 * Sums per unit per Stockholm day of `[from, to]` (inclusive 'YYYY-MM-DD', validated by the caller). Each reading is
 * a whole UTC hour and Stockholm's offsets are whole hours, so every reading lies in one Stockholm day: convert each
 * hour, then sum (the ADR-0024 way). A null share counts as 0, as in `monthSums`. Days without readings are absent;
 * the read model adds them back with their expected hours.
 */
export async function daySums({ from, to }: { from: string; to: string }): Promise<HeatPumpDayRow[]> {
  const r = heatPumpReading
  const rows = await db
    .select({
      heatPumpId: r.heatPumpId,
      day: sql<string>`to_char(${r.hourStart} AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD')`,
      kwh: sql<number>`sum(${r.energyKwh})`,
      heatKwh: sql<number>`sum(${r.energyKwh} * coalesce(${r.heatShare}, 0))`,
      coolKwh: sql<number>`sum(${r.energyKwh} * coalesce(${r.coolShare}, 0))`,
      insideC: sql<number | null>`avg(${r.insideC})`,
      outsideC: sql<number | null>`avg(${r.outsideC})`,
      setpointC: sql<number | null>`avg(${r.setpointC})`,
      hours: sql<number>`count(*)::int`,
    })
    .from(r)
    .where(
      and(
        gte(r.hourStart, new Date(stockholmDayBounds(from).startMs)),
        lt(r.hourStart, new Date(stockholmDayBounds(to).endMs)),
      ),
    )
    .groupBy(r.heatPumpId, sql`2`)
    .orderBy(sql`2`, asc(r.heatPumpId))
  return rows.map((row) => ({
    heatPumpId: row.heatPumpId,
    day: row.day,
    kwh: Number(row.kwh),
    heatKwh: Number(row.heatKwh),
    coolKwh: Number(row.coolKwh),
    insideC: numOrNull(row.insideC),
    outsideC: numOrNull(row.outsideC),
    setpointC: numOrNull(row.setpointC),
    hours: Number(row.hours),
  }))
}

/**
 * Each unit's first and newest stored hour: the read model clips expected hours to them. A grouped min/max over the
 * primary key (≈ 17,5k rows a year for two units, ADR-0027).
 */
export async function readingSpans(): Promise<{ heatPumpId: string; firstHour: Date; lastHour: Date }[]> {
  const r = heatPumpReading
  const rows = await db
    .select({ heatPumpId: r.heatPumpId, firstHour: min(r.hourStart), lastHour: max(r.hourStart) })
    .from(r)
    .groupBy(r.heatPumpId)
  return rows.flatMap((row) =>
    row.firstHour && row.lastHour
      ? [{ heatPumpId: row.heatPumpId, firstHour: row.firstHour, lastHour: row.lastHour }]
      : [],
  )
}
```

(The time zone name stays inside SQL, as in `drizzle/0021_house_energy_month_view.sql` and step 2's `monthSums`;
`stockholm.ts` stays the only TypeScript module that names it.) Add `export * from './daySums'` to `index.ts`.

- [ ] **Step 3: Run** `bunx vitest run src/lib/services/heatPump/ && TZ=UTC bunx vitest run src/lib/services/heatPump/daySums.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/lib/services/heatPump/daySums.ts src/lib/services/heatPump/daySums.test.ts src/lib/services/heatPump/index.ts
git commit -m "feat(heat-pumps): sum heat pump readings per Stockholm day" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The read model `heatPumpRead.ts` (expected hours, gaps, last year so far)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/services/heatPump/heatPumpRead.ts`, `src/lib/services/heatPump/heatPumpRead.test.ts`
- Modify: `src/lib/services/heatPump/index.ts`, `src/lib/time/stockholm.ts`, `src/lib/time/stockholm.test.ts`

**Interfaces:**
- Consumes: Task 2's `daySums`, `readingSpans` (`./daySums`); step 1a's `listUnits(): Promise<HeatPump[]>`; step 2's
  `monthSums({ from, to }): Promise<HeatPumpMonthRow[]>` (`./monthSums`; `heatPumpId, name, year, month, kwh, heatKwh, coolKwh,
  insideC, outsideC, setpointC, hours, firstHour, lastHour`) and `byHeatPumpName` (Task 0 says where it lives);
  step 1b's `STALE_AFTER_MS.comfortCloud` (13 h) in `~/lib/services/integrationSync/policy`.
- Produces (exported from `~/lib/services/heatPump`):

```ts
export type HeatPumpUnitDto = { id: string; name: string }
export type HeatPumpMonthCell = {
  heatPumpId: string; year: number; month: number
  kwh: number; heatKwh: number; coolKwh: number; outsideC: number | null
  hours: number; expectedHours: number
}
export type HeatPumpMonths = {
  units: HeatPumpUnitDto[]                 // units with readings, in byHeatPumpName order (= colour order)
  year: number | null                      // null: the whole history (Totalt)
  availableYears: number[]                 // newest first
  firstReadingDay: string | null           // Stockholm day of the first reading, null without readings
  monthsWithReadings: string[]             // 'YYYY-MM', any unit, oldest first
  newestMonth: string | null               // 'YYYY-MM' of the coverage end (newest stored hour or now)
  months: HeatPumpMonthCell[]              // year: each unit's months of `year` inside its history; Totalt: every month of it
  lastYear: HeatPumpMonthCell[]            // year: the same for year − 1; Totalt: []
  lastYearSoFar: HeatPumpMonthCell[] | null // the newest month a year earlier, cut at the same hour; null unless year holds the coverage end
}
export type HeatPumpDaysOutput = { units: HeatPumpUnitDto[]; days: { heatPumpId: string; day: string; kwh: number;
  heatKwh: number; coolKwh: number; insideC: number | null; outsideC: number | null; setpointC: number | null;
  hours: number; expectedHours: number }[] }   // the brief's contract, consumed by step 4b
export function expectedHours(bounds: { startMs: number; endMs: number }, firstMs: number, endCapMs: number): number
export function getHeatPumpMonths(input?: { year?: number; now?: Date }): Promise<HeatPumpMonths>
export function getHeatPumpDays(input: { from: string; to: string; now?: Date }): Promise<HeatPumpDaysOutput>
```

  and `stockholmYearBefore(ms: number): number` in `stockholm.ts` (the same Stockholm wall-clock time one year
  earlier; 29 February → 28 February).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/time/stockholm.test.ts` (add `stockholmYearBefore` to its import):

```ts
describe('stockholmYearBefore', () => {
  test('keeps the Stockholm wall-clock time, across a DST difference and a leap day', () => {
    expect(stockholmYearBefore(utc('2026-03-01T12:00:00Z'))).toBe(utc('2025-03-01T12:00:00Z')) // 13:00 CET both
    // 2026-03-29 12:00 CEST (DST day 2026) → 2025-03-29 12:00 CET (DST came on the 30th in 2025)
    expect(stockholmYearBefore(utc('2026-03-29T10:00:00Z'))).toBe(utc('2025-03-29T11:00:00Z'))
    expect(stockholmYearBefore(utc('2028-02-29T11:00:00Z'))).toBe(utc('2027-02-28T11:00:00Z'))
  })
})
```

```ts
// src/lib/services/heatPump/heatPumpRead.test.ts
import { expect, test } from 'vitest'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { getHeatPumpDays, getHeatPumpMonths, type HeatPumpMonthCell } from './heatPumpRead'

setupDatabase()

const HOUR_MS = 3_600_000
const plusHours = (iso: string, n: number) => new Date(Date.parse(iso) + n * HOUR_MS).toISOString()
const cellOf = (cells: HeatPumpMonthCell[], heatPumpId: string, year: number, month: number) =>
  cells.find((c) => c.heatPumpId === heatPumpId && c.year === year && c.month === month)

// Matsal: 2025-10-25 00:00 Z … 10-27 23:00 Z; its end, 10-28 00:00 Z, is also `now` floored to the hour (AUTUMN_NOW).
// Övervåning: from 2025-10-26 10:00 Z for `overvaningHours` h; by default 14 (to 10-26 23:00 Z), then offline for
// 24 h, past the 13-hour trailing-lag threshold, so its silence counts as missing.
const AUTUMN_NOW = new Date('2025-10-28T00:30:00Z')
async function seedAutumn(overvaningHours = 14) {
  const ids = await seedUnits('Matsal', 'Övervåning')
  await storeHours(ids.Matsal, '2025-10-25T00:00:00Z', '2025-10-28T00:00:00Z')
  await storeHours(ids.Övervåning, '2025-10-26T10:00:00Z', plusHours('2025-10-26T10:00:00Z', overvaningHours))
  return ids
}

test('days: expected hours per Stockholm day, DST-aware, clipped to the first hour and the coverage end', async () => {
  const ids = await seedAutumn()
  const out = await getHeatPumpDays({ from: '2025-10-25', to: '2025-10-28', now: AUTUMN_NOW })
  expect(out.units).toEqual([
    { id: ids.Matsal, name: 'Matsal' },
    { id: ids.Övervåning, name: 'Övervåning' },
  ])
  const pick = (id: string) => out.days.filter((d) => d.heatPumpId === id).map((d) => [d.day, d.hours, d.expectedHours])
  expect(pick(ids.Matsal)).toEqual([
    ['2025-10-25', 22, 22], // from its first hour
    ['2025-10-26', 25, 25], // the 25-hour DST day, complete
    ['2025-10-27', 24, 24],
    ['2025-10-28', 1, 1], // up to the coverage end
  ])
  expect(pick(ids.Övervåning)).toEqual([
    // nothing before its first hour (2025-10-25 is absent)
    ['2025-10-26', 13, 13], // 10:00–22:00 Z; its 23:00 Z hour is Stockholm's 10-27
    ['2025-10-27', 1, 24], // offline for 24 h (≥ 13 h): 23 h missing
    ['2025-10-28', 0, 1], // a day inside the coverage with no readings: a gap, kWh 0
  ])
  const gap = out.days.find((d) => d.heatPumpId === ids.Övervåning && d.day === '2025-10-28')
  expect(gap).toMatchObject({ kwh: 0, heatKwh: 0, coolKwh: 0, insideC: null, outsideC: null, setpointC: null })
})

test.each([
  // 33 h: its newest hour is 10-27 18:00 Z, 5 h behind the coverage end: a lagging sync, not missing.
  [33, [['2025-10-26', 13, 13], ['2025-10-27', 20, 20]]],
  // 25 h: newest 10-27 10:00 Z, exactly 13 h behind: the trailing hours count as missing.
  [25, [['2025-10-26', 13, 13], ['2025-10-27', 12, 24], ['2025-10-28', 0, 1]]],
] as const)('days: a unit %i h long trails the coverage end; its tail is missing only from 13 h', async (hours, expected) => {
  const ids = await seedAutumn(hours)
  const out = await getHeatPumpDays({ from: '2025-10-25', to: '2025-10-28', now: AUTUMN_NOW })
  expect(
    out.days.filter((d) => d.heatPumpId === ids.Övervåning).map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual(expected)
})

test('both units silent for 2 days (Comfort Cloud stalled): the coverage runs to now, 48 h missing each', async () => {
  const ids = await seedUnits('Matsal', 'Övervåning')
  for (const id of [ids.Matsal, ids.Övervåning]) {
    await storeHours(id, '2026-03-01T00:00:00Z', '2026-03-08T00:00:00Z') // newest hour 03-07 23:00 Z
  }
  const now = new Date('2026-03-10T00:30:00Z') // floored: 03-10 00:00 Z, 48 h after the newest stored hour's end
  const months = await getHeatPumpMonths({ year: 2026, now })
  for (const id of [ids.Matsal, ids.Övervåning]) {
    // From the first hour (03-01 00:00 Z) to 03-10 00:00 Z: 216 expected, 168 stored → under 99 %, no change tile.
    expect(cellOf(months.months, id, 2026, 3)).toMatchObject({ hours: 168, expectedHours: 216 })
  }
  const days = await getHeatPumpDays({ from: '2026-03-07', to: '2026-03-10', now })
  expect(
    days.days.filter((d) => d.heatPumpId === ids.Matsal).map((d) => [d.day, d.hours, d.expectedHours]),
  ).toEqual([
    ['2026-03-07', 24, 24],
    ['2026-03-08', 1, 24],
    ['2026-03-09', 0, 24],
    ['2026-03-10', 0, 1],
  ])
  const missing = days.days.reduce((sum, d) => sum + d.expectedHours - d.hours, 0)
  expect(missing).toBe(2 * 48)
})

test('days: the 23-hour spring DST day is complete', async () => {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')
  const out = await getHeatPumpDays({ from: '2026-03-29', to: '2026-03-29', now: new Date('2026-04-01T00:00:00Z') })
  expect(out.days).toEqual([expect.objectContaining({ day: '2026-03-29', hours: 23, expectedHours: 23 })])
})

test('days: no future days, and nothing without readings', async () => {
  expect(await getHeatPumpDays({ from: '2025-10-01', to: '2025-10-31' })).toEqual({ units: [], days: [] })
  await seedAutumn()
  const out = await getHeatPumpDays({ from: '2025-10-27', to: '2025-11-30', now: AUTUMN_NOW })
  expect(Math.max(...out.days.map((d) => Number(d.day.slice(8))))).toBe(28)
  expect(out.days.every((d) => d.day <= '2025-10-28')).toBe(true)
})

// Matsal: Stockholm 2025-03-01 and -02 (48 h), then 2026-02-28 20:00 Z … 2026-03-01 11:00 Z (16 h; its end, 12:00 Z,
// is also `now` floored). Övervåning: 2026-03-01 05:00–07:00 Z only.
async function seedSpring() {
  const ids = await seedUnits('Matsal', 'Övervåning')
  // Two calls for Matsal are safe: they touch different UTC days.
  await storeHours(ids.Matsal, '2025-02-28T23:00:00Z', '2025-03-02T23:00:00Z')
  await storeHours(ids.Matsal, '2026-02-28T20:00:00Z', '2026-03-01T12:00:00Z')
  await storeHours(ids.Övervåning, '2026-03-01T05:00:00Z', '2026-03-01T08:00:00Z')
  return ids
}
const NOW = new Date('2026-03-01T12:30:00Z')

test('months, a year: cells inside each unit\'s history, gaps included, with expected hours', async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ year: 2026, now: NOW })
  expect(o.year).toBe(2026)
  expect(o.units.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
  expect(o.availableYears).toEqual([2026, 2025])
  expect(o.firstReadingDay).toBe('2025-03-01')
  expect(o.monthsWithReadings).toEqual(['2025-03', '2026-02', '2026-03'])
  expect(o.newestMonth).toBe('2026-03')
  // January: a whole month offline inside the history: 0 of 744 h.
  expect(cellOf(o.months, ids.Matsal, 2026, 1)).toMatchObject({ kwh: 0, hours: 0, expectedHours: 744 })
  // February ends at 2026-02-28 23:00 Z: 20, 21, 22 Z are February, 23 Z is March.
  expect(cellOf(o.months, ids.Matsal, 2026, 2)).toMatchObject({ hours: 3, expectedHours: 672 })
  expect(cellOf(o.months, ids.Matsal, 2026, 2)?.kwh).toBeCloseTo(0.3, 9)
  expect(cellOf(o.months, ids.Matsal, 2026, 3)).toMatchObject({ hours: 13, expectedHours: 13 })
  // Övervåning's history starts on 2026-03-01 05:00 Z: one cell. Its newest hour (07:00 Z) trails the coverage end
  // (12:00 Z) by 4 h, under the 13-hour threshold: those hours aren't missing.
  expect(o.months.filter((c) => c.heatPumpId === ids.Övervåning)).toEqual([
    expect.objectContaining({ year: 2026, month: 3, hours: 3, expectedHours: 3 }),
  ])
  // Last year: Matsal March–December 2025; March 2025 has 743 h (DST on the 30th), October 745.
  expect(o.lastYear.filter((c) => c.heatPumpId === ids.Matsal).map((c) => c.month)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(cellOf(o.lastYear, ids.Matsal, 2025, 3)).toMatchObject({ hours: 48, expectedHours: 743 })
  expect(cellOf(o.lastYear, ids.Matsal, 2025, 10)?.expectedHours).toBe(745)
})

test('months: the newest month a year earlier is cut at the same Stockholm hour (the running comparison)', async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ year: 2026, now: NOW })
  // Coverage ends 2026-03-01 12:00 Z → cut at 2025-03-01 12:00 Z: 13 of March 2025's 48 stored hours.
  expect(o.lastYearSoFar).toEqual([
    expect.objectContaining({ heatPumpId: ids.Matsal, year: 2025, month: 3, hours: 13, expectedHours: 13 }),
  ])
  expect(o.lastYearSoFar?.some((c) => c.heatPumpId === ids.Övervåning)).toBe(false)
  expect((await getHeatPumpMonths({ year: 2025, now: NOW })).lastYearSoFar).toBeNull()
})

test('months, Totalt (no year): every month of each unit\'s history, no last year', async () => {
  const ids = await seedSpring()
  const o = await getHeatPumpMonths({ now: NOW })
  expect(o.year).toBeNull()
  expect(o.months.filter((c) => c.heatPumpId === ids.Matsal)).toHaveLength(13) // 2025-03 … 2026-03
  expect(o.months).toHaveLength(14)
  expect(o.lastYear).toEqual([])
  expect(o.lastYearSoFar).toBeNull()
})

test('months: a year without readings opens on the current year; no readings at all is empty', async () => {
  const empty = await getHeatPumpMonths({ year: 2026, now: NOW })
  expect(empty).toEqual({
    units: [],
    year: 2026,
    availableYears: [2026],
    firstReadingDay: null,
    monthsWithReadings: [],
    newestMonth: null,
    months: [],
    lastYear: [],
    lastYearSoFar: null,
  })
  expect((await getHeatPumpMonths({ now: NOW })).year).toBeNull()
  await seedSpring()
  expect((await getHeatPumpMonths({ year: 2023, now: NOW })).year).toBe(2026)
})
```

Run: `bunx vitest run src/lib/time/stockholm.test.ts src/lib/services/heatPump/heatPumpRead.test.ts` → FAIL
(`stockholmYearBefore` / `./heatPumpRead` missing).

- [ ] **Step 2: `stockholmYearBefore`** (append to `stockholm.ts`; add `subYears` to the `date-fns` import)

```ts
/**
 * The same Stockholm wall-clock time one year earlier (29 February → 28 February): where "the same period a year
 * earlier" ends for a running period (heat pumps step 3).
 */
export function stockholmYearBefore(ms: number): number {
  return subYears(ms, 1, { in: inStockholm }).getTime()
}
```

- [ ] **Step 3: `heatPumpRead.ts`**

```ts
// src/lib/services/heatPump/heatPumpRead.ts
// The Värmepumpar page's read model (heat pumps step 3, ADR-0027 decision 6): month and day sums per unit with
// their expected hours. Only sums leave here, never an hour. Expected hours come from the Stockholm calendar
// (23–25 h days), clipped to the unit's first stored hour and to the coverage end: the end of the newest stored hour
// of any unit or `now` floored to the hour, whichever is later, so a unit that stops reporting, or a Comfort Cloud
// that stalls for both, shows missing hours (ADR-0024 clips its buckets the same way). Step 2's trailing-lag rule: a
// unit's hours after its own newest stored hour count as missing only once that gap, measured to the coverage end,
// reaches the source's stale threshold (13 h); a shorter lag is the 6-hourly sync's normal delay. Inner gaps always
// count.
import { millisecondsInHour } from 'date-fns/constants'
import { byHeatPumpName } from '~/lib/houseEnergy/figures'
import { monthKey } from '~/lib/houseEnergy/period'
import { STALE_AFTER_MS } from '~/lib/services/integrationSync/policy'
import {
  addDays,
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearBefore,
  stockholmYearMonth,
} from '~/lib/time/stockholm'
import { daySums, readingSpans } from './daySums'
import { listUnits } from './heatPump'
import { type HeatPumpMonthRow, monthSums } from './monthSums'

export type HeatPumpUnitDto = { id: string; name: string }

export type HeatPumpMonthCell = {
  heatPumpId: string
  year: number
  /** 1–12, Stockholm. */
  month: number
  kwh: number
  heatKwh: number
  coolKwh: number
  outsideC: number | null
  hours: number
  expectedHours: number
}

export type HeatPumpMonths = {
  /** Units with readings, in `byHeatPumpName` order: the chart's stack and colour order. */
  units: HeatPumpUnitDto[]
  /** The year asked for (the current Stockholm year when it has no readings); null: the whole history (Totalt). */
  year: number | null
  /** The first reading's year … the current year, newest first. */
  availableYears: number[]
  firstReadingDay: string | null
  /** 'YYYY-MM' of every month with readings (any unit), oldest first: the period control's months. */
  monthsWithReadings: string[]
  /** 'YYYY-MM' of the coverage end (the newest stored hour or now): the running period the comparison cuts. */
  newestMonth: string | null
  /** A year: each unit's months of it inside the unit's history; Totalt: every month of the history. Oldest first. */
  months: HeatPumpMonthCell[]
  /** A year: the same for the year before (the outline, the comparison); Totalt: []. */
  lastYear: HeatPumpMonthCell[]
  /**
   * The newest month a year earlier, cut at the same Stockholm hour (the running period's comparison); null unless
   * `year` holds the coverage end.
   */
  lastYearSoFar: HeatPumpMonthCell[] | null
}

export type HeatPumpDaysOutput = {
  units: HeatPumpUnitDto[]
  /** Per unit (`byHeatPumpName` order), per Stockholm day (oldest first) inside the unit's coverage; gap days have 0 hours. */
  days: {
    heatPumpId: string
    day: string
    kwh: number
    heatKwh: number
    coolKwh: number
    insideC: number | null
    outsideC: number | null
    setpointC: number | null
    hours: number
    expectedHours: number
  }[]
}

type YearMonth = { year: number; month: number }
/** A unit with readings: its first stored hour and where its expected hours end (`capMs`). */
type Covered = HeatPumpUnitDto & { firstMs: number; capMs: number }

/** Step 2's trailing-lag rule: the stale threshold (13 h, ADR-0019 policy). */
const TRAILING_LAG_MS = STALE_AFTER_MS.comfortCloud

/** Whole hours of `[bounds)` from `firstMs` to `endCapMs`; 0 when they don't overlap. Every bound is a whole UTC hour. */
export function expectedHours(
  bounds: { startMs: number; endMs: number },
  firstMs: number,
  endCapMs: number,
): number {
  const start = Math.max(bounds.startMs, firstMs)
  const end = Math.min(bounds.endMs, endCapMs)
  return end > start ? Math.round((end - start) / millisecondsInHour) : 0
}

// The units with readings (byHeatPumpName order, never SQL's), the coverage end (the newest stored hour's end or
// `now` floored to the hour, whichever is later), and each unit's cap: that end, or its own newest hour's end while
// it trails the coverage end by less than the stale threshold.
async function coverage(nowMs: number): Promise<{ units: Covered[]; endMs: number } | null> {
  const [units, spans] = await Promise.all([listUnits(), readingSpans()])
  if (spans.length === 0) return null
  const newestEndMs = Math.max(...spans.map((s) => s.lastHour.getTime())) + millisecondsInHour
  const endMs = Math.max(newestEndMs, Math.floor(nowMs / millisecondsInHour) * millisecondsInHour)
  const byId = new Map(spans.map((s) => [s.heatPumpId, s]))
  const covered = units
    .flatMap((u) => {
      const s = byId.get(u.id)
      if (!s) return []
      const ownEndMs = s.lastHour.getTime() + millisecondsInHour
      return [
        {
          id: u.id,
          name: u.name,
          firstMs: s.firstHour.getTime(),
          capMs: endMs - ownEndMs >= TRAILING_LAG_MS ? endMs : ownEndMs,
        },
      ]
    })
    .sort(byHeatPumpName)
  return covered.length === 0 ? null : { units: covered, endMs }
}

const dto = (u: Covered): HeatPumpUnitDto => ({ id: u.id, name: u.name })

function monthsFrom(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = []
  let { year, month } = from
  while (year < to.year || (year === to.year && month <= to.month)) {
    out.push({ year, month })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

function cellOf(
  unitId: string,
  ym: YearMonth,
  row: HeatPumpMonthRow | undefined,
  expected: number,
): HeatPumpMonthCell {
  return row
    ? {
        heatPumpId: unitId,
        year: ym.year,
        month: ym.month,
        kwh: row.kwh,
        heatKwh: row.heatKwh,
        coolKwh: row.coolKwh,
        outsideC: row.outsideC,
        hours: row.hours,
        expectedHours: Math.max(expected, row.hours),
      }
    : {
        heatPumpId: unitId,
        year: ym.year,
        month: ym.month,
        kwh: 0,
        heatKwh: 0,
        coolKwh: 0,
        outsideC: null,
        hours: 0,
        expectedHours: expected,
      }
}

const rowKey = (heatPumpId: string, year: number, month: number) => `${heatPumpId}|${monthKey(year, month)}`

/**
 * Month sums for a year and the year before (`year` given), or for the whole history (`year` omitted: Totalt). One
 * grouped read over the history (`monthSums`, ≈ 17,5k rows a year for two units), plus one month for the running
 * comparison when `year` holds the coverage end.
 */
export async function getHeatPumpMonths(
  input: { year?: number; now?: Date } = {},
): Promise<HeatPumpMonths> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const cov = await coverage(now.getTime())
  if (!cov) {
    return {
      units: [],
      year: input.year === undefined ? null : current.year,
      availableYears: [current.year],
      firstReadingDay: null,
      monthsWithReadings: [],
      newestMonth: null,
      months: [],
      lastYear: [],
      lastYearSoFar: null,
    }
  }
  const firstMs = Math.min(...cov.units.map((u) => u.firstMs))
  const newest = stockholmYearMonth(cov.endMs - 1)
  const rows = await monthSums({ from: new Date(firstMs), to: new Date(cov.endMs) })
  const byKey = new Map(rows.map((r) => [rowKey(r.heatPumpId, r.year, r.month), r]))
  // Each unit's months from its first through the newest: a month without hours inside them is a gap. A month the
  // unit's cap doesn't reach (a new month's first hours, the sync not run yet) has nothing to say: left out.
  const cells = cov.units
    .flatMap((u) =>
      monthsFrom(stockholmYearMonth(u.firstMs), newest).map((ym) =>
        cellOf(
          u.id,
          ym,
          byKey.get(rowKey(u.id, ym.year, ym.month)),
          expectedHours(stockholmMonthBounds(ym.year, ym.month), u.firstMs, u.capMs),
        ),
      ),
    )
    .filter((c) => c.expectedHours > 0 || c.hours > 0)
  const first = stockholmYearMonth(firstMs)
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year === undefined ? null : availableYears.includes(input.year) ? input.year : current.year

  let lastYearSoFar: HeatPumpMonthCell[] | null = null
  if (year === newest.year) {
    const cutMs = stockholmYearBefore(cov.endMs)
    const ym = { year: newest.year - 1, month: newest.month }
    const bounds = stockholmMonthBounds(ym.year, ym.month)
    const soFar = await monthSums({ from: new Date(bounds.startMs), to: new Date(cutMs) })
    lastYearSoFar = cov.units.flatMap((u) => {
      const expected = expectedHours(bounds, u.firstMs, cutMs)
      const row = soFar.find((r) => r.heatPumpId === u.id && r.year === ym.year && r.month === ym.month)
      return expected === 0 && !row ? [] : [cellOf(u.id, ym, row, expected)]
    })
  }

  return {
    units: cov.units.map(dto),
    year,
    availableYears,
    firstReadingDay: stockholmDayOf(firstMs),
    monthsWithReadings: [
      ...new Set(rows.filter((r) => r.hours > 0).map((r) => monthKey(r.year, r.month))),
    ].sort(),
    newestMonth: monthKey(newest.year, newest.month),
    months: year === null ? cells : cells.filter((c) => c.year === year),
    lastYear: year === null ? [] : cells.filter((c) => c.year === year - 1),
    lastYearSoFar,
  }
}

/**
 * Day sums for `[from, to]` (Stockholm days, inclusive; the procedure caps the range at 800 days), never past today.
 * Each unit gets every day inside its coverage, a gap day with 0 hours.
 */
export async function getHeatPumpDays(input: {
  from: string
  to: string
  now?: Date
}): Promise<HeatPumpDaysOutput> {
  const nowMs = (input.now ?? new Date()).getTime()
  const today = stockholmDayOf(nowMs)
  const to = input.to < today ? input.to : today
  const cov = await coverage(nowMs)
  if (!cov) return { units: [], days: [] }
  if (to < input.from) return { units: cov.units.map(dto), days: [] }
  const rows = await daySums({ from: input.from, to })
  const byKey = new Map(rows.map((r) => [`${r.heatPumpId}|${r.day}`, r]))
  const days: HeatPumpDaysOutput['days'] = []
  for (const u of cov.units) {
    for (let day = input.from; day <= to; day = addDays(day, 1)) {
      const expected = expectedHours(stockholmDayBounds(day), u.firstMs, u.capMs)
      const row = byKey.get(`${u.id}|${day}`)
      if (row) days.push({ ...row, expectedHours: Math.max(expected, row.hours) })
      else if (expected > 0)
        days.push({
          heatPumpId: u.id,
          day,
          kwh: 0,
          heatKwh: 0,
          coolKwh: 0,
          insideC: null,
          outsideC: null,
          setpointC: null,
          hours: 0,
          expectedHours: expected,
        })
    }
  }
  return { units: cov.units.map(dto), days }
}
```

`index.ts`: add `export * from './heatPumpRead'`.

- [ ] **Step 4: Run** `bunx vitest run src/lib/time/stockholm.test.ts src/lib/services/heatPump/ && TZ=UTC bunx vitest run src/lib/time/stockholm.test.ts src/lib/services/heatPump/heatPumpRead.test.ts` → PASS.
  If a number in a test is off, recompute it by hand from the fixture comment before touching the code (each figure
  is derived there); fix the code, not the expectation, unless the hand computation disagrees.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/services/heatPump/heatPumpRead.ts src/lib/services/heatPump/heatPumpRead.test.ts \
  src/lib/services/heatPump/index.ts src/lib/time/stockholm.ts src/lib/time/stockholm.test.ts
git commit -m "feat(heat-pumps): read heat pump months and days with expected hours" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Procedures `heatPump.months` / `heatPump.days`

**Reviewers:** `code-reviewer` + reviewer loading `better-auth-security-best-practices` (told: read-only, protected,
input bounds, no hourly data or timestamps leave, no 500 on bad input).

**Files:**
- Create: `src/lib/heatPump/period.ts`, `src/lib/heatPump/period.test.ts`,
  `src/lib/orpc/procedures/heatPump.ts`, `src/lib/orpc/procedures/heatPump.test.ts`
- Modify: `src/lib/orpc/router.ts`; `src/components/evCharging/SyncNowButton.tsx` and
  `SyncNowButton.browser.test.tsx` (step 1b's literal heat pump key prefix → `orpc.heatPump.key()`, now that the
  router exists)

**Interfaces:**
- Consumes: Task 3's `getHeatPumpMonths`, `getHeatPumpDays`.
- Produces: `HEAT_PUMP_DAYS_MAX = 800`, `monthDays(year, month): { from: string; to: string }` (client-safe);
  `heatPumpRouter` registered as `heatPump` (`heatPump.months` input `{ year?: int 2020–2100 }`, `heatPump.days`
  input `{ from: 'YYYY-MM-DD'; to: 'YYYY-MM-DD' }`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/heatPump/period.test.ts
import { expect, test } from 'vitest'
import { HEAT_PUMP_DAYS_MAX, monthDays } from './period'

test('a month\'s first and last day, leap years included', () => {
  expect(monthDays(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  expect(monthDays(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  expect(monthDays(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  expect(HEAT_PUMP_DAYS_MAX).toBe(800)
})
```

```ts
// src/lib/orpc/procedures/heatPump.test.ts
import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { addDays } from '~/lib/time/stockholm'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { heatPumpRouter } from './heatPump'

setupDatabase()

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog
  },
}
const context = (timings?: Record<string, number>) => ({
  headers: new Headers(),
  log: noopLog,
  requestId: 'test-request',
  timings,
})

// As energy.test.ts: a real user row, the session mocked.
async function signIn(role: 'user' | 'admin') {
  const [row] = await db
    .insert(user)
    .values({ name: role, email: `${role}@test.videbacken.local`, role })
    .returning({ id: user.id, email: user.email })
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
      role,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function seedDay() {
  const ids = await seedUnits('Matsal')
  await storeHours(ids.Matsal, '2026-02-10T00:00:00Z', '2026-02-11T00:00:00Z')
}

test('a member reads months and days; both record their timing', async () => {
  await seedDay()
  await signIn('user')
  const timings: Record<string, number> = {}
  const months = await call(heatPumpRouter.months, { year: 2026 }, { context: context(timings) })
  expect(months.year).toBe(2026)
  const days = await call(heatPumpRouter.days, { from: '2026-02-01', to: '2026-02-28' }, { context: context(timings) })
  expect(days.days.length).toBeGreaterThan(0)
  expect(typeof timings.heatPumpMonthsMs).toBe('number')
  expect(typeof timings.heatPumpDaysMs).toBe('number')
})

test('rejects an unauthenticated caller', async () => {
  await expect(call(heatPumpRouter.months, {}, { context: context() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(
    call(heatPumpRouter.days, { from: '2026-02-01', to: '2026-02-28' }, { context: context() }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('months: a year outside 2020–2100 or not whole is a bad request', async () => {
  await signIn('user')
  for (const year of [2019, 2101, 2026.5]) {
    await expect(call(heatPumpRouter.months, { year }, { context: context() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

test('days: at most 800 days, from ≤ to, real days only; never a server error', async () => {
  await signIn('user')
  const from = '2024-01-01'
  await expect(
    call(heatPumpRouter.days, { from, to: addDays(from, 799) }, { context: context() }),
  ).resolves.toBeDefined()
  for (const input of [
    { from, to: addDays(from, 800) }, // 801 days
    { from: '2026-02-10', to: '2026-02-09' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-2-1', to: '2026-02-28' },
    { from: 'junk', to: 'junk' },
  ]) {
    await expect(call(heatPumpRouter.days, input, { context: context() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  }
})

test('privacy: only month and day sums leave; no hour and no timestamp in any output', async () => {
  await seedDay()
  await signIn('user')
  const months = await call(heatPumpRouter.months, { year: 2026 }, { context: context() })
  expect(Object.keys(months).sort()).toEqual([
    'availableYears',
    'firstReadingDay',
    'lastYear',
    'lastYearSoFar',
    'months',
    'monthsWithReadings',
    'newestMonth',
    'units',
    'year',
  ])
  const cellKeys = ['coolKwh', 'expectedHours', 'heatKwh', 'heatPumpId', 'hours', 'kwh', 'month', 'outsideC', 'year']
  expect(months.months.length).toBeGreaterThan(0) // the key check is not vacuous
  for (const c of [...months.months, ...months.lastYear, ...(months.lastYearSoFar ?? [])]) {
    expect(Object.keys(c).sort()).toEqual(cellKeys)
  }
  expect(months.units.every((u) => Object.keys(u).sort().join() === 'id,name')).toBe(true)

  const days = await call(heatPumpRouter.days, { from: '2026-02-01', to: '2026-02-28' }, { context: context() })
  expect(Object.keys(days).sort()).toEqual(['days', 'units'])
  // One row per unit and day, never per hour: 2026-02-10 (23 of its hours), 02-11 (the 23:00 Z hour), then gap days
  // to the 28th (the readings stopped long before `now`, so the coverage runs on: 19 days in all).
  expect(days.days).toHaveLength(19)
  expect(days.days.slice(0, 2).map((d) => [d.day, d.hours])).toEqual([
    ['2026-02-10', 23],
    ['2026-02-11', 1],
  ])
  expect(days.days.slice(2).every((d) => d.hours === 0 && d.expectedHours === 24)).toBe(true)
  for (const d of days.days) {
    expect(Object.keys(d).sort()).toEqual([
      'coolKwh',
      'day',
      'expectedHours',
      'heatKwh',
      'heatPumpId',
      'hours',
      'insideC',
      'kwh',
      'outsideC',
      'setpointC',
    ])
    expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
  for (const out of [months, days]) expect(JSON.stringify(out)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
})
```

Run: `bunx vitest run src/lib/heatPump/period.test.ts src/lib/orpc/procedures/heatPump.test.ts` → FAIL (modules missing).

- [ ] **Step 2: Implement**

```ts
// src/lib/heatPump/period.ts
// Client-safe (heat pumps step 3): the day range rule of `heatPump.days` and a month's days, shared by the
// procedure and the page.

/** The longest range `heatPump.days` answers, in days (inclusive). */
export const HEAT_PUMP_DAYS_MAX = 800

/** The first and last Stockholm calendar day of `month` (1–12) of `year`, 'YYYY-MM-DD'. Calendar maths only. */
export function monthDays(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0')
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}
```

```ts
// src/lib/orpc/procedures/heatPump.ts
import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { HEAT_PUMP_DAYS_MAX } from '~/lib/heatPump/period'
import { protectedProcedure } from '~/lib/orpc/context'
import { getHeatPumpDays, getHeatPumpMonths } from '~/lib/services/heatPump'
import { daysBetween, isStockholmDay } from '~/lib/time/stockholm'

const day = z.string().refine(isStockholmDay, { message: 'Expected a YYYY-MM-DD day' })
// isStockholmDay again inside: an object refinement must never reach daysBetween with a bad day (it throws).
const dayRange = z.object({ from: day, to: day }).refine(
  ({ from, to }) =>
    isStockholmDay(from) &&
    isStockholmDay(to) &&
    from <= to &&
    daysBetween(from, to) < HEAT_PUMP_DAYS_MAX,
  { message: `Expected from ≤ to and at most ${HEAT_PUMP_DAYS_MAX} days` },
)

export const heatPumpRouter = {
  // The Värmepumpar page's month read (heat pumps step 3, ADR-0027): a year and the year before, or the whole
  // history without a year (Totalt). Any signed-in member: read-only. Sums only.
  months: protectedProcedure
    .input(
      z.object({ year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional() }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const out = await getHeatPumpMonths({ year: input.year })
      if (context.timings)
        context.timings.heatPumpMonthsMs = Math.round(performance.now() - startedAt)
      return out
    }),
  // Per unit per Stockholm day of a range (a month on the page; step 4b's signature reads longer ones). Sums only.
  days: protectedProcedure.input(dayRange).handler(async ({ input, context }) => {
    const startedAt = performance.now()
    const out = await getHeatPumpDays({ from: input.from, to: input.to })
    if (context.timings) context.timings.heatPumpDaysMs = Math.round(performance.now() - startedAt)
    return out
  }),
}
```

`router.ts`: `import { heatPumpRouter } from './procedures/heatPump'` and `heatPump: heatPumpRouter,` (alphabetical,
after `health`).

- [ ] **Step 3: Step 1b's key prefix.** Step 1b invalidates the literal `[['heatPump'], {}]` after a Comfort Cloud
  Synka nu, with a comment asking this step to switch. In `SyncNowButton.tsx`, delete `HEAT_PUMP_QUERY_PREFIX` and
  its comment, and invalidate the router's own key:

```ts
            // energy.overview carries heat pump data (step 2); heatPump.* is the Värmepumpar page (step 3).
            void queryClient.invalidateQueries({ queryKey: orpc.energy.key() })
            void queryClient.invalidateQueries({ queryKey: orpc.heatPump.key() })
```

  In `SyncNowButton.browser.test.tsx`, the `~/lib/orpc/client` mock gains `heatPump: { key: () => ['heatPump'] }`
  (beside `energy`), and the two Comfort Cloud tests assert `{ queryKey: ['heatPump'] }` instead of
  `{ queryKey: [['heatPump'], {}] }` (called on success, not called on a failure), as they do for `['energy']`.

- [ ] **Step 4: Run** `bunx vitest run src/lib/heatPump/ src/lib/orpc/procedures/heatPump.test.ts && bunx vitest run --project browser src/components/evCharging/SyncNowButton.browser.test.tsx && bun run typecheck` → PASS.
  If Zod 4 runs the object refinement despite a failed field (the `junk` case would then throw inside
  `daysBetween`), the guard above already covers it; if a case still answers 500, the test says so.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/heatPump/period.ts src/lib/heatPump/period.test.ts src/lib/orpc/procedures/heatPump.ts \
  src/lib/orpc/procedures/heatPump.test.ts src/lib/orpc/router.ts \
  src/components/evCharging/SyncNowButton.tsx src/components/evCharging/SyncNowButton.browser.test.tsx
git commit -m "feat(heat-pumps): add the heat pump months and days procedures" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `BarChart` options — a line on a right-hand axis, an outline series

**Decision: extend `src/components/chart/`, not a sibling component.** `BarChart` already owns everything this chart
needs besides two details: hover and keyboard walking, the portalled tooltip card, selection with its outline and
tint, legend, the label thinning and short labels, SSR-safe measuring, and a line overlay (`line?: LineSeries`,
Spot's month average). A sibling would copy ~600 lines of that behaviour and its 900 lines of tests, and the two would
drift. The two missing details are small and generic: the existing line gets its own scale and axis on the right
(its values no longer stretch the bars' axis), and a bar series can draw as an outline (no fill). Both are opt-in, so
every existing chart renders as before (their tests run unchanged). The right axis' ticks don't align with the left
grid; the grid stays the bars' (a second grid would read as clutter), as in most dual-axis charts.

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told: the
existing charts must be unchanged; their tests pass without edits).

**Files:**
- Modify: `src/components/chart/barLayout.ts` (`BarSeries.outline`), `src/components/chart/BarChart.tsx`,
  `src/components/chart/ChartParts.tsx` (`ChartLegend`, `TooltipRow`)
- Test: `src/components/chart/BarChart.browser.test.tsx` (append)

**Interfaces:**
- Produces:
  - `LineSeries = { key; label; color; dash?; axis?: 'left' | 'right'; tickFormat?: (v: number) => string; strokeWidth?: number }`
    (`axis: 'right'`: own scale over the line's values (0 included), an axis on the right labelled with `tickFormat`
    (default `yTickFormat`), the plot narrowed to fit it; the bars' extent ignores the line)
  - `BarSeries.outline?: boolean` (no fill; a `color` stroke of `strokeWidth ?? 1.5`)
  - `ChartLegend` items and `TooltipRow` accept `outline?: boolean` (an outlined swatch)
  - DOM hook: the right axis is `<g data-axis="y-right">`

- [ ] **Step 1: Write the failing tests** (append to `BarChart.browser.test.tsx`; it already has `render`, `base`,
  `rows`; add `lineDots` to the `~test/browser/chartDom` import)

```tsx
const rightTicks = (root: ParentNode) =>
  [...root.querySelectorAll('[data-axis="y-right"] .visx-axis-tick')].map((t) => t.textContent ?? '')

test('a right-axis line gets its own scale and axis; the bars keep theirs', async () => {
  const { screen } = await render({
    series: [{ key: 'a', label: 'Serie A', color: 'red' }],
    // b: 5, –, 0, 10 against a: 10, –, 0, 30. On the left axis b would sit at a third of the plot.
    line: { key: 'b', label: 'Temp', color: 'blue', axis: 'right', tickFormat: (v) => `${v}°` },
  })
  await vi.waitFor(() => expect(rightTicks(screen.container).length).toBeGreaterThan(1))
  expect(rightTicks(screen.container).every((t) => t.endsWith('°'))).toBe(true)
  // April's dot (b = 10, the line's top) sits level with April's bar top (a = 30, the bars' top).
  const aprBar = bars(screen.container).find((b) => b.getAttribute('data-index') === '3')
  const dots = lineDots(screen.container)
  expect(dots).toHaveLength(3)
  const aprDot = dots[dots.length - 1]
  expect(Math.abs(centre(aprDot).y - (aprBar?.getBoundingClientRect().top ?? 0))).toBeLessThan(2)
})

test('the right axis labels stay inside the chart', async () => {
  const { screen } = await render({
    line: { key: 'b', label: 'Temp', color: 'blue', axis: 'right', tickFormat: (v) => `${v} °C` },
  })
  await vi.waitFor(() => expect(rightTicks(screen.container).length).toBeGreaterThan(1))
  const box = screen.container.querySelector('[data-chart="bar"]')?.getBoundingClientRect()
  for (const t of screen.container.querySelectorAll('[data-axis="y-right"] text')) {
    expect(t.getBoundingClientRect().right).toBeLessThanOrEqual((box?.right ?? 0) + 0.5)
  }
})

test('without axis: "right" there is no right axis', async () => {
  const { screen } = await render({ line: { key: 'b', label: 'Serie B', color: 'blue' } })
  await vi.waitFor(() => expect(lineDots(screen.container).length).toBeGreaterThan(0))
  expect(screen.container.querySelector('[data-axis="y-right"]')).toBeNull()
})

test('an outline series draws unfilled bars in its colour and an outlined legend swatch', async () => {
  const { screen } = await render({
    series: [
      { key: 'a', label: 'Serie A', color: 'red', stack: 's' },
      { key: 'b', label: 'Förra året', color: 'gray', outline: true },
    ],
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 1).length).toBeGreaterThan(0))
  const bar = seriesBars(screen.container, 1)[0]
  expect(bar.getAttribute('fill')).toBe('none')
  expect(bar.getAttribute('stroke')).toBe('gray')
  // Beside the stack, not on it: a slot of its own.
  const a = seriesBars(screen.container, 0)[0].getBoundingClientRect()
  expect(bar.getBoundingClientRect().left).toBeGreaterThanOrEqual(a.right - 0.5)
  const swatch = screen.container.querySelector<HTMLElement>('[data-legend-item="b"] > div')
  expect(swatch?.style.boxShadow).toContain('inset')
  expect(swatch?.style.backgroundColor).toBe('')
})
```

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx` → the four new tests FAIL.

- [ ] **Step 2: Implement**

`barLayout.ts`, in `BarSeries` after `pattern`:

```ts
  /** Drawn as an outline: no fill, a `color` stroke (`strokeWidth`, default 1.5), e.g. last year beside this year. */
  outline?: boolean
```

`ChartParts.tsx`: `TooltipRow` gains `outline?: boolean`; its swatch style becomes
`style={outline ? { boxShadow: \`inset 0 0 0 1.5px ${color}\` } : { background: color }}`. `ChartLegend`'s item type
gains `outline?: boolean`, and its swatch style:

```tsx
            style={
              item.outline
                ? { boxShadow: `inset 0 0 0 1.5px ${item.color}` }
                : item.pattern === 'hatch'
                  ? { backgroundImage: HATCH_SWATCH(item.color) }
                  : { backgroundColor: item.color }
            }
```

`BarChart.tsx`:

1. Import `AxisRight` with `AxisLeft`, and `type ScaleLinear` from `d3-scale`.
2. The type:

```ts
export type LineSeries = {
  key: string
  label: string
  color: string
  dash?: string
  /** 'right': its own scale (0 included) and an axis on the right; the bars' axis ignores it. Default 'left'. */
  axis?: 'left' | 'right'
  /** The right axis' tick labels (default `yTickFormat`). */
  tickFormat?: (v: number) => string
  /** Default 2. */
  strokeWidth?: number
}
```

3. In the geometry memo, replace the `keys` line and the scale / width block:

```ts
    const right = line?.axis === 'right' ? line : undefined
    const keys = line && !right ? [...series, { key: line.key, label: '', color: '' }] : series
    const measure = measureAt(tickPx)
    const extent = stackExtent({ count, series: keys, value: at, offset: stackOffset })
    const plotH = Math.max(0, plotBoxH - marginTop - MARGIN.bottom - X_AXIS_H)
    const y = yScaleFor({ extent, height: plotH, integers: yIntegers, domain: yDomain })
    const yLabels = y.ticks.map(yTickFormat)
    const yAxisW = hideYAxis ? 0 : yAxisWidth(yLabels, measure)
    const left = MARGIN.left + yAxisW
    let yRight: { scale: ScaleLinear<number, number>; ticks: number[] } | null = null
    let rightW: number = MARGIN.right
    if (right) {
      const values = range(count).flatMap((i) => {
        const v = at(i, right.key)
        return v === null ? [] : [v]
      })
      yRight = yScaleFor({
        extent: values.length ? [Math.min(...values), Math.max(...values)] : [0, 0],
        height: plotH,
      })
      rightW = Math.max(MARGIN.right, yAxisWidth(yRight.ticks.map(right.tickFormat ?? yTickFormat), measure))
    }
    const plotW = Math.max(0, width - left - rightW)
```

   and return `yRight` with the rest (`return { x, y, yRight, left, plotW, plotH, xTicks, rects, centres, short }`).
4. A helper after `selected`: `const lineScale = geometry ? (geometry.yRight ?? geometry.y).scale : null`. In `anchor`,
   `geometry.y.scale(dot)` becomes `(geometry.yRight ?? geometry.y).scale(dot)`. In the line's `LinePath` and dots,
   `geometry.y.scale(…)` becomes `(lineScale ?? geometry.y.scale)(…)`; `strokeWidth={2}` on the path becomes
   `strokeWidth={line.strokeWidth ?? 2}`.
5. Bars: in `common`,

```ts
                  fill: s.outline
                    ? 'none'
                    : s.pattern === 'hatch'
                      ? `url(#${patternId}-${s.key})`
                      : s.color,
                  stroke: s.outline ? s.color : s.stroke,
                  strokeWidth: s.outline ? (s.strokeWidth ?? 1.5) : s.strokeWidth,
```

6. `legendItems`: series items carry `outline: s.outline` (destructure it with `pattern`).
7. The right axis, after the `data-axis="y"` group:

```tsx
        {geometry.yRight && line ? (
          <g data-axis="y-right">
            <AxisRight
              left={geometry.plotW}
              scale={geometry.yRight.scale}
              tickValues={geometry.yRight.ticks}
              tickFormat={(v) => (line.tickFormat ?? yTickFormat)(Number(v))}
              hideTicks
              tickLength={TICK_SIZE}
              hideAxisLine={!yAxisLine}
              stroke={AXIS_COLOR}
              tickLabelProps={() => ({
                ...tickLabel,
                dx: Y_TICK_MARGIN,
                dy: '0.32em',
                textAnchor: 'start' as const,
              })}
            />
          </g>
        ) : null}
```

- [ ] **Step 3: Run** `bunx vitest run --project browser src/components/chart/ src/components/energy/ src/components/evCharging/ src/components/sensor/ && bun run typecheck`
  → PASS; `git diff --stat -- src/components/energy src/components/evCharging src/components/sensor` prints nothing.

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/components/chart
git commit -m "feat(charts): add a right-axis line and outline bar series" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The view model `heatPumpView.ts` and formatters (pure, test-first)

**How `?period=` maps to this page** (read from `energySearch.ts`, `period.ts`, `PeriodControl.tsx`,
`useEnergyPeriod.ts`): the URL holds a month (`2026-09`), a year (`2026`, a number) or `all`; `resolvePeriod` falls
back to the current month (or the newest month with readings this year, else Totalt) when the asked-for period has
no readings; the control steps within the kind and its picker offers months, the whole year and Totalt. On
Värmepumpar:

| Period | Chart | Tiles from | Reads |
|---|---|---|---|
| month `2026-09` | one bar per day of the month (stacked units), outdoor line | `months` cells of that month (+ last year's or `lastYearSoFar`) | `heatPump.months({ year: 2026 })` + `heatPump.days(2026-09-01…30)` |
| year `2026` | 12 month bars, last year's outline beside each, outdoor line; a month click selects it | the year's cells (+ last year's, cut for a running year) | `heatPump.months({ year: 2026 })` |
| `all` | one bar per month from the first reading's month to the newest; a month click selects it | every cell, no comparison | `heatPump.months({})` |

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/components/heatPump/heatPumpView.ts`, `src/components/heatPump/heatPumpView.test.ts`,
  `src/components/heatPump/format.ts`, `src/components/heatPump/format.test.ts`, `test/fixtures/heatPumpView.ts`

**Interfaces:**
- Consumes: `HeatPumpMonths`, `HeatPumpMonthCell`, `HeatPumpDaysOutput`, `HeatPumpUnitDto` (types only);
  `monthDays`; `COVERAGE_COMPLETE` and step 2's `byHeatPumpName` (`~/lib/houseEnergy/figures`); step 2's
  `heatPumpColor(units, id)` (`~/lib/houseEnergy/heatPumpColors`; Task 0 confirms both paths); `EnergyPeriod`, `monthKey`.
- Produces:

```ts
export const LAST_YEAR_KEY = 'lastYear'
export const OUTDOOR_KEY = 'outdoor'
export type HeatPumpChartRow = { key: string; label: string; short: string; title: string;
  month: { year: number; month: number } | null; selectable: boolean; kwh: Record<string, number | null>;
  total: number | null; lastYear: number | null; outdoorC: number | null; missingHours: number; running: boolean }
export type HeatPumpTile = { id: string; name: string; color: string; kwh: number | null; change: number | null }
export type HeatPumpTiles = { units: HeatPumpTile[]; outdoorC: number | null; missingHours: number | null;
  comparedWith: string | null; running: boolean }
export type HeatPumpView = { kind: 'month' | 'year' | 'all'; year: number | null; units: HeatPumpUnitDto[];
  rows: HeatPumpChartRow[]; tiles: HeatPumpTiles; chartLabel: string; periodLabel: string }
export function meanOutdoor(cells: readonly { outsideC: number | null; hours: number }[]): number | null
export function heatPumpView(input: { months: HeatPumpMonths; days: HeatPumpDaysOutput | null; period: EnergyPeriod;
  now: { year: number; month: number }; today: string }): HeatPumpView | null   // null: the reads don't match the period
// format.ts
export function formatChange(change: number): string      // "−19 %", "+25 %", "0 %"
export function formatCelsius(c: number): string          // "−2,6 °C"
export function formatCelsiusTick(c: number): string      // "−5°"
export function formatKwh(kwh: number): string            // "42,3 kWh" under 100, "1 512 kWh" from 100
```

- [ ] **Step 1: The payload fixture**

```ts
// test/fixtures/heatPumpView.ts
// Synthetic `heatPump.months` / `heatPump.days` payloads (heat pumps step 3). Never the owner's figures.
import type { HeatPumpDaysOutput, HeatPumpMonthCell, HeatPumpMonths } from '~/lib/services/heatPump'

export const MATSAL = { id: '00000000-0000-4000-8000-000000000001', name: 'Matsal' }
export const OVERVANING = { id: '00000000-0000-4000-8000-000000000002', name: 'Övervåning' }
const UNITS = [MATSAL, OVERVANING]
const pad = (n: number) => String(n).padStart(2, '0')
export const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/** A complete month cell: 100 kWh, all heating, 2 °C outside, 720 of 720 hours, unless overridden. */
export const cell = (
  unit: { id: string },
  year: number,
  month: number,
  over: Partial<HeatPumpMonthCell> = {},
): HeatPumpMonthCell => ({
  heatPumpId: unit.id,
  year,
  month,
  kwh: 100,
  heatKwh: 100,
  coolKwh: 0,
  outsideC: 2,
  hours: 720,
  expectedHours: 720,
  ...over,
})

/**
 * The year 2026 read on 2026-09-15: both units, 2025 complete, 2026 up to September (the newest month, half done:
 * 50 kWh in 360 of 360 hours so far), and September 2025 cut at the same hour (50 kWh, 360 h).
 */
export function monthsPayload(over: Partial<HeatPumpMonths> = {}): HeatPumpMonths {
  return {
    units: UNITS,
    year: 2026,
    availableYears: [2026, 2025],
    firstReadingDay: '2025-01-01',
    monthsWithReadings: [
      ...span(1, 12).map((mo) => `2025-${pad(mo)}`),
      ...span(1, 9).map((mo) => `2026-${pad(mo)}`),
    ],
    newestMonth: '2026-09',
    months: UNITS.flatMap((u) => [
      ...span(1, 8).map((mo) => cell(u, 2026, mo)),
      cell(u, 2026, 9, { kwh: 50, hours: 360, expectedHours: 360 }),
    ]),
    lastYear: UNITS.flatMap((u) => span(1, 12).map((mo) => cell(u, 2025, mo))),
    lastYearSoFar: UNITS.map((u) => cell(u, 2025, 9, { kwh: 50, hours: 360, expectedHours: 360 })),
    ...over,
  }
}

/** Totalt: every month 2025-01 … 2026-09 of both units in `months`, no last year. */
export function allPayload(): HeatPumpMonths {
  const year = monthsPayload()
  return monthsPayload({ year: null, months: [...year.lastYear, ...year.months], lastYear: [], lastYearSoFar: null })
}

/** Days 1 … `withData` of a month: Matsal 5 kWh, Övervåning 2 kWh a day, 3 °C outside, 24 of 24 hours. */
export function daysPayload(year: number, month: number, withData: number): HeatPumpDaysOutput {
  const days = span(1, withData).map((d) => `${year}-${pad(month)}-${pad(d)}`)
  return {
    units: UNITS,
    days: UNITS.flatMap((u, i) =>
      days.map((day) => ({
        heatPumpId: u.id,
        day,
        kwh: i === 0 ? 5 : 2,
        heatKwh: i === 0 ? 5 : 2,
        coolKwh: 0,
        insideC: 21,
        outsideC: 3,
        setpointC: 21,
        hours: 24,
        expectedHours: 24,
      })),
    ),
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/components/heatPump/format.test.ts
import { expect, test } from 'vitest'
import { formatCelsius, formatCelsiusTick, formatChange, formatKwh } from './format'

test('a change is a signed whole percent; one that rounds to zero has no sign', () => {
  expect(formatChange(-0.190476)).toMatch(/^−19\s%$/)
  expect(formatChange(0.25)).toMatch(/^\+25\s%$/)
  expect(formatChange(0.001)).toMatch(/^0\s%$/)
  expect(formatChange(-0.001)).toMatch(/^0\s%$/)
})

test('temperatures and kWh', () => {
  expect(formatCelsius(-2.6)).toMatch(/^−2,6\s°C$/)
  expect(formatCelsius(3)).toMatch(/^3,0\s°C$/)
  expect(formatCelsiusTick(-5)).toBe('−5°')
  expect(formatCelsiusTick(2.5)).toBe('2,5°')
  expect(formatKwh(42.26)).toBe('42,3 kWh')
  expect(formatKwh(1512.4)).toMatch(/^1\s512 kWh$/)
})
```

```ts
// src/components/heatPump/heatPumpView.test.ts
import { describe, expect, test } from 'vitest'
import { formatDay, monthLabel } from '~/components/evCharging/format'
import { m } from '~/paraglide/messages'
import {
  allPayload,
  cell,
  daysPayload,
  MATSAL,
  monthsPayload,
  OVERVANING,
  span,
} from '~test/fixtures/heatPumpView'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { heatPumpView, meanOutdoor } from './heatPumpView'

const NOW = { year: 2026, month: 9 }
const TODAY = '2026-09-15'
const view = (input: Partial<Parameters<typeof heatPumpView>[0]> & Pick<Parameters<typeof heatPumpView>[0], 'period'>) =>
  heatPumpView({ months: monthsPayload(), days: null, now: NOW, today: TODAY, ...input })

describe('year view', () => {
  test('12 month rows: units stacked, the total, last year beside, selectable months with readings', () => {
    const v = view({ period: { kind: 'year', year: 2026 } })
    expect(v?.kind).toBe('year')
    expect(v?.rows).toHaveLength(12)
    const [jan] = v?.rows ?? []
    expect(jan).toMatchObject({
      key: '2026-01',
      label: monthLabel(1),
      short: monthLabel(1).charAt(0).toUpperCase(),
      month: { year: 2026, month: 1 },
      selectable: true,
      kwh: { [MATSAL.id]: 100, [OVERVANING.id]: 100 },
      total: 200,
      lastYear: 200,
      outdoorC: 2,
      missingHours: 0,
      running: false,
    })
    expect(v?.rows[8].running).toBe(true) // September 2026, the current month
    // October: nothing this year, last year's outline only, not selectable.
    expect(v?.rows[9]).toMatchObject({ total: null, lastYear: 200, selectable: false, outdoorC: null })
    expect(v?.chartLabel).toBe(m.heat_pump_chart_title_year({ year: '2026' }))
  })

  test('the outdoor temperature is hour-weighted over both units; missing hours are the worst unit\'s', () => {
    const p = monthsPayload()
    p.months = p.months.map((c) =>
      c.year === 2026 && c.month === 3
        ? c.heatPumpId === MATSAL.id
          ? { ...c, outsideC: 0, hours: 100, expectedHours: 744 }
          : { ...c, outsideC: 4, hours: 300, expectedHours: 744 }
        : c,
    )
    const mar = view({ months: p, period: { kind: 'year', year: 2026 } })?.rows[2]
    expect(mar?.outdoorC).toBeCloseTo(3, 9) // (0 × 100 + 4 × 300) ÷ 400
    expect(mar?.missingHours).toBe(644)
  })
})

describe('tiles', () => {
  test('a running year compares with last year up to the same hour, not with last year\'s whole newest month', () => {
    const p = monthsPayload()
    // Matsal 2025 January–August 125 kWh: base 8 × 125 + 50 (September so far) = 1050; 2026: 8 × 100 + 50 = 850.
    p.lastYear = p.lastYear.map((c) => (c.heatPumpId === MATSAL.id && c.month <= 8 ? { ...c, kwh: 125 } : c))
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    const matsal = t?.units.find((u) => u.id === MATSAL.id)
    expect(matsal?.kwh).toBe(850)
    expect(matsal?.change).toBeCloseTo((850 - 1050) / 1050, 9)
    expect(t).toMatchObject({ comparedWith: '2025', running: true, outdoorC: 2, missingHours: null })
  })

  test('no change unless both periods have 99 % of their expected hours', () => {
    const p = monthsPayload()
    // Övervåning: 2025 base 7 × 720 + 600 + 300 of 8 × 720 + 360 expected = 97 %.
    p.lastYear = p.lastYear.map((c) => (c.heatPumpId === OVERVANING.id && c.month === 1 ? { ...c, hours: 600 } : c))
    p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) => (c.heatPumpId === OVERVANING.id ? { ...c, hours: 300 } : c))
    const t = view({ months: p, period: { kind: 'year', year: 2026 } })?.tiles
    expect(t?.units.find((u) => u.id === OVERVANING.id)?.change).toBeNull()
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0, 9)
  })

  test('a 48-hour stall in the running month hides the change for both units and names the gap', () => {
    const p = monthsPayload()
    // September so far: 312 of 360 expected hours (the read model counts a stall to `now`, Task 3); last year's 360 of 360.
    p.months = p.months.map((c) => (c.month === 9 ? { ...c, hours: 312, expectedHours: 360 } : c))
    const t = view({ months: p, days: daysPayload(2026, 9, 13), period: { kind: 'month', year: 2026, month: 9 } })?.tiles
    expect(t?.units.map((u) => u.change)).toEqual([null, null])
    expect(t?.missingHours).toBe(48)
  })

  test('a past month compares with the same month a year earlier', () => {
    const p = monthsPayload()
    p.lastYear = p.lastYear.map((c) => (c.heatPumpId === MATSAL.id && c.month === 5 ? { ...c, kwh: 80 } : c))
    const t = view({ months: p, days: daysPayload(2026, 5, 31), period: { kind: 'month', year: 2026, month: 5 } })?.tiles
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0.25, 9)
    expect(t?.comparedWith).toBe(m.energy_period_month({ month: monthLabel(5), year: '2025' }))
    expect(t?.running).toBe(false)
  })

  test('the running month compares with last year\'s same month so far', () => {
    const p = monthsPayload()
    p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) => (c.heatPumpId === MATSAL.id ? { ...c, kwh: 40 } : c))
    const t = view({ months: p, days: daysPayload(2026, 9, 15), period: { kind: 'month', year: 2026, month: 9 } })?.tiles
    expect(t?.units.find((u) => u.id === MATSAL.id)?.change).toBeCloseTo(0.25, 9) // 50 vs 40
    expect(t?.running).toBe(true)
  })

  test('a unit without cells in the period: "no figure", no change; order and colours by byHeatPumpName', () => {
    const p = monthsPayload({ units: [OVERVANING, MATSAL] }) // the payload's order doesn't decide
    p.months = p.months.filter((c) => !(c.heatPumpId === OVERVANING.id && c.month === 5))
    const v = view({ months: p, days: daysPayload(2026, 5, 31), period: { kind: 'month', year: 2026, month: 5 } })
    expect(v?.units.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
    const t = v?.tiles
    expect(t?.units.map((u) => [u.name, u.color])).toEqual([
      ['Matsal', heatPumpColor([MATSAL, OVERVANING], MATSAL.id)],
      ['Övervåning', heatPumpColor([MATSAL, OVERVANING], OVERVANING.id)],
    ])
    expect(t?.units[0].color).not.toBe(t?.units[1].color)
    expect(t?.units[1]).toMatchObject({ kwh: null, change: null })
  })

  test('missing hours: the worst unit\'s, rounded; none when complete', () => {
    const p = monthsPayload()
    p.months = p.months.map((c) => (c.heatPumpId === MATSAL.id && c.month === 5 ? { ...c, hours: 700, expectedHours: 744 } : c))
    expect(view({ months: p, days: daysPayload(2026, 5, 31), period: { kind: 'month', year: 2026, month: 5 } })?.tiles.missingHours).toBe(44)
    expect(view({ days: daysPayload(2026, 5, 31), period: { kind: 'month', year: 2026, month: 5 } })?.tiles.missingHours).toBeNull()
  })
})

describe('month view', () => {
  test('one row per day of the month, today running, no last year, not selectable', () => {
    const v = view({ days: daysPayload(2026, 9, 15), period: { kind: 'month', year: 2026, month: 9 } })
    expect(v?.kind).toBe('month')
    expect(v?.rows).toHaveLength(30)
    expect(v?.rows[0]).toMatchObject({
      key: '2026-09-01',
      label: '1',
      title: formatDay('2026-09-01'),
      month: null,
      selectable: false,
      kwh: { [MATSAL.id]: 5, [OVERVANING.id]: 2 },
      total: 7,
      lastYear: null,
      outdoorC: 3,
    })
    expect(v?.rows[14].running).toBe(true)
    expect(v?.rows[15]).toMatchObject({ total: null, outdoorC: null, running: false })
  })
})

describe('Totalt', () => {
  test('one row per month of the history, no comparison', () => {
    const v = view({ months: allPayload(), period: { kind: 'all' } })
    expect(v?.rows).toHaveLength(21) // 2025-01 … 2026-09
    expect(v?.rows[0]).toMatchObject({
      key: '2025-01',
      label: m.energy_period_month({ month: monthLabel(1), year: '2025' }),
      selectable: true,
      lastYear: null,
    })
    expect(v?.tiles.comparedWith).toBeNull()
    expect(v?.tiles.units.every((u) => u.change === null)).toBe(true)
    expect(v?.periodLabel).toBe(m.charging_tile_all_time())
  })
})

test('reads that do not match the period give no view', () => {
  expect(view({ period: { kind: 'year', year: 2025 } })).toBeNull() // payload is 2026
  expect(view({ period: { kind: 'month', year: 2026, month: 9 } })).toBeNull() // no days yet
  expect(view({ period: { kind: 'all' } })).toBeNull() // a year payload
  expect(view({ months: allPayload(), period: { kind: 'year', year: 2026 } })).toBeNull()
})

test('meanOutdoor skips cells without a value or without hours', () => {
  expect(
    meanOutdoor([
      cell(MATSAL, 2026, 1, { outsideC: null }),
      cell(MATSAL, 2026, 2, { outsideC: 10, hours: 0 }),
      cell(OVERVANING, 2026, 1, { outsideC: -1, hours: 10 }),
    ]),
  ).toBeCloseTo(-1, 9)
  expect(meanOutdoor([])).toBeNull()
  expect(span(1, 3)).toEqual([1, 2, 3])
})
```

Run: `bunx vitest run src/components/heatPump/` → FAIL (modules missing; the `heat_pump_*` message functions don't
exist yet either: add the messages in Step 3 first).

- [ ] **Step 3: Messages used here** (`messages/sv.json` after the `energy_battery_*` block, `messages/en.json` in
  the same place; then `bun run i18n:compile`)

| Key | sv | en |
|---|---|---|
| `heat_pump_chart_title_year` | `Värmepumparnas förbrukning per månad {year}` | `The heat pumps' consumption per month, {year}` |
| `heat_pump_chart_title_month` | `Värmepumparnas förbrukning per dag, {period}` | `The heat pumps' consumption per day, {period}` |
| `heat_pump_chart_title_all` | `Värmepumparnas förbrukning per månad sedan {since}` | `The heat pumps' consumption per month since {since}` |

- [ ] **Step 4: Implement**

```ts
// src/components/heatPump/format.ts
import { formatCount, formatOneDecimal } from '~/components/evCharging/format'
import { getIntlLocale } from '~/lib/i18n/format'

/** A change as a signed whole percent ("−19 %", "+25 %"); one that rounds to zero reads "0 %", never "−0 %". */
export function formatChange(change: number): string {
  const rounded = Math.round(change * 100) / 100
  return new Intl.NumberFormat(getIntlLocale(), {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(rounded === 0 ? 0 : rounded)
}

/** A temperature with one decimal ("−2,6 °C"). */
export function formatCelsius(c: number): string {
  return `${formatOneDecimal(c)} °C`
}

/** A right-axis tick ("−5°", "2,5°"). */
export function formatCelsiusTick(c: number): string {
  return `${new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 1 }).format(c)}°`
}

/** A tile's kWh: one decimal under 100 ("42,3 kWh"), whole from 100 ("1 512 kWh"). */
export function formatKwh(kwh: number): string {
  return `${kwh < 100 ? formatOneDecimal(kwh) : formatCount(Math.round(kwh))} kWh`
}
```

```ts
// src/components/heatPump/heatPumpView.ts
// Client-safe, pure (heat pumps step 3, ADR-0027): what the Förbrukning card shows for a period: the chart's rows (a
// year's 12 months, every month of the history for Totalt, or a month's days) and the tiles, from the
// `heatPump.months` and `heatPump.days` reads. Types only from the service.
import { formatDay, monthLabel, monthName } from '~/components/evCharging/format'
import { monthDays } from '~/lib/heatPump/period'
import { byHeatPumpName, COVERAGE_COMPLETE } from '~/lib/houseEnergy/figures'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { type EnergyPeriod, monthKey } from '~/lib/houseEnergy/period'
import type {
  HeatPumpDaysOutput,
  HeatPumpMonthCell,
  HeatPumpMonths,
  HeatPumpUnitDto,
} from '~/lib/services/heatPump'
import { m } from '~/paraglide/messages'

type YearMonth = { year: number; month: number }
/** What a month cell and a day row share: enough to sum, weigh and count. */
type Sums = { heatPumpId: string; kwh: number; outsideC: number | null; hours: number; expectedHours: number }

export const LAST_YEAR_KEY = 'lastYear'
export const OUTDOOR_KEY = 'outdoor'

export type HeatPumpChartRow = {
  key: string
  /** The x label; `short` when the full ones don't fit (year view). */
  label: string
  short: string
  /** The tooltip's title. */
  title: string
  /** The month a click selects (year view, Totalt); null for a day. */
  month: YearMonth | null
  selectable: boolean
  /** Per unit id; null: no hours that month or day. */
  kwh: Record<string, number | null>
  total: number | null
  /** The same month a year earlier, all units (year view only). */
  lastYear: number | null
  outdoorC: number | null
  /** The worst unit's expected − stored hours. */
  missingHours: number
  /** The current month or day ("hittills"). */
  running: boolean
}

export type HeatPumpTile = {
  id: string
  name: string
  /** Step 2's `heatPumpColor(units, id)`. */
  color: string
  kwh: number | null
  /** (this − before) ÷ before; null unless both periods are ≥ 99 % complete. */
  change: number | null
}

export type HeatPumpTiles = {
  units: HeatPumpTile[]
  outdoorC: number | null
  /** Hours to name in "Data saknas för N h" (the worst unit's, rounded), or null below 1. */
  missingHours: number | null
  /** The compared period's name ("2025", "sep 2025"); null for Totalt. */
  comparedWith: string | null
  running: boolean
}

export type HeatPumpView = {
  kind: EnergyPeriod['kind']
  year: number | null
  units: HeatPumpUnitDto[]
  rows: HeatPumpChartRow[]
  tiles: HeatPumpTiles
  /** The chart's accessible name. */
  chartLabel: string
  /** The period's name in "Ingen värmepumpsdata för …". */
  periodLabel: string
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
const ofUnit = <T extends Sums>(cells: readonly T[], id: string) => cells.filter((c) => c.heatPumpId === id)
const at = (cells: readonly HeatPumpMonthCell[], ym: YearMonth) =>
  cells.filter((c) => c.year === ym.year && c.month === ym.month)
const missing = (cells: readonly Sums[]) =>
  Math.max(0, sum(cells.map((c) => c.expectedHours)) - sum(cells.map((c) => c.hours)))
const covered = (cells: readonly Sums[]) => {
  const expected = sum(cells.map((c) => c.expectedHours))
  return expected > 0 && sum(cells.map((c) => c.hours)) / expected >= COVERAGE_COMPLETE
}
/** The cells' kWh, or null when none has an hour. */
const kwhOf = (cells: readonly Sums[]) => (cells.some((c) => c.hours > 0) ? sum(cells.map((c) => c.kwh)) : null)
const worstMissing = (units: readonly HeatPumpUnitDto[], cells: readonly Sums[]) =>
  Math.max(0, ...units.map((u) => missing(ofUnit(cells, u.id))))

/**
 * The hour-weighted mean outdoor temperature over the cells with a value and hours; null without. Across units each
 * unit's mean is weighted by its hour count: an approximation when a unit has hours without an outdoor value (the
 * reads carry no count of those), exact otherwise.
 */
export function meanOutdoor(cells: readonly Pick<Sums, 'outsideC' | 'hours'>[]): number | null {
  let weighted = 0
  let hours = 0
  for (const c of cells) {
    if (c.outsideC === null || c.hours <= 0) continue
    weighted += c.outsideC * c.hours
    hours += c.hours
  }
  return hours > 0 ? weighted / hours : null
}

type RowBase = Omit<HeatPumpChartRow, 'kwh' | 'total' | 'outdoorC' | 'missingHours'>

function rowOf(base: RowBase, units: readonly HeatPumpUnitDto[], cells: readonly Sums[]): HeatPumpChartRow {
  const kwh: Record<string, number | null> = {}
  for (const u of units) kwh[u.id] = kwhOf(ofUnit(cells, u.id))
  const values = Object.values(kwh).filter((v): v is number => v !== null)
  return {
    ...base,
    kwh,
    total: values.length > 0 ? sum(values) : null,
    outdoorC: meanOutdoor(cells),
    missingHours: worstMissing(units, cells),
  }
}

const monthTitle = (ym: YearMonth) =>
  m.energy_period_month({ month: monthName(ym.month), year: String(ym.year) })
const monthShort = (ym: YearMonth) =>
  m.energy_period_month({ month: monthLabel(ym.month), year: String(ym.year) })

function yearRows(data: HeatPumpMonths, year: number, now: YearMonth): HeatPumpChartRow[] {
  return Array.from({ length: 12 }, (_, i) => {
    const ym = { year, month: i + 1 }
    const key = monthKey(year, ym.month)
    return rowOf(
      {
        key,
        label: monthLabel(ym.month),
        short: monthLabel(ym.month).charAt(0).toUpperCase(),
        title: monthTitle(ym),
        month: ym,
        selectable: data.monthsWithReadings.includes(key),
        lastYear: kwhOf(at(data.lastYear, { year: year - 1, month: ym.month })),
        running: year === now.year && ym.month === now.month,
      },
      data.units,
      at(data.months, ym),
    )
  })
}

function allRows(data: HeatPumpMonths, now: YearMonth): HeatPumpChartRow[] {
  if (data.months.length === 0) return []
  const index = data.months.map((c) => c.year * 12 + c.month - 1)
  const first = Math.min(...index)
  const last = Math.max(...index)
  return Array.from({ length: last - first + 1 }, (_, i) => {
    const ym = { year: Math.floor((first + i) / 12), month: ((first + i) % 12) + 1 }
    const key = monthKey(ym.year, ym.month)
    return rowOf(
      {
        key,
        label: monthShort(ym),
        short: monthShort(ym),
        title: monthTitle(ym),
        month: ym,
        selectable: data.monthsWithReadings.includes(key),
        lastYear: null,
        running: ym.year === now.year && ym.month === now.month,
      },
      data.units,
      at(data.months, ym),
    )
  })
}

function dayRows(
  days: HeatPumpDaysOutput,
  units: readonly HeatPumpUnitDto[],
  ym: YearMonth,
  today: string,
): HeatPumpChartRow[] {
  const { from, to } = monthDays(ym.year, ym.month)
  return Array.from({ length: Number(to.slice(8)) }, (_, i) => {
    const day = `${from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`
    return rowOf(
      {
        key: day,
        label: String(i + 1),
        short: String(i + 1),
        title: formatDay(day),
        month: null,
        selectable: false,
        lastYear: null,
        running: day === today,
      },
      units,
      days.days.filter((d) => d.day === day),
    )
  })
}

// The period's cells and what each unit is compared with. A running period (it holds the newest stored hour)
// compares with the same span a year earlier: last year's months before the newest month plus `lastYearSoFar`.
function tilesOf(data: HeatPumpMonths, period: EnergyPeriod, now: YearMonth): HeatPumpTiles {
  const newest = data.newestMonth
  let cells: HeatPumpMonthCell[]
  let before: HeatPumpMonthCell[] | null
  let comparedWith: string | null
  let running: boolean
  if (period.kind === 'all') {
    cells = data.months
    before = null
    comparedWith = null
    running = false
  } else if (period.kind === 'year') {
    cells = data.months.filter((c) => c.year === period.year)
    const soFar = newest?.startsWith(`${period.year}-`) ? data.lastYearSoFar : null
    const newestMonth = newest ? Number(newest.slice(5, 7)) : 13
    before = soFar ? [...data.lastYear.filter((c) => c.month < newestMonth), ...soFar] : data.lastYear
    comparedWith = String(period.year - 1)
    running = period.year === now.year
  } else {
    cells = at(data.months, period)
    const soFar = newest === monthKey(period.year, period.month) ? data.lastYearSoFar : null
    before = soFar ?? at(data.lastYear, { year: period.year - 1, month: period.month })
    comparedWith = m.energy_period_month({ month: monthLabel(period.month), year: String(period.year - 1) })
    running = period.year === now.year && period.month === now.month
  }
  const units = data.units.map((u) => {
    const mine = ofUnit(cells, u.id)
    const theirs = before ? ofUnit(before, u.id) : []
    const kwh = kwhOf(mine)
    const base = kwhOf(theirs)
    const change =
      kwh !== null && base !== null && base > 0 && covered(mine) && covered(theirs)
        ? (kwh - base) / base
        : null
    return { id: u.id, name: u.name, color: heatPumpColor(data.units, u.id), kwh, change }
  })
  const gap = Math.round(worstMissing(data.units, cells))
  return { units, outdoorC: meanOutdoor(cells), missingHours: gap >= 1 ? gap : null, comparedWith, running }
}

/** The card's view of `period`, or null when the reads don't answer it (another year's placeholder, days not in). */
export function heatPumpView({
  months,
  days,
  period,
  now,
  today,
}: {
  months: HeatPumpMonths
  days: HeatPumpDaysOutput | null
  period: EnergyPeriod
  now: YearMonth
  today: string
}): HeatPumpView | null {
  // Step 2's order everywhere (Swedish collation, then id), whatever order the read sent.
  const data: HeatPumpMonths = { ...months, units: [...months.units].sort(byHeatPumpName) }
  if (period.kind === 'all') {
    if (data.year !== null) return null
    return {
      kind: 'all',
      year: null,
      units: data.units,
      rows: allRows(data, now),
      tiles: tilesOf(data, period, now),
      chartLabel: m.heat_pump_chart_title_all({
        since: data.firstReadingDay ? formatDay(data.firstReadingDay) : '',
      }),
      periodLabel: m.charging_tile_all_time(),
    }
  }
  if (data.year !== period.year) return null
  if (period.kind === 'year') {
    return {
      kind: 'year',
      year: period.year,
      units: data.units,
      rows: yearRows(data, period.year, now),
      tiles: tilesOf(data, period, now),
      chartLabel: m.heat_pump_chart_title_year({ year: String(period.year) }),
      periodLabel: String(period.year),
    }
  }
  if (!days) return null
  const label = monthTitle(period)
  return {
    kind: 'month',
    year: period.year,
    units: data.units,
    rows: dayRows(days, data.units, period, today),
    tiles: tilesOf(data, period, now),
    chartLabel: m.heat_pump_chart_title_month({ period: label }),
    periodLabel: label,
  }
}
```

- [ ] **Step 5: Run** `bunx vitest run src/components/heatPump/ src/lib/heatPump/ && TZ=UTC bunx vitest run src/components/heatPump/` → PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/components/heatPump/heatPumpView.ts src/components/heatPump/heatPumpView.test.ts \
  src/components/heatPump/format.ts src/components/heatPump/format.test.ts test/fixtures/heatPumpView.ts \
  messages/sv.json messages/en.json
git commit -m "feat(heat-pumps): model the heat pump chart rows and tiles" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The card body: queries, period hook, tiles, chart, empty state

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/heatPump/heatPumpQueries.ts`, `src/components/heatPump/useHeatPumpPeriod.ts`,
  `src/components/heatPump/HeatPumpTiles.tsx`, `src/components/heatPump/HeatPumpTiles.browser.test.tsx`,
  `src/components/heatPump/HeatPumpConsumptionChart.tsx`,
  `src/components/heatPump/HeatPumpConsumptionChart.browser.test.tsx`,
  `src/components/heatPump/HeatPumpConsumption.tsx`, `src/components/heatPump/HeatPumpEmpty.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: Task 1 `periodRewrite`; Task 4 `monthDays`; Task 5 `LineSeries.axis`, `BarSeries.outline`,
  `TooltipRow.outline`; Task 6 `heatPumpView`, `LAST_YEAR_KEY`, `OUTDOOR_KEY`, formatters; step 2's
  `heatPumpColor(units, id)`.
- Produces:
  - `HEAT_PUMP_STALE_TIME`, `heatPumpMonthsQuery(year: number | undefined)`, `heatPumpMonthsQueryFor(period: EnergyPeriod | null)`,
    `heatPumpDaysQuery(range: { from: string; to: string })`, `heatPumpDaysQueryFor(period: EnergyPeriod | null)` (null unless a month)
  - `useHeatPumpPeriod(search: EnergySearch, writeSearch: EnergySearchWrite)` →
    `{ monthsResult, daysResult, months, shown, period, setPeriod, now, view, dimmed, busy, pending }`
  - `HeatPumpConsumption({ view, onSelectMonth })`, `HeatPumpTiles({ tiles })`,
    `HeatPumpConsumptionChart({ view, onSelectMonth })`, `HeatPumpEmpty()`, `LAST_YEAR_COLOR`

- [ ] **Step 1: Messages** (sv + en, after Task 6's; `bun run i18n:compile`)

| Key | sv | en |
|---|---|---|
| `heat_pump_empty_title` | `Ingen värmepumpsdata ännu` | `No heat pump data yet` |
| `heat_pump_empty_description` | `Siffrorna visas när Comfort Cloud-synken har hämtat värmepumparnas första dag.` | `The figures appear once the Comfort Cloud sync has fetched the heat pumps' first day.` |
| `heat_pump_tile_change` | `{change} mot {period}` | `{change} vs {period}` |
| `heat_pump_tile_outdoor` | `Ute` | `Outdoors` |
| `heat_pump_tile_outdoor_detail` | `Medeltemperatur` | `Mean temperature` |
| `heat_pump_series_last_year` | `Förra året ({year})` | `Last year ({year})` |
| `heat_pump_series_outdoor` | `Ute, °C` | `Outdoors, °C` |
| `heat_pump_tooltip_total` | `Totalt` | `Total` |
| `heat_pump_chart_hint` | `Klicka på en månad för att se dess dagar.` | `Click a month to see its days.` |
| `heat_pump_chart_no_data` | `Ingen värmepumpsdata för {period}` | `No heat pump data for {period}` |

- [ ] **Step 2: Write the failing browser tests**

```tsx
// src/components/heatPump/HeatPumpTiles.browser.test.tsx
import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { MATSAL, monthsPayload, OVERVANING } from '~test/fixtures/heatPumpView'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpTiles } from './HeatPumpTiles'
import { heatPumpView } from './heatPumpView'

const tilesFor = (months = monthsPayload()) => {
  const v = heatPumpView({ months, days: null, period: { kind: 'year', year: 2026 }, now: { year: 2026, month: 9 }, today: '2026-09-15' })
  if (!v) throw new Error('no view')
  return v.tiles
}
const tile = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-heat-pump-tile="${id}"]`)

test('a tile per unit with its kWh and "hittills", the change against last year, and the outdoor tile', async () => {
  const p = monthsPayload()
  p.lastYear = p.lastYear.map((c) => (c.heatPumpId === MATSAL.id && c.month <= 8 ? { ...c, kwh: 125 } : c))
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  const matsal = tile(screen.container, MATSAL.id)
  expect(matsal?.textContent).toContain('Matsal')
  expect(matsal?.textContent).toMatch(/850 kWh/)
  expect(matsal?.textContent).toContain(m.energy_chart_so_far())
  expect(matsal?.textContent).toMatch(/−19\s%\smot 2025/)
  expect(tile(screen.container, 'outdoor')?.textContent).toMatch(/2,0\s°C/)
})

test('no change line without 99 % of the hours, but its line keeps its height', async () => {
  const p = monthsPayload()
  p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) => (c.heatPumpId === OVERVANING.id ? { ...c, hours: 100 } : c))
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  const over = tile(screen.container, OVERVANING.id)
  expect(over?.textContent).not.toMatch(/mot 2025/)
  expect(over?.querySelectorAll('dd')).toHaveLength(2) // the empty change line is still there
})

test('a unit without a figure reads "—"; the missing-hours note shows only with a gap', async () => {
  const p = monthsPayload({ months: monthsPayload().months.filter((c) => c.heatPumpId === MATSAL.id) })
  p.months = p.months.map((c) => (c.month === 3 ? { ...c, hours: 700, expectedHours: 744 } : c))
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  expect(tile(screen.container, OVERVANING.id)?.textContent).toContain('—')
  expect(screen.container.querySelector('[data-slot="heat-pump-missing"]')?.textContent).toBe(
    m.energy_missing_hours({ hours: '44' }),
  )
})
```

```tsx
// src/components/heatPump/HeatPumpConsumptionChart.browser.test.tsx
import { beforeEach, expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { allPayload, daysPayload, monthsPayload } from '~test/fixtures/heatPumpView'
import { clickOn, legendLabels, lineDots, parkPointer, seriesBars } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpConsumptionChart } from './HeatPumpConsumptionChart'
import { type HeatPumpView, heatPumpView } from './heatPumpView'

beforeEach(parkPointer)

const NOW = { year: 2026, month: 9 }
const viewOf = (input: Partial<Parameters<typeof heatPumpView>[0]> & Pick<Parameters<typeof heatPumpView>[0], 'period'>) => {
  const v = heatPumpView({ months: monthsPayload(), days: null, now: NOW, today: '2026-09-15', ...input })
  if (!v) throw new Error('no view')
  return v
}
const render = (view: HeatPumpView, onSelectMonth = vi.fn()) =>
  renderWithProviders(
    <div style={{ width: 720 }}>
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} />
    </div>,
  )
const rightTicks = (root: ParentNode) => root.querySelectorAll('[data-axis="y-right"] .visx-axis-tick')

test('year: units stacked per month, last year as an outline beside them, outdoor °C on a right axis', async () => {
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(9)) // Matsal, Jan–Sep
  expect(seriesBars(screen.container, 1)).toHaveLength(9) // Övervåning
  expect(seriesBars(screen.container, 2)).toHaveLength(12) // 2025, every month
  expect(seriesBars(screen.container, 2)[0].getAttribute('fill')).toBe('none')
  expect(legendLabels(screen.container)).toEqual([
    'Matsal',
    'Övervåning',
    m.heat_pump_series_last_year({ year: '2025' }),
    m.heat_pump_series_outdoor(),
  ])
  expect(lineDots(screen.container)).toHaveLength(9)
  expect(rightTicks(screen.container).length).toBeGreaterThan(1)
  expect(screen.container.textContent).toContain(m.heat_pump_chart_hint())
})

test('year: clicking a month with readings selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(viewOf({ period: { kind: 'year', year: 2026 } }), onSelectMonth)
  await vi.waitFor(() => expect(seriesBars(screen.container, 0).length).toBeGreaterThan(2))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  expect(onSelectMonth).toHaveBeenCalledWith({ year: 2026, month: 3 })
})

test('month: a bar per day with data, no outline, not selectable; the hint line is reserved but hidden', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(
    viewOf({ days: daysPayload(2026, 9, 15), period: { kind: 'month', year: 2026, month: 9 } }),
    onSelectMonth,
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
  expect(screen.container.querySelector('[data-series="lastYear"]')).toBeNull()
  await clickOn(screen.container, seriesBars(screen.container, 0)[0])
  expect(onSelectMonth).not.toHaveBeenCalled()
  expect(screen.container.querySelector('[data-slot="heat-pump-chart-hint"]')?.className).toContain('invisible')
})

test('Totalt: one bar group per month of the history', async () => {
  const { screen } = await render(viewOf({ months: allPayload(), period: { kind: 'all' } }))
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
  expect(screen.container.querySelector('[data-series="lastYear"]')).toBeNull()
})

test('a period without data: the no-data line at the chart\'s height', async () => {
  const empty = monthsPayload({ months: [], lastYear: [], lastYearSoFar: null })
  const { screen } = await render(viewOf({ months: empty, period: { kind: 'year', year: 2026 } }))
  await expect.element(screen.getByText(m.heat_pump_chart_no_data({ period: '2026' }))).toBeVisible()
})
```

Run: `bunx vitest run --project browser src/components/heatPump/` → FAIL (components missing).

- [ ] **Step 3: Queries and the hook**

```ts
// src/components/heatPump/heatPumpQueries.ts
import { monthDays } from '~/lib/heatPump/period'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { orpc } from '~/lib/orpc/client'
import { stockholmYearMonth } from '~/lib/time/stockholm'

/** Fresh for 5 minutes, as the Energi overview (the sync runs every six hours; focus refetch still applies, ADR-0018). */
export const HEAT_PUMP_STALE_TIME = 5 * 60_000

/** A year's months and the year before; `undefined`: the whole history (Totalt). */
export const heatPumpMonthsQuery = (year: number | undefined) =>
  orpc.heatPump.months.queryOptions({
    input: year === undefined ? {} : { year },
    staleTime: HEAT_PUMP_STALE_TIME,
  })

/**
 * A month or a year asks for its year, Totalt for the history, no period (the default) for the current Stockholm
 * year, so the default and any month of this year share one cache entry.
 */
export const heatPumpMonthsQueryFor = (period: EnergyPeriod | null) =>
  heatPumpMonthsQuery(
    period?.kind === 'all' ? undefined : (period?.year ?? stockholmYearMonth(Date.now()).year),
  )

export const heatPumpDaysQuery = (range: { from: string; to: string }) =>
  orpc.heatPump.days.queryOptions({ input: range, staleTime: HEAT_PUMP_STALE_TIME })

/** A month's days; null for a year or Totalt (no day chart). */
export const heatPumpDaysQueryFor = (period: EnergyPeriod | null) =>
  period?.kind === 'month' ? heatPumpDaysQuery(monthDays(period.year, period.month)) : null
```

```ts
// src/components/heatPump/useHeatPumpPeriod.ts
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type EnergySearch, periodOfSearch, periodRewrite, periodSearchValue } from '~/components/energy/energySearch'
import type { EnergySearchWrite } from '~/components/energy/useEnergyPeriod'
import { firstLoadPending, loadFailed } from '~/components/layout/LoadErrorAlert'
import { monthDays } from '~/lib/heatPump/period'
import { type EnergyPeriod, formatPeriod, parsePeriod, resolvePeriod } from '~/lib/houseEnergy/period'
import { stockholmDayOf, stockholmYearMonth } from '~/lib/time/stockholm'
import { heatPumpDaysQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'
import { heatPumpView } from './heatPumpView'

// The Värmepumpar page's state (heat pumps step 3), on the Energi pages' rules (useEnergyPeriod): the requested
// period, the months read (one cache entry per year, or the history for Totalt), the days read for a month, the
// period shown, the view built from them, and the URL rewrite of a period the data can't show. While another read
// loads, the last view stays, dimmed; a failed read blanks it under its alert (ADR-0016).
/** `writeSearch` must be referentially stable (wrap it in `useCallback`). */
export function useHeatPumpPeriod(search: EnergySearch, writeSearch: EnergySearchWrite) {
  const requested = periodOfSearch(search)
  // Hourly data, synced every six hours: focus refetch only, no polling (ADR-0018).
  const monthsResult = useQuery({
    ...heatPumpMonthsQueryFor(requested),
    placeholderData: keepPreviousData,
  })
  const failed = loadFailed(monthsResult)
  const months = monthsResult.data && !failed ? monthsResult.data : undefined
  const stale = monthsResult.isPlaceholderData
  // The last months read with readings: keeps the card and its period control through a failed read of another year.
  const [lastShown, setLastShown] = useState(months)
  if (months && months.firstReadingDay !== null && months !== lastShown) setLastShown(months)
  const shown = months ?? lastShown
  // Read during render on the server and the client alike (see useEnergyPeriod).
  const now = stockholmYearMonth(Date.now())
  const today = stockholmDayOf(Date.now())
  const period = shown ? resolvePeriod(requested, shown.monthsWithReadings, now) : null
  const periodKey = period ? formatPeriod(period) : null
  const setPeriod = useCallback(
    (p: EnergyPeriod) => writeSearch({ period: periodSearchValue(p) }),
    [writeSearch],
  )
  const isMonth = period?.kind === 'month'
  const daysResult = useQuery({
    ...heatPumpDaysQuery(isMonth ? monthDays(period.year, period.month) : monthDays(now.year, now.month)),
    enabled: isMonth,
    placeholderData: keepPreviousData,
  })
  const daysFailed = isMonth && loadFailed(daysResult)
  const days = isMonth && daysResult.data && !daysResult.isPlaceholderData && !daysFailed ? daysResult.data : null
  // Memoised on the period's key: a new object every render would loop the "last view" state below.
  const current = useMemo(() => {
    const p = periodKey === null ? null : parsePeriod(periodKey)
    return months && !stale && p
      ? heatPumpView({ months, days, period: p, now: { year: now.year, month: now.month }, today })
      : null
  }, [months, stale, days, periodKey, now.year, now.month, today])
  const [lastView, setLastView] = useState(current)
  if (current && current !== lastView) setLastView(current)
  const view = failed || daysFailed ? null : (current ?? lastView)
  const waiting = current === null && lastView !== null && !failed && !daysFailed
  const rewriteTo = periodRewrite(
    search,
    requested,
    period,
    Boolean(months && !stale && months.firstReadingDay !== null),
  )
  useEffect(() => {
    if (rewriteTo === undefined) return
    writeSearch(rewriteTo === null ? {} : { period: rewriteTo })
  }, [rewriteTo, writeSearch])
  return {
    monthsResult,
    daysResult,
    months,
    shown,
    period,
    setPeriod,
    now,
    view,
    /** The card's body is the last view (another read is loading) or blank under an alert. */
    dimmed: waiting || failed || daysFailed,
    /** aria-busy: another read is loading (not a failure). */
    busy: waiting,
    /** Nothing to show yet and nothing failed: the section's skeleton. One-way per key (see SectionSkeleton). */
    pending:
      firstLoadPending(monthsResult) || (isMonth && firstLoadPending(daysResult) && lastView === null),
  }
}
```

(`period.year` inside the `isMonth` ternary: if TypeScript doesn't narrow `period` through `isMonth`, write
`period?.kind === 'month'` inline there.)

- [ ] **Step 4: The components**

```tsx
// src/components/heatPump/HeatPumpEmpty.tsx
import { AirVentIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { m } from '~/paraglide/messages'

// No heat pump readings yet (ADR-0016, spec "Error handling": names Comfort Cloud): only data says so, never a skeleton.
export function HeatPumpEmpty() {
  return (
    <Empty className="brand-wash rounded-lg border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AirVentIcon />
        </EmptyMedia>
        <EmptyTitle>{m.heat_pump_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.heat_pump_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
```

```tsx
// src/components/heatPump/HeatPumpTiles.tsx
import { m } from '~/paraglide/messages'
import { formatCelsius, formatChange, formatKwh } from './format'
import type { HeatPumpTiles as Tiles } from './heatPumpView'

// The period's figures (spec "Förbrukning"): kWh per unit with "hittills" on a running period, the change against
// the same period a year earlier (only when both are ≥ 99 % complete), the mean outdoor temperature, and the
// missing-hours note. Every line keeps its height whether or not it has text: changing period moves nothing.
export function HeatPumpTiles({ tiles }: { tiles: Tiles }) {
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {tiles.units.map((t) => (
          <div key={t.id} data-heat-pump-tile={t.id} className="flex min-w-0 flex-col gap-0.5 rounded-lg border p-3">
            <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ background: t.color }}
              />
              <span className="truncate">{t.name}</span>
            </dt>
            <dd className="font-semibold text-2xl tabular-nums">
              {t.kwh === null ? '—' : formatKwh(t.kwh)}
              {tiles.running && t.kwh !== null ? (
                <span className="ml-1.5 font-normal text-muted-foreground text-sm">{m.energy_chart_so_far()}</span>
              ) : null}
            </dd>
            <dd className="text-muted-foreground text-sm tabular-nums">
              {t.change === null || tiles.comparedWith === null
                ? ' '
                : m.heat_pump_tile_change({ change: formatChange(t.change), period: tiles.comparedWith })}
            </dd>
          </div>
        ))}
        <div data-heat-pump-tile="outdoor" className="flex min-w-0 flex-col gap-0.5 rounded-lg border p-3">
          <dt className="text-muted-foreground text-sm">{m.heat_pump_tile_outdoor()}</dt>
          <dd className="font-semibold text-2xl tabular-nums">
            {tiles.outdoorC === null ? '—' : formatCelsius(tiles.outdoorC)}
          </dd>
          <dd className="text-muted-foreground text-sm">{m.heat_pump_tile_outdoor_detail()}</dd>
        </div>
      </dl>
      <p data-slot="heat-pump-missing" className="text-muted-foreground text-sm">
        {tiles.missingHours === null ? ' ' : m.energy_missing_hours({ hours: String(tiles.missingHours) })}
      </p>
    </div>
  )
}
```

```tsx
// src/components/heatPump/HeatPumpConsumptionChart.tsx
import { useMemo } from 'react'
import { BarChart, type BarSeries, type LineSeries } from '~/components/chart/BarChart'
import { CHART_HEIGHT, TooltipRow } from '~/components/chart/ChartParts'
import { formatCount, formatOneDecimal } from '~/components/evCharging/format'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { formatCelsius, formatCelsiusTick } from './format'
import { type HeatPumpChartRow, type HeatPumpView, LAST_YEAR_KEY, OUTDOOR_KEY } from './heatPumpView'

/** Last year's outline: the muted foreground, a little transparent (it is context, not the data). */
export const LAST_YEAR_COLOR = 'color-mix(in oklab, var(--muted-foreground) 75%, transparent)'

// BarChart's accessors at module level: a stable identity keeps its geometry memo across re-renders.
const rowLabel = (r: HeatPumpChartRow) => r.label
const rowShort = (r: HeatPumpChartRow) => r.short
const rowValue = (r: HeatPumpChartRow, key: string) =>
  key === LAST_YEAR_KEY ? r.lastYear : key === OUTDOOR_KEY ? r.outdoorC : (r.kwh[key] ?? null)
const kwhText = (v: number | null | undefined) => (v == null ? '—' : `${formatOneDecimal(v)} kWh`)

// The Förbrukning chart (spec "Energi › Värmepumpar"): the units stacked (step 2's colours, name order), last year
// as an outline beside each month (year view), the hour-weighted outdoor temperature as a line on a right-hand
// °C axis. A month bar (year view, Totalt) selects that month; the day chart selects nothing.
export function HeatPumpConsumptionChart({
  view,
  onSelectMonth,
}: {
  view: HeatPumpView
  onSelectMonth: (month: { year: number; month: number }) => void
}) {
  const { units, kind } = view
  const lastYear = kind === 'year' && view.year !== null ? view.year - 1 : null
  const series = useMemo<BarSeries[]>(
    () => [
      ...units.map((u, i) => ({
        key: u.id,
        label: u.name,
        color: heatPumpColor(units, u.id),
        stack: 'kwh',
        stroke: 'var(--card)',
        strokeWidth: 2,
        ...(i === units.length - 1 ? { radius: 2, roundEndOnly: true } : {}),
      })),
      ...(lastYear === null
        ? []
        : [
            {
              key: LAST_YEAR_KEY,
              label: m.heat_pump_series_last_year({ year: String(lastYear) }),
              color: LAST_YEAR_COLOR,
              outline: true,
              strokeWidth: 1.5,
              radius: 2,
              roundEndOnly: true,
            },
          ]),
    ],
    [units, lastYear],
  )
  const line = useMemo<LineSeries>(
    () => ({
      key: OUTDOOR_KEY,
      label: m.heat_pump_series_outdoor(),
      color: 'var(--muted-foreground)',
      axis: 'right',
      tickFormat: formatCelsiusTick,
      strokeWidth: 1.5,
    }),
    [],
  )
  const selectable = kind !== 'month'
  const hint = (
    <p
      data-slot="heat-pump-chart-hint"
      aria-hidden={selectable ? undefined : true}
      className={cn('mt-2 text-muted-foreground text-sm', !selectable && 'invisible')}
    >
      {m.heat_pump_chart_hint()}
    </p>
  )
  if (view.rows.every((r) => r.total === null && r.lastYear === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.heat_pump_chart_no_data({ period: view.periodLabel })}
        </div>
        {hint}
      </div>
    )
  }
  return (
    <div>
      <BarChart
        rows={view.rows}
        category={rowLabel}
        shortCategory={kind === 'year' ? rowShort : undefined}
        series={series}
        line={line}
        value={rowValue}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 border-border px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) =>
          r.total === null && r.lastYear === null && r.outdoorC === null ? null : (
            <HeatPumpTooltip row={r} view={view} lastYear={lastYear} />
          )
        }
        label={view.chartLabel}
        keyboardHint={selectable ? m.energy_chart_keyboard_hint() : undefined}
        selection={
          selectable
            ? {
                selected: null,
                onSelect: (i) => {
                  const month = view.rows[i]?.month
                  if (month) onSelectMonth(month)
                },
                canSelect: (r) => r.selectable,
              }
            : undefined
        }
      />
      {hint}
    </div>
  )
}

function HeatPumpTooltip({
  row,
  view,
  lastYear,
}: {
  row: HeatPumpChartRow
  view: HeatPumpView
  lastYear: number | null
}) {
  return (
    <>
      <div className="font-semibold text-sm">
        {row.title}
        {row.running ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {view.units.map((u) => (
        <TooltipRow key={u.id} label={u.name} color={heatPumpColor(view.units, u.id)}>
          {kwhText(row.kwh[u.id])}
        </TooltipRow>
      ))}
      <TooltipRow label={m.heat_pump_tooltip_total()} strong>
        {kwhText(row.total)}
      </TooltipRow>
      {lastYear === null ? null : (
        <TooltipRow label={m.heat_pump_series_last_year({ year: String(lastYear) })} color={LAST_YEAR_COLOR} outline>
          {kwhText(row.lastYear)}
        </TooltipRow>
      )}
      <TooltipRow label={m.heat_pump_tile_outdoor()}>
        {row.outdoorC === null ? '—' : formatCelsius(row.outdoorC)}
      </TooltipRow>
      {row.missingHours >= 1 ? (
        <span className="text-muted-foreground">
          {m.energy_missing_hours({ hours: String(Math.round(row.missingHours)) })}
        </span>
      ) : null}
    </>
  )
}
```

```tsx
// src/components/heatPump/HeatPumpConsumption.tsx
import { HeatPumpConsumptionChart } from './HeatPumpConsumptionChart'
import { HeatPumpTiles } from './HeatPumpTiles'
import type { HeatPumpView } from './heatPumpView'

// The Förbrukning card's body (inside EnergySummaryCard): the tiles above the chart.
export function HeatPumpConsumption({
  view,
  onSelectMonth,
}: {
  view: HeatPumpView
  onSelectMonth: (month: { year: number; month: number }) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <HeatPumpTiles tiles={view.tiles} />
      <HeatPumpConsumptionChart view={view} onSelectMonth={onSelectMonth} />
    </div>
  )
}
```

- [ ] **Step 5: Run** `bunx vitest run --project browser src/components/heatPump/ && TZ=UTC bunx vitest run --project browser src/components/heatPump/ && bun run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/components/heatPump messages/sv.json messages/en.json
git commit -m "feat(heat-pumps): draw the heat pump tiles and consumption chart" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The page, sidebar sub-item, Cmd+K, skeleton, bundle entry

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/routes/_authenticated/energy/heat-pumps.tsx`,
  `src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx`,
  `src/components/heatPump/clientSafe.browser.test.tsx`, `src/bones/heat-pump-consumption.bones.json` (generated)
- Modify: `src/components/AppSidebar.tsx`, `src/components/AppSidebar.browser.test.tsx`,
  `src/components/command/commands.ts`, `scripts/captureBones.ts`, `scripts/measureBundle.ts`,
  `messages/sv.json`, `messages/en.json`, `src/routeTree.gen.ts` (regenerated)

- [ ] **Step 1: Messages** (sv + en; `nav_*` and `meta_*` beside the battery's, `cmd_kw_*` beside
  `cmd_kw_energy_battery`; `bun run i18n:compile`)

| Key | sv | en |
|---|---|---|
| `nav_energy_heat_pumps` | `Värmepumpar` | `Heat pumps` |
| `cmd_kw_energy_heat_pumps` | `värmepump värmepumpar luftvärmepump panasonic comfort cloud förbrukning utetemperatur förra året` | `heat pump heat pumps air source panasonic comfort cloud consumption outdoor temperature last year` |
| `meta_energy_heat_pumps_title` | `Värmepumpar` | `Heat pumps` |
| `meta_energy_heat_pumps_description` | `Värmepumparnas elförbrukning per månad och dag, mot förra året och utetemperaturen.` | `The heat pumps' electricity use per month and day, against last year and the outdoor temperature.` |
| `heat_pump_title` | `Värmepumpar` | `Heat pumps` |
| `heat_pump_description` | `Förbrukning och temperatur från Panasonic Comfort Cloud. Datan synkas var sjätte timme.` | `Consumption and temperature from Panasonic Comfort Cloud. The data syncs every six hours.` |
| `heat_pump_consumption_heading` | `Förbrukning` | `Consumption` |
| `heat_pump_error_title` | `Värmepumpsdatan kunde inte hämtas` | `The heat pump data couldn't be loaded` |

- [ ] **Step 2: Write the failing tests**

```tsx
// src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { z } from 'zod'
import { energySearchSchema } from '~/components/energy/energySearch'
import { formatAgo } from '~/components/evCharging/format'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { heatPumpDaysQuery, heatPumpMonthsQuery } from '~/components/heatPump/heatPumpQueries'
import { m } from '~/paraglide/messages'
import { clickOn, parkPointer, seriesBars } from '~test/browser/chartDom'
import { makeTestQueryClient } from '~test/browser/render'
import { seedSourcesHealth } from '~test/browser/syncHealth'
import { allPayload, daysPayload, MATSAL, monthsPayload } from '~test/fixtures/heatPumpView'
import { Route } from './heat-pumps'

// The default month is September 2026 (the fixture's newest month). Only `Date` is faked.
beforeEach(async () => {
  await parkPointer()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const seedYear = (qc: QueryClient, data: unknown = monthsPayload()) =>
  qc.setQueryData(heatPumpMonthsQuery(2026).queryKey, data as never)
const seedSeptember = (qc: QueryClient) =>
  qc.setQueryData(
    heatPumpDaysQuery({ from: '2026-09-01', to: '2026-09-30' }).queryKey,
    daysPayload(2026, 9, 15) as never,
  )

// As -energyPage.browser.test.tsx: anything unseeded fails (no /api/rpc in the test server).
// `validateSearch` stands in for a later step's wider schema (step 4a extends the route's with `dialog`, `eventId`).
async function renderPage(
  path: string,
  prepare: (qc: QueryClient) => void,
  health: Parameters<typeof seedSourcesHealth>[1] = {},
  validateSearch: unknown = energySearchSchema,
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } })
  qc.setQueryDefaults(syncHealthQuery.queryKey, { staleTime: Number.POSITIVE_INFINITY })
  seedSourcesHealth(qc, health)
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({ component: Outlet })
  const pathname = path.split('?')[0]
  ;(Route as unknown as { update: (o: unknown) => void }).update({
    id: pathname,
    path: pathname,
    getParentRoute: () => root,
    validateSearch,
  })
  const router = createRouter({
    routeTree: root.addChildren([Route] as never[]),
    context: { queryClient: qc, user: { role: 'user' } },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

test('the default is the current month: heading, the Förbrukning card, tiles and a bar per day', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await expect.element(screen.getByRole('heading', { level: 1, name: m.heat_pump_title() })).toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.heat_pump_consumption_heading() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: /september 2026/i })).toBeVisible()
  expect(screen.container.querySelector(`[data-heat-pump-tile="${MATSAL.id}"]`)).not.toBeNull()
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
})

test('a year: month bars with last year\'s outline; clicking a month opens its days', async () => {
  const { screen, router } = await renderPage('/energy/heat-pumps?period=2026', (qc) => seedYear(qc))
  await vi.waitFor(() => expect(seriesBars(screen.container, 2)).toHaveLength(12))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-03' }))
})

test('a period change keeps the page\'s other search keys (step 4a\'s dialog state)', async () => {
  const withDialog = energySearchSchema.extend({ dialog: z.string().optional().catch(undefined) })
  const { screen, router } = await renderPage(
    '/energy/heat-pumps?period=2026&dialog=eventNew',
    (qc) => seedYear(qc),
    {},
    withDialog,
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0).length).toBeGreaterThan(2))
  await clickOn(screen.container, seriesBars(screen.container, 0)[2])
  await vi.waitFor(() =>
    expect(router.state.location.search).toEqual({ period: '2026-03', dialog: 'eventNew' }),
  )
})

test('Totalt reads the whole history: a bar per month, no comparison', async () => {
  const { screen } = await renderPage('/energy/heat-pumps?period=all', (qc) =>
    qc.setQueryData(heatPumpMonthsQuery(undefined).queryKey, allPayload() as never),
  )
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(21))
  expect(screen.container.textContent).not.toMatch(/mot 20\d\d/)
})

test('stepping to another month keeps the last chart, dimmed and busy, until its days land', async () => {
  const { screen, qc } = await renderPage('/energy/heat-pumps', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  // August's days never arrive.
  void qc.prefetchQuery({
    queryKey: heatPumpDaysQuery({ from: '2026-08-01', to: '2026-08-31' }).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await vi.waitFor(() => expect(seriesBars(screen.container, 0)).toHaveLength(15))
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click()
  await expect.element(screen.getByRole('button', { name: /augusti 2026/i })).toBeVisible()
  await vi.waitFor(() => expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull())
  expect(seriesBars(screen.container, 0)).toHaveLength(15) // September's bars, dimmed
})

test('a month without readings moves the URL to the default month', async () => {
  const { router } = await renderPage('/energy/heat-pumps?period=2026-11', (qc) => {
    seedYear(qc)
    seedSeptember(qc)
  })
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-09' }))
})

test('no readings: the empty state', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', (qc) =>
    seedYear(
      qc,
      monthsPayload({
        units: [],
        availableYears: [2026],
        firstReadingDay: null,
        monthsWithReadings: [],
        newestMonth: null,
        months: [],
        lastYear: [],
        lastYearSoFar: null,
      }),
    ),
  )
  await expect.element(screen.getByText(m.heat_pump_empty_title())).toBeVisible()
})

test('a failed read: the heading stays, the alert shows', async () => {
  const { screen } = await renderPage('/energy/heat-pumps', () => {})
  await expect.element(screen.getByRole('heading', { level: 1, name: m.heat_pump_title() })).toBeVisible()
  await expect.element(screen.getByText(m.heat_pump_error_title())).toBeVisible()
})

test('Comfort Cloud\'s health: its alert when unhealthy, its "senast synkad" in the heading', async () => {
  const synced = new Date('2026-09-15T06:00:00Z')
  const { screen } = await renderPage(
    '/energy/heat-pumps',
    (qc) => {
      seedYear(qc)
      seedSeptember(qc)
    },
    {
      comfortCloud: {
        state: 'failing',
        lastSuccessAt: synced,
        failingSince: new Date('2026-09-15T00:20:00Z'),
        consecutiveFailures: 2,
        code: 'unreachable',
      },
      emaldo: { lastSuccessAt: new Date('2026-09-15T11:45:00Z') },
    },
  )
  await expect.element(screen.getByRole('alert')).toBeVisible()
  await expect.element(screen.getByText(m.charging_last_synced({ time: formatAgo(synced) }))).toBeVisible()
})
```

(If `SyncHealthAlert` needs more health fields for `failing` than the override gives, copy them from
`test/browser/syncHealth.ts`'s `okHealth` shape; if the alert has no `alert` role, find it by its title,
`m.charging_health_title(...)`, as the charging page tests do.)

```tsx
// src/components/heatPump/clientSafe.browser.test.tsx
import { expect, test } from 'vitest'

// Client code may only `import type` from services (CLAUDE.md gotcha): a value import pulls db → pg → Buffer into
// the browser and crashes at module init. Evaluating these modules in the browser project proves they don't.
test('the /energy/heat-pumps route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/heat-pumps')
  expect(mod.Route).toBeDefined()
})

test('the heat pump view model and period helpers are importable client-side', async () => {
  expect(typeof (await import('./heatPumpView')).heatPumpView).toBe('function')
  expect(typeof (await import('~/lib/heatPump/period')).monthDays).toBe('function')
})
```

In `AppSidebar.browser.test.tsx`: in 'lists the energy views as sub-items under Energi' add
`expect(subLink(screen, m.nav_energy_heat_pumps(), '/energy/heat-pumps')).toBeTruthy()`; turn the `test.each` into
three rows with a third flag:

```tsx
test.each([
  ['/energy', true, false, false],
  ['/energy/battery', false, true, false],
  ['/energy/heat-pumps', false, false, true],
] as const)(
  'on %s marks only that energy view active, and Energi',
  async (path, overviewOn, batteryOn, heatPumpsOn) => {
    current.path = path
    const { screen } = await renderSidebar()
    expect(active(subLink(screen, m.nav_energy_overview(), '/energy'))).toBe(overviewOn)
    expect(active(subLink(screen, m.nav_energy_battery(), '/energy/battery'))).toBe(batteryOn)
    expect(active(subLink(screen, m.nav_energy_heat_pumps(), '/energy/heat-pumps'))).toBe(heatPumpsOn)
    expect(active(screen.getByRole('link', { name: m.nav_energy(), exact: true }).element())).toBe(true)
    expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(false)
  },
)
```

and add `` `/energy/heat-pumps|${m.nav_energy_heat_pumps()}` `` to the keys of 'energy links match exactly and carry
the period, …'.

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx src/components/heatPump/clientSafe.browser.test.tsx src/components/AppSidebar.browser.test.tsx`
→ FAIL (no route, no sub-item).

- [ ] **Step 3: The route** (first with `name="heat-pump-consumption"`; Step 6 switches to the captured bones)

```tsx
// src/routes/_authenticated/energy/heat-pumps.tsx
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import type { EnergySearchWrite } from '~/components/energy/useEnergyPeriod'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { HeatPumpConsumption } from '~/components/heatPump/HeatPumpConsumption'
import { HeatPumpEmpty } from '~/components/heatPump/HeatPumpEmpty'
import { heatPumpDaysQueryFor, heatPumpMonthsQueryFor } from '~/components/heatPump/heatPumpQueries'
import { useHeatPumpPeriod } from '~/components/heatPump/useHeatPumpPeriod'
import { LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { loadRouteData } from '~/lib/query/routeData'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/energy/heat-pumps')({
  head: () => ({
    meta: seo({
      title: m.meta_energy_heat_pumps_title(),
      description: m.meta_energy_heat_pumps_description(),
    }),
  }),
  validateSearch: energySearchSchema,
  // ADR-0025: the card is above the fold, so its reads are critical on the server; a client navigation awaits
  // nothing. The period is read here, not a loader dep (see energy/index.tsx). No period asked for: the default is
  // the current month (when it has readings), so its days load with it.
  loader: ({ context: { queryClient }, location }) => {
    const requested = periodOfSearch(energySearchSchema.parse(location.search))
    const now = stockholmYearMonth(Date.now())
    const dayPeriod: EnergyPeriod = requested ?? { kind: 'month', year: now.year, month: now.month }
    return loadRouteData(queryClient, {
      critical: [heatPumpMonthsQueryFor(requested), heatPumpDaysQueryFor(dayPeriod), syncHealthQuery],
    })
  },
  component: HeatPumpsPage,
})

function HeatPumpsPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  // Every source's health (one read); this page shows Comfort Cloud's (spec: its alert and its "senast synkad"),
  // rendered here directly with SyncHealthAlert (no shared Energi alerts component).
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.comfortCloud
  const navigate = Route.useNavigate()
  // Merges into the current search, so the page's other keys (step 4a's `dialog` / `eventId`) survive a period
  // change. Writing a period drops a legacy ?year=; `{}` (nothing valid asked for) drops both.
  const writeSearch = useCallback<EnergySearchWrite>(
    (next) =>
      void navigate({
        to: '.',
        search: (prev) => ({ ...prev, period: next.period, year: undefined }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  const h = useHeatPumpPeriod(Route.useSearch(), writeSearch)
  return (
    <PageContainer>
      <EnergyHeading
        title={m.heat_pump_title()}
        description={m.heat_pump_description()}
        lastSuccessAt={health?.lastSuccessAt}
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('comfortCloud')}
          retrying={syncNow.isPendingFor('comfortCloud')}
        />
      ) : null}
      {h.months?.firstReadingDay === null ? (
        <HeatPumpEmpty />
      ) : (
        <div className="flex flex-col gap-4">
          <SectionSkeleton name="heat-pump-consumption" loading={h.pending} fallbackHeight="30rem">
            {h.shown && h.period ? (
              <EnergySummaryCard
                title={m.heat_pump_consumption_heading()}
                period={h.period}
                monthsWithReadings={h.shown.monthsWithReadings}
                now={h.now}
                onChange={h.setPeriod}
                dimmed={h.dimmed}
                busy={h.busy}
              >
                {h.view ? (
                  <HeatPumpConsumption
                    view={h.view}
                    onSelectMonth={(month) => h.setPeriod({ kind: 'month', ...month })}
                  />
                ) : null}
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <LoadErrorAlert title={m.heat_pump_error_title()} query={h.monthsResult} />
          {h.period?.kind === 'month' ? (
            <LoadErrorAlert title={m.heat_pump_error_title()} query={h.daysResult} />
          ) : null}
        </div>
      )}
    </PageContainer>
  )
}
```

Run `bun run build` once: it regenerates `src/routeTree.gen.ts` with `/energy/heat-pumps`.

- [ ] **Step 4: Sidebar and palette.** `AppSidebar.tsx`, in `energySubItems` after Batteri:

```ts
  { to: '/energy/heat-pumps', label: m.nav_energy_heat_pumps, link: 'energy', adminOnly: false },
```

`commands.ts` (add `AirVentIcon` to the lucide import), after the `/energy/battery` entry:

```ts
  {
    to: '/energy/heat-pumps',
    label: m.nav_energy_heat_pumps,
    keywords: m.cmd_kw_energy_heat_pumps,
    icon: AirVentIcon,
    adminOnly: false,
  },
```

- [ ] **Step 5: Run** `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/heatPump/ src/components/AppSidebar.browser.test.tsx && TZ=UTC bunx vitest run --project browser src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx && bun run typecheck` → PASS.

- [ ] **Step 6: Skeleton.** In `scripts/captureBones.ts` add `'/energy/heat-pumps'` to `DEFAULT_PATHS` after
  `'/energy/battery'` (no extra breakpoint: the card doesn't switch layout at 1220 px). The capture needs local heat
  pump data: if the local DB has none, sign in as the admin on the dev server and press Synka nu for Comfort Cloud
  under `/charging/settings` › Datakällor (the `.env.local` credentials; each run backfills up to 60 days per unit)
  until the current month and the previous one have readings. Start the dev server on 14611 (Task 0) and run
  `BONES_ORIGIN=http://localhost:14611 bun run bones:capture /energy/heat-pumps`. Then in the route replace
  `name="heat-pump-consumption"` with `bones={heatPumpConsumptionBones}` and add
  `import heatPumpConsumptionBones from '~/bones/heat-pump-consumption.bones.json'`. Run
  `bunx vitest run test/sectionSkeletonBones.test.ts` → PASS.

- [ ] **Step 7: Bundle entry.** In `scripts/measureBundle.ts` add `'/energy/heat-pumps': 'heat-pumps'` to `PAGES`
  after `/energy` (check the chunk's real prefix with `ls .output/public/assets | grep -i heat` after the build and
  match it). Run `bun run bundle:measure` on this branch and on `main` (in the main checkout, read-only) and record
  both outputs for the PR. Expected: the `entry:` line and every existing page within ±0,2 KB gz of `main`; no new
  watched package on any page; `/energy/heat-pumps` beyond entry + shell close to `/energy`'s (it shares visx and the
  period control). Anything else (the entry grew, a page grew by more than 1 KB, a cycle printed) is a finding to fix
  before the PR.

- [ ] **Step 8: Commit**

```bash
bun run check
git add src/routes/_authenticated/energy/heat-pumps.tsx src/routes/_authenticated/energy/-heatPumpsPage.browser.test.tsx \
  src/routeTree.gen.ts src/components/heatPump/clientSafe.browser.test.tsx src/components/AppSidebar.tsx \
  src/components/AppSidebar.browser.test.tsx src/components/command/commands.ts scripts/captureBones.ts \
  scripts/measureBundle.ts src/bones/heat-pump-consumption.bones.json messages/sv.json messages/en.json
git commit -m "feat(heat-pumps): add the Värmepumpar page" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verify live, review the branch, record the step, open the PR

- [ ] **Step 1: Query cost check** (local, the full local history from Task 8 Step 6):

```bash
psql postgres://videbacken:videbacken@localhost:14620/videbacken -c "EXPLAIN (ANALYZE, BUFFERS)
SELECT heat_pump_id, to_char(hour_start AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD'), sum(energy_kwh), count(*)
FROM heat_pump_reading WHERE hour_start >= '2025-08-31 22:00Z' AND hour_start < '2026-10-31 23:00Z' GROUP BY 1, 2"
```

Expected: well under 20 ms. If it isn't, don't add an index here: a migration needs the schema-design review; raise
it in the PR and with the owner.

- [ ] **Step 2: Live (Phase 6).** Playwright on the worktree's dev server (14611), signed in through Mailpit (memory
  "live UI check via Playwright": wait for load + 4 s, never `networkidle`). `/energy/heat-pumps` at 1440, 820 and
  390 px, light and dark:
  - the Förbrukning card's rect stays identical (± 0,5 px) while stepping months (day view), switching to the whole
    year, to Totalt and back (tiles, change line, missing note and hint keep their lines);
  - the stacked colours match Översikt's Användning colours per unit; last year's outline sits beside each month in
    the year view only; the outdoor line's right axis stays inside the card at 390 px; no horizontal overflow;
  - a running period shows "hittills" and a change only when both periods are complete; Totalt shows no change;
  - Översikt → Värmepumpar via the sidebar keeps `?period=`; the network log shows one `heatPump/months` request (and
    one `heatPump/days` for a month), none repeated on a month step inside the same year;
  - Cmd+K "värmepump" finds the page; console clean. Screenshots for the PR.

- [ ] **Step 3: Figures vs SQL** (local DB; the same queries are checkpoint 4's on prod):

```sql
-- A month per unit: kWh, hours, hour-weighted outdoor mean (compare the month tiles and the month's day bars' sum).
SELECT h.name, round(sum(r.energy_kwh)::numeric, 2) AS kwh, count(*) AS hours,
       round(avg(r.outside_c)::numeric, 2) AS outside_c
FROM heat_pump_reading r JOIN heat_pump h ON h.id = r.heat_pump_id
WHERE date_trunc('month', r.hour_start AT TIME ZONE 'Europe/Stockholm') = '2026-02-01'
GROUP BY h.name ORDER BY h.name;

-- One day per unit (the day bar's tooltip).
SELECT h.name, round(sum(r.energy_kwh)::numeric, 3) AS kwh, count(*) AS hours
FROM heat_pump_reading r JOIN heat_pump h ON h.id = r.heat_pump_id
WHERE (r.hour_start AT TIME ZONE 'Europe/Stockholm')::date = '2026-01-15'
GROUP BY h.name ORDER BY h.name;

-- Last year's outline: 2025 per month, all units (the 2026 year view's outlines).
SELECT extract(month FROM r.hour_start AT TIME ZONE 'Europe/Stockholm')::int AS month,
       round(sum(r.energy_kwh)::numeric, 2) AS kwh
FROM heat_pump_reading r
WHERE extract(year FROM r.hour_start AT TIME ZONE 'Europe/Stockholm') = 2025
GROUP BY 1 ORDER BY 1;

-- The outdoor line per month: each unit's mean weighted by its hours (the page's rule).
WITH u AS (
  SELECT date_trunc('month', hour_start AT TIME ZONE 'Europe/Stockholm') AS m, heat_pump_id,
         avg(outside_c) AS c, count(*) AS n
  FROM heat_pump_reading GROUP BY 1, 2)
SELECT to_char(m, 'YYYY-MM') AS month, round((sum(c * n) / sum(n) FILTER (WHERE c IS NOT NULL))::numeric, 2) AS outside_c
FROM u WHERE c IS NOT NULL GROUP BY m ORDER BY m;
```

Each tile and tooltip value within 0,05 kWh / 0,05 °C of its row (the page rounds for display).

- [ ] **Step 4: Branch review (Phase 5).** `code-reviewer` (ADR-0002, 0024, 0025, 0027 adherence; the Task 1
  refactor and the Task 5 chart options truly behaviour-preserving for the existing pages), `test-completeness`
  (service, read model, view model; no new domain error code in this step), and a general correctness pass over the
  whole diff. No schema or `drizzle/` change in this step, so no migration-guard / schema-design gate (if one
  slipped in, both are mandatory). Fix or rule on every finding.

- [ ] **Step 5: Docs.**
  - Roadmap row 3: plan link (this file), PR link, `PR open`; a Log line with the live result, the bundle numbers
    and anything that diverged from the spec.
  - The spec already records this plan's decisions (Totalt = `months` without a year, the extra output fields, the
    same-span comparison, the default month, the trailing-lag rule, unit order and colours). Amend the spec and
    ADR-0027 only for a decision that changes during the build, and note it in the roadmap's Log.
  - `CLAUDE.md` code map: add `heatPump` to the `components/` entity folders and `/energy/heat-pumps` where the
    Energi routes are listed, if steps 1b/2 haven't.

- [ ] **Step 6: Pre-PR gate** (`docs/feature-workflow.md`, verbatim):

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

- **UI changed:** checked responsive at desktop, tablet and mobile widths in a real browser (Step 2).
- **PR title:** `<type>(<scope>): <subject>`, ≤72 chars, imperative, and one concern.

Also: `TZ=UTC bunx vitest run --project browser src/components/heatPump/ src/routes/_authenticated/energy/ src/components/chart/`
(CI's time zone). Browser files that fail only after a merge (Vite re-optimising deps) are re-run alone before
calling them failures.

- [ ] **Step 7: Commit and PR**

```bash
git add docs/superpowers/roadmaps/2026-10-08-heat-pumps.md CLAUDE.md   # + the spec / ADR only if Step 5 amended them
git commit -m "docs(heat-pumps): track step 3" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/heat-pumps-page
gh pr create --title "feat(heat-pumps): add the heat pump consumption page" --body-file <(cat <<'EOF'
<.github/PULL_REQUEST_TEMPLATE.md filled in: why (spec + ADR-0027 links), what (the reads, the procedures, the chart
options, the page), verification (pre-PR gate output, TZ=UTC run, live screenshots at 1440/820/390 light + dark,
the SQL comparison, bundle:measure before/after), any spec amendment from the build, follow-ups.>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

**Checkpoint 4 (prod) runs after merge, in a new session** (roadmap "Checkpoints" 4): Step 3's SQL as read-only
SELECTs on prod for 2026-02 (month view) and one day in 2026-01 (day view), 2025 for the outlines, the outdoor line
per month; each equals the page per unit. Then the owner reviews Värmepumpar live (desktop + phone) and accepts it.
Record the result in the roadmap.
