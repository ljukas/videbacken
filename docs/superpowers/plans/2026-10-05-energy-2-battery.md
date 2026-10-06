# House energy, step 2: Energi › Batteri — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Rewritten 2026-10-06** for the [battery page design](../specs/2026-10-06-energy-battery-page-design.md). The
> first version (four figure tiles, a Recharts chart with a metric toggle, `PeriodTabs`, `?year=`) predated steps 1b
> and 1c and is replaced in full.

**Goal:** A second Energi sub-page, `/energy/battery`, that shows the chosen period's home battery as a flow diagram
(solar and bought in, the battery's change in stored energy, out and the loss as its own node, the efficiency in a
ring) above a month chart of out with the loss stacked on top, plus a winter note.

**Architecture:** No new read: the page uses `energy.overview` through the same cache entry as Översikt
(`energyOverviewQueryFor(period)`) and the definitions in `figures.ts`. Two behaviour-preserving refactor commits come
first: Översikt's period state moves into a shared hook (with the card frame and empty state), and step 1c's flow
primitives and drawing parts move out of `EnergyFlowDiagram` / `EnergyFlow` so a second diagram can use them. Then a
`--energy-loss` token and two generic `BarChart` options (a hatch pattern, a label above a stack), the battery flow
geometry (pure), the battery flow card, the month chart, and the route with its sidebar sub-items, palette entry and
skeletons.

**Tech Stack:** TanStack Start / Router file routes, TanStack Query, visx (`@visx/group`, `@visx/responsive`, the
shared `BarChart`), lucide-react, Paraglide, Vitest (node + browser), Biome, boneyard-js skeletons.

**Spec:** [`docs/superpowers/specs/2026-10-06-energy-battery-page-design.md`](../specs/2026-10-06-energy-battery-page-design.md)
· ADR: [`docs/adr/0024-house-energy-pages.md`](../../adr/0024-house-energy-pages.md) (decision 6, step-2 amendment)
· Roadmap: [`docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md`](../roadmaps/2026-10-05-house-energy-pages.md) (step 2)
· Builds on: [period control design](../specs/2026-10-05-energy-period-control-design.md) (1b),
[flow summary design](../specs/2026-10-06-energy-flow-summary-design.md) (1c)
· Approved mockup: <https://claude.ai/artifact/9DQUpranaTQ1acazwzLM81> (version 3)

## Global Constraints

- Read-only; no new procedure, no schema change, no new dependency (ADR-0024).
- All figures from `energyFigures` (`src/lib/houseEnergy/figures.ts`); no new definitions. `C` = `BATTERY_CAPACITY_KWH` (7,58), never hard-coded.
- Loss below 0,5 kWh, or negative: "≈ 0 kWh", no loss arrow, no loss share (`lossLabel` / `MIN_LOSS_KWH`); tables and tooltips keep the real value.
- Efficiency `null`: "—" and an empty ring; efficiency ≥ 1: "≈ 100 %"; arrows under 0,05 kWh (`MIN_FLOW_KWH`) are not drawn.
- `--energy-loss`: `#b91c1c` light, `#dc3c3c` dark; the chart's loss segment is hatched at 45°.
- Wide layout from a card content width of 860 px (`WIDE_MIN_WIDTH`); flow box height 300 wide / 430 narrow, reserved by a container query (no layout shift).
- The "Visa värden" switch shares Översikt's key `videbacken-energy-flow-values`.
- URL `/energy/battery`; `?period=` exactly as `/energy`; the sidebar carries `?period=` between Översikt and Batteri.
- Paraglide sv (source) + en key-complete; Swedish copy exactly as written in this plan.
- Every task's refactor commits leave Översikt's existing tests green **unchanged** (a refactor that needs a test edit isn't behaviour-preserving).
- Conventional Commits; `git add <paths>`, never `-A`. PR title `feat(energy): add the home battery page`.

## Review Focus

1. **The current month on its first day, or a month with meter noise**: the loss is slightly negative. The Förlust
   node says "≈ 0 kWh", no loss arrow is drawn, no share line, and the chart draws only Ut for that month (never a
   negative segment). Pinned in Task 5 (`BatteryFlow`) and Task 6 (`batteryChartRows`).
2. **A month where the battery barely ran (< 1 kWh in, e.g. a gap-heavy month)**: Verkningsgrad "—" with an empty
   ring, no "% av det som laddades in" anywhere, the in-arrows' tooltip share not divided by ~0. Pinned in Task 5.
3. **Switching Översikt → Batteri keeps the period and sends no request**: same cache entry, the sidebar sub-item
   carries `?period=`. Pinned in Task 7 (page test with one seeded entry; sidebar link-props test).
4. **A period with a battery sale (`batteryToGrid` ≥ 0,05)**: the Ut node shows "varav såld X kWh", the table gets
   the row, the Ut arrow's tooltip splits house / sold; with none, the line's room stays reserved (nothing moves).
   Pinned in Task 5.
5. **Another year loading or a failed read on Batteri**: the old diagram stays dimmed / the box goes blank under the
   alert, exactly as Översikt. Pinned by the shared hook in Task 1 (Översikt's tests) and a Batteri case in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/energy/energySearch.ts` (create) | `energySearchSchema`, `periodOfSearch`, `periodSearchValue` (moved out of `energy/index.tsx`) |
| `src/components/energy/useEnergyPeriod.ts` (create) | The pages' shared period + overview state (moved out of `energy/index.tsx`) |
| `src/components/energy/EnergySummaryCard.tsx` (create) | The Summering card frame: heading, `PeriodControl`, announcement, dimmed body |
| `src/components/energy/EnergyEmpty.tsx` (create) | "Ingen energidata ännu" |
| `src/routes/_authenticated/energy/index.tsx` (modify) | Uses the four above; behaviour unchanged |
| `src/lib/houseEnergy/flowLayout.ts` (modify) | Primitives generic over node keys (`FlowGraph<K>`, `FlowEdgeSpec<K>`, `flowEdge`) |
| `src/components/energy/flowParts.tsx` (create) | `NODE_SURFACE`, `NODE_MUTED`, `ValuePill`, `useFittedSize`, `NodeFrame`, `RingFigure`, `FlowValuesSwitch`, `FlowTableFrame` |
| `src/components/energy/EnergyFlowDiagram.tsx`, `EnergyFlow.tsx` (modify) | Use `flowParts`; render identically |
| `src/styles/app.css` (modify) | `--energy-loss` light/dark + `--color-energy-loss` |
| `src/components/chart/barLayout.ts`, `BarChart.tsx`, `ChartParts.tsx` (+ `BarChart.browser.test.tsx`) (modify) | Series `pattern: 'hatch'`, `barLabel` |
| `src/lib/houseEnergy/batteryFlowLayout.ts` (+ `.test.ts`) (create) | Battery diagram geometry, edge values, node text placement |
| `src/components/energy/BatteryFlowDiagram.tsx` (+ `.browser.test.tsx`) (create) | Draws the battery flow |
| `src/components/energy/BatteryFlow.tsx` (+ `.browser.test.tsx`) (create) | The Summering card body: ring, diagram box, switch, gap note, table |
| `src/components/energy/BatteryMonthlyChart.tsx` (+ `.browser.test.tsx`), `batteryChart.ts` (+ `.test.ts`) (create) | The month chart and its pure rows |
| `src/components/energy/EnergyHeading.tsx` (modify) | Optional `description` |
| `src/routes/_authenticated/energy/battery.tsx` (create) | The Batteri page |
| `src/routes/_authenticated/energy/-energyPage.browser.test.tsx` (modify) | Battery page cases |
| `src/components/AppSidebar.tsx` (+ test) (modify) | Energi sub-items; `?period=` carried |
| `src/components/command/commands.ts` (modify) | Palette entry |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (modify) | Battery route + layout guards |
| `scripts/captureBones.ts`, `src/bones/energy-battery-*.bones.json` (modify / generate) | Battery skeletons |
| `messages/sv.json`, `messages/en.json` (modify) | `energy_battery_*`, `nav_energy_*`, `meta_energy_battery_*`, `cmd_kw_energy_battery` |
| `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` (modify) | Row 2 → `PR open`, log line |

---

### Task 0: Verify `main` still matches this plan; worktree

- [ ] **Step 1: Check what the plan builds on**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "| 1c |" docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md          # checkpoint passed
grep -n "export function energyFigures\|export function gapHours\|WINTER_LOSS_SHARE =\|lossShare\|batteryToGrid" src/lib/houseEnergy/figures.ts | head
grep -n "export function flowLayout\|export function flowCurve\|export function arrowHead\|export function flowWidth\|export function lossLabel\|MIN_FLOW_KWH =\|MIN_LOSS_KWH =\|WIDE_MIN_WIDTH =" src/lib/houseEnergy/flowLayout.ts
grep -n "export const energyOverviewQueryFor\|export const energyOverviewQuery " src/components/energy/energyQueries.ts
grep -n "export function PeriodControl\|export function periodLabel" src/components/energy/PeriodControl.tsx
grep -n "export function EnergyFlow\b\|SHOW_FLOW_VALUES_KEY\|function SelfSufficiency\|function FlowTable" src/components/energy/EnergyFlow.tsx
grep -n "function ValuePill\|function useFittedSize\|function FlowNodeBox\|NODE_SURFACE =\|NODE_MUTED =" src/components/energy/EnergyFlowDiagram.tsx
grep -n "selection?: BarSelection\|export type BarSeries" src/components/chart/BarChart.tsx src/components/chart/barLayout.ts
grep -n "export function formatSignedOneDecimal\|export function formatDecimal\b\|export function formatShare\|export function formatOneDecimal" src/components/evCharging/format.ts
grep -n "placement" src/components/evCharging/ChartPopover.tsx | head -2
grep -n "chargingSubItems\|sectionLinkProps\|unscopedLinkProps\|'/energy'" src/components/AppSidebar.tsx
ls src/routes/_authenticated/energy/ src/bones/ | grep -i energy
```

Expected: row 1c is `checkpoint passed`; every grep prints; the energy folder has `index.tsx` and
`-energyPage.browser.test.tsx` only. If a name moved, adapt the tasks' imports first and note it in the PR.

- [ ] **Step 2: Worktree**

```bash
git worktree add .claude/worktrees/energy-battery -b feat/energy-battery origin/main
cd .claude/worktrees/energy-battery && bun install && bun run db:up && bun run db:migrate
```

Port 14610 is often another session's dev server: run this worktree's dev server on 14611
(`BETTER_AUTH_URL=http://localhost:14611 bun run dev -- --port 14611`) and pass `BONES_ORIGIN=http://localhost:14611`
to `bones:capture`.

---

### Task 1 (refactor): Översikt's period state into a shared hook

**Reviewers:** `code-reviewer` + reviewer loading `vercel-react-best-practices` (both told: the commit must not change
behaviour; Översikt's tests must pass unchanged).

**Files:**
- Create: `src/components/energy/energySearch.ts`, `src/components/energy/useEnergyPeriod.ts`,
  `src/components/energy/EnergySummaryCard.tsx`, `src/components/energy/EnergyEmpty.tsx`
- Modify: `src/routes/_authenticated/energy/index.tsx`
- Test: `src/routes/_authenticated/energy/-energyPage.browser.test.tsx` (run, **not edited**)

**Interfaces:**
- Produces:
  - `energySearchSchema` (zod object: `period?: string | number`, `year?: number`), `type EnergySearch`
  - `periodOfSearch(search: EnergySearch): EnergyPeriod | null`
  - `periodSearchValue(p: EnergyPeriod): string | number`
  - `type EnergySearchWrite = (search: { period?: string | number }) => void`
  - `useEnergyPeriod(search: EnergySearch, writeSearch: EnergySearchWrite)` returning
    `{ result, overview, tiles, period, setPeriod, now, sums, sumsDimmed, sumsStale, stale, failed, pending }`
  - `EnergySummaryCard({ period, monthsWithReadings, now, onChange, dimmed, children })`
  - `EnergyEmpty()`

- [ ] **Step 1: Run Översikt's tests as the baseline**

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/energy/`
Expected: PASS. Note the count.

- [ ] **Step 2: `energySearch.ts`** (moved verbatim from `index.tsx`, renamed for export)

```ts
// src/components/energy/energySearch.ts
import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { type EnergyPeriod, formatPeriod, periodFromSearch } from '~/lib/houseEnergy/period'

// Both Energi pages' search (step 1b). The router JSON-parses search values, so
// `?period=2026` arrives as a number (and a year is written as one, keeping the
// URL unquoted); months and `all` stay strings.
export const energySearchSchema = z.object({
  period: z
    .union([z.string().max(10), z.number()])
    .optional()
    .catch(undefined),
  /** Step-1 links: read as `?period=Y`, dropped on the next write. */
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})
export type EnergySearch = z.infer<typeof energySearchSchema>

export const periodOfSearch = ({ period, year }: EnergySearch) =>
  periodFromSearch({ period: period === undefined ? undefined : String(period), year })

/** The URL value: a year as a number, so the router writes it unquoted. */
export const periodSearchValue = (p: EnergyPeriod) => (p.kind === 'year' ? p.year : formatPeriod(p))
```

- [ ] **Step 3: `useEnergyPeriod.ts`**: move the body of `EnergyOverviewPage` from `const requested = …` through the
  `rewriteTo` effect, unchanged except that `navigate({ to: '.', search, replace: true, resetScroll: false })`
  becomes `writeSearch(search)`. Keep every comment.

```ts
// src/components/energy/useEnergyPeriod.ts
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { type EnergyPeriod, formatPeriod, resolvePeriod } from '~/lib/houseEnergy/period'
import { firstLoadPending, loadFailed } from '~/components/layout/LoadErrorAlert'
import { stockholmYearMonth } from '~/lib/time/stockholm'
import { energyOverviewQueryFor } from './energyQueries'
import { type EnergySearch, periodOfSearch, periodSearchValue } from './energySearch'

export type EnergySearchWrite = (search: { period?: string | number }) => void

// The Energi pages' shared state (steps 1b and 2): the requested period, the
// overview read (one cache entry per year, shared by both pages), the period
// shown, its sums with the stale/failed rules, and the URL rewrite of a period
// the data can't show. Moved from energy/index.tsx unchanged.
export function useEnergyPeriod(search: EnergySearch, writeSearch: EnergySearchWrite) {
  const requested = periodOfSearch(search)
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({
    ...energyOverviewQueryFor(requested),
    placeholderData: keepPreviousData,
  })
  const { data, isPlaceholderData: stale } = result
  const failed = loadFailed(result)
  const overview = data && !failed ? data : undefined
  const pending = firstLoadPending(result)
  const [lastShown, setLastShown] = useState(overview)
  if (overview && overview.firstReadingDay !== null && overview !== lastShown) {
    setLastShown(overview)
  }
  const tiles = overview ?? lastShown
  const now = stockholmYearMonth(Date.now())
  const period = tiles ? resolvePeriod(requested, tiles.monthsWithReadings, now) : null
  const setPeriod = useCallback(
    (p: EnergyPeriod) => writeSearch({ period: periodSearchValue(p) }),
    [writeSearch],
  )
  const periodSums =
    !tiles || !period
      ? null
      : period.kind === 'all'
        ? tiles.allTime
        : period.kind === 'year'
          ? tiles.yearTotal
          : period.year === tiles.year
            ? tiles.months[period.month - 1]
            : null
  const [lastSums, setLastSums] = useState<PeriodSums | null>(periodSums)
  if (!stale && !failed && periodSums !== lastSums) setLastSums(periodSums)
  const sumsStale = stale && period?.kind !== 'all'
  const sums: PeriodSums | null | 'unavailable' = failed
    ? 'unavailable'
    : sumsStale
      ? lastSums
      : periodSums
  const rewriteTo: string | number | null | undefined = requested
    ? overview && !stale && overview.firstReadingDay !== null && period
      ? formatPeriod(requested) !== formatPeriod(period)
        ? periodSearchValue(period)
        : undefined
      : undefined
    : search.period !== undefined || search.year !== undefined
      ? null
      : undefined
  useEffect(() => {
    if (rewriteTo === undefined) return
    writeSearch(rewriteTo === null ? {} : { period: rewriteTo })
  }, [rewriteTo, writeSearch])
  return {
    result,
    overview,
    tiles,
    period,
    setPeriod,
    now,
    sums,
    /** The period's figures are the last ones shown while another year loads, or a failed read's blank. */
    sumsDimmed: sumsStale || failed,
    sumsStale,
    stale,
    failed,
    pending,
  }
}
```

(Copy the original comments from `index.tsx` above each block: "Placeholder data counts as data …", "The last
overview with readings …", "The server render and the hydrating one read the clock …", "`monthsWithReadings` spans
every year …", "While another year loads …", "A period the data can't show …".)

- [ ] **Step 4: `EnergySummaryCard.tsx` and `EnergyEmpty.tsx`** (the JSX moved from `index.tsx`)

```tsx
// src/components/energy/EnergySummaryCard.tsx
import type * as React from 'react'
import { useId } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { PeriodControl, periodLabel } from './PeriodControl'

type YearMonth = { year: number; month: number }

// The Energi pages' Summering card (steps 1b, 1c, 2): the heading, the period
// control, a polite announcement of each period change, and the body, dimmed
// while another year loads or after a failed read. The control stays live.
export function EnergySummaryCard({
  period,
  monthsWithReadings,
  now,
  onChange,
  dimmed,
  busy,
  children,
}: {
  period: EnergyPeriod
  monthsWithReadings: string[]
  now: YearMonth
  onChange: (p: EnergyPeriod) => void
  dimmed: boolean
  /** aria-busy on the body: another year is loading (not a failed read). */
  busy: boolean
  children: React.ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <Card>
        {/* As tall for every period: the control's label cell is as wide as its widest label, its buttons a fixed 40 px. */}
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="font-semibold text-lg">
            {m.energy_tiles_heading()}
          </h2>
          <PeriodControl
            period={period}
            monthsWithReadings={monthsWithReadings}
            current={now}
            onChange={onChange}
          />
        </CardHeader>
        {/* Announces each period change (the label sits inside a button, which screen readers don't re-read).
            Outside the busy figures, so it isn't held back while a year loads. */}
        <p data-slot="period-announcement" aria-live="polite" className="sr-only">
          {periodLabel(period, now)}
        </p>
        <CardContent
          className={cn('transition-opacity', dimmed && 'opacity-60')}
          aria-busy={busy || undefined}
        >
          {children}
        </CardContent>
      </Card>
    </section>
  )
}
```

```tsx
// src/components/energy/EnergyEmpty.tsx
import { SunIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { m } from '~/paraglide/messages'

// No house readings yet (ADR-0016): only data says so, never a skeleton.
export function EnergyEmpty() {
  return (
    <Empty className="brand-wash rounded-lg border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SunIcon />
        </EmptyMedia>
        <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
```

- [ ] **Step 5: `index.tsx` uses them.** The route keeps its `head`, `loader` (now `periodOfSearch(energySearchSchema.parse(location.search))`) and `validateSearch: energySearchSchema`. The component becomes:

```tsx
function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.emaldo
  const navigate = Route.useNavigate()
  const writeSearch = useCallback<EnergySearchWrite>(
    (search) => void navigate({ to: '.', search, replace: true, resetScroll: false }),
    [navigate],
  )
  const e = useEnergyPeriod(Route.useSearch(), writeSearch)
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()
  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health?.lastSuccessAt} />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('emaldo')}
          retrying={syncNow.isPendingFor('emaldo')}
        />
      ) : null}
      {e.overview?.firstReadingDay === null ? (
        <EnergyEmpty />
      ) : (
        <div className="flex flex-col gap-4">
          <SectionSkeleton bones={energyTilesBones} loading={e.pending} fallbackHeight="12rem">
            {e.tiles && e.period ? (
              <EnergySummaryCard
                period={e.period}
                monthsWithReadings={e.tiles.monthsWithReadings}
                now={e.now}
                onChange={e.setPeriod}
                dimmed={e.sumsDimmed}
                busy={e.sumsStale}
              >
                <EnergyFlow sums={e.sums} />
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          {/* chart section: unchanged, reading e.overview, e.stale, e.now, e.period, e.setPeriod */}
          <LoadErrorAlert title={m.energy_error_title()} query={e.result} />
        </div>
      )}
    </PageContainer>
  )
}
```

The chart `SectionSkeleton` block stays as it is, with `overview` → `e.overview`, `stale` → `e.stale`, `now` →
`e.now`, `period` → `e.period`, `setPeriod` → `e.setPeriod`. Keep the comments that still apply ("A skeleton is
not an empty state", "The same element whatever the state …"). Remove now-unused imports.

- [ ] **Step 6: Run Översikt's tests unchanged + typecheck**

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/energy/ && bun run typecheck`
Expected: PASS with Step 1's count; no test file changed (`git diff --stat -- '*.test.*'` prints nothing).

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/components/energy/energySearch.ts src/components/energy/useEnergyPeriod.ts \
  src/components/energy/EnergySummaryCard.tsx src/components/energy/EnergyEmpty.tsx \
  src/routes/_authenticated/energy/index.tsx
git commit -m "refactor(energy): share the period state between the Energi pages"
```

---

### Task 2 (refactor): Shared flow primitives and drawing parts

**Reviewers:** `code-reviewer` + reviewer loading `vercel-react-best-practices` + `web-design-guidelines` (told: the
Översikt diagram must render identically; its tests pass unchanged).

**Files:**
- Modify: `src/lib/houseEnergy/flowLayout.ts`, `src/components/energy/EnergyFlowDiagram.tsx`,
  `src/components/energy/EnergyFlow.tsx`
- Create: `src/components/energy/flowParts.tsx`
- Test: `flowLayout.test.ts`, `EnergyFlow*.browser.test.tsx` (run, not edited)

**Interfaces:**
- Produces (`flowLayout.ts`):
  - `type FlowEdgeSpec<K extends string = FlowNodeKey>` (same fields, `from` / `to: K`)
  - `type FlowGraph<K extends string> = { narrow: boolean; height: number; nodes: Record<K, FlowNode>; edges: FlowEdgeSpec<K>[] }`
  - `type FlowLayout = FlowGraph<FlowNodeKey> & { loss: … }` (unchanged shape)
  - `flowEdge<K>(from, to, fromSide, fromOffset, toSide, toOffset, k1?, k2?, labelT?)` (the private `edge`, exported)
  - `flowCurve<K extends string>(layout: FlowGraph<K>, e: FlowEdgeSpec<K>)` (body unchanged)
  - `export const NODE_PADDING = 12` (was private)
- Produces (`flowParts.tsx`):
  - `NODE_SURFACE`, `NODE_MUTED` (moved constants)
  - `ValuePill({ x, y, text, className })`, `useFittedSize(ref, text, { x, size, minSize, room })` (moved verbatim)
  - `NodeFrame({ node, tile, label, labelText, Icon, tint, children })`: the node rect, the icon tile, the icon and
    the label (the first four elements of `FlowNodeBox`), with `children` (the node's figures) after them
  - `RingFigure({ value, valueText?, label, detail, arcClassName, hidden })` (Självförsörjning's ring; `valueText`
    defaults to `value === null ? '—' : formatShare(value)`; the arc colour is a prop, `'stroke-foreground'` on
    Översikt; `data-slot="ring-figure"` on the root and `data-slot="ring-arc"` on the arc circle)
  - `FlowValuesSwitch({ checked, onCheckedChange, hint })` (the hint + switch row)
  - `FlowTableFrame({ rows, children })`: the `<table>` with the Flöde / Värde header, `rows: [string, string][]`,
    `children` = extra `<tr>`s after the rows (Översikt's charge-level and Självförsörjning rows)

- [ ] **Step 1: Baseline**: `bunx vitest run src/lib/houseEnergy/flowLayout.test.ts && bunx vitest run --project browser src/components/energy/` → PASS (note counts).

- [ ] **Step 2: Generalise `flowLayout.ts`.** Make `FlowEdgeSpec` generic with a default, add `FlowGraph<K>`, define
  `FlowLayout` as `FlowGraph<FlowNodeKey> & { loss: { side: 'b' | 'r'; offset: number; length: number } }`, export
  the `edge` helper as `flowEdge` (generic in `K`) and `NODE_PADDING`, and type `flowCurve` / `port` over
  `FlowGraph<K>`:

```ts
export type FlowEdgeSpec<K extends string = FlowNodeKey> = {
  from: K
  to: K
  fromSide: Side
  fromOffset: number
  toSide: Side
  toOffset: number
  k1: number
  k2: number
  labelT: number
}
export type FlowGraph<K extends string> = {
  narrow: boolean
  height: number
  nodes: Record<K, FlowNode>
  edges: FlowEdgeSpec<K>[]
}
export type FlowLayout = FlowGraph<FlowNodeKey> & {
  loss: { side: 'b' | 'r'; offset: number; length: number }
}

export const flowEdge = <K extends string>(
  from: K,
  to: K,
  fromSide: Side,
  fromOffset: number,
  toSide: Side,
  toOffset: number,
  k1 = 0.5,
  k2 = 0.5,
  labelT = 0.5,
): FlowEdgeSpec<K> => ({ from, to, fromSide, fromOffset, toSide, toOffset, k1, k2, labelT })

export function flowCurve<K extends string>(layout: FlowGraph<K>, e: FlowEdgeSpec<K>) {
  // body unchanged
}
```

Replace `edge(` with `flowEdge(` inside `flowLayout`. `drawnFlows`, `edgeKwh`, `lossStub` and `nodeText` stay
specific to `FlowLayout`.

- [ ] **Step 3: `flowParts.tsx`.** Move `NODE_SURFACE`, `NODE_MUTED`, `ValuePill` and `useFittedSize` from
  `EnergyFlowDiagram.tsx` verbatim (with their comments). Add:

```tsx
/** A node's box, icon tile, icon and label; the node's figures follow as children. */
export function NodeFrame({
  node: n,
  tile,
  label,
  labelText,
  Icon,
  tint,
  children,
  ...rest
}: {
  node: FlowNode
  tile: NodeText['tile']
  label: { x: number; y: number }
  labelText: string
  Icon: LucideIcon
  /** The arrow colour the tile is tinted with (sources); neutral without. */
  tint?: string
  children?: React.ReactNode
} & React.SVGProps<SVGGElement>) {
  return (
    <g {...rest}>
      <rect
        x={n.x - n.w / 2}
        y={n.y - n.h / 2}
        width={n.w}
        height={n.h}
        rx={12}
        className="stroke-border"
        style={{ fill: NODE_SURFACE }}
      />
      <rect
        x={tile.x}
        y={tile.y}
        width={tile.size}
        height={tile.size}
        rx={tile.size * 0.24}
        style={{
          fill: tint
            ? `color-mix(in oklab, ${tint} 24%, ${NODE_SURFACE})`
            : 'color-mix(in oklab, var(--foreground) 7%, var(--card))',
        }}
      />
      <Icon
        aria-hidden
        x={tile.x + (tile.size - tile.icon) / 2}
        y={tile.y + (tile.size - tile.icon) / 2}
        width={tile.icon}
        height={tile.icon}
        className="text-foreground"
      />
      <text x={label.x} y={label.y} fontSize={14} fontWeight={500} className="fill-foreground">
        {labelText}
      </text>
      {children}
    </g>
  )
}
```

`FlowNodeBox` in `EnergyFlowDiagram.tsx` becomes `<NodeFrame data-flow-node={key} node={n} tile={t.tile}
label={t.label} labelText={label(key)} Icon={ICON[key]} tint={SOURCE_COLOR[key]}>…the figure texts…</NodeFrame>`.

Move `SelfSufficiency` from `EnergyFlow.tsx` to `RingFigure` (same markup; `m.energy_tile_self_sufficiency()` →
`label`, `…_detail()` → `detail`, `className="stroke-foreground"` on the arc → `arcClassName`), and the table
`<table>…<thead>…</thead><tbody>{rows}{children}</tbody></table>` wrapper of `FlowTable` to `FlowTableFrame`. Move
the hint + switch row:

```tsx
export function FlowValuesSwitch({
  checked,
  onCheckedChange,
  hint,
}: {
  checked: boolean
  onCheckedChange: (on: boolean) => void
  hint: string
}) {
  const switchId = useId()
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p className="text-muted-foreground text-sm">{hint}</p>
      <label htmlFor={switchId} className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm">
        <Switch id={switchId} checked={checked} onCheckedChange={onCheckedChange} />
        {m.energy_flow_show_values()}
      </label>
    </div>
  )
}
```

`EnergyFlow` uses `RingFigure` (`label={m.energy_tile_self_sufficiency()}`,
`detail={m.energy_tile_self_sufficiency_detail()}`, `arcClassName="stroke-foreground"`), `FlowValuesSwitch`
(`hint={m.energy_flow_hint()}`) and `FlowTableFrame`. Keep `SHOW_FLOW_VALUES_KEY` exported from `EnergyFlow.tsx`.

- [ ] **Step 4: Run the baseline tests unchanged + typecheck**

Run: `bunx vitest run src/lib/houseEnergy/flowLayout.test.ts && bunx vitest run --project browser src/components/energy/ src/routes/_authenticated/energy/ && bun run typecheck`
Expected: PASS with the same counts; `git diff --stat -- '*.test.*'` prints nothing.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/houseEnergy/flowLayout.ts src/components/energy/flowParts.tsx \
  src/components/energy/EnergyFlowDiagram.tsx src/components/energy/EnergyFlow.tsx
git commit -m "refactor(energy): share the flow diagram's parts"
```

---

### Task 3: The loss colour and two `BarChart` options

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/styles/app.css`, `src/components/chart/barLayout.ts` (`BarSeries`), `src/components/chart/BarChart.tsx`,
  `src/components/chart/ChartParts.tsx` (`ChartLegend`)
- Test: `src/components/chart/BarChart.browser.test.tsx`

**Interfaces:**
- Produces: `--energy-loss` / `bg-energy-loss`; `BarSeries.pattern?: 'hatch'`; `BarChartProps.barLabel?: (row: Row, index: number) => string | null`;
  `ChartLegend` items accept `pattern?: 'hatch'`; `HATCH_SWATCH(color)` exported from `ChartParts.tsx` (the CSS
  background of a hatched swatch, reused by the battery tooltip).

- [ ] **Step 1: Write the failing tests** (append to `BarChart.browser.test.tsx`, using that file's existing
  render helper and `rows` fixture; adapt names to it)

```tsx
test('a hatched series fills its bars with a pattern in the chart and hatches its legend swatch', async () => {
  const { screen } = await renderChart({
    series: [
      { key: 'a', label: 'A', color: 'var(--energy-battery)', stack: 's' },
      { key: 'b', label: 'B', color: 'var(--energy-loss)', stack: 's', pattern: 'hatch' },
    ],
    legend: true,
  })
  await vi.waitFor(() => expect(screen.container.querySelector('[data-series="b"] [data-bar]')).not.toBeNull())
  const fill = screen.container.querySelector('[data-series="b"] [data-bar]')?.getAttribute('fill') ?? ''
  const id = /^url\(#(.+)\)$/.exec(fill)?.[1]
  expect(id).toBeTruthy()
  expect(screen.container.querySelector(`pattern[id="${id}"]`)).not.toBeNull()
  expect(screen.container.querySelector('[data-series="a"] [data-bar]')?.getAttribute('fill')).toBe('var(--energy-battery)')
  const swatch = screen.container.querySelector<HTMLElement>('[data-legend-item="b"] > div')
  expect(swatch?.style.backgroundImage).toContain('repeating-linear-gradient')
})

test('barLabel draws above its stack, and nothing where it returns null', async () => {
  const { screen } = await renderChart({ barLabel: (_r, i) => (i === 1 ? '43 %' : null) })
  await vi.waitFor(() => expect(screen.container.querySelectorAll('[data-bar-label]')).toHaveLength(1))
  const label = screen.container.querySelector<SVGTextElement>('[data-bar-label]')
  expect(label?.textContent).toBe('43 %')
  const top = Math.min(
    ...[...screen.container.querySelectorAll('[data-bar][data-index="1"]')].map((b) => b.getBoundingClientRect().top),
  )
  expect(label?.getBoundingClientRect().bottom).toBeLessThanOrEqual(top)
})

test('without pattern or barLabel nothing new is drawn', async () => {
  const { screen } = await renderChart({})
  await vi.waitFor(() => expect(screen.container.querySelectorAll('[data-bar]').length).toBeGreaterThan(0))
  expect(screen.container.querySelectorAll('pattern, [data-bar-label]')).toHaveLength(0)
})
```

Run: `bunx vitest run --project browser src/components/chart/BarChart.browser.test.tsx` → FAIL (no pattern / label).

- [ ] **Step 2: The token** (`src/styles/app.css`): in the `@theme inline` block after `--color-energy-car`:
  `--color-energy-loss: var(--energy-loss);`; in `:root` after `--energy-car`: `--energy-loss: #b91c1c;`; in `.dark`
  after `--energy-car`: `--energy-loss: #dc3c3c;`. Comment above the light value:
  `/* The battery's loss (step 2): red, validated with solar, grid and battery (--pairs all) in both themes; hatched in charts. */`

- [ ] **Step 3: Implement**

`barLayout.ts`, in `BarSeries`:

```ts
  /** 'hatch': 45° stripes of `color` over a 40 % tint (a second cue besides colour, e.g. the battery's loss). */
  pattern?: 'hatch'
```

`ChartParts.tsx`:

```tsx
/** A hatched swatch's CSS background: `color` stripes over a 45 % tint, at 135°. */
export const HATCH_SWATCH = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 3px, color-mix(in srgb, ${color} 45%, var(--card)) 3px 5px)`
```

and in `ChartLegend` the item type gains `pattern?: 'hatch'` and the swatch becomes
`style={item.pattern === 'hatch' ? { backgroundImage: HATCH_SWATCH(item.color) } : { backgroundColor: item.color }}`.

`BarChart.tsx`:
- `const patternId = useId()`; a series' fill is `s.pattern === 'hatch' ? \`url(#${patternId}-${s.key})\` : s.color`
  (in `common`). Inside the `<svg>` before the first `<Group>`:

```tsx
{series.some((s) => s.pattern) ? (
  <defs>
    {series
      .filter((s) => s.pattern === 'hatch')
      .map((s) => (
        <pattern
          key={s.key}
          id={`${patternId}-${s.key}`}
          width={5}
          height={5}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={5} height={5} fill={`color-mix(in srgb, ${s.color} 40%, var(--card))`} />
          <rect width={2.5} height={5} fill={s.color} />
        </pattern>
      ))}
  </defs>
) : null}
```

- `legendItems` carry `pattern: s.pattern`.
- New prop `barLabel?: (row: Row, index: number) => string | null` ("A short label above a category's stack, e.g. a
  winter loss share; null draws none."). After the series groups, inside the plot `<Group>`:

```tsx
{barLabel
  ? range(count).map((i) => {
      const text = barLabel(rows[i], i)
      const tops = geometry.rects.filter((r) => r.index === i).map((r) => r.y)
      if (text === null || tops.length === 0) return null
      return (
        <text
          key={i}
          data-bar-label
          x={geometry.centres[i]}
          y={Math.min(...tops) - 6}
          textAnchor="middle"
          fontSize={tickPx}
          fontWeight={600}
          className="fill-foreground tabular-nums"
          pointerEvents="none"
        >
          {text}
        </text>
      )
    })
  : null}
```

`barLabel` joins the geometry memo's neighbours only as a render input (no memo change). The chart's top margin
(8 px) can clip a label over the tallest bar: when `barLabel` is set, use `top: MARGIN.top + tickPx + 6` for the
plot (compute `const marginTop = barLabel ? MARGIN.top + tickPx + 6 : MARGIN.top` and use it wherever `MARGIN.top`
is read).

- [ ] **Step 4: Run** `bunx vitest run --project browser src/components/chart/ src/components/energy/ src/components/evCharging/` → PASS (the other charts unchanged).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/styles/app.css src/components/chart
git commit -m "feat(charts): add hatched series and bar labels"
```

---

### Task 4: Battery flow geometry (`batteryFlowLayout.ts`)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/houseEnergy/batteryFlowLayout.ts`, `src/lib/houseEnergy/batteryFlowLayout.test.ts`

**Interfaces:**
- Consumes: `flowEdge`, `flowCurve`, `FlowGraph`, `FlowNode`, `NodeText`, `WIDE_MIN_WIDTH`, `MIN_FLOW_KWH`,
  `lossLabel`, `NODE_PADDING`, `FIGURE_MIN_SIZE` from `./flowLayout`; `EnergyFigures` from `./figures`.
- Produces:
  - `type BatteryNodeKey = 'sol' | 'imp' | 'bat' | 'out' | 'loss'`
  - `BATTERY_WIDE_HEIGHT = 300`, `BATTERY_NARROW_HEIGHT = 430`
  - `batteryFlowLayout(width: number): FlowGraph<BatteryNodeKey>`
  - `batteryEdgeKwh(f: EnergyFigures, from: BatteryNodeKey, to: BatteryNodeKey): number`
  - `batteryDrawnFlows(layout, f): { spec: FlowEdgeSpec<BatteryNodeKey>; kwh: number }[]`
  - `batteryNodeText(node: FlowNode, key: BatteryNodeKey, narrow: boolean): NodeText`
    (`second`: Ut's "varav såld" or Förlust's share line, wide only for the share; `third`: null)

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/houseEnergy/batteryFlowLayout.test.ts
import { describe, expect, test } from 'vitest'
import {
  BATTERY_NARROW_HEIGHT,
  BATTERY_WIDE_HEIGHT,
  type BatteryNodeKey,
  batteryDrawnFlows,
  batteryEdgeKwh,
  batteryFlowLayout,
  batteryNodeText,
} from './batteryFlowLayout'
import { energyFigures, type PeriodSums } from './figures'
import { flowCurve } from './flowLayout'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561, gridExportKwh: 114, solarKwh: 509, loadKwh: 947,
  batteryDischargeKwh: 225.4, batteryChargeSolarKwh: 172.9, batteryChargeGridKwh: 67.9, carKwh: 211,
  firstSocPct: 15, lastSocPct: 20, buckets: 8603, expectedBuckets: 8640, ...over,
})
const KEYS: BatteryNodeKey[] = ['sol', 'imp', 'bat', 'out', 'loss']
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h

describe.each([324, 754, 1006])('at %i px', (width) => {
  const layout = batteryFlowLayout(width)
  test('the layout kind and height follow the 860 px rule', () => {
    expect(layout.narrow).toBe(width < 860)
    expect(layout.height).toBe(width < 860 ? BATTERY_NARROW_HEIGHT : BATTERY_WIDE_HEIGHT)
  })
  test('every node lies inside the box and no two overlap', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      expect(n.x - n.w / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w / 2, k).toBeLessThanOrEqual(width)
      expect(n.y - n.h / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h / 2, k).toBeLessThanOrEqual(layout.height)
    }
    for (const a of KEYS) for (const b of KEYS) if (a < b) expect(overlap(layout.nodes[a], layout.nodes[b]), `${a}/${b}`).toBe(false)
  })
  test('every arrow joins the battery, starts on its source edge and ends on its target edge', () => {
    expect(layout.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['bat>loss', 'bat>out', 'imp>bat', 'sol>bat'])
    for (const e of layout.edges) {
      const c = flowCurve(layout, e)
      const t = layout.nodes[e.to]
      const onEdge = Math.abs(Math.abs(c.tip.x - t.x) - t.w / 2) < 0.01 || Math.abs(Math.abs(c.tip.y - t.y) - t.h / 2) < 0.01
      expect(onEdge, `${e.from}>${e.to}`).toBe(true)
    }
  })
  test('node text stays inside its node', () => {
    for (const k of KEYS) {
      const n = layout.nodes[k]
      const t = batteryNodeText(n, k, layout.narrow)
      expect(t.value.x + 0, k).toBeGreaterThan(n.x - n.w / 2)
      expect(t.value.room, k).toBeGreaterThan(0)
      expect(t.value.y, k).toBeLessThan(n.y + n.h / 2)
      if (t.second) expect(t.second.y, k).toBeLessThan(n.y + n.h / 2)
      if (t.second) expect(t.second.y, k).toBeGreaterThan(t.value.y)
    }
  })
})

test('edge values: into the battery by origin, out, and the loss only when it reads as a value', () => {
  const f = energyFigures(sums())
  expect(batteryEdgeKwh(f, 'sol', 'bat')).toBeCloseTo(172.9, 9)
  expect(batteryEdgeKwh(f, 'imp', 'bat')).toBeCloseTo(67.9, 9)
  expect(batteryEdgeKwh(f, 'bat', 'out')).toBeCloseTo(225.4, 9)
  expect(batteryEdgeKwh(f, 'bat', 'loss')).toBeCloseTo(f.loss, 9)
  const noisy = energyFigures(sums({ batteryChargeSolarKwh: 10, batteryChargeGridKwh: 0, batteryDischargeKwh: 10.2, firstSocPct: 50, lastSocPct: 50 }))
  expect(batteryEdgeKwh(noisy, 'bat', 'loss')).toBe(0)
})

test('arrows under 0,05 kWh are not drawn', () => {
  const f = energyFigures(sums({ batteryChargeGridKwh: 0.04 }))
  const drawn = batteryDrawnFlows(batteryFlowLayout(1006), f).map((x) => `${x.spec.from}>${x.spec.to}`)
  expect(drawn).not.toContain('imp>bat')
  expect(drawn).toContain('sol>bat')
})

test('the Förlust share line is wide only; Ut keeps its line on both', () => {
  const wide = batteryFlowLayout(1006)
  const narrow = batteryFlowLayout(324)
  expect(batteryNodeText(wide.nodes.loss, 'loss', false).second).not.toBeNull()
  expect(batteryNodeText(narrow.nodes.loss, 'loss', true).second).toBeNull()
  expect(batteryNodeText(narrow.nodes.out, 'out', true).second).not.toBeNull()
})
```

Run: `bunx vitest run src/lib/houseEnergy/batteryFlowLayout.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
// src/lib/houseEnergy/batteryFlowLayout.ts
// Client-safe, pure (step 2, ADR-0024). The Batteri page's flow diagram geometry: solar and bought into the
// battery, out and the loss from it. Two nodes on each side, every arrow joining the battery, so none cross.
// Numbers from the approved mockup (battery page design, "Geometry"); built on step 1c's primitives.
import type { EnergyFigures } from './figures'
import {
  FIGURE_MIN_SIZE,
  type FlowEdgeSpec,
  type FlowGraph,
  type FlowNode,
  flowEdge,
  lossLabel,
  MIN_FLOW_KWH,
  NODE_PADDING,
  type NodeText,
  WIDE_MIN_WIDTH,
} from './flowLayout'

export type BatteryNodeKey = 'sol' | 'imp' | 'bat' | 'out' | 'loss'
export const BATTERY_WIDE_HEIGHT = 300
export const BATTERY_NARROW_HEIGHT = 430

export function batteryFlowLayout(width: number): FlowGraph<BatteryNodeKey> {
  if (width >= WIDE_MIN_WIDTH) {
    const nw = 236
    const H = BATTERY_WIDE_HEIGHT
    const L = nw / 2 + 1
    const R = width - nw / 2 - 1
    return {
      narrow: false,
      height: H,
      nodes: {
        sol: { x: L, y: 50, w: nw, h: 80 },
        imp: { x: L, y: H - 50, w: nw, h: 80 },
        bat: { x: width / 2, y: H / 2, w: 220, h: 84 },
        out: { x: R, y: 50, w: nw, h: 92 },
        loss: { x: R, y: H - 50, w: nw, h: 92 },
      },
      edges: [
        flowEdge<BatteryNodeKey>('sol', 'bat', 'r', 0, 'l', -20),
        flowEdge<BatteryNodeKey>('imp', 'bat', 'r', 0, 'l', 20),
        flowEdge<BatteryNodeKey>('bat', 'out', 'r', -20, 'l', 0),
        flowEdge<BatteryNodeKey>('bat', 'loss', 'r', 20, 'l', 0),
      ],
    }
  }
  const nw = Math.min(220, Math.floor((width - 24) / 2))
  const H = BATTERY_NARROW_HEIGHT
  // Offsets tuned at a 146 px node (as step 1c's narrow layout); they scale with it.
  const k = nw / 146
  const L = nw / 2 + 1
  const R = width - nw / 2 - 1
  return {
    narrow: true,
    height: H,
    nodes: {
      sol: { x: L, y: 43, w: nw, h: 82 },
      imp: { x: R, y: 43, w: nw, h: 82 },
      bat: { x: width / 2, y: H / 2, w: Math.min(190, nw + 30), h: 82 },
      out: { x: L, y: H - 51, w: nw, h: 98 },
      loss: { x: R, y: H - 51, w: nw, h: 98 },
    },
    edges: [
      flowEdge<BatteryNodeKey>('sol', 'bat', 'b', 20 * k, 't', -30 * k),
      flowEdge<BatteryNodeKey>('imp', 'bat', 'b', -20 * k, 't', 30 * k),
      flowEdge<BatteryNodeKey>('bat', 'out', 'b', -30 * k, 't', 20 * k),
      flowEdge<BatteryNodeKey>('bat', 'loss', 'b', 30 * k, 't', -20 * k),
    ],
  }
}

/** What each arrow carries. The loss arrow exists only when the loss reads as a value (≥ 0,5 kWh). */
export function batteryEdgeKwh(f: EnergyFigures, from: BatteryNodeKey, to: BatteryNodeKey): number {
  switch (`${from}>${to}`) {
    case 'sol>bat':
      return f.solarToBattery
    case 'imp>bat':
      // batteryIn = solar + charge_grid (+ ac): the bought part of what went in.
      return f.batteryIn - f.solarToBattery
    case 'bat>out':
      return f.batteryOut
    case 'bat>loss':
      return lossLabel(f.loss) === 'value' ? f.loss : 0
    default:
      return 0
  }
}

export function batteryDrawnFlows(layout: FlowGraph<BatteryNodeKey>, f: EnergyFigures) {
  return layout.edges
    .map((spec: FlowEdgeSpec<BatteryNodeKey>) => ({ spec, kwh: batteryEdgeKwh(f, spec.from, spec.to) }))
    .filter((x) => x.kwh >= MIN_FLOW_KWH)
}

/**
 * Where a node's tile and text go (step 1c's rules). Wide: the tile left, label and figure beside it; the battery
 * centres its two rows (label, "Lager ±") on its tile. Narrow: tile and label in the first row, the figure below.
 * `second` is Ut's "varav såld" line (both layouts) or Förlust's share line (wide only: a phone node is too narrow;
 * the share is in the tooltip and the table).
 */
export function batteryNodeText(node: FlowNode, key: BatteryNodeKey, narrow: boolean): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  const value = (x: number, y: number, size: number) => ({
    x,
    y,
    size,
    minSize: FIGURE_MIN_SIZE,
    room: x0 + node.w - NODE_PADDING - x,
  })
  const lastLine = { x: 0, y: y0 + node.h - 12 }
  if (narrow) {
    const tile = { x: x0 + 12, y: y0 + 10, size: 34, icon: 20 }
    const label = { x: tile.x + 34 + 10, y: tile.y + 22 }
    if (key === 'bat') return { tile, label, value: value(x0 + 12, y0 + 70, 18), second: null, third: null }
    return {
      tile,
      label,
      value: value(x0 + 12, y0 + 72, 24),
      second: key === 'out' ? { ...lastLine, x: x0 + 12 } : null,
      third: null,
    }
  }
  if (key === 'bat') {
    const tile = { x: x0 + 12, y: y0 + (node.h - 48) / 2, size: 48, icon: 28 }
    const tx = tile.x + 48 + 12
    // Two rows centred on the tile (step 1c's battery without its third line).
    return { tile, label: { x: tx, y: y0 + 34.5 }, value: value(tx, y0 + 59.5, 20), second: null, third: null }
  }
  const tile = { x: x0 + 12, y: y0 + 16, size: 48, icon: 28 }
  const tx = tile.x + 48 + 12
  return {
    tile,
    label: { x: tx, y: tile.y + 14 },
    value: value(tx, tile.y + 44, 28),
    second: key === 'out' || key === 'loss' ? { ...lastLine, x: tx } : null,
    third: null,
  }
}
```

- [ ] **Step 3: Run** `bunx vitest run src/lib/houseEnergy/batteryFlowLayout.test.ts` → PASS. If a geometry case
  fails, fix the numbers (not the test) and record the change in the spec's "Geometry" table.

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/lib/houseEnergy/batteryFlowLayout.ts src/lib/houseEnergy/batteryFlowLayout.test.ts
git commit -m "feat(energy): lay out the battery flow diagram"
```

---

### Task 5: The battery Summering (`BatteryFlowDiagram`, `BatteryFlow`) + every step-2 message

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/energy/BatteryFlowDiagram.tsx`, `src/components/energy/BatteryFlow.tsx`,
  `src/components/energy/BatteryFlow.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (this task's keys and Tasks 6–7's, all at once)

**Interfaces:**
- Consumes: Task 2's `flowParts` (`NodeFrame`, `ValuePill`, `useFittedSize`, `NODE_MUTED`, `RingFigure`,
  `FlowValuesSwitch`, `FlowTableFrame`), `SHOW_FLOW_VALUES_KEY` (`EnergyFlow.tsx`), Task 4's layout,
  `useLocalStorageFlag`, `ChartPopover` / `useChartPopover`, `energyFigures`, `gapHours`, `WINTER_LOSS_SHARE`,
  `lossLabel`, `flowCurve`, `arrowHead`, `flowWidth`, `formatOneDecimal`, `formatShare`, `formatSignedOneDecimal`.
- Produces: `BatteryFlow({ sums }: { sums: PeriodSums | null | 'unavailable' })`; `efficiencyText(e: number | null): string`
  (exported from `BatteryFlow.tsx`, reused by Task 6).

- [ ] **Step 1: Add every step-2 message**

`messages/sv.json` (append):

```json
  "nav_energy_overview": "Översikt",
  "nav_energy_battery": "Batteri",
  "nav_energy_battery_long": "Hemmabatteri",
  "cmd_kw_energy_battery": "batteri hemmabatteri förlust verkningsgrad laddning urladdning lager vinter emaldo",
  "meta_energy_battery_title": "Hemmabatteri",
  "meta_energy_battery_description": "Vad hemmabatteriet laddade in, gav tillbaka och förlorade.",
  "energy_battery_title": "Hemmabatteri",
  "energy_battery_description": "Vad hemmabatteriet laddade in, gav tillbaka och förlorade, från Emaldo. Datan synkas varje timme.",
  "energy_battery_efficiency": "Verkningsgrad",
  "energy_battery_efficiency_detail": "av det som laddades in kom ut igen, rättat för lagret",
  "energy_battery_node_out": "Ut",
  "energy_battery_stored_label": "Lager",
  "energy_battery_out_sold": "varav såld {kwh} kWh",
  "energy_battery_out_house": "till huset",
  "energy_battery_out_split": "{house} kWh till huset · {sold} kWh såld",
  "energy_battery_in_share": "{share} av det som laddades in",
  "energy_battery_flow_description": "Batteriets energiflöden för perioden. Värdena finns också i tabellen under diagrammet.",
  "energy_battery_row_in_solar": "In från sol",
  "energy_battery_row_in_grid": "In från nätet",
  "energy_battery_row_in_total": "In totalt",
  "energy_battery_row_sold": "varav såld",
  "energy_battery_chart_title": "Batteriet per månad {year}",
  "energy_battery_series_out": "Ut",
  "energy_battery_series_loss": "Förlust",
  "energy_battery_tooltip_in": "In",
  "energy_battery_tooltip_from_solar": "från sol",
  "energy_battery_tooltip_from_grid": "från nätet",
  "energy_battery_chart_hint": "Stapeln är det som gick genom batteriet: grönt kom ut igen, rött förlorades. Klicka på en månad för att se den i summeringen.",
  "energy_battery_note": "Vintertid förloras mer: batteriet värmer sig självt och drar ström i vila när det är kallt. Förlusten räknas som in − ut − ändrat lager, med {capacity} kWh per 100 % laddnivå."
```

`messages/en.json` (append):

```json
  "nav_energy_overview": "Overview",
  "nav_energy_battery": "Battery",
  "nav_energy_battery_long": "Home battery",
  "cmd_kw_energy_battery": "battery home battery loss efficiency charge discharge stored winter emaldo",
  "meta_energy_battery_title": "Home battery",
  "meta_energy_battery_description": "What the home battery took in, gave back and lost.",
  "energy_battery_title": "Home battery",
  "energy_battery_description": "What the home battery took in, gave back and lost, from Emaldo. The data syncs every hour.",
  "energy_battery_efficiency": "Efficiency",
  "energy_battery_efficiency_detail": "of what went in came back out, corrected for stored energy",
  "energy_battery_node_out": "Out",
  "energy_battery_stored_label": "Stored",
  "energy_battery_out_sold": "of which sold {kwh} kWh",
  "energy_battery_out_house": "to the house",
  "energy_battery_out_split": "{house} kWh to the house · {sold} kWh sold",
  "energy_battery_in_share": "{share} of what went in",
  "energy_battery_flow_description": "The battery's energy flows for the period. The values are also in the table below the diagram.",
  "energy_battery_row_in_solar": "In from solar",
  "energy_battery_row_in_grid": "In from the grid",
  "energy_battery_row_in_total": "In, total",
  "energy_battery_row_sold": "of which sold",
  "energy_battery_chart_title": "The battery by month {year}",
  "energy_battery_series_out": "Out",
  "energy_battery_series_loss": "Loss",
  "energy_battery_tooltip_in": "In",
  "energy_battery_tooltip_from_solar": "from solar",
  "energy_battery_tooltip_from_grid": "from the grid",
  "energy_battery_chart_hint": "Each bar is what passed through the battery: green came back out, red was lost. Click a month to see it in the summary.",
  "energy_battery_note": "More is lost in winter: the battery heats itself and draws power while idle when it is cold. Loss is in − out − change in stored energy, at {capacity} kWh per 100 % charge."
```

Run `bun run i18n:compile` and the sv/en key check from the pre-PR gate → "sv/en keys match".

- [ ] **Step 2: Write the failing tests**

```tsx
// src/components/energy/BatteryFlow.browser.test.tsx
import { beforeEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { BatteryFlow } from './BatteryFlow'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'

// September 2026 on prod: in 172,9 + 67,9, out 225,4, SoC 15 → 20 (Δ +0,379), loss 15,0, efficiency 94 %.
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561, gridExportKwh: 114, solarKwh: 509, loadKwh: 947,
  batteryDischargeKwh: 225.4, batteryChargeSolarKwh: 172.9, batteryChargeGridKwh: 67.9, carKwh: 211,
  firstSocPct: 15, lastSocPct: 20, buckets: 8640, expectedBuckets: 8640, ...over,
})
const node = (key: string) => document.querySelector(`[data-flow-node="${key}"]`)?.textContent ?? ''
const edges = () => [...document.querySelectorAll('[data-flow-edge]')].map((e) => e.getAttribute('data-flow-edge'))

beforeEach(async () => {
  localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
  await page.viewport(1440, 900)
})

test('the five nodes, the efficiency and the four arrows', async () => {
  const { screen } = await renderWithProviders(<div style={{ width: 1100 }}><BatteryFlow sums={sums()} /></div>)
  await vi.waitFor(() => expect(edges()).toHaveLength(4))
  expect(node('sol')).toContain('172,9')
  expect(node('imp')).toContain('67,9')
  expect(node('bat')).toMatch(/Lager \+0,4/)
  expect(node('out')).toContain('225,4')
  expect(node('loss')).toContain('15,0')
  expect(node('loss')).toMatch(/6\s% av det som laddades in/)
  await expect.element(screen.getByText(/^94\s%$/)).toBeVisible()
  expect(edges().sort()).toEqual(['bat>loss', 'bat>out', 'imp>bat', 'sol>bat'])
})

test('a small or negative loss reads ≈ 0 kWh, with no loss arrow and no share', async () => {
  await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums({ batteryChargeSolarKwh: 10, batteryChargeGridKwh: 0, batteryDischargeKwh: 10.2, firstSocPct: 50, lastSocPct: 50 })} />
    </div>,
  )
  await vi.waitFor(() => expect(edges()).toContain('bat>out'))
  expect(node('loss')).toContain('≈ 0')
  expect(node('loss')).not.toContain('av det som laddades in')
  expect(edges()).not.toContain('bat>loss')
})

test('a battery that barely ran: "—", an empty ring, no shares', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums({ batteryChargeSolarKwh: 0.4, batteryChargeGridKwh: 0.2, batteryDischargeKwh: 0.1, firstSocPct: 50, lastSocPct: 50 })} />
    </div>,
  )
  await expect.element(screen.getByText(m.energy_battery_efficiency())).toBeVisible()
  expect(screen.container.querySelector('[data-slot="ring-figure"]')?.textContent).toContain('—')
  expect(screen.container.querySelector('[data-slot="ring-arc"]')).toBeNull()
  expect(screen.container.textContent).not.toContain('av det som laddades in')
})

test('a battery sale adds "varav såld" to Ut and to the table', async () => {
  // Export beyond the solar surplus: 509 − 172,9 = 336,1 < 400 → 63,9 kWh from the battery.
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}><BatteryFlow sums={sums({ gridExportKwh: 400 })} /></div>,
  )
  await vi.waitFor(() => expect(node('out')).toContain('varav såld 63,9 kWh'))
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  await expect.element(screen.getByRole('rowheader', { name: m.energy_battery_row_sold() })).toBeVisible()
})

test('no sale: no "varav såld", the table has the battery rows with units', async () => {
  const { screen } = await renderWithProviders(<div style={{ width: 1100 }}><BatteryFlow sums={sums()} /></div>)
  await vi.waitFor(() => expect(edges()).toHaveLength(4))
  expect(node('out')).not.toContain('varav såld')
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  for (const name of [
    m.energy_battery_row_in_solar(), m.energy_battery_row_in_grid(), m.energy_battery_row_in_total(),
    m.energy_flow_row_stored(), m.energy_battery_node_out(), m.energy_flow_loss_title(), m.energy_battery_efficiency(),
  ]) {
    await expect.element(screen.getByRole('rowheader', { name, exact: true })).toBeVisible()
  }
  await expect.element(screen.getByRole('cell', { name: '+0,4 kWh' })).toBeVisible()
})

test('the values switch hides the pills and is the same preference as Översikt', async () => {
  const { screen } = await renderWithProviders(<div style={{ width: 1100 }}><BatteryFlow sums={sums()} /></div>)
  await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(4))
  await userEvent.click(screen.getByRole('switch', { name: m.energy_flow_show_values() }))
  expect(document.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  expect(localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('false')
})

test('no data and unavailable', async () => {
  const none = await renderWithProviders(<BatteryFlow sums={null} />)
  await expect.element(none.screen.getByText(m.energy_period_no_data())).toBeVisible()
  none.screen.unmount()
  const unavailable = await renderWithProviders(<BatteryFlow sums="unavailable" />)
  expect(unavailable.screen.container.querySelector('[data-flow-node]')).toBeNull()
  expect(unavailable.screen.container.textContent).not.toContain(m.energy_period_no_data())
})
```

(Check `useLocalStorageFlag`'s stored format in `src/hooks/useLocalStorageFlag.ts` and match the `'false'`
assertion to it.)

Run: `bunx vitest run --project browser src/components/energy/BatteryFlow.browser.test.tsx` → FAIL (module).

- [ ] **Step 3: Implement `BatteryFlowDiagram.tsx`**

```tsx
// src/components/energy/BatteryFlowDiagram.tsx
import { Group } from '@visx/group'
import {
  BatteryMediumIcon,
  FlameIcon,
  HouseIcon,
  type LucideIcon,
  SolarPanelIcon,
  UtilityPoleIcon,
} from 'lucide-react'
import type * as React from 'react'
import { useRef } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatOneDecimal, formatShare, formatSignedOneDecimal } from '~/components/evCharging/format'
import {
  type BatteryNodeKey,
  batteryDrawnFlows,
  batteryFlowLayout,
  batteryNodeText,
} from '~/lib/houseEnergy/batteryFlowLayout'
import { type EnergyFigures, type PeriodSums, WINTER_LOSS_SHARE } from '~/lib/houseEnergy/figures'
import { arrowHead, flowCurve, flowWidth, lossLabel, MIN_FLOW_KWH } from '~/lib/houseEnergy/flowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { NODE_MUTED, NodeFrame, useFittedSize, ValuePill } from './flowParts'

// The Batteri page's Summering diagram (step 2): what went into the battery (by origin), what came out and what
// was lost. Geometry in batteryFlowLayout.ts. Colour = where the energy came from; the loss is red.
const COLOR: Record<BatteryNodeKey, string | undefined> = {
  sol: 'var(--energy-solar)',
  imp: 'var(--energy-grid)',
  bat: 'var(--energy-battery)',
  out: undefined,
  loss: 'var(--energy-loss)',
}
const ICON: Record<BatteryNodeKey, LucideIcon> = {
  sol: SolarPanelIcon,
  imp: UtilityPoleIcon,
  bat: BatteryMediumIcon,
  out: HouseIcon,
  loss: FlameIcon,
}
const label = (key: BatteryNodeKey) =>
  ({
    sol: m.energy_tile_solar(),
    imp: m.energy_tile_import(),
    bat: m.energy_flow_battery(),
    out: m.energy_battery_node_out(),
    loss: m.energy_flow_loss(),
  })[key]
const kwh = (v: number) => formatOneDecimal(v)
const arrowColor = (from: BatteryNodeKey, to: BatteryNodeKey) => (to === 'loss' ? COLOR.loss : COLOR[from])

type Tip = { id: string; from: BatteryNodeKey; to: BatteryNodeKey; kwh: number; lines: string[] }

function tipLines(f: EnergyFigures, sums: PeriodSums, from: BatteryNodeKey, to: BatteryNodeKey, v: number) {
  if (to === 'bat')
    return f.batteryIn > 0 ? [m.energy_battery_in_share({ share: formatShare(v / f.batteryIn) })] : []
  if (to === 'out')
    return [
      f.batteryToGrid >= MIN_FLOW_KWH
        ? m.energy_battery_out_split({ house: kwh(f.batteryToHouse), sold: kwh(f.batteryToGrid) })
        : m.energy_battery_out_house(),
    ]
  const lines: string[] = []
  if (f.lossShare !== null) lines.push(m.energy_flow_loss_share({ share: formatShare(f.lossShare) }))
  if (sums.firstSocPct !== null && sums.lastSocPct !== null)
    lines.push(
      m.energy_flow_charge_level({
        from: String(Math.round(sums.firstSocPct)),
        to: String(Math.round(sums.lastSocPct)),
      }),
    )
  if (f.lossShare !== null && f.lossShare > WINTER_LOSS_SHARE) lines.push(m.energy_flow_winter_hint())
  return lines
}

export function BatteryFlowDiagram({
  sums,
  figures: f,
  width,
  showValues,
}: {
  sums: PeriodSums
  figures: EnergyFigures
  width: number
  showValues: boolean
}) {
  const layout = batteryFlowLayout(width)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps, hide } = popover
  const leaveProps = {
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') hide()
    },
  }
  const flows = batteryDrawnFlows(layout, f)
  const max = Math.max(0, ...flows.map((x) => x.kwh))
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)
  const fade = 'transition-opacity motion-reduce:transition-none'

  return (
    <div {...containerProps} className="relative">
      <svg
        width={width}
        height={layout.height}
        role="img"
        aria-label={m.energy_battery_flow_description()}
        className="block overflow-visible"
      >
        <Group>
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const w = flowWidth(v, max, layout.narrow)
            const color = arrowColor(spec.from, spec.to)
            return (
              <g key={id} data-flow-edge={id} className={cn(fade, dim(id))}>
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as BatteryNodeKey[]).map((key) => (
            <BatteryNode key={key} nodeKey={key} layout={layout} f={f} />
          ))}
        </Group>
        <Group>
          {showValues
            ? flows.map(({ spec, kwh: v }) => {
                const id = `${spec.from}>${spec.to}`
                const p = flowCurve(layout, spec).at(spec.labelT)
                return <ValuePill key={id} x={p.x} y={p.y} text={kwh(v)} className={cn(fade, dim(id))} />
              })
            : null}
          {flows.map(({ spec, kwh: v }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            return (
              <path
                key={id}
                data-flow-hit={id}
                d={c.d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(22, flowWidth(v, max, layout.narrow))}
                pointerEvents="stroke"
                className="cursor-pointer"
                {...markProps(
                  { id, from: spec.from, to: spec.to, kwh: v, lines: tipLines(f, sums, spec.from, spec.to, v) },
                  mid.x,
                  mid.y,
                )}
                {...leaveProps}
              />
            )
          })}
        </Group>
      </svg>
      <ChartPopover
        state={popover}
        dataKey={popover.data?.id}
        placement="above"
        className="flex min-w-48 flex-col gap-0.5 whitespace-normal rounded-lg border bg-card px-3 py-2 text-card-foreground text-sm shadow-lg"
      >
        {popover.data ? (
          <>
            <span className="flex items-center gap-2 font-semibold">
              <span
                aria-hidden
                className="size-2.5 rounded-xs"
                style={{ background: arrowColor(popover.data.from, popover.data.to) }}
              />
              {m.energy_flow_arrow({ from: label(popover.data.from), to: label(popover.data.to) })}
            </span>
            <span className="font-semibold text-base tabular-nums">{kwh(popover.data.kwh)} kWh</span>
            {popover.data.lines.map((line) => (
              <span key={line} className="max-w-64 text-muted-foreground">
                {line}
              </span>
            ))}
          </>
        ) : null}
      </ChartPopover>
    </div>
  )
}

function BatteryNode({
  nodeKey: key,
  layout,
  f,
}: {
  nodeKey: BatteryNodeKey
  layout: ReturnType<typeof batteryFlowLayout>
  f: EnergyFigures
}) {
  const n = layout.nodes[key]
  const t = batteryNodeText(n, key, layout.narrow)
  const value =
    key === 'bat'
      ? formatSignedOneDecimal(f.deltaStored)
      : key === 'loss'
        ? lossLabel(f.loss) === 'about-zero'
          ? m.energy_flow_about_zero()
          : kwh(f.loss)
        : kwh({ sol: f.solarToBattery, imp: f.batteryIn - f.solarToBattery, out: f.batteryOut }[key])
  const valueRef = useRef<SVGTextElement>(null)
  const size = useFittedSize(valueRef, value, t.value)
  // Ut: "varav såld" only with a sale; Förlust: its share only when it reads as a value. The line's room is
  // part of the node either way, so nothing moves.
  const second =
    key === 'out' && f.batteryToGrid >= MIN_FLOW_KWH
      ? m.energy_battery_out_sold({ kwh: kwh(f.batteryToGrid) })
      : key === 'loss' && lossLabel(f.loss) === 'value' && f.lossShare !== null
        ? m.energy_flow_loss_share({ share: formatShare(f.lossShare) })
        : null
  return (
    <NodeFrame
      data-flow-node={key}
      node={n}
      tile={t.tile}
      label={t.label}
      labelText={label(key)}
      Icon={ICON[key]}
      tint={COLOR[key]}
    >
      {key === 'bat' ? (
        <text ref={valueRef} x={t.value.x} y={t.value.y} fontSize={14} style={NODE_MUTED}>
          {m.energy_battery_stored_label()}{' '}
          <tspan fontSize={size} fontWeight={600} className="fill-foreground tabular-nums">
            {value}
          </tspan>{' '}
          kWh
        </text>
      ) : (
        <text
          ref={valueRef}
          x={t.value.x}
          y={t.value.y}
          fontSize={size}
          fontWeight={600}
          className="fill-foreground tabular-nums"
        >
          {value}{' '}
          <tspan fontSize={14} fontWeight={400} style={NODE_MUTED}>
            kWh
          </tspan>
        </text>
      )}
      {t.second && second ? (
        <text x={t.second.x} y={t.second.y} fontSize={13} style={NODE_MUTED} className="tabular-nums">
          {second}
        </text>
      ) : null}
    </NodeFrame>
  )
}
```

The battery node needs the word "Lager" alone (`energy_battery_stored_label`): step 1c's `energy_flow_stored`
("Lager {kwh} kWh") is one string and can't size its figure separately.

- [ ] **Step 4: Implement `BatteryFlow.tsx`**

```tsx
// src/components/energy/BatteryFlow.tsx
import { useParentSize } from '@visx/responsive'
import { formatOneDecimal, formatShare, formatSignedOneDecimal } from '~/components/evCharging/format'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import { type EnergyFigures, energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { MIN_FLOW_KWH } from '~/lib/houseEnergy/flowLayout'
import { m } from '~/paraglide/messages'
import { BatteryFlowDiagram } from './BatteryFlowDiagram'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { FlowTableFrame, FlowValuesSwitch, RingFigure } from './flowParts'

/** "—" without a value, "≈ 100 %" when capped at 1, else the share. */
export function efficiencyText(e: number | null): string {
  if (e === null) return '—'
  return e >= 1 ? `≈ ${formatShare(1)}` : formatShare(e)
}

// The Batteri page's Summering card body (step 2, battery page design): Verkningsgrad, the battery flow in a box
// whose height is reserved per layout by a container query (content 860 px wide → 300 px, else 430 px), the values
// switch (Översikt's preference), the gap note and the table.
export function BatteryFlow({ sums }: { sums: PeriodSums | null | 'unavailable' }) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const gap = f ? gapHours(f) : null
  return (
    <div className="@container flex flex-col gap-3">
      <RingFigure
        value={f?.efficiency ?? null}
        label={m.energy_battery_efficiency()}
        detail={m.energy_battery_efficiency_detail()}
        valueText={efficiencyText(f?.efficiency ?? null)}
        arcClassName="stroke-energy-battery"
        hidden={!f}
      />
      <div
        ref={parentRef}
        data-slot="energy-flow-box"
        className="relative h-[430px] w-full @[860px]:h-[300px]"
      >
        {s && f && width > 0 ? (
          <BatteryFlowDiagram sums={s} figures={f} width={width} showValues={showValues} />
        ) : null}
        {sums === null ? (
          <p className="absolute top-0 left-0 text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
        ) : null}
      </div>
      <FlowValuesSwitch checked={showValues} onCheckedChange={setShowValues} hint={m.energy_flow_hint()} />
      <p data-slot="energy-gap" className="min-h-[1.5em] text-muted-foreground text-sm leading-normal">
        {gap === null ? null : m.energy_missing_hours({ hours: String(gap) })}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {m.energy_flow_table_toggle()}
        </summary>
        {f ? <BatteryTable f={f} /> : null}
      </details>
    </div>
  )
}

function BatteryTable({ f }: { f: EnergyFigures }) {
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  const rows: [string, string][] = [
    [m.energy_battery_row_in_solar(), kwh(f.solarToBattery)],
    [m.energy_battery_row_in_grid(), kwh(f.batteryIn - f.solarToBattery)],
    [m.energy_battery_row_in_total(), kwh(f.batteryIn)],
    [m.energy_flow_row_stored(), `${formatSignedOneDecimal(f.deltaStored)} kWh`],
    [m.energy_battery_node_out(), kwh(f.batteryOut)],
    ...(f.batteryToGrid >= MIN_FLOW_KWH
      ? ([[m.energy_battery_row_sold(), kwh(f.batteryToGrid)]] as [string, string][])
      : []),
    // The real value, also when the diagram says "≈ 0".
    [m.energy_flow_loss_title(), kwh(f.loss)],
    [m.energy_battery_efficiency(), efficiencyText(f.efficiency)],
  ]
  return <FlowTableFrame rows={rows} />
}
```


- [ ] **Step 5: Run** `bunx vitest run --project browser src/components/energy/` → PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add messages src/components/energy/BatteryFlowDiagram.tsx src/components/energy/BatteryFlow.tsx \
  src/components/energy/BatteryFlow.browser.test.tsx src/components/energy/flowParts.tsx
git commit -m "feat(energy): draw the battery's period as a flow diagram"
```

---

### Task 6: The month chart (`batteryChart.ts`, `BatteryMonthlyChart`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/energy/batteryChart.ts`, `src/components/energy/batteryChart.test.ts`,
  `src/components/energy/BatteryMonthlyChart.tsx`, `src/components/energy/BatteryMonthlyChart.browser.test.tsx`

**Interfaces:**
- Consumes: Task 3's `BarChart` (`pattern`, `barLabel`), `HATCH_SWATCH`; `CHART_HEIGHT`, `TooltipRow`
  (`~/components/chart/ChartParts`); `efficiencyText` (Task 5); `monthLabel`, `monthName`, `formatCount`,
  `formatOneDecimal`, `formatShare`, `formatSignedOneDecimal`.
- Produces:
  - `type BatteryChartRow = { month: number; sums: PeriodSums | null; out: number | null; loss: number | null; label: string | null }`
  - `batteryChartRows(months: (PeriodSums | null)[]): BatteryChartRow[]`
  - `BatteryMonthlyChart({ year, months, currentMonth, selectedMonth, onSelectMonth })` (EnergyMonthlyChart's props without `metric`)

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/energy/batteryChart.test.ts
import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { batteryChartRows } from './batteryChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 0, gridExportKwh: 0, solarKwh: 0, loadKwh: 0,
  batteryDischargeKwh: 157, batteryChargeSolarKwh: 25.6, batteryChargeGridKwh: 248.9, carKwh: 0,
  firstSocPct: 34, lastSocPct: 23, buckets: 1, expectedBuckets: 1, ...over,
})

test('a month: out, the loss stacked on it, and a label only above the winter share', () => {
  const [feb, jun] = batteryChartRows([
    sums(), // February on prod: loss 118,3 of 275,3 → 43 %
    sums({ batteryDischargeKwh: 186.8, batteryChargeSolarKwh: 187.5, batteryChargeGridKwh: 9.8, firstSocPct: 80, lastSocPct: 90 }),
  ])
  expect(feb.out).toBe(157)
  expect(feb.loss).toBeCloseTo(274.5 - 157 + 0.11 * 7.58, 9)
  expect(feb.label).toMatch(/^43\s%$/)
  expect(jun.loss).toBeGreaterThan(0)
  expect(jun.label).toBeNull()
})

test('no readings: no bar; a negative loss draws only out', () => {
  const [none, noisy] = batteryChartRows([
    null,
    sums({ batteryChargeSolarKwh: 10, batteryChargeGridKwh: 0, batteryDischargeKwh: 10.2, firstSocPct: 50, lastSocPct: 50 }),
  ])
  expect(none).toMatchObject({ out: null, loss: null, label: null })
  expect(noisy.out).toBeCloseTo(10.2, 9)
  expect(noisy.loss).toBeNull()
  expect(noisy.label).toBeNull()
})
```

```tsx
// src/components/energy/BatteryMonthlyChart.browser.test.tsx
import { expect, test, vi } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { bars, clickOn, legendText } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { BatteryMonthlyChart } from './BatteryMonthlyChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500, gridExportKwh: 100, solarKwh: 400, loadKwh: 800,
  batteryDischargeKwh: 186.8, batteryChargeSolarKwh: 187.5, batteryChargeGridKwh: 9.8, carKwh: 0,
  firstSocPct: 80, lastSocPct: 90, buckets: 100, expectedBuckets: 100, ...over,
})
const feb = sums({ batteryDischargeKwh: 157, batteryChargeSolarKwh: 25.6, batteryChargeGridKwh: 248.9, firstSocPct: 34, lastSocPct: 23 })
// Jan none; Feb winter; Mar–Sep summer-like; Oct–Dec none.
const months = Array.from({ length: 12 }, (_, i) => (i === 0 || i > 8 ? null : i === 1 ? feb : sums()))
const render = (data = months, onSelectMonth = vi.fn()) =>
  renderWithProviders(
    <div style={{ width: 720, height: 360 }}>
      <BatteryMonthlyChart year={2026} months={data} currentMonth={null} selectedMonth={null} onSelectMonth={onSelectMonth} />
    </div>,
  )

test('out and loss per month with readings; the loss is hatched; one winter label', async () => {
  const { screen } = await render()
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(16)) // 8 months × (out + loss)
  expect(screen.container.querySelector('[data-series="loss"] [data-bar]')?.getAttribute('fill')).toMatch(/^url\(#/)
  const labels = [...screen.container.querySelectorAll('[data-bar-label]')].map((l) => l.textContent)
  expect(labels).toHaveLength(1)
  expect(labels[0]).toMatch(/^43\s%$/)
  expect(legendText(screen.container)).toEqual([m.energy_battery_series_out(), m.energy_battery_series_loss()])
})

test('clicking a month with readings selects it', async () => {
  const onSelectMonth = vi.fn()
  const { screen } = await render(months, onSelectMonth)
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  await clickOn(screen.container, 1)
  expect(onSelectMonth).toHaveBeenCalledWith(2)
})

test('no data in the year: the no-data state', async () => {
  const { screen } = await render(Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
})
```

(Check `clickOn` / `legendText` signatures in `test/browser/chartDom.ts` and match them; they are what
`EnergyMonthlyChart.browser.test.tsx` uses.)

Run both → FAIL (modules).

- [ ] **Step 2: Implement `batteryChart.ts`**

```ts
// src/components/energy/batteryChart.ts
// Pure: the Batteri month chart's rows (battery page design, "The month chart"). Each bar is what passed through
// the battery (in − ändrat lager): out at the bottom, the loss on top, so the green share is the efficiency.
import { formatShare } from '~/components/evCharging/format'
import { energyFigures, type PeriodSums, WINTER_LOSS_SHARE } from '~/lib/houseEnergy/figures'

export type BatteryChartRow = {
  month: number
  sums: PeriodSums | null
  out: number | null
  /** max(0, loss); null when there is none to draw. */
  loss: number | null
  /** The loss share above a winter month's bar, else null. */
  label: string | null
}

export function batteryChartRows(months: (PeriodSums | null)[]): BatteryChartRow[] {
  return months.map((sums, i) => {
    if (!sums) return { month: i + 1, sums, out: null, loss: null, label: null }
    const f = energyFigures(sums)
    return {
      month: i + 1,
      sums,
      out: f.batteryOut,
      loss: f.loss > 0 ? f.loss : null,
      label: f.lossShare !== null && f.lossShare > WINTER_LOSS_SHARE ? formatShare(f.lossShare) : null,
    }
  })
}
```

- [ ] **Step 3: Implement `BatteryMonthlyChart.tsx`**

```tsx
// src/components/energy/BatteryMonthlyChart.tsx
import { useMemo } from 'react'
import { BarChart, type BarSeries } from '~/components/chart/BarChart'
import { CHART_HEIGHT, HATCH_SWATCH, TooltipRow } from '~/components/chart/ChartParts'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  formatSignedOneDecimal,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { efficiencyText } from './BatteryFlow'
import { type BatteryChartRow, batteryChartRows } from './batteryChart'

const monthCategory = (r: BatteryChartRow) => monthLabel(r.month)
const monthInitial = (r: BatteryChartRow) => monthLabel(r.month).charAt(0).toUpperCase()
const seriesValue = (r: BatteryChartRow, key: string) => (key === 'out' ? r.out : r.loss)
const barLabel = (r: BatteryChartRow) => r.label

// The battery per month of `year` (step 2): out with the loss stacked on top, a share label above winter months,
// a legend, a tooltip with in by origin, the change in stored energy, out, the loss and the efficiency. Clicking a
// month (or Enter on the keyboard-focused one) selects it. Months without readings draw no bar.
export function BatteryMonthlyChart({
  year,
  months,
  currentMonth,
  selectedMonth,
  onSelectMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  currentMonth: number | null
  selectedMonth: number | null
  onSelectMonth: (month: number) => void
}) {
  const series = useMemo<BarSeries[]>(
    () => [
      { key: 'out', label: m.energy_battery_series_out(), color: 'var(--energy-battery)', stack: 'kwh', stroke: 'var(--card)', strokeWidth: 2 },
      { key: 'loss', label: m.energy_battery_series_loss(), color: 'var(--energy-loss)', stack: 'kwh', pattern: 'hatch', radius: 2, roundEndOnly: true, stroke: 'var(--card)', strokeWidth: 2 },
    ],
    [],
  )
  const rows = useMemo(() => batteryChartRows(months), [months])
  if (months.every((p) => p === null)) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {m.energy_chart_no_data({ year: String(year) })}
        </div>
        <p aria-hidden className="invisible mt-2 text-muted-foreground text-sm">
          {m.energy_battery_chart_hint()}
        </p>
      </div>
    )
  }
  return (
    <div>
      <BarChart
        rows={rows}
        category={monthCategory}
        shortCategory={monthInitial}
        series={series}
        value={seriesValue}
        yTickFormat={formatCount}
        yIntegers
        tickPx={13}
        minBarPx={0}
        legend
        legendClassName="text-sm"
        barLabel={barLabel}
        tooltipTitle={false}
        tooltipClassName="min-w-56 gap-1 border-border px-3 py-2 text-sm [&>div]:gap-1"
        tooltip={(r) => (r.sums ? <BatteryTooltip row={r} sums={r.sums} currentMonth={currentMonth} /> : null)}
        label={m.energy_battery_chart_title({ year: String(year) })}
        keyboardHint={m.energy_chart_keyboard_hint()}
        selection={{
          selected: selectedMonth === null ? null : selectedMonth - 1,
          onSelect: (i) => onSelectMonth(rows[i].month),
          canSelect: (r) => r.sums !== null,
        }}
      />
      <p className="mt-2 text-muted-foreground text-sm">{m.energy_battery_chart_hint()}</p>
    </div>
  )
}

function BatteryTooltip({
  row,
  sums,
  currentMonth,
}: {
  row: BatteryChartRow
  sums: PeriodSums
  currentMonth: number | null
}) {
  const f = energyFigures(sums)
  const gap = gapHours(f)
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  return (
    <>
      <div className="font-semibold text-sm">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      <TooltipRow label={m.energy_battery_tooltip_in()} strong share="">
        {kwh(f.batteryIn)}
      </TooltipRow>
      <TooltipRow label={m.energy_battery_tooltip_from_solar()} color="var(--energy-solar)" share="">
        {kwh(f.solarToBattery)}
      </TooltipRow>
      <TooltipRow label={m.energy_battery_tooltip_from_grid()} color="var(--energy-grid)" share="">
        {kwh(f.batteryIn - f.solarToBattery)}
      </TooltipRow>
      <TooltipRow label={m.energy_flow_row_stored()} share="">
        {formatSignedOneDecimal(f.deltaStored)} kWh
      </TooltipRow>
      <TooltipRow label={m.energy_battery_series_out()} color="var(--energy-battery)" strong share="">
        {kwh(f.batteryOut)}
      </TooltipRow>
      <TooltipRow
        label={m.energy_battery_series_loss()}
        color={HATCH_SWATCH('var(--energy-loss)')}
        strong
        share={f.lossShare === null ? '' : formatShare(Math.max(0, f.lossShare))}
      >
        {kwh(f.loss)}
      </TooltipRow>
      <TooltipRow label={m.energy_battery_efficiency()} share="">
        {efficiencyText(f.efficiency)}
      </TooltipRow>
      {gap === null ? null : (
        <span className="text-muted-foreground">{m.energy_missing_hours({ hours: String(gap) })}</span>
      )}
    </>
  )
}
```

`TooltipRow`'s `color` sets a swatch's `background`; check `ChartParts.tsx`: if it sets `backgroundColor`, change
that one line to `background` so a gradient works (the other charts pass plain colours, unchanged).

- [ ] **Step 4: Run** `bunx vitest run src/components/energy/batteryChart.test.ts && bunx vitest run --project browser src/components/energy/BatteryMonthlyChart.browser.test.tsx src/components/chart/` → PASS.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/batteryChart.ts src/components/energy/batteryChart.test.ts \
  src/components/energy/BatteryMonthlyChart.tsx src/components/energy/BatteryMonthlyChart.browser.test.tsx \
  src/components/chart/ChartParts.tsx
git commit -m "feat(energy): chart the battery's loss per month"
```

---

### Task 7: The Batteri page, sidebar sub-items, palette, skeletons

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/routes/_authenticated/energy/battery.tsx`, `src/bones/energy-battery-flow.bones.json`,
  `src/bones/energy-battery-chart.bones.json` (generated)
- Modify: `src/components/energy/EnergyHeading.tsx`, `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`,
  `src/components/AppSidebar.tsx`, `src/components/AppSidebar.browser.test.tsx`,
  `src/components/command/commands.ts`, `src/lib/houseEnergy/clientSafe.browser.test.tsx`,
  `scripts/captureBones.ts`, `src/routeTree.gen.ts` (regenerated)

- [ ] **Step 1: Write the failing tests**

In `-energyPage.browser.test.tsx`: `import { Route as Battery } from './battery'`; replace the comment and type with
`type AnyRoute = typeof Overview | typeof Battery`; add:

```tsx
test('Batteri: heading, the Summering card with its period control, the chart, the winter note naming C', async () => {
  const { screen } = await renderPage(Battery, '/energy/battery', seedOverview(withData))
  await expect.element(screen.getByRole('heading', { level: 1, name: m.energy_battery_title() })).toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.energy_tiles_heading() })).toBeVisible()
  await expect.element(screen.getByText(m.energy_battery_efficiency(), { exact: true })).toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.energy_battery_chart_title({ year: '2026' }) })).toBeVisible()
  await expect.element(screen.getByText(/7,58 kWh per 100/)).toBeVisible()
})

test('Batteri reads the same cache entry as Översikt: no request, the period from the URL', async () => {
  const { screen, router } = await renderPage(Battery, '/energy/battery?period=2026-03', seedOverview(withData))
  await expect.element(screen.getByRole('button', { name: /mars 2026/i })).toBeVisible()
  expect(router.state.location.search).toEqual({ period: '2026-03' })
})

test('Batteri: clicking a month in the chart selects it', async () => {
  const { screen, router } = await renderPage(Battery, '/energy/battery', seedOverview(withData))
  await vi.waitFor(() => expect(screen.container.querySelectorAll('[data-bar]').length).toBeGreaterThan(0))
  await clickOn(screen.container, 2)
  await vi.waitFor(() => expect(router.state.location.search).toEqual({ period: '2026-03' }))
})

test('Batteri: empty and failed reads', async () => {
  const emptyPage = await renderPage(Battery, '/energy/battery', seedOverview(empty))
  await expect.element(emptyPage.screen.getByText(m.energy_empty_title())).toBeVisible()
  emptyPage.screen.unmount()
  const failed = await renderPage(Battery, '/energy/battery', () => {})
  await expect.element(failed.screen.getByRole('heading', { level: 1, name: m.energy_battery_title() })).toBeVisible()
  await expect.element(failed.screen.getByText(m.energy_error_title())).toBeVisible()
})
```

(Match `renderPage`'s return value: if it doesn't return `router`, return it alongside `screen`; check how the
existing "stepping writes ?period=" test reads the URL and do the same. Match the period button's accessible name
to `PeriodControl`'s, as the existing tests do.)

In `AppSidebar.browser.test.tsx`, with two "Översikt" links the `Link` mock keys by target: replace the `label`
computation with `linkProps.set(to, { search, activeOptions })` (and fix the comment: "by target"). Update the
existing reads: the charging loop iterates `['/charging', '/charging/patterns']` (the section link and its Översikt
share `/charging` and the same props), `linkProps.get(m.nav_sensors())` → `linkProps.get('/sensors')`,
`linkProps.get(m.nav_charging_settings_short())` → `linkProps.get('/charging/settings')`. Every
`screen.getByRole('link', { name: m.nav_charging_overview(), exact: true })` becomes `subLink(screen,
m.nav_charging_overview(), '/charging')` with

```tsx
const subLink = (screen: Awaited<ReturnType<typeof renderSidebar>>['screen'], name: string, href: string) => {
  const el = [...screen.container.querySelectorAll('a')].find(
    (a) => a.textContent === name && a.getAttribute('href') === href,
  )
  if (!el) throw new Error(`no link ${name} → ${href}`)
  return el
}
```

(`expect.element(x).toHaveAttribute(…)` / `.toBeVisible()` on those become `expect(el).toHaveAttribute(…)` /
`expect(el).toBeTruthy()`; the "members do not see Inställningar" test's visibility check becomes
`expect(subLink(screen, m.nav_charging_overview(), '/charging')).toBeTruthy()`.) Then add:

```tsx
test('lists the energy views as sub-items under Energi', async () => {
  const { screen } = await renderSidebar()
  expect(subLink(screen, m.nav_energy_overview(), '/energy')).toBeTruthy()
  expect(subLink(screen, m.nav_energy_battery(), '/energy/battery')).toBeTruthy()
})

test.each([
  ['/energy', true, false],
  ['/energy/battery', false, true],
] as const)('on %s marks only that energy view active, and Energi', async (path, overviewOn, batteryOn) => {
  current.path = path
  const { screen } = await renderSidebar()
  expect(active(subLink(screen, m.nav_energy_overview(), '/energy'))).toBe(overviewOn)
  expect(active(subLink(screen, m.nav_energy_battery(), '/energy/battery'))).toBe(batteryOn)
  expect(active(screen.getByRole('link', { name: m.nav_energy(), exact: true }).element())).toBe(true)
  expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(false)
})

test('energy links match exactly and carry the period, never the charging year or vehicle', async () => {
  current.path = '/energy/battery'
  await renderSidebar()
  for (const to of ['/energy', '/energy/battery']) {
    const props = linkProps.get(to)
    expect(props?.activeOptions, to).toEqual({ exact: true, includeSearch: false })
    const search = props?.search as (prev: object) => object
    expect(search({ period: '2026-08', year: 2025, vehicle: 'other' })).toEqual({ period: '2026-08' })
    expect(search({ period: 2026 })).toEqual({ period: 2026 })
    expect(Object.entries(search({})).filter(([, v]) => v !== undefined)).toEqual([])
  }
})
```

In `clientSafe.browser.test.tsx` add:

```tsx
test('the /energy/battery route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/battery')
  expect(mod.Route).toBeDefined()
})

test('the battery flow geometry is importable client-side', async () => {
  const mod = await import('~/lib/houseEnergy/batteryFlowLayout')
  expect(typeof mod.batteryFlowLayout).toBe('function')
})
```

Run the three files → FAIL (no battery route, no sub-items).

- [ ] **Step 2: `EnergyHeading` description.** Add `description?: string` (default `m.energy_description()`), used
  in the `<p>`.

- [ ] **Step 3: The route.** First capture placeholder bones so the imports resolve: copy
  `src/bones/energy-tiles.bones.json` to `energy-battery-flow.bones.json` and `energy-chart.bones.json` to
  `energy-battery-chart.bones.json` (Step 6 replaces both with real captures).

```tsx
// src/routes/_authenticated/energy/battery.tsx
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useId } from 'react'
import batteryChartBones from '~/bones/energy-battery-chart.bones.json'
import batteryFlowBones from '~/bones/energy-battery-flow.bones.json'
import { BatteryFlow } from '~/components/energy/BatteryFlow'
import { BatteryMonthlyChart } from '~/components/energy/BatteryMonthlyChart'
import { EnergyEmpty } from '~/components/energy/EnergyEmpty'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { EnergySummaryCard } from '~/components/energy/EnergySummaryCard'
import { energyOverviewQueryFor } from '~/components/energy/energyQueries'
import { energySearchSchema, periodOfSearch } from '~/components/energy/energySearch'
import { type EnergySearchWrite, useEnergyPeriod } from '~/components/energy/useEnergyPeriod'
import { formatDecimal } from '~/components/evCharging/format'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { syncHealthQuery } from '~/components/evCharging/syncHealth'
import { LoadErrorAlert } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { BATTERY_CAPACITY_KWH } from '~/lib/houseEnergy/mix/pool'
import { loadRouteData } from '~/lib/query/routeData'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/energy/battery')({
  head: () => ({
    meta: seo({ title: m.meta_energy_battery_title(), description: m.meta_energy_battery_description() }),
  }),
  validateSearch: energySearchSchema,
  // As /energy (ADR-0025): both sections are above the fold, so both reads are critical on the server; a client
  // navigation awaits nothing. The same overview cache entry as Översikt, so switching sub-page costs no request.
  // The period's year is read here, not a loader dep (see energy/index.tsx).
  loader: ({ context: { queryClient }, location }) =>
    loadRouteData(queryClient, {
      critical: [energyOverviewQueryFor(periodOfSearch(energySearchSchema.parse(location.search))), syncHealthQuery],
    }),
  component: EnergyBatteryPage,
})

function EnergyBatteryPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: sourcesHealth } = useQuery({ ...syncHealthQuery, refetchInterval: 60_000 })
  const health = sourcesHealth?.emaldo
  const navigate = Route.useNavigate()
  const writeSearch = useCallback<EnergySearchWrite>(
    (search) => void navigate({ to: '.', search, replace: true, resetScroll: false }),
    [navigate],
  )
  const e = useEnergyPeriod(Route.useSearch(), writeSearch)
  const chartHeadingId = useId()
  // The chart's year (the overview's), for the month click; only read while the chart renders.
  const chartYear = e.overview?.year ?? e.now.year
  return (
    <PageContainer>
      <EnergyHeading
        title={m.energy_battery_title()}
        description={m.energy_battery_description()}
        lastSuccessAt={health?.lastSuccessAt}
      />
      {health ? (
        <SyncHealthAlert
          health={health}
          isAdmin={isAdmin}
          onRetry={() => syncNow.syncSource('emaldo')}
          retrying={syncNow.isPendingFor('emaldo')}
        />
      ) : null}
      {e.overview?.firstReadingDay === null ? (
        <EnergyEmpty />
      ) : (
        <div className="flex flex-col gap-4">
          <SectionSkeleton bones={batteryFlowBones} loading={e.pending} fallbackHeight="12rem">
            {e.tiles && e.period ? (
              <EnergySummaryCard
                period={e.period}
                monthsWithReadings={e.tiles.monthsWithReadings}
                now={e.now}
                onChange={e.setPeriod}
                dimmed={e.sumsDimmed}
                busy={e.sumsStale}
              >
                <BatteryFlow sums={e.sums} />
              </EnergySummaryCard>
            ) : null}
          </SectionSkeleton>
          <SectionSkeleton bones={batteryChartBones} loading={e.pending} fallbackHeight="22rem">
            {e.overview ? (
              <section aria-labelledby={chartHeadingId}>
                <Card>
                  <CardHeader>
                    <h2 id={chartHeadingId} className="font-semibold text-lg">
                      {m.energy_battery_chart_title({ year: String(e.overview.year) })}
                    </h2>
                  </CardHeader>
                  <CardContent
                    className={cn('transition-opacity', e.stale && 'opacity-60')}
                    aria-busy={e.stale || undefined}
                  >
                    <BatteryMonthlyChart
                      year={e.overview.year}
                      months={e.overview.months}
                      currentMonth={e.overview.year === e.now.year ? e.now.month : null}
                      selectedMonth={
                        e.period?.kind === 'month' && e.period.year === e.overview.year ? e.period.month : null
                      }
                      onSelectMonth={(month) => e.setPeriod({ kind: 'month', year: chartYear, month })}
                    />
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </SectionSkeleton>
          {e.tiles ? (
            <p className="max-w-[70ch] text-pretty text-muted-foreground text-sm">
              {m.energy_battery_note({ capacity: formatDecimal(BATTERY_CAPACITY_KWH) })}
            </p>
          ) : null}
          <LoadErrorAlert title={m.energy_error_title()} query={e.result} />
        </div>
      )}
    </PageContainer>
  )
}
```

(`formatDecimal` keeps up to three decimals: "7,58".)

- [ ] **Step 4: Sidebar and palette.**

`src/components/AppSidebar.tsx`: replace the `scoped` flag with a `link` kind, add Energi's sub-items, and split the
link props by section:

```ts
const chargingSubItems = linkOptions([
  { to: '/charging', label: m.nav_charging_overview, link: 'charging', adminOnly: false },
  { to: '/charging/patterns', label: m.nav_charging_patterns_short, link: 'charging', adminOnly: false },
  { to: '/charging/economy', label: m.nav_charging_economy_short, link: 'charging', adminOnly: false },
  { to: '/charging/settings', label: m.nav_charging_settings_short, link: 'unscoped', adminOnly: true },
])
const energySubItems = linkOptions([
  { to: '/energy', label: m.nav_energy_overview, link: 'energy', adminOnly: false },
  { to: '/energy/battery', label: m.nav_energy_battery, link: 'energy', adminOnly: false },
])

const mainNavItems = linkOptions([
  { to: '/', label: m.nav_home, icon: HomeIcon },
  { to: '/sensors', label: m.nav_sensors, icon: ThermometerIcon },
  { to: '/charging', label: m.nav_charging, icon: ZapIcon, subItems: chargingSubItems, link: 'charging' },
  { to: '/energy', label: m.nav_energy, icon: SunIcon, subItems: energySubItems, link: 'energy' },
  { to: '/users', label: m.nav_users, icon: UsersIcon },
])

type NavItem = (typeof mainNavItems)[number]
type NavSubItem = (typeof chargingSubItems)[number] | (typeof energySubItems)[number]

const activeOptions = { exact: true, includeSearch: false } as const
// Charging views keep the chosen year and vehicle scope (the page filter, ADR-0021) between them.
const chargingLinkProps = {
  search: (prev: { year?: number; vehicle?: VehicleScope }) => ({ year: prev.year, vehicle: prev.vehicle }),
  activeOptions,
} as const
// Energi views keep the chosen period (step 1b's ?period=); they have no year or vehicle filter.
const energyLinkProps = {
  search: (prev: { period?: string | number }) => ({ period: prev.period }),
  activeOptions,
} as const
// Settings: matched exactly like the views, but it starts from a clean URL.
const unscopedLinkProps = { search: () => ({}), activeOptions } as const
const LINK_PROPS = { charging: chargingLinkProps, energy: energyLinkProps, unscoped: unscopedLinkProps } as const
```

`renderItem`: `{...('subItems' in item ? LINK_PROPS[item.link] : {})}`; `renderSubItem`: `{...LINK_PROPS[item.link]}`.
Update the comment above the old `sectionLinkProps` accordingly (exact match because `/charging` and `/energy` are
prefixes of their views). Run `bun run typecheck`; if spreading the union into `<Link>` fails, branch instead:
`item.link === 'energy' ? <Link … {...energyLinkProps} /> : …`.

`src/components/command/commands.ts` (add `BatteryChargingIcon` to the lucide import), after the `/energy` entry:

```ts
  {
    to: '/energy/battery',
    label: m.nav_energy_battery_long,
    keywords: m.cmd_kw_energy_battery,
    icon: BatteryChargingIcon,
    adminOnly: false,
  },
```

- [ ] **Step 5: Run** `bun run build` (regenerates `src/routeTree.gen.ts`), then
  `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/AppSidebar.browser.test.tsx src/lib/houseEnergy/clientSafe.browser.test.tsx src/components/command/`
  and `bun run typecheck` → PASS.

- [ ] **Step 6: Skeletons.** In `scripts/captureBones.ts` add `'/energy/battery'` to `DEFAULT_PATHS` after
  `'/energy'`, and `'/energy/battery': [1220]` to `EXTRA_BREAKPOINTS` (the same card width rule; update the comment
  to name both pages). Start the dev server on 14611 (Task 0) and run
  `BONES_ORIGIN=http://localhost:14611 bun run bones:capture /energy/battery`. Confirm the two `energy-battery-*`
  files changed (not the copies) and `bunx vitest run test/sectionSkeletonBones.test.ts` passes.

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/routes/_authenticated/energy src/routeTree.gen.ts src/components/energy/EnergyHeading.tsx \
  src/components/AppSidebar.tsx src/components/AppSidebar.browser.test.tsx src/components/command/commands.ts \
  src/lib/houseEnergy/clientSafe.browser.test.tsx scripts/captureBones.ts src/bones/energy-battery-flow.bones.json \
  src/bones/energy-battery-chart.bones.json
git commit -m "feat(energy): add the home battery page"
```

---

### Task 8: Verify live, review the branch, record the step, open the PR

- [ ] **Step 1: Live (Phase 6)** — Playwright on the worktree's dev server (14611) with the local full history,
  signed in through Mailpit (memory: live UI check via Playwright; wait for load + 4 s, never `networkidle`).
  `/energy/battery` at 1440, 820 and 390 px, light and dark:
  - the Summering card and the flow box keep identical rects while stepping October → January and to Hela 2026 /
    Totalt (± 0,5 px);
  - no value pill overlaps a node; each node's text stays inside it (a four-digit Totalt loss on a 390 px phone
    included: note any overflow in the PR);
  - February: Förlust ≈ 118 kWh, "43 % av det som laddades in" (wide), the winter hint in the loss tooltip, the
    chart's "43 %" label above February; June: no label;
  - Översikt → Batteri via the sidebar keeps `?period=` and the network log shows no second `energy/overview`
    request; Batteri → Översikt likewise;
  - no horizontal overflow; console clean. Screenshots for the PR.
  - Figures vs SQL for 2026-02, 2026-05, 2026-09 (local DB):

```sql
with r as (select date_trunc('month', bucket_start at time zone 'Europe/Stockholm') m, * from house_energy_reading)
select to_char(m,'YYYY-MM') mon,
  round(sum(battery_charge_solar_kwh)::numeric,2) in_solar,
  round(sum(battery_charge_grid_kwh + battery_charge_ac_kwh)::numeric,2) in_grid,
  round(sum(battery_discharge_kwh)::numeric,2) out_kwh,
  (array_agg(battery_soc_pct order by bucket_start) filter (where battery_soc_pct is not null))[1] first_soc,
  (array_agg(battery_soc_pct order by bucket_start desc) filter (where battery_soc_pct is not null))[1] last_soc
from r group by 1 order by 1;
```

  (loss = in − out − (last − first) ÷ 100 × 7,58; efficiency = out ÷ (in − Δ)). Each table value within 0,1 kWh.

- [ ] **Step 2: Branch review (Phase 5)**: `code-reviewer` (ADR-0024/0025 adherence, the two refactors truly
  behaviour-preserving) and a general correctness pass over the whole diff; fix or rule on every finding.

- [ ] **Step 3: Roadmap**: row 2 → plan link (this file), PR link, `PR open`; a Log line with the live result and
  anything that diverged from the spec (amend the spec in the same PR if a decision changed).

- [ ] **Step 4: Pre-PR gate** (`docs/feature-workflow.md`): `bun run check`, `bun run check:ci`, `bun run build`,
  `bun run test`, the sv/en key check. Browser files that fail only after a merge (Vite re-optimising deps) are
  re-run alone before calling them failures.

- [ ] **Step 5: Commit and PR**

```bash
git add docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md
git commit -m "docs(energy): track step 2"
git push -u origin feat/energy-battery
gh pr create --title "feat(energy): add the home battery page" --body-file <(…PR template filled: why + ADR-0024 link, verification evidence, screenshots…)
```

Checkpoint 4 (prod) runs after merge, in a new session.
