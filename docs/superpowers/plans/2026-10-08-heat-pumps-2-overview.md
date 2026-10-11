# Heat pumps, step 2: Energi › Översikt: Användning — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Energi › Översikt gets a second flow card, **Användning**, that splits the chosen period's load into
laddning, each heat pump and övrigt hus; the month chart's Förbrukning stacks the same parts; every Energi page shows a
Comfort Cloud health alert when the source is unhealthy.

**Architecture:** One new grouped read in the service (`heatPump.monthSums`, per unit per Stockholm month over the
house data's range) feeds `getEnergyOverview`, which adds `heatPumps: HeatPumpPeriod[]` to every `PeriodSums`
(expected hours clipped like ADR-0024's buckets) and times it as `heatPumpMs`. `figures.ts` (pure, test-first) caps
the heat pumps at load − laddning and makes `restOfHouse` exclude them. The card is a visx diagram drawn in the idiom
of step 1c's `EnergyFlowDiagram` / step 2's `BatteryFlowDiagram`: pure geometry in `src/lib/houseEnergy/usageFlowLayout.ts`
on the shared `flowLayout.ts` primitives, the shared `flowParts.tsx` drawing parts, the shared "Visa värden"
preference. Same query as Summering: no new request, no new procedure.

**Tech Stack:** Drizzle (`sql`, `min`/`max`) on Postgres, TanStack Start / Query, visx (`@visx/group`,
`@visx/responsive`, the shared `BarChart`), lucide-react, Paraglide, Vitest (node + browser), Biome, boneyard-js.

**Spec:** [`docs/superpowers/specs/2026-10-08-heat-pumps-design.md`](../specs/2026-10-08-heat-pumps-design.md)
("Read model › `energy.overview`", "Energi › Översikt: Användning", "Error handling and edge cases", "Testing")
· ADR: [`docs/adr/0027-heat-pump-energy-data.md`](../../adr/0027-heat-pump-energy-data.md) (decisions 6, 7)
· Builds on: [ADR-0024](../../adr/0024-house-energy-pages.md) (`figures.ts`, buckets, the Energi pages),
[ADR-0025](../../adr/0025-deferred-route-loading.md) (section skeletons)
· Roadmap: [`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`](../roadmaps/2026-10-08-heat-pumps.md) (step 2, checkpoint 3)

## Global Constraints

- Read-only step: no schema change, no new procedure, no new dependency. The only server change is one grouped read
  inside `energy.overview` (ADR-0027 decision 6: **only sums reach the browser**, never an hour).
- Definitions live in `figures.ts` only (ADR-0024 decision 4):
  `heatPumps[i].kwh = unit kWh × min(1, max(0, load − car) ÷ Σ units' kWh)` (Σ = 0 → 0);
  `share = load > 0 ? kwh ÷ load : null`; `restOfHouse = max(0, load − car − Σ heatPumps[i].kwh)`;
  `heatPumpMissingHours = max over units of max(0, expectedHours − hours)`. Summering's figures are unchanged.
- Expected hours per unit and period: from max(period start, the first house reading's Stockholm day, the unit's first
  hour) to min(period end, the unit's end), counted in whole hours (a partly covered last hour counts). The unit's end
  is the newest house bucket + 5 min, **except** that a trailing gap (the hours after the unit's newest stored hour)
  counts as missing only when it is ≥ 13 h (`STALE_AFTER_MS.comfortCloud`, the source's stale threshold): a shorter
  trailing lag is the 6-hourly sync's normal delay, so the unit's end is then its newest stored hour + 1 h (no note).
  Gaps inside the stored range always count (coordinator ruling).
- Unit order everywhere (diagram, table, chart stack, tooltip, colours): `byHeatPumpName` (`localeCompare(…, 'sv')`,
  then id), exported from the client-safe `src/lib/houseEnergy/figures.ts`; step 3 reuses it. Consumer order:
  laddning, the units, övrigt hus. Unit colours follow the **all-time** unit order (`overview.allTime.heatPumps`), so a
  unit keeps its colour whatever the period shows.
- Colours (validated, light / dark): `--energy-heat-pump-1` `#1597ad` / `#1a9db0`, `--energy-heat-pump-2` `#a1286a` /
  `#b33c86`, `--energy-heat-pump-3` `#3d5fd6` / `#5b7be8`; existing `--energy-car`, `--energy-house`.
- The Användning box height is reserved by a container query: `h-[436px] @[860px]:h-[312px]` (wide from a card content
  width of 860 px, `WIDE_MIN_WIDTH`), the same for any number of consumers; the note line is reserved
  (`min-h-[1.5em]`). Switching periods moves nothing.
- "Visa värden" is Summering's preference (`SHOW_FLOW_VALUES_KEY = 'videbacken-energy-flow-values'`).
- Client code may only `import type` from services (`clientSafe.browser.test.tsx` guards it).
- Paraglide: Swedish is the source; English key-complete; Swedish copy exactly as written here. "Videbacken" and
  "Comfort Cloud" untranslated.
- Browser tests have no app CSS: pin structure and the reservation classes; verify layout live. CI runs browser tests
  in UTC: nothing here may depend on the runner's time zone.
- Test fixtures: synthetic numbers and fake ids/guids only (`hp-a`, `CS-HZ25ZKE+0000000001`), names "Matsal" /
  "Övervåning".
- Never two vitest processes at once (shared local DB); reviewers don't run vitest while the implementer does.
- Conventional Commits ≤ 72 chars, one hat per commit, body ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; `git add <paths>`, never `-A`.
  PR title `feat(energy): show what the house's consumption was used for`.

## Decisions this plan makes where the spec is silent (flag in the PR)

1. `monthSums` lives in its own file `src/lib/services/heatPump/monthSums.ts` (re-exported from the service barrel);
   `HeatPumpMonthRow` carries no expected hours (the contract), so `getEnergyOverview` computes them.
2. Heat pump hours outside the house data's range are not read (`from` = first house day, `to` = newest bucket + 5 min):
   outside it there is no load to share.
3. A unit appears in a period when it has a reading in it or is expected to (its first hour lies before the period's
   clipped end); a unit with neither is left out (no node before its first reading, spec).
4. A fourth unit has no colour of its own (data-viz rule: never cycle): it takes `var(--muted-foreground)`, its name
   carries identity.
5. **Narrow layout (< 860 px) draws no value pills**: the arrows run side by side down a 88 px lane where a pill can't
   sit without covering its neighbours; every consumer node shows its kWh and share in both layouts, so nothing is
   lost. The "Visa värden" switch is hidden on the narrow layout (`hidden @[860px]:flex`), its hint stays.
6. The Användning header shows the period's label (`periodLabel`), right-aligned: the period comes from Summering's
   control.
7. Laddning and övrigt hus always have a node (an arrow only from 0,05 kWh, like Summering); heat pump nodes follow the
   period.
8. The car read and the heat pump read run in parallel (`Promise.all`), each timed, to keep `energy.overview`'s warm
   `totalMs` within checkpoint 3's 20 ms.
9. Översikt and Batteri render their alerts through a new `EnergySyncAlerts` (Emaldo, then Comfort Cloud).
   No special case per state: Comfort Cloud's alert behaves exactly as Emaldo's does (`SyncHealthAlert` as is, incl.
   `not_configured` on Preview).

Coordinator rulings (2026-10-11) folded in: the trailing-gap rule above; items 4 and 5 accepted; `byHeatPumpName` is
the one unit order; the geometry file is `usageFlowLayout.ts`; a null heating/cooling share counts 0; a unit reads under
its current name. Step 1b invalidates the `energy` query keys after a Comfort Cloud "Synka nu", so nothing here does.

## Review Focus

1. **The current period while the Comfort Cloud sync lags the house data** (it runs every 6 h, Emaldo hourly): a
   trailing lag under 13 h is not missing (no "Värmepumpsdata saknas" note); 13 h or more counts in full; a gap inside
   the stored hours always counts. Pinned in Task 3 (trailing 6 h → 0, trailing 14 h → 14, the 12 h / 13 h boundary,
   inner 2 h → 2).
2. **Heat pumps above load − laddning** (a month where the house data has a gap the heat pumps don't, meter noise, or
   laddning ≥ load): units scaled down to fit, övrigt hus exactly 0, the chart's parts add up to the load, no share
   above 100 %. Pinned in Task 1 (figures) and Task 7 (tooltip rows).
3. **A period before a unit's first reading, or a unit added mid-period**: no node before; expected hours from its first
   hour, so it isn't "missing" before it existed; the Användning box keeps its rect when the node count changes. Pinned
   in Task 3 (service) and Task 8 (page: stepping into a month without heat pumps).
4. **A long unit name** (Comfort Cloud names are user-set) on a 311 px card: the node label is cut with "…" inside its
   node; the tooltip and the table name it in full. Pinned in Task 6.
5. **A unit with no data in the chart year while a later-named unit has**: the later unit keeps its all-time colour
   (colour follows the entity, never its rank). Pinned in Task 6 (diagram) and Task 7 (chart).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/houseEnergy/figures.ts` (+ `.test.ts`) (modify) | `HeatPumpPeriod`, `PeriodSums.heatPumps`, `byHeatPumpName`, heat pump merge in `addPeriodSums`, `energyFigures.heatPumps` / `heatPumpMissingHours`, `restOfHouse` excludes heat pumps |
| every test building a `PeriodSums` (12 files, Task 1) (modify) | `heatPumps: []` in the fixture |
| `src/lib/services/heatPump/monthSums.ts` (+ `.test.ts`) (create), `index.ts` (modify) | `monthSums({ from, to })`, `HeatPumpMonthRow` |
| `test/fixtures/heatPumpHours.ts` (create) | `seedUnits`, `storeHours` (synthetic readings through the service) |
| `src/lib/services/houseEnergy/energyOverview.ts` (+ `.test.ts`) (modify) | Heat pumps per period, `heatPumpMs` |
| `src/lib/orpc/procedures/energy.ts` (+ `.test.ts`) (modify) | `heatPumpMs` timing; privacy test covers heat pumps |
| `src/styles/app.css` (modify) | Three `--energy-heat-pump-N` tokens + `@theme` colours |
| `src/lib/houseEnergy/heatPumpColors.ts` (+ `.test.ts`) (create) | `HEAT_PUMP_COLORS`, `heatPumpColor(units, id)` |
| `src/lib/houseEnergy/flowLayout.ts` (modify) | Export `ARROW_LENGTH` |
| `src/lib/houseEnergy/usageFlowLayout.ts` (+ `.test.ts`) (create) | Användning geometry: nodes, side-by-side ports, node text |
| `src/components/energy/flowParts.tsx` (modify) | `useFontsReady`, `useFittedText`, `NodeFrame.labelRef`, `FlowValuesSwitch.switchClassName`, `FlowTableFrame.columns` |
| `src/components/energy/EnergyUseFlowDiagram.tsx` (+ `.browser.test.tsx`) (create) | Draws the Användning flow |
| `src/components/energy/EnergyUseFlow.tsx` (+ `.browser.test.tsx`) (create) | The card body: box, switch, note, table |
| `src/components/energy/energyTooltip.ts` (+ `.test.ts`) (modify) | Heat pump series keys, `metricSeries`, `chartUnits`, load rows per unit |
| `src/components/energy/EnergyMonthlyChart.tsx` (+ `.browser.test.tsx`) (modify) | Dynamic Förbrukning series, colours, tooltip |
| `src/components/energy/EnergySyncAlerts.tsx` (create) | Emaldo + Comfort Cloud `SyncHealthAlert`s |
| `src/routes/_authenticated/energy/index.tsx`, `battery.tsx`, `-energyPage.browser.test.tsx` (modify) | Användning card, alerts, chart units |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (modify) | Guards for the new client modules |
| `src/bones/energy-use.bones.json` (generate) | Användning skeleton |
| `messages/sv.json`, `messages/en.json` (modify) | `energy_use_*`, `energy_heat_pump_name` |
| `CLAUDE.md` (modify) | Code map: the new houseEnergy modules |
| `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md` (modify) | Row 2 → PR link, `PR open` |

---

### Task 0: Verify `main` still matches this plan; worktree

- [ ] **Step 1: Check what the plan builds on**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "| 1b |" docs/superpowers/roadmaps/2026-10-08-heat-pumps.md            # status: checkpoint passed
grep -n "export const heatPump\b\|export const heatPumpReading\|hourStart\|energyKwh\|heatShare\|coolShare\|setpointC\|insideC\|outsideC" src/lib/db/schema/heatPump.ts
grep -n "heatPump" src/lib/db/schema/index.ts
grep -n "export async function upsertUnits\|export async function replaceDay\|export type HeatPumpHourInput\|export type HeatPumpUnitInput" src/lib/services/heatPump/heatPump.ts
cat src/lib/services/heatPump/index.ts
grep -n "INTEGRATION_SOURCES = " src/lib/integrationHealth.ts                     # includes 'comfortCloud'
grep -n "comfortCloud" src/lib/integrationHealthMessage.ts src/components/evCharging/SyncNowButton.tsx | head -5
grep -n "restOfHouse: Math.max(0, p.loadKwh - car)\|export function addPeriodSums\|export type PeriodSums" src/lib/houseEnergy/figures.ts
grep -n "timings?: { houseScanMs?: number; carMs?: number }\|const withExpected\|const total = " src/lib/services/houseEnergy/energyOverview.ts
grep -n "load: \['car', 'house'\]\|export function chartRows\|export function energyTooltipRows" src/components/energy/energyTooltip.ts
grep -n "export function NodeFrame\|export function useFittedSize\|export function FlowValuesSwitch\|export function FlowTableFrame\|export function ValuePill" src/components/energy/flowParts.tsx
grep -n "^const ARROW_LENGTH\|export const WIDE_MIN_WIDTH\|export function flowWidth\|export const flowEdge" src/lib/houseEnergy/flowLayout.ts
grep -n "INTEGRATION_SOURCES.map" test/browser/syncHealth.ts
grep -n "export const STALE_AFTER_MS\|comfortCloud" src/lib/services/integrationSync/policy.ts   # comfortCloud: 13 h
ls test/fixtures/ src/bones/ | grep -i "heat\|energy-use"                          # nothing yet
grep -c "^DATABASE_URL" .env.local 2>/dev/null                                     # 0 (CLAUDE.md gotcha)
```

Expected: row 1b is `checkpoint passed`; the schema and service match the brief's contract (columns `heatPumpId`,
`hourStart`, `energyKwh`, `heatShare`, `coolShare`, `setpointC`, `insideC`, `outsideC`; `heatPump.name`);
`INTEGRATION_SOURCES` and the health/sync-now copy include `comfortCloud`; every other grep prints; no heat pump test
fixture and no `energy-use` bones exist (if 1a/1b added `test/fixtures/heatPump.ts`, put Task 2's helpers there
instead of a new file and adjust the imports). If a name moved, adapt the tasks first and note it in the PR.

- [ ] **Step 2: Worktree**

```bash
git worktree add .claude/worktrees/heat-pumps-overview -b feat/heat-pumps-overview origin/main
cd .claude/worktrees/heat-pumps-overview && bun install && bun run db:up && bun run db:migrate
```

Port 14610 is often another session's dev server: run this worktree's on 14611
(`BETTER_AUTH_URL=http://localhost:14611 bun run dev -- --port 14611`) and pass `BONES_ORIGIN=http://localhost:14611`
to `bones:capture`.

- [ ] **Step 3: Local heat pump data** (for Tasks 8–9). In the worktree's dev app, signed in as admin,
  `/charging/settings` → Datakällor → Comfort Cloud → "Synka nu" (the `.env.local` credentials, roadmap prerequisite).
  One run stores the last three days plus up to 60 backfill days per unit; run it about five times so February 2026
  and the current month have data (check `select min(hour_start) from heat_pump_reading` reaches 2026-02-01 or
  earlier). Check per unit: `docker compose exec db psql -U videbacken -c "select h.name, count(*) from heat_pump_reading r join heat_pump h on h.id = r.heat_pump_id group by 1"`.

---

### Task 1: Heat pumps in the period figures (`figures.ts`)

**Reviewers:** `code-reviewer` + `test-completeness` (both told: assume the figures are wrong; check every rule in the
Global Constraints against the code and the tests, and that Summering's figures can't have changed).

**Files:**
- Modify: `src/lib/houseEnergy/figures.ts`, `src/lib/houseEnergy/figures.test.ts`
- Modify (fixture line only): `src/lib/houseEnergy/flowLayout.test.ts`, `src/lib/houseEnergy/batteryFlowLayout.test.ts`,
  `src/components/energy/energyTooltip.test.ts`, `src/components/energy/batteryChart.test.ts`,
  `src/components/energy/EnergyMonthlyChart.browser.test.tsx`, `src/components/energy/BatteryMonthlyChart.browser.test.tsx`,
  `src/components/energy/EnergyFlow.browser.test.tsx`, `src/components/energy/EnergyFlowDiagram.browser.test.tsx`,
  `src/components/energy/BatteryFlow.browser.test.tsx`, `src/components/energy/BatteryFlowDiagram.browser.test.tsx`,
  `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`
- Modify (compile only): `src/lib/services/houseEnergy/energyOverview.ts`

**Interfaces:**
- Produces:
  - `type HeatPumpPeriod = { id: string; name: string; kwh: number; hours: number; expectedHours: number }`
  - `PeriodSums.heatPumps: HeatPumpPeriod[]` (name order)
  - `EnergyFigures.heatPumps: { id: string; name: string; kwh: number; share: number | null }[]`,
    `EnergyFigures.heatPumpMissingHours: number`; `restOfHouse` excludes the heat pumps
  - `byHeatPumpName(a: { id: string; name: string }, b: { id: string; name: string }): number` — THE unit order
    everywhere (coordinator ruling), client-safe in `figures.ts`; step 3 imports it from `~/lib/houseEnergy/figures`
  - `addPeriodSums` merges `heatPumps` by id (kWh, hours, expected hours added; the later name wins; name order)

- [ ] **Step 1: Write the failing tests** (append to `figures.test.ts`; add `heatPumps: []` to its `sums()` default
  after `expectedBuckets: 0,` and `type HeatPumpPeriod` + `byHeatPumpName` to the import)

```ts
const unit = (over: Partial<HeatPumpPeriod> = {}): HeatPumpPeriod => ({
  id: 'hp-a',
  name: 'Matsal',
  kwh: 0,
  hours: 744,
  expectedHours: 744,
  ...over,
})
const matsal = (kwh: number, over: Partial<HeatPumpPeriod> = {}) => unit({ kwh, ...over })
const overvaning = (kwh: number, over: Partial<HeatPumpPeriod> = {}) =>
  unit({ id: 'hp-b', name: 'Övervåning', kwh, ...over })

test('heat pumps: their kWh and share of the load; the rest of the house excludes them', () => {
  const f = energyFigures(sums({ loadKwh: 900, carKwh: 300, heatPumps: [matsal(150), overvaning(60)] }))
  expect(f.heatPumps).toEqual([
    { id: 'hp-a', name: 'Matsal', kwh: 150, share: 150 / 900 },
    { id: 'hp-b', name: 'Övervåning', kwh: 60, share: 60 / 900 },
  ])
  expect(f.car).toBe(300)
  expect(f.restOfHouse).toBe(390)
})

test('heat pumps above load − laddning are scaled down to fit; övrigt hus is exactly 0', () => {
  // 100 kWh left after the car, 200 kWh of heat pumps: each halved.
  const f = energyFigures(sums({ loadKwh: 400, carKwh: 300, heatPumps: [matsal(150), overvaning(50)] }))
  expect(f.heatPumps.map((u) => u.kwh)).toEqual([75, 25])
  expect(f.restOfHouse).toBe(0)
  expect(f.car + f.heatPumps.reduce((a, u) => a + u.kwh, 0) + f.restOfHouse).toBeCloseTo(400, 9)
  expect(Math.max(...f.heatPumps.map((u) => u.share ?? 0))).toBeLessThanOrEqual(1)
})

test('laddning at or above the load leaves no room: heat pumps 0, övrigt hus 0', () => {
  const f = energyFigures(sums({ loadKwh: 2, carKwh: 3, heatPumps: [matsal(1)] }))
  expect(f.car).toBe(2)
  expect(f.heatPumps).toEqual([{ id: 'hp-a', name: 'Matsal', kwh: 0, share: 0 }])
  expect(f.restOfHouse).toBe(0)
})

test('without load the heat pumps have no share; with 0 kWh no division by zero', () => {
  expect(energyFigures(sums({ heatPumps: [matsal(5)] })).heatPumps[0]).toEqual({
    id: 'hp-a',
    name: 'Matsal',
    kwh: 0,
    share: null,
  })
  const zero = energyFigures(sums({ loadKwh: 10, heatPumps: [matsal(0), overvaning(0)] }))
  expect(zero.heatPumps.map((u) => u.kwh)).toEqual([0, 0])
  expect(zero.heatPumps.map((u) => u.share)).toEqual([0, 0])
  expect(zero.restOfHouse).toBe(10)
})

test('no heat pumps: no heat pump figures, övrigt hus as before step 2', () => {
  const f = energyFigures(sums({ loadKwh: 947, carKwh: 312 }))
  expect(f.heatPumps).toEqual([])
  expect(f.heatPumpMissingHours).toBe(0)
  expect(f.restOfHouse).toBe(635)
})

test('heatPumpMissingHours is the most hours any unit misses, never negative', () => {
  const f = energyFigures(
    sums({
      loadKwh: 900,
      heatPumps: [
        matsal(10, { hours: 700, expectedHours: 744 }),
        overvaning(10, { hours: 745, expectedHours: 740 }),
      ],
    }),
  )
  expect(f.heatPumpMissingHours).toBe(44)
  expect(
    energyFigures(sums({ heatPumps: [matsal(1, { hours: 745, expectedHours: 744 })] }))
      .heatPumpMissingHours,
  ).toBe(0)
})

test("Summering's figures don't change with heat pumps", () => {
  const base = sums({
    gridImportKwh: 561,
    gridExportKwh: 114,
    solarKwh: 509,
    loadKwh: 947,
    batteryDischargeKwh: 225,
    batteryChargeSolarKwh: 173,
    batteryChargeGridKwh: 68,
    carKwh: 312,
    firstSocPct: 30,
    lastSocPct: 40,
    buckets: 8600,
    expectedBuckets: 8640,
  })
  const without = energyFigures(base)
  const withUnits = energyFigures({ ...base, heatPumps: [matsal(150), overvaning(60)] })
  const strip = ({ heatPumps: _h, heatPumpMissingHours: _m, restOfHouse: _r, ...rest }: EnergyFigures) => rest
  expect(strip(withUnits)).toEqual(strip(without))
})

test('addPeriodSums merges heat pumps by id, in name order; the later name wins', () => {
  const jan = sums({ heatPumps: [matsal(10, { hours: 100, expectedHours: 110 })] })
  const feb = sums({
    heatPumps: [
      overvaning(5, { hours: 50, expectedHours: 60 }),
      matsal(20, { name: 'Matsalen', hours: 200, expectedHours: 210 }),
    ],
  })
  expect(addPeriodSums(jan, feb).heatPumps).toEqual([
    { id: 'hp-a', name: 'Matsalen', kwh: 30, hours: 300, expectedHours: 320 },
    { id: 'hp-b', name: 'Övervåning', kwh: 5, hours: 50, expectedHours: 60 },
  ])
  // Inputs are not mutated.
  expect(jan.heatPumps[0].kwh).toBe(10)
})

test('byHeatPumpName sorts by Swedish name, then id', () => {
  const names = [
    { id: 'b', name: 'Övervåning' },
    { id: 'c', name: 'Matsal' },
    { id: 'a', name: 'Matsal' },
    { id: 'd', name: 'Ateljé' },
  ].sort(byHeatPumpName)
  expect(names.map((u) => u.id)).toEqual(['d', 'a', 'c', 'b'])
})
```

Add `type EnergyFigures` to the import too.

- [ ] **Step 2: Run it to see it fail**

Run: `bunx vitest run --project node src/lib/houseEnergy/figures.test.ts`
Expected: FAIL (type errors are not reported by vitest; the run fails on `f.heatPumps` undefined / `byHeatPumpName` not
exported).

- [ ] **Step 3: Implement** (`figures.ts`)

After `COVERAGE_COMPLETE`:

```ts
/** One heat pump's sums over a period (ADR-0027): its kWh, the hours with a reading and the hours expected. */
export type HeatPumpPeriod = {
  id: string
  name: string
  kwh: number
  hours: number
  expectedHours: number
}

/** The heat pumps' order everywhere (diagram, table, chart stack): Swedish name order, then id. */
export function byHeatPumpName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return a.name.localeCompare(b.name, 'sv') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
```

In `PeriodSums`, after `expectedBuckets`:

```ts
  /** Each heat pump with a reading in the period or expected to have one, in name order (heat pumps step 2). */
  heatPumps: HeatPumpPeriod[]
```

In `EnergyFigures`, replace `restOfHouse: number` with:

```ts
  /** Load minus laddning and the heat pumps, never negative (heat pumps step 2: excludes the heat pumps). */
  restOfHouse: number
  /**
   * Each heat pump's kWh and share of the load, in name order. Capped: laddning + heat pumps never exceed the load
   * (meter noise, or heat pump hours where house buckets are missing), so övrigt hus is never negative.
   */
  heatPumps: { id: string; name: string; kwh: number; share: number | null }[]
  /** The most hours any heat pump is missing in the period (whole hours; 0 when complete or without units). */
  heatPumpMissingHours: number
```

`addPeriodSums` gains `heatPumps: mergeHeatPumps(earlier.heatPumps, later.heatPumps),` and, below it:

```ts
function mergeHeatPumps(earlier: HeatPumpPeriod[], later: HeatPumpPeriod[]): HeatPumpPeriod[] {
  const byId = new Map<string, HeatPumpPeriod>()
  for (const u of [...earlier, ...later]) {
    const seen = byId.get(u.id)
    byId.set(
      u.id,
      seen
        ? {
            id: u.id,
            name: u.name,
            kwh: seen.kwh + u.kwh,
            hours: seen.hours + u.hours,
            expectedHours: seen.expectedHours + u.expectedHours,
          }
        : { ...u },
    )
  }
  return [...byId.values()].sort(byHeatPumpName)
}
```

In `energyFigures`, after `const car = …`:

```ts
  // The heat pumps share what the car left of the load; scaled down together when they'd exceed it.
  const unitsKwh = p.heatPumps.reduce((sum, u) => sum + u.kwh, 0)
  const room = Math.max(0, p.loadKwh - car)
  const scale = unitsKwh > 0 ? Math.min(1, room / unitsKwh) : 0
  const heatPumps = p.heatPumps.map((u) => {
    const kwh = u.kwh * scale
    return { id: u.id, name: u.name, kwh, share: p.loadKwh > 0 ? kwh / p.loadKwh : null }
  })
  const heatPumpKwh = heatPumps.reduce((sum, u) => sum + u.kwh, 0)
```

and in the returned object replace the `restOfHouse` line with:

```ts
    // Capped heat pumps fill the room exactly: 0, not a floating-point crumb.
    restOfHouse: scale < 1 ? 0 : Math.max(0, p.loadKwh - car - heatPumpKwh),
    heatPumps,
    heatPumpMissingHours: p.heatPumps.reduce((most, u) => Math.max(most, u.expectedHours - u.hours), 0),
```

Update the header comment's first sentence: "… car vs heat pumps vs the rest of the house and battery in / out / loss."

- [ ] **Step 4: Keep everything compiling.** In `energyOverview.ts` `withExpected`, return
  `{ ...row.sums, carKwh: 0, expectedBuckets: Math.max(expected, row.sums.buckets), heatPumps: [] }` (Task 3 fills it).
  Add `heatPumps: [],` after the `expectedBuckets` line of the `sums()` fixture in each of the 11 test files listed
  under **Files** (find them with `grep -rln "expectedBuckets:" src`). Run `bun run typecheck` → clean.

- [ ] **Step 5: Run**

```bash
bunx vitest run --project node src/lib/houseEnergy src/components/energy src/lib/services/houseEnergy
bunx vitest run --project browser src/components/energy src/routes/_authenticated/energy
```

Expected: PASS (the browser suites unchanged apart from the fixture line).

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/houseEnergy/figures.ts src/lib/houseEnergy/figures.test.ts src/lib/houseEnergy/flowLayout.test.ts \
  src/lib/houseEnergy/batteryFlowLayout.test.ts src/lib/services/houseEnergy/energyOverview.ts src/components/energy \
  src/routes/_authenticated/energy/-energyPage.browser.test.tsx
git commit -m "feat(energy): add the heat pumps to the period figures" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Monthly heat pump sums (`heatPump.monthSums`)

**Reviewers:** `code-reviewer` + `test-completeness` (both told: assume a reading lands in the wrong Stockholm month or a
mean is not hour-weighted; check the DST and month-edge tests prove otherwise, and that no hour leaves the service).

**Files:**
- Create: `src/lib/services/heatPump/monthSums.ts`, `src/lib/services/heatPump/monthSums.test.ts`,
  `test/fixtures/heatPumpHours.ts`
- Modify: `src/lib/services/heatPump/index.ts`

**Interfaces:**
- Consumes (step 1a): `upsertUnits(units: HeatPumpUnitInput[], now: Date): Promise<HeatPump[]>`,
  `replaceDay(heatPumpId: string, utcDay: string, hours: HeatPumpHourInput[]): Promise<{ stored: number }>`,
  tables `heatPump`, `heatPumpReading`.
- Produces:
  - `monthSums({ from, to }: { from: Date; to: Date }): Promise<HeatPumpMonthRow[]>` — hours in `[from, to)`, ordered by
    name, unit, year, month
  - `type HeatPumpMonthRow = { heatPumpId: string; name: string; year: number; month: number; kwh: number; heatKwh: number; coolKwh: number; insideC: number | null; outsideC: number | null; setpointC: number | null; hours: number; firstHour: Date; lastHour: Date }`
  - test helpers `seedUnits(...names: string[]): Promise<Record<string, string>>` (name → id) and
    `storeHours(heatPumpId, fromIso, toIso, at?)`

- [ ] **Step 1: The fixture** (`test/fixtures/heatPumpHours.ts`)

```ts
import { type HeatPumpHourInput, replaceDay, upsertUnits } from '~/lib/services/heatPump'

// SYNTHETIC heat pump readings for tests. Never put real readings in the repo (it's public).

const HOUR_MS = 3_600_000
const SEEN_AT = new Date('2026-10-08T12:00:00Z')

/** Inserts one unit per name (fake guids, model CS-HZ25ZKE); returns name → id. */
export async function seedUnits(...names: string[]): Promise<Record<string, string>> {
  const rows = await upsertUnits(
    names.map((name, i) => ({ guid: `CS-HZ25ZKE+000000000${i + 1}`, name, model: 'CS-HZ25ZKE' })),
    SEEN_AT,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.id]))
}

export type HourValues = Partial<Omit<HeatPumpHourInput, 'hourStart'>>

/**
 * Stores every UTC hour in [fromIso, toIso) for one unit: 0,1 kWh, all heating, 21 °C in, 0 °C out, unless `at(t, i)`
 * says otherwise; `at` returning null leaves that hour out (a gap). One `replaceDay` per UTC day, which replaces that
 * whole day: don't store the same unit's UTC day in two calls.
 */
export async function storeHours(
  heatPumpId: string,
  fromIso: string,
  toIso: string,
  at: (hourStartMs: number, i: number) => HourValues | null = () => ({}),
): Promise<void> {
  const days = new Map<string, HeatPumpHourInput[]>()
  for (let t = Date.parse(fromIso), i = 0; t < Date.parse(toIso); t += HOUR_MS, i++) {
    const values = at(t, i)
    if (values === null) continue
    const day = new Date(t).toISOString().slice(0, 10)
    const hours = days.get(day) ?? []
    hours.push({
      hourStart: new Date(t),
      energyKwh: 0.1,
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 21,
      outsideC: 0,
      ...values,
    })
    days.set(day, hours)
  }
  for (const [day, hours] of days) await replaceDay(heatPumpId, day, hours)
}
```

- [ ] **Step 2: Write the failing tests** (`monthSums.test.ts`)

```ts
import { expect, test } from 'vitest'
import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'
import { setupDatabase } from '~test/setup'
import { upsertUnits } from './heatPump'
import { monthSums } from './monthSums'

setupDatabase()

const all = { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2030-01-01T00:00:00Z') }

test('no readings: no rows', async () => {
  expect(await monthSums(all)).toEqual([])
})

test('sums each unit per Stockholm month across a month edge, in name order', async () => {
  // Inserted Övervåning first: the order comes from the name, not the insert.
  const id = await seedUnits('Övervåning', 'Matsal')
  // 31 March CEST: 20:00Z and 21:00Z are 22:00 and 23:00 in March, 22:00Z is 00:00 on 1 April.
  await storeHours(id.Matsal, '2026-03-31T20:00:00Z', '2026-03-31T23:00:00Z')
  await storeHours(id.Övervåning, '2026-03-31T21:00:00Z', '2026-03-31T22:00:00Z', () => ({ energyKwh: 0.3 }))
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.name, r.year, r.month, r.hours])).toEqual([
    ['Matsal', 2026, 3, 2],
    ['Matsal', 2026, 4, 1],
    ['Övervåning', 2026, 3, 1],
  ])
  expect(rows[0].kwh).toBeCloseTo(0.2, 9)
  expect(rows[1].kwh).toBeCloseTo(0.1, 9)
  expect(rows[2].kwh).toBeCloseTo(0.3, 9)
  expect(rows[0].heatPumpId).toBe(id.Matsal)
  expect(rows[0].firstHour).toEqual(new Date('2026-03-31T20:00:00Z'))
  expect(rows[0].lastHour).toEqual(new Date('2026-03-31T21:00:00Z'))
})

test('both DST days: October 2025 has 745 hours, March 2026 743, none spill into a neighbour month', async () => {
  const id = await seedUnits('Matsal')
  // Stockholm October 2025: 2025-09-30T22:00Z (CEST) → 2025-10-31T23:00Z (CET), the 26th has 25 h.
  await storeHours(id.Matsal, '2025-09-30T22:00:00Z', '2025-10-31T23:00:00Z')
  // Stockholm March 2026: 2026-02-28T23:00Z (CET) → 2026-03-31T22:00:00Z (CEST), the 29th has 23 h.
  await storeHours(id.Matsal, '2026-02-28T23:00:00Z', '2026-03-31T22:00:00Z')
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.year, r.month, r.hours])).toEqual([
    [2025, 10, 745],
    [2026, 3, 743],
  ])
  expect(rows[0].kwh).toBeCloseTo(74.5, 9)
  expect(rows[1].kwh).toBeCloseTo(74.3, 9)
})

test('heating and cooling kWh weight each hour by its share; temperatures are hour means over hours with a value', async () => {
  const id = await seedUnits('Matsal')
  const hours = [
    { energyKwh: 0.2, heatShare: 1, coolShare: 0, insideC: 20, outsideC: -2, setpointC: null },
    { energyKwh: 0.4, heatShare: 0.5, coolShare: 0.5, insideC: 22, outsideC: null, setpointC: null },
    { energyKwh: 0.1, heatShare: null, coolShare: null, insideC: null, outsideC: null, setpointC: null },
    { energyKwh: 0.3, heatShare: 0, coolShare: 1, insideC: 21, outsideC: 4, setpointC: null },
  ]
  await storeHours(id.Matsal, '2026-01-15T10:00:00Z', '2026-01-15T14:00:00Z', (_t, i) => hours[i])
  const [row] = await monthSums(all)
  expect(row.kwh).toBeCloseTo(1, 9)
  expect(row.heatKwh).toBeCloseTo(0.4, 9) // 0,2 + 0,2; an hour without a share counts 0
  expect(row.coolKwh).toBeCloseTo(0.5, 9) // 0,2 + 0,3
  expect(row.insideC).toBeCloseTo(21, 9)
  expect(row.outsideC).toBeCloseTo(1, 9)
  expect(row.setpointC).toBeNull()
  expect(row.hours).toBe(4)
})

test('only hours in [from, to) are read', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T06:00:00Z')
  const [row] = await monthSums({
    from: new Date('2026-01-15T02:00:00Z'),
    to: new Date('2026-01-15T05:00:00Z'),
  })
  expect(row.hours).toBe(3)
  expect(row.firstHour).toEqual(new Date('2026-01-15T02:00:00Z'))
  expect(row.lastHour).toEqual(new Date('2026-01-15T04:00:00Z'))
})

test('a renamed unit reads under its current name, history kept', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T02:00:00Z')
  await upsertUnits([{ guid: 'CS-HZ25ZKE+0000000001', name: 'Matsalen', model: 'CS-HZ25ZKE' }], new Date())
  const rows = await monthSums(all)
  expect(rows.map((r) => [r.heatPumpId, r.name, r.hours])).toEqual([[id.Matsal, 'Matsalen', 2]])
})

test('privacy: a row holds sums only, never an hour', async () => {
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-01-15T00:00:00Z', '2026-01-15T03:00:00Z')
  const [row] = await monthSums(all)
  expect(Object.keys(row).sort()).toEqual([
    'coolKwh',
    'firstHour',
    'heatKwh',
    'heatPumpId',
    'hours',
    'insideC',
    'kwh',
    'lastHour',
    'month',
    'name',
    'outsideC',
    'setpointC',
    'year',
  ])
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `bunx vitest run --project node src/lib/services/heatPump/monthSums.test.ts`
Expected: FAIL ("Cannot find module './monthSums'").

- [ ] **Step 4: Implement** (`monthSums.ts`)

```ts
import { and, gte, lt, sql, eq } from 'drizzle-orm'
import { db } from '~/lib/db'
import { heatPump, heatPumpReading } from '~/lib/db/schema'

/** One unit's sums over one Stockholm month (ADR-0027). */
export type HeatPumpMonthRow = {
  heatPumpId: string
  name: string
  year: number
  /** 1–12, Stockholm. */
  month: number
  kwh: number
  /** Σ kWh × heating share (an hour without a share counts 0); `coolKwh` likewise. */
  heatKwh: number
  coolKwh: number
  /** Hour-weighted means over the hours that have a value; null when none has. */
  insideC: number | null
  outsideC: number | null
  setpointC: number | null
  /** Hours with a reading. */
  hours: number
  firstHour: Date
  lastHour: Date
}

/**
 * Per unit and Stockholm month, the sums over the unit's readings in [from, to), ordered by name, unit, year and month.
 * A reading is already one whole UTC hour (the table's primary key and hour CHECK), so ADR-0024's rule (sum per UTC
 * hour, then convert the hour to Stockholm time) is one GROUP BY here: Stockholm offsets are whole hours, so every UTC
 * hour lies in exactly one Stockholm month, DST days included. Each row is one hour, so `avg` is the hour-weighted
 * mean. Sums only: an hour never leaves this function (ADR-0027 decision 6). The name is the unit's current one.
 */
export async function monthSums({ from, to }: { from: Date; to: Date }): Promise<HeatPumpMonthRow[]> {
  const local = sql`(${heatPumpReading.hourStart} AT TIME ZONE 'Europe/Stockholm')`
  return db
    .select({
      heatPumpId: heatPumpReading.heatPumpId,
      name: heatPump.name,
      year: sql<number>`extract(year from ${local})::int`,
      month: sql<number>`extract(month from ${local})::int`,
      kwh: sql<number>`sum(${heatPumpReading.energyKwh})`.mapWith(Number),
      heatKwh: sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.heatShare}, 0))`.mapWith(
        Number,
      ),
      coolKwh: sql<number>`sum(${heatPumpReading.energyKwh} * coalesce(${heatPumpReading.coolShare}, 0))`.mapWith(
        Number,
      ),
      insideC: sql<number | null>`avg(${heatPumpReading.insideC})`.mapWith(Number),
      outsideC: sql<number | null>`avg(${heatPumpReading.outsideC})`.mapWith(Number),
      setpointC: sql<number | null>`avg(${heatPumpReading.setpointC})`.mapWith(Number),
      hours: sql<number>`count(*)::int`,
      firstHour: sql<Date>`min(${heatPumpReading.hourStart})`.mapWith(heatPumpReading.hourStart),
      lastHour: sql<Date>`max(${heatPumpReading.hourStart})`.mapWith(heatPumpReading.hourStart),
    })
    .from(heatPumpReading)
    .innerJoin(heatPump, eq(heatPump.id, heatPumpReading.heatPumpId))
    .where(and(gte(heatPumpReading.hourStart, from), lt(heatPumpReading.hourStart, to)))
    .groupBy(sql`1, 2, 3, 4`)
    .orderBy(sql`2, 1, 3, 4`)
}
```

(Drizzle passes a null aggregate through without calling `mapWith`, so the means stay null. If the names sort
differently from `byHeatPumpName` under the database's collation, that's fine: `getEnergyOverview` re-sorts in JS.)

`index.ts`: add `export * from './monthSums'`.

- [ ] **Step 5: Run** `bunx vitest run --project node src/lib/services/heatPump` → PASS (1a's tests too).

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/services/heatPump/monthSums.ts src/lib/services/heatPump/monthSums.test.ts \
  src/lib/services/heatPump/index.ts test/fixtures/heatPumpHours.ts
git commit -m "feat(heat-pumps): sum readings per Stockholm month" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Heat pumps in `energy.overview` (+ `heatPumpMs`)

**Reviewers:** `code-reviewer` + `test-completeness` (both told: assume the expected hours are clipped wrong somewhere —
a total, the newest month, a unit's first hour — and that an hourly row can reach the output; the procedure gate is
unchanged).

**Files:**
- Modify: `src/lib/services/houseEnergy/energyOverview.ts`, `src/lib/services/houseEnergy/energyOverview.test.ts`,
  `src/lib/orpc/procedures/energy.ts`, `src/lib/orpc/procedures/energy.test.ts`

**Interfaces:**
- Consumes: `monthSums`, `HeatPumpMonthRow` (Task 2); `HeatPumpPeriod`, `byHeatPumpName` (Task 1);
  `STALE_AFTER_MS.comfortCloud` (13 h, step 1b's `src/lib/services/integrationSync/policy.ts`).
- Produces: every `PeriodSums` from `getEnergyOverview` carries `heatPumps` (name order, expected hours clipped);
  `getEnergyOverview({ timings })` fills `timings.heatPumpMs`; the RPC's `context.timings.heatPumpMs`.

- [ ] **Step 1: Write the failing tests** (append to `energyOverview.test.ts`; import `seedUnits`, `storeHours` from
  `~test/fixtures/heatPumpHours`)

```ts
test('heat pumps per month in name order, expected hours from each unit’s first hour', async () => {
  // House: 10 May → 1 June 2026 (Stockholm), now 2 June. Coverage starts 2026-05-09T22:00Z; the newest bucket ends
  // 2026-06-01T22:00Z.
  for (let d = 10; d <= 31; d++) await storeDay(`2026-05-${String(d).padStart(2, '0')}`, { loadKwh: 0.1 })
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  const id = await seedUnits('Övervåning', 'Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-06-01T22:00:00Z')
  // Övervåning starts on 20 May at 10:00Z: May expects 276 h of it, not 528.
  await storeHours(id.Övervåning, '2026-05-20T10:00:00Z', '2026-06-01T22:00:00Z', () => ({ energyKwh: 0.2 }))
  const o = await overview({ year: 2026, now: new Date('2026-06-02T08:00:00Z') })
  const may = o.months[4]?.heatPumps ?? []
  expect(may.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 528, 528],
    ['Övervåning', 276, 276],
  ])
  expect(may[0].kwh).toBeCloseTo(52.8, 9)
  expect(may[1].kwh).toBeCloseTo(55.2, 9)
  expect(may[0].id).toBe(id.Matsal)
  // June: the newest month ends at the newest house bucket (24 h).
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([
    [24, 24],
    [24, 24],
  ])
  // The totals: each unit from its first hour (or the first house day) to the newest bucket.
  expect(o.yearTotal?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([
    [552, 552],
    [300, 300],
  ])
  expect(o.allTime?.heatPumps.map((u) => u.name)).toEqual(['Matsal', 'Övervåning'])
})

test('heat pump hours outside the house data’s range are not read', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  // 9 May (before the first house day) and 10 May: only the 10th's 24 Stockholm hours count.
  await storeHours(id.Matsal, '2026-05-08T22:00:00Z', '2026-05-10T23:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-05-11T08:00:00Z') })
  expect(o.months[4]?.heatPumps[0].hours).toBe(24)
  expect(o.months[4]?.heatPumps[0].kwh).toBeCloseTo(2.4, 9)
})

test('a period before a unit’s first reading has no heat pump', async () => {
  await storeDay('2026-04-15', { loadKwh: 0.1 })
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-05-10T22:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-05-11T08:00:00Z') })
  expect(o.months[3]?.heatPumps).toEqual([])
  expect(o.months[4]?.heatPumps).toHaveLength(1)
})

test('a unit offline for a whole month is listed with all its hours missing', async () => {
  await storeDay('2026-05-10', { loadKwh: 0.1 })
  await storeDay('2026-06-15', { loadKwh: 0.1 })
  await storeDay('2026-07-01', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-05-09T22:00:00Z', '2026-05-10T22:00:00Z')
  await storeHours(id.Matsal, '2026-06-30T22:00:00Z', '2026-07-01T22:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-07-02T08:00:00Z') })
  expect(o.months[5]?.heatPumps).toEqual([
    { id: id.Matsal, name: 'Matsal', kwh: 0, hours: 0, expectedHours: 720 },
  ])
})

test('a trailing lag under 13 h is the sync’s normal delay, not missing', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 }) // newest bucket ends 2026-06-01T22:00Z
  const id = await seedUnits('Matsal')
  // The last Comfort Cloud run stored up to 15:00Z: six hours behind the house data.
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T16:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[18, 18]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(0)
})

test('a trailing gap of 13 h or more counts as missing in full', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  await storeDay('2026-06-02', { loadKwh: 0.1 }) // newest bucket ends 2026-06-02T22:00Z
  const id = await seedUnits('Matsal')
  // Stored up to 07:00Z: 14 h behind.
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-02T08:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-02T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[34, 48]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(14)
})

test('the stale threshold: a 13 h trailing gap counts, a 12 h one does not', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 }) // newest bucket ends 2026-06-01T22:00Z
  const id = await seedUnits('Matsal', 'Övervåning')
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T09:00:00Z') // stored end 09:00Z → 13 h
  await storeHours(id.Övervåning, '2026-05-31T22:00:00Z', '2026-06-01T10:00:00Z') // stored end 10:00Z → 12 h
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.name, u.hours, u.expectedHours])).toEqual([
    ['Matsal', 11, 24],
    ['Övervåning', 12, 12],
  ])
})

test('a gap inside the stored hours always counts', async () => {
  await storeDay('2026-06-01', { loadKwh: 0.1 })
  const id = await seedUnits('Matsal')
  // 10:00Z and 11:00Z missing; the rest of the day stored up to the newest house bucket.
  const gap = (t: number) =>
    t >= Date.parse('2026-06-01T10:00:00Z') && t < Date.parse('2026-06-01T12:00:00Z') ? null : {}
  await storeHours(id.Matsal, '2026-05-31T22:00:00Z', '2026-06-01T22:00:00Z', gap)
  const o = await overview({ year: 2026, now: new Date('2026-06-01T22:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[22, 24]])
  expect(energyFigures(o.months[5] as PeriodSums).heatPumpMissingHours).toBe(2)
})

test('a partly covered newest hour counts as expected', async () => {
  // 100 buckets: the newest starts 08:15 local, so the 08:00 hour is expected (9 h from midnight).
  await storeDay('2026-06-02', {}, 100)
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-06-01T22:00:00Z', '2026-06-02T07:00:00Z')
  const o = await overview({ year: 2026, now: new Date('2026-06-02T07:30:00Z') })
  expect(o.months[5]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[9, 9]])
})

test('DST: October 2025 expects 745 heat pump hours', async () => {
  for (let d = 1; d <= 31; d++) await storeDay(`2025-10-${String(d).padStart(2, '0')}`)
  await storeDay('2025-11-01')
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2025-09-30T22:00:00Z', '2025-10-31T23:00:00Z')
  const o = await overview({ year: 2025, now: new Date('2025-11-02T12:00:00Z') })
  expect(o.months[9]?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[745, 745]])
})

test('year total and all time sum the units across years', async () => {
  await storeDay('2025-12-31')
  await storeDay('2026-01-01')
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2025-12-30T23:00:00Z', '2026-01-01T23:00:00Z')
  const o = await overview({ year: 2025, now: new Date('2026-01-02T12:00:00Z') })
  expect(o.yearTotal?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[24, 24]])
  expect(o.allTime?.heatPumps.map((u) => [u.hours, u.expectedHours])).toEqual([[48, 48]])
  expect(o.allTime?.heatPumps[0].kwh).toBeCloseTo(4.8, 9)
})

test('without heat pump readings every period has no heat pumps', async () => {
  await storeDay('2026-02-10')
  const o = await overview({ year: 2026, now: new Date('2026-02-11T12:00:00Z') })
  expect(o.months[1]?.heatPumps).toEqual([])
  expect(o.yearTotal?.heatPumps).toEqual([])
  expect(o.allTime?.heatPumps).toEqual([])
})
```

(Imports for these: `energyFigures`, `type PeriodSums` from `~/lib/houseEnergy/figures`.)

Extend the existing `records the house scan and car timings` test: its `timings` type gains `heatPumpMs?: number` and
it asserts `expect(typeof timings.heatPumpMs).toBe('number')`.

In `energy.test.ts`, replace the privacy test's `flat` helper and add a heat pump case:

```ts
// Every period is a flat object of numbers, plus its heat pumps: flat objects of an id, a name and numbers.
const flatUnit = (u: unknown) =>
  Object.entries(u as object).every(([k, v]) =>
    k === 'id' || k === 'name' ? typeof v === 'string' : typeof v === 'number',
  )
const flat = (p: unknown) =>
  p === null ||
  Object.entries(p as object).every(([k, v]) =>
    k === 'heatPumps' ? Array.isArray(v) && v.every(flatUnit) : v === null || typeof v === 'number',
  )
```

(move it to module level, above the privacy test, and delete the inner one), and:

```ts
test('privacy: the heat pumps reach the output as period sums only, and their timing is recorded', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await refreshMonthSums()
  const id = await seedUnits('Matsal')
  await storeHours(id.Matsal, '2026-02-09T23:00:00Z', '2026-02-10T23:00:00Z')
  await signIn('user')
  const timings: Record<string, number> = {}
  const o = await call(energyRouter.overview, { year: 2026 }, { context: context(timings) })
  const [unit] = o.months[1]?.heatPumps ?? []
  expect(Object.keys(unit).sort()).toEqual(['expectedHours', 'hours', 'id', 'kwh', 'name'])
  expect(unit.hours).toBe(24)
  expect([o.months[1], o.yearTotal, o.allTime].every(flat)).toBe(true)
  expect(typeof timings.heatPumpMs).toBe('number')
})
```

(`import { seedUnits, storeHours } from '~test/fixtures/heatPumpHours'`.)

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project node src/lib/services/houseEnergy/energyOverview.test.ts src/lib/orpc/procedures/energy.test.ts`
Expected: FAIL (every new test: `heatPumps` is `[]`, `heatPumpMs` undefined).

- [ ] **Step 3: Implement** (`energyOverview.ts`)

Imports: add `import { byHeatPumpName, type HeatPumpPeriod } from '~/lib/houseEnergy/figures'` (merge with the
existing figures import), `import { type HeatPumpMonthRow, monthSums } from '~/lib/services/heatPump'` and
`import { STALE_AFTER_MS } from '~/lib/services/integrationSync/policy'`; constant `const HOUR_MS = 60 * 60_000`.

Below `monthRows()`:

```ts
type Span = { startMs: number; endMs: number }

/**
 * A period's heat pumps (ADR-0027) from the unit months: each unit's kWh and hours in the period, and its expected
 * hours clipped like the house buckets (ADR-0024): from the latest of the period's start, the first house reading's
 * day and the unit's first hour, to the earlier of the period's end and the unit's end, in whole hours (a partly
 * covered last hour counts). A unit's end is the newest house bucket's end, but a trailing gap after its newest stored
 * hour counts as missing only from the source's stale threshold (13 h, two missed 6-hourly runs): shorter, it is the
 * sync's normal lag, so the unit ends at its newest stored hour (so in a new month's first hours, before the next run,
 * a unit may have no node in the new month yet). Gaps inside the stored hours always count. A unit with
 * nothing stored and nothing expected is left out, so a period before its first reading has no heat pump. Name order
 * (`byHeatPumpName`).
 */
function heatPumpPeriods(rows: HeatPumpMonthRow[], coverageStartMs: number, newestEndMs: number) {
  const units = new Map<string, { id: string; name: string; firstMs: number; lastMs: number }>()
  for (const r of rows) {
    const firstMs = r.firstHour.getTime()
    const lastMs = r.lastHour.getTime()
    const seen = units.get(r.heatPumpId)
    units.set(r.heatPumpId, {
      id: r.heatPumpId,
      name: r.name,
      firstMs: seen ? Math.min(seen.firstMs, firstMs) : firstMs,
      lastMs: seen ? Math.max(seen.lastMs, lastMs) : lastMs,
    })
  }
  const unitEndMs = (u: { lastMs: number }) => {
    const storedEndMs = u.lastMs + HOUR_MS
    return newestEndMs - storedEndMs >= STALE_AFTER_MS.comfortCloud
      ? newestEndMs
      : Math.min(newestEndMs, storedEndMs)
  }
  const ordered = [...units.values()].sort(byHeatPumpName)
  return (period: Span, inPeriod: (r: HeatPumpMonthRow) => boolean): HeatPumpPeriod[] => {
    return ordered.flatMap((u) => {
      const endMs = Math.min(period.endMs, unitEndMs(u))
      let kwh = 0
      let hours = 0
      for (const r of rows) {
        if (r.heatPumpId !== u.id || !inPeriod(r)) continue
        kwh += r.kwh
        hours += r.hours
      }
      const startMs = Math.max(period.startMs, coverageStartMs, u.firstMs)
      const expected = endMs > startMs ? Math.ceil((endMs - startMs) / HOUR_MS) : 0
      if (expected === 0 && hours === 0) return []
      return [{ id: u.id, name: u.name, kwh, hours, expectedHours: Math.max(expected, hours) }]
    })
  }
}
```

In `getEnergyOverview`:
- the `timings` type becomes `{ houseScanMs?: number; carMs?: number; heatPumpMs?: number }`;
- move `const newestEndMs = newest.lastBucket.getTime() + BUCKET_MS` up, right after `coverageStartMs`;
- replace the car block with:

```ts
  const timed = async <T>(key: 'carMs' | 'heatPumpMs', read: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now()
    const result = await read()
    if (input.timings) input.timings[key] = Math.round(performance.now() - startedAt)
    return result
  }
  // Independent reads, in parallel. The heat pumps are read over the house data's range only: outside it there is
  // no load to share (ADR-0027).
  const [car, unitMonths] = await Promise.all([
    timed('carMs', () => getChargingOverview({ year, now, vehicle: 'all' })),
    timed('heatPumpMs', () =>
      monthSums({ from: new Date(coverageStartMs), to: new Date(newestEndMs) }),
    ),
  ])
  const heatPumpsIn = heatPumpPeriods(unitMonths, coverageStartMs, newestEndMs)
```

- `withExpected` returns, instead of `heatPumps: []`:

```ts
      heatPumps: heatPumpsIn(
        bounds,
        (r) => r.year === row.year && r.month === row.month,
      ),
```

- `total` takes a third parameter `inPeriod: (r: HeatPumpMonthRow) => boolean` and returns
  `{ ...sums, expectedBuckets: Math.max(expected, sums.buckets), heatPumps: heatPumpsIn(period, inPeriod) }`
  (the merged `heatPumps` of `addPeriodSums` are replaced: a total's expected hours come from its bounds, so a month
  without readings counts as missing, as for the buckets);
- the year total passes `(r) => r.year === year`; all time passes `() => true`.

Update the doc comment of `getEnergyOverview`: "… and, per period, each heat pump's kWh with its expected hours
(heat pumps step 2)."

`energy.ts` (procedure): the `timings` object type gains `heatPumpMs?: number`, and inside the `if (context.timings)`
block add `if (timings.heatPumpMs !== undefined) context.timings.heatPumpMs = timings.heatPumpMs`; the comment above
`overview` names the third sub-timing ("… plus the service's sub-timings (houseScanMs, carMs, heatPumpMs; the car and
heat pump reads run in parallel)").

- [ ] **Step 4: Run** the two files from Step 2, then `bunx vitest run --project node src/lib/services src/lib/orpc`
  → PASS.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/services/houseEnergy/energyOverview.ts src/lib/services/houseEnergy/energyOverview.test.ts \
  src/lib/orpc/procedures/energy.ts src/lib/orpc/procedures/energy.test.ts
git commit -m "feat(energy): read the heat pumps into the energy overview" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Validated heat pump colours

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` and the `dataviz` skill (re-runs the
validator commands below and checks the `@theme` names).

**Files:**
- Modify: `src/styles/app.css`
- Create: `src/lib/houseEnergy/heatPumpColors.ts`, `src/lib/houseEnergy/heatPumpColors.test.ts`

**Interfaces:**
- Produces: `--energy-heat-pump-1..3` (+ `bg-energy-heat-pump-N` utilities);
  `HEAT_PUMP_COLORS: readonly ['var(--energy-heat-pump-1)', 'var(--energy-heat-pump-2)', 'var(--energy-heat-pump-3)']`;
  `heatPumpColor(units: readonly { id: string }[], id: string): string` (index in `units`; a fourth unit or an unknown
  id → `'var(--muted-foreground)'`). Step 3 reuses both.

- [ ] **Step 1: Validate** (load the `dataviz` skill; `V` is its base directory). The sets are what a viewer sees
  together: the stack for one, two and three units, in stack order (laddning, units, övrigt hus).

```bash
V=$(ls -d /private/tmp/claude-*/bundled-skills/*/*/dataviz 2>/dev/null | head -1)   # or the dataviz skill's base dir
for s in "light #ffffff #4a3aa7,#1597ad,#eb6834" "light #ffffff #4a3aa7,#1597ad,#a1286a,#eb6834" \
         "light #ffffff #4a3aa7,#1597ad,#a1286a,#3d5fd6,#eb6834" "dark #1c1c1f #9085e9,#1a9db0,#d95926" \
         "dark #1c1c1f #9085e9,#1a9db0,#b33c86,#d95926" "dark #1c1c1f #9085e9,#1a9db0,#b33c86,#5b7be8,#d95926"; do
  bash -c "set -- $s; node $V/scripts/validate_palette.js \"\$3\" --mode \$1 --surface \"\$2\""; done
```

Expected (planning run, 2026-10-11): `→ ALL CHECKS PASS` for all six, no `[WARN]`: contrast ≥ 3:1 for every colour in
both themes; worst adjacent CVD ΔE 13.3 light / 8.3 dark; normal-vision floor ≥ 16. Rejected on the way: olive or lime
for a unit (deutan/protan 0.9–2.5 against övrigt hus orange), a darker plum in dark (2.75:1), teal `#1597ab` with plum in
dark (CVD 7.1, warn band). Blue sits only in slot 3 (a third unit, hypothetical today); it is shifted towards indigo
(`#3d5fd6` / `#5b7be8`) from Såld's blue and never shares a chart with it.

- [ ] **Step 2: The tokens** (`src/styles/app.css`)

`@theme inline`, after `--color-energy-loss`:

```css
    --color-energy-heat-pump-1: var(--energy-heat-pump-1);
    --color-energy-heat-pump-2: var(--energy-heat-pump-2);
    --color-energy-heat-pump-3: var(--energy-heat-pump-3);
```

`:root`, after `--energy-loss`:

```css
  /* The heat pumps (ADR-0027 step 2), by unit order: validated with laddning and övrigt hus in stack order for one,
     two and three units (light on #fff / dark on #1c1c1f), each ≥ 3:1. */
  --energy-heat-pump-1: #1597ad;
  --energy-heat-pump-2: #a1286a;
  --energy-heat-pump-3: #3d5fd6;
```

`.dark`, after `--energy-loss`:

```css
  --energy-heat-pump-1: #1a9db0;
  --energy-heat-pump-2: #b33c86;
  --energy-heat-pump-3: #5b7be8;
```

- [ ] **Step 3: Failing test** (`heatPumpColors.test.ts`)

```ts
import { expect, test } from 'vitest'
import { HEAT_PUMP_COLORS, heatPumpColor } from './heatPumpColors'

const units = [{ id: 'hp-a' }, { id: 'hp-b' }, { id: 'hp-c' }, { id: 'hp-d' }]

test('a unit’s colour is its place in the all-time order', () => {
  expect(heatPumpColor(units, 'hp-a')).toBe('var(--energy-heat-pump-1)')
  expect(heatPumpColor(units, 'hp-b')).toBe('var(--energy-heat-pump-2)')
  expect(heatPumpColor(units, 'hp-c')).toBe('var(--energy-heat-pump-3)')
  expect(HEAT_PUMP_COLORS).toHaveLength(3)
})

test('a fourth unit or an unknown id is neutral, never a cycled colour', () => {
  expect(heatPumpColor(units, 'hp-d')).toBe('var(--muted-foreground)')
  expect(heatPumpColor(units, 'nope')).toBe('var(--muted-foreground)')
})
```

Run: `bunx vitest run --project node src/lib/houseEnergy/heatPumpColors.test.ts` → FAIL (no module).

- [ ] **Step 4: Implement** (`heatPumpColors.ts`)

```ts
// Client-safe (heat pumps step 2, ADR-0027). A unit's colour is its place in the all-time unit order (name order), so
// it keeps its colour whatever a period or a year shows (data-viz: colour follows the entity, never its rank). Three
// validated tokens; a fourth unit gets no colour of its own (never cycled): neutral, its name carries identity.
export const HEAT_PUMP_COLORS = [
  'var(--energy-heat-pump-1)',
  'var(--energy-heat-pump-2)',
  'var(--energy-heat-pump-3)',
] as const

export function heatPumpColor(units: readonly { id: string }[], id: string): string {
  return HEAT_PUMP_COLORS[units.findIndex((u) => u.id === id)] ?? 'var(--muted-foreground)'
}
```

(`findIndex` → −1 for an unknown id; `HEAT_PUMP_COLORS[-1]` is undefined.)

- [ ] **Step 5: Run** the test → PASS. **Commit**

```bash
bun run check
git add src/styles/app.css src/lib/houseEnergy/heatPumpColors.ts src/lib/houseEnergy/heatPumpColors.test.ts
git commit -m "feat(energy): add validated heat pump colours" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Användning geometry (`usageFlowLayout.ts`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told: assume
two arrows overlap or cross, a node leaves the box, or the box height depends on the node count).

**Files:**
- Modify: `src/lib/houseEnergy/flowLayout.ts` (`export const ARROW_LENGTH = 9`, was a private `const`)
- Create: `src/lib/houseEnergy/usageFlowLayout.ts`, `src/lib/houseEnergy/usageFlowLayout.test.ts`

**Interfaces:**
- Consumes: `flowEdge`, `flowWidth`, `flowCurve` (tests), `FlowGraph`, `FlowEdgeSpec`, `FlowNode`, `NodeText`,
  `NODE_PADDING`, `FIGURE_MIN_SIZE`, `MIN_FLOW_KWH`, `WIDE_MIN_WIDTH`, `ARROW_LENGTH` (flowLayout); `EnergyFigures`.
- Produces:
  - `type UseConsumerKey = 'car' | 'house' | \`hp:${string}\``, `type UseNodeKey = 'load' | UseConsumerKey`
  - `type UseConsumer = { key: UseConsumerKey; kwh: number }`
  - `type UseFlow = { spec: FlowEdgeSpec<UseNodeKey>; kwh: number; width: number }`
  - `type UseFlowLayout = FlowGraph<UseNodeKey> & { flows: UseFlow[] }`
  - `USE_WIDE_HEIGHT = 312`, `USE_NARROW_HEIGHT = 436`, `USE_LANE = 88`
  - `usageConsumers(f: EnergyFigures): UseConsumer[]` — car, units in figure order, house
  - `stackPorts(widths: readonly number[], room: number): number[]`
  - `usageFlowLayout(width: number, consumers: readonly UseConsumer[]): UseFlowLayout`
  - `usageNodeText(node: FlowNode, key: UseNodeKey, narrow: boolean): NodeText`

Named `usageFlowLayout.ts` (coordinator ruling, not the brief's `useFlowLayout.ts`): nothing in it is a React hook, so
neither the file nor an export starts with `use` (CLAUDE.md's `useX` naming is for hooks).

- [ ] **Step 1: Write the failing tests** (`usageFlowLayout.test.ts`)

```ts
import { describe, expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from './figures'
import { ARROW_LENGTH, flowCurve, NODE_PADDING } from './flowLayout'
import {
  stackPorts,
  type UseConsumer,
  USE_LANE,
  USE_NARROW_HEIGHT,
  USE_WIDE_HEIGHT,
  usageConsumers,
  usageFlowLayout,
  usageNodeText,
} from './usageFlowLayout'

type Box = { x: number; y: number; w: number; h: number }
const overlap = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h
type P = { x: number; y: number }
const side = (a: P, b: P, c: P) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
const cross = (p: P[], q: P[]) => {
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++)
      if (
        side(p[i - 1], p[i], q[j - 1]) * side(p[i - 1], p[i], q[j]) < 0 &&
        side(q[j - 1], q[j], p[i - 1]) * side(q[j - 1], q[j], p[i]) < 0
      )
        return true
  return false
}

// September-like shares: house the largest, the car next, two units smaller.
const two: UseConsumer[] = [
  { key: 'car', kwh: 300 },
  { key: 'house', kwh: 390 },
]
const four: UseConsumer[] = [
  { key: 'car', kwh: 300 },
  { key: 'hp:hp-a', kwh: 150 },
  { key: 'hp:hp-b', kwh: 60 },
  { key: 'house', kwh: 390 },
]
const five: UseConsumer[] = [...four.slice(0, 3), { key: 'hp:hp-c', kwh: 40 }, four[3]]

test('usageConsumers: laddning, the units in figure order, övrigt hus', () => {
  const s: PeriodSums = {
    gridImportKwh: 0,
    gridExportKwh: 0,
    solarKwh: 0,
    loadKwh: 900,
    batteryDischargeKwh: 0,
    batteryChargeSolarKwh: 0,
    batteryChargeGridKwh: 0,
    carKwh: 300,
    firstSocPct: null,
    lastSocPct: null,
    buckets: 1,
    expectedBuckets: 1,
    heatPumps: [
      { id: 'hp-a', name: 'Matsal', kwh: 150, hours: 1, expectedHours: 1 },
      { id: 'hp-b', name: 'Övervåning', kwh: 60, hours: 1, expectedHours: 1 },
    ],
  }
  expect(usageConsumers(energyFigures(s))).toEqual(four)
})

test('stackPorts lays widths side by side, 2 px apart, centred; squeezes evenly when they do not fit', () => {
  expect(stackPorts([10, 4], 30)).toEqual([12, 21]) // 16 wide in 30: starts at 7 → centres 7 + 5 and 19 + 2
  expect(stackPorts([], 30)).toEqual([])
  const squeezed = stackPorts([20, 20, 20], 40)
  expect(squeezed[0]).toBe(10)
  expect(squeezed[2]).toBe(30)
})

test('the 860 px rule: 859 is narrow, 860 is wide', () => {
  expect(usageFlowLayout(859, four).narrow).toBe(true)
  expect(usageFlowLayout(860, four).narrow).toBe(false)
})

describe.each([256, 296, 311, 324, 380, 754, 859, 860, 1006])('at %i px', (width) => {
  test.each([
    ['two', two],
    ['four', four],
    ['five', five],
  ] as const)('%s consumers: a fixed height, every node inside, none overlapping', (_n, consumers) => {
    const layout = usageFlowLayout(width, consumers)
    expect(layout.height).toBe(width < 860 ? USE_NARROW_HEIGHT : USE_WIDE_HEIGHT)
    const keys = Object.keys(layout.nodes) as (keyof typeof layout.nodes)[]
    expect(keys).toEqual(['load', ...consumers.map((c) => c.key)])
    for (const k of keys) {
      const n = layout.nodes[k]
      expect(n.x - n.w / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w / 2, k).toBeLessThanOrEqual(width)
      expect(n.y - n.h / 2, k).toBeGreaterThanOrEqual(0)
      expect(n.y + n.h / 2, k).toBeLessThanOrEqual(layout.height)
    }
    for (const a of keys) for (const b of keys) if (a < b) expect(overlap(layout.nodes[a], layout.nodes[b]), `${a}/${b}`).toBe(false)
    // Consumers top to bottom in the given order.
    const ys = consumers.map((c) => layout.nodes[c.key].y)
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
  })

  test('the arrows leave the load side by side and never cross', () => {
    const layout = usageFlowLayout(width, four)
    const load = layout.nodes.load
    for (let i = 1; i < layout.flows.length; i++) {
      const a = layout.flows[i - 1]
      const b = layout.flows[i]
      const gap = layout.narrow
        ? a.spec.fromOffset - b.spec.fromOffset // narrow: the lower consumer's arrow sits further left
        : b.spec.fromOffset - a.spec.fromOffset // wide: in order from the top
      expect(gap).toBeGreaterThanOrEqual((a.width + b.width) / 2 + 2 - 1e-9)
    }
    for (const f of layout.flows) {
      if (layout.narrow) {
        const x = load.x + f.spec.fromOffset
        expect(x - f.width / 2).toBeGreaterThanOrEqual(1)
        // The ports' strip ends where an arrow still has 24 px to turn and its arrowhead before the column.
        expect(x + f.width / 2).toBeLessThanOrEqual(USE_LANE - ARROW_LENGTH - 24 + 1e-9)
      } else {
        expect(Math.abs(f.spec.fromOffset) + f.width / 2).toBeLessThanOrEqual(load.h / 2)
      }
    }
    const curves = layout.flows.map((f) => {
      const c = flowCurve(layout, f.spec)
      return Array.from({ length: 41 }, (_, i) => c.at(i / 40))
    })
    for (let i = 0; i < curves.length; i++)
      for (let j = i + 1; j < curves.length; j++) expect(cross(curves[i], curves[j]), `${i}/${j}`).toBe(false)
  })
})

test('wide: the value pills sit at least 30 px apart', () => {
  const layout = usageFlowLayout(1006, five)
  const ys = layout.flows.map((f) => flowCurve(layout, f.spec).at(f.spec.labelT).y)
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(30)
})

test('narrow: each arrow runs down the lane, left of the consumer column', () => {
  const layout = usageFlowLayout(311, four)
  for (const f of layout.flows) {
    const pts = Array.from({ length: 41 }, (_, i) => flowCurve(layout, f.spec).at(i / 40))
    const target = layout.nodes[f.spec.to]
    // Until it reaches its node's row, the arrow stays inside the lane.
    for (const p of pts) if (p.y < target.y - target.h / 2) expect(p.x).toBeLessThanOrEqual(USE_LANE)
  }
})

test('a consumer under 0,05 kWh has a node but no arrow; nothing drawn leaves the nodes placed', () => {
  const layout = usageFlowLayout(1006, [{ key: 'car', kwh: 0.01 }, { key: 'house', kwh: 390 }])
  expect(layout.nodes.car).toBeDefined()
  expect(layout.flows.map((f) => f.spec.to)).toEqual(['house'])
  const none = usageFlowLayout(1006, [{ key: 'car', kwh: 0 }, { key: 'house', kwh: 0 }])
  expect(none.flows).toEqual([])
  expect(Object.keys(none.nodes)).toEqual(['load', 'car', 'house'])
})

test('arrow widths are the data: linear in kWh, the largest 20 px wide / 16 px narrow', () => {
  const wide = usageFlowLayout(1006, four)
  expect(wide.flows.find((f) => f.spec.to === 'house')?.width).toBe(20)
  expect(wide.flows.find((f) => f.spec.to === 'car')?.width).toBeCloseTo((20 * 300) / 390, 9)
  expect(usageFlowLayout(311, four).flows.find((f) => f.spec.to === 'house')?.width).toBe(16)
})

describe.each([256, 311, 1006])('node text at %i px', (width) => {
  test('every node’s text starts inside it and leaves the figure room', () => {
    const layout = usageFlowLayout(width, five)
    for (const key of Object.keys(layout.nodes) as (keyof typeof layout.nodes)[]) {
      const n = layout.nodes[key]
      const t = usageNodeText(n, key, layout.narrow)
      expect(t.tile.x).toBeGreaterThanOrEqual(n.x - n.w / 2)
      expect(t.tile.y + t.tile.size).toBeLessThanOrEqual(n.y + n.h / 2)
      expect(t.label.x).toBeLessThan(n.x + n.w / 2 - NODE_PADDING)
      expect(t.value.y).toBeLessThanOrEqual(n.y + n.h / 2)
      expect(t.value.room).toBeGreaterThanOrEqual(90)
    }
  })
})
```

Run: `bunx vitest run --project node src/lib/houseEnergy/usageFlowLayout.test.ts` → FAIL (no module).

- [ ] **Step 2: Implement** (`usageFlowLayout.ts`)

```ts
// Client-safe, pure (heat pumps step 2, ADR-0027). The Användning flow diagram's geometry: the period's load (one node)
// split into its consumers (laddning, each heat pump, övrigt hus). Wide: the load on the left, the consumers in a
// column on the right. Narrow: the load across the top, the consumers in a column below, the arrows down an 88 px lane
// on the left. The arrows leave the load side by side, each as wide as its kWh (Sankey-like), so they never overlap
// at the source and never cross. Built on step 1c's primitives; the box height is fixed for up to five consumers so
// the card never changes size with the period.
import type { EnergyFigures } from './figures'
import {
  ARROW_LENGTH,
  FIGURE_MIN_SIZE,
  type FlowEdgeSpec,
  type FlowGraph,
  type FlowNode,
  flowEdge,
  flowWidth,
  MIN_FLOW_KWH,
  NODE_PADDING,
  type NodeText,
  WIDE_MIN_WIDTH,
} from './flowLayout'

export type UseConsumerKey = 'car' | 'house' | `hp:${string}`
export type UseNodeKey = 'load' | UseConsumerKey
export type UseConsumer = { key: UseConsumerKey; kwh: number }
export type UseFlow = { spec: FlowEdgeSpec<UseNodeKey>; kwh: number; width: number }
export type UseFlowLayout = FlowGraph<UseNodeKey> & {
  /** The drawn arrows (from MIN_FLOW_KWH), in consumer order, with their kWh and stroke width. */
  flows: UseFlow[]
}

export const USE_WIDE_HEIGHT = 312
export const USE_NARROW_HEIGHT = 436
/** Narrow: the strip left of the consumer column that the arrows run down. */
export const USE_LANE = 88
/** Arrows leave the load this far apart. */
const PORT_GAP = 2
/** Narrow: room an arrow needs to turn from down to right before its arrowhead. */
const TURN = 24
/** Narrow: where the first arrow may leave the load's bottom edge. */
const LANE_START = 11

export function usageConsumers(f: EnergyFigures): UseConsumer[] {
  return [
    { key: 'car', kwh: f.car },
    ...f.heatPumps.map((u) => ({ key: `hp:${u.id}` as const, kwh: u.kwh })),
    { key: 'house', kwh: f.restOfHouse },
  ]
}

/**
 * Centres for `widths` laid side by side PORT_GAP apart and centred in [0, room]. When they don't fit (several
 * consumers near the largest), the centres are spread evenly and the arrows overlap a little at the source.
 */
export function stackPorts(widths: readonly number[], room: number): number[] {
  const n = widths.length
  if (n === 0) return []
  const total = widths.reduce((sum, w) => sum + w, 0) + PORT_GAP * (n - 1)
  if (total <= room) {
    let at = (room - total) / 2
    return widths.map((w) => {
      const centre = at + w / 2
      at += w + PORT_GAP
      return centre
    })
  }
  if (n === 1) return [room / 2]
  const first = widths[0] / 2
  const step = (room - first - widths[n - 1] / 2) / (n - 1)
  return widths.map((_, i) => first + i * step)
}

export function usageFlowLayout(width: number, consumers: readonly UseConsumer[]): UseFlowLayout {
  const narrow = width < WIDE_MIN_WIDTH
  const n = Math.max(1, consumers.length)
  const drawn = consumers.filter((c) => c.kwh >= MIN_FLOW_KWH)
  const max = Math.max(0, ...drawn.map((c) => c.kwh))
  const widths = drawn.map((c) => flowWidth(c.kwh, max, narrow))
  const nodes = {} as Record<UseNodeKey, FlowNode>
  let flows: UseFlow[]
  if (!narrow) {
    const H = USE_WIDE_HEIGHT
    const load: FlowNode = { x: 236 / 2 + 1, y: H / 2, w: 236, h: 124 }
    nodes.load = load
    // Five consumers fill the box exactly (5 × 52 + 4 × 12 = 308); fewer are centred on the load.
    const pitch = Math.min(64, (H - 4 + 12) / n)
    const h = pitch - 12
    const top = (H - (consumers.length * pitch - 12)) / 2
    consumers.forEach((c, i) => {
      nodes[c.key] = { x: width - 280 / 2 - 1, y: top + h / 2 + i * pitch, w: 280, h }
    })
    // The arrows leave the load's right side top to bottom in consumer order.
    const room = load.h - 24
    const centres = stackPorts(widths, room)
    flows = drawn.map((c, i) => ({
      spec: flowEdge<UseNodeKey>('load', c.key, 'r', centres[i] - room / 2, 'l', 0, 0.5, 0.5, 0.65),
      kwh: c.kwh,
      width: widths[i],
    }))
  } else {
    const H = USE_NARROW_HEIGHT
    const load: FlowNode = { x: width / 2, y: 33, w: width - 2, h: 64 }
    nodes.load = load
    const top = load.h + 1 + 28
    const pitch = Math.min(66, (H - top - 2 + 10) / n)
    const h = pitch - 10
    const w = width - USE_LANE - 2
    consumers.forEach((c, i) => {
      nodes[c.key] = { x: 1 + USE_LANE + w / 2, y: top + h / 2 + i * pitch, w, h }
    })
    // The arrows leave the load's bottom inside the lane, the lowest consumer's outermost (left): each turns right
    // into its node below the ones above it, so none crosses another. Down first, then a late turn (k1 1, k2 0).
    const room = USE_LANE - ARROW_LENGTH - TURN - LANE_START // 44 px, from x = 11
    const centres = stackPorts([...widths].reverse(), room).reverse()
    flows = drawn.map((c, i) => ({
      spec: flowEdge<UseNodeKey>('load', c.key, 'b', LANE_START + centres[i] - load.x, 'l', 0, 1, 0),
      kwh: c.kwh,
      width: widths[i],
    }))
  }
  return { narrow, height: narrow ? USE_NARROW_HEIGHT : USE_WIDE_HEIGHT, nodes, edges: flows.map((f) => f.spec), flows }
}

/**
 * Where a node's tile and text go. The load: wide, step 1c's big tile with the label and the figure beside it;
 * narrow, a small tile with the two rows beside it. A consumer: a small tile, the name on the first row and
 * "kWh · share" on the second (the figure steps down from 16 px to fit).
 */
export function usageNodeText(node: FlowNode, key: UseNodeKey, narrow: boolean): NodeText {
  const x0 = node.x - node.w / 2
  const y0 = node.y - node.h / 2
  const value = (x: number, y: number, size: number, minSize: number) => ({
    x,
    y,
    size,
    minSize,
    room: x0 + node.w - NODE_PADDING - x,
  })
  if (key === 'load') {
    if (narrow) {
      const tile = { x: x0 + 12, y: y0 + 15, size: 34, icon: 20 }
      return { tile, label: { x: x0 + 56, y: y0 + 28 }, value: value(x0 + 56, y0 + 52, 20, 16), second: null, third: null }
    }
    const tile = { x: x0 + 12, y: node.y - 24, size: 48, icon: 28 }
    return {
      tile,
      label: { x: x0 + 72, y: node.y - 6 },
      value: value(x0 + 72, node.y + 24, 28, FIGURE_MIN_SIZE),
      second: null,
      third: null,
    }
  }
  const tile = { x: x0 + 10, y: node.y - 16, size: 32, icon: 18 }
  return { tile, label: { x: x0 + 52, y: node.y - 4 }, value: value(x0 + 52, node.y + 16, 16, 13), second: null, third: null }
}
```

(With four consumers in September-like shares the narrow arrows are 16 + 12,3 + 6,2 + 2,5 px wide: 43 px with the
gaps, inside the 44 px strip. Five consumers can exceed it; `stackPorts` then spreads them evenly.)

Run: `bunx vitest run --project node src/lib/houseEnergy/usageFlowLayout.test.ts src/lib/houseEnergy/flowLayout.test.ts`
Expected: PASS. If the crossing or lane test fails at 256 px, lower the narrow consumer pitch only (never the box
height), re-run, and note the change in the PR.

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/lib/houseEnergy/flowLayout.ts src/lib/houseEnergy/usageFlowLayout.ts src/lib/houseEnergy/usageFlowLayout.test.ts
git commit -m "feat(energy): lay out the usage flow diagram" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Användning card body (`EnergyUseFlowDiagram`, `EnergyUseFlow`) + its messages

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told: assume a
label overflows its node, a colour follows the period instead of the unit, or the box changes height; Summering's and
Batteri's tests must pass unchanged after the `flowParts` additions).

**Files:**
- Modify: `src/components/energy/flowParts.tsx`, `messages/sv.json`, `messages/en.json`
- Create: `src/components/energy/EnergyUseFlowDiagram.tsx`, `src/components/energy/EnergyUseFlowDiagram.browser.test.tsx`,
  `src/components/energy/EnergyUseFlow.tsx`, `src/components/energy/EnergyUseFlow.browser.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 4, 5.
- Produces:
  - `flowParts.tsx`: `useFontsReady(): boolean`; `useFittedText(ref, text, x, room): string`; `NodeFrame` prop
    `labelRef?: React.Ref<SVGTextElement>`; `FlowValuesSwitch` prop `switchClassName?: string`; `FlowTableFrame` props
    `columns?: string[]`, `rows: string[][]`
  - `EnergyUseFlowDiagram({ sums, figures, units, width, showValues })`
  - `EnergyUseFlow({ sums, units }: { sums: PeriodSums | null | 'unavailable'; units: readonly { id: string; name: string }[] })`
  - messages `energy_use_heading`, `energy_use_description`, `energy_use_hint`, `energy_use_house`,
    `energy_use_missing_hours`, `energy_use_table_consumer`, `energy_use_table_energy`, `energy_use_table_share`,
    `energy_heat_pump_name`

- [ ] **Step 1: Messages.** After `"energy_flow_table_value"` in `messages/sv.json`:

```json
  "energy_use_heading": "Användning",
  "energy_use_description": "Periodens förbrukning fördelad på laddning, värmepumpar och övrigt hus. Värdena finns också i tabellen under diagrammet.",
  "energy_use_hint": "Pilens bredd visar mängden energi.",
  "energy_use_house": "Övrigt hus",
  "energy_use_missing_hours": "Värmepumpsdata saknas för {hours} h",
  "energy_use_table_consumer": "Förbrukare",
  "energy_use_table_energy": "Energi",
  "energy_use_table_share": "Andel",
  "energy_heat_pump_name": "Värmepump {name}",
```

and in `messages/en.json`:

```json
  "energy_use_heading": "Usage",
  "energy_use_description": "The period's consumption split into charging, heat pumps and the rest of the house. The values are also in the table below the diagram.",
  "energy_use_hint": "The arrow's width shows the amount of energy.",
  "energy_use_house": "Rest of the house",
  "energy_use_missing_hours": "Heat pump data missing for {hours} h",
  "energy_use_table_consumer": "Consumer",
  "energy_use_table_energy": "Energy",
  "energy_use_table_share": "Share",
  "energy_heat_pump_name": "Heat pump {name}",
```

Run `bun run i18n:compile`.

- [ ] **Step 2: `flowParts.tsx` additions** (behaviour-preserving for existing callers)

Extract the fonts effect from `useFittedSize` into:

```ts
/** True once the body font has loaded (it changes text widths after first paint). */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    document.fonts?.ready.then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [])
  return ready
}
```

and in `useFittedSize` replace its own state + effect with `const fontsLoaded = useFontsReady()`. Add:

```ts
/**
 * `text`, cut with "…" one character at a time until it fits `room` px from `x` (a user-set name on a phone node),
 * measured before paint and again once the body font has loaded. The full text stays in the tooltip and the table.
 */
export function useFittedText(
  ref: React.RefObject<SVGTextElement | null>,
  text: string,
  x: number,
  room: number,
): string {
  const fontsLoaded = useFontsReady()
  const key = `${text}|${room}|${fontsLoaded}`
  const [fit, setFit] = useState({ key, length: text.length })
  const length = fit.key === key ? fit.length : text.length
  const shown = length >= text.length ? text : `${text.slice(0, Math.max(1, length)).trimEnd()}…`
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || length <= 1) return
    const b = el.getBBox()
    if (b.x + b.width > x + room) setFit({ key, length: length - 1 })
  }, [ref, key, length, room, x])
  return shown
}
```

`NodeFrame`: new optional prop `labelRef?: React.Ref<SVGTextElement>` passed as `ref={labelRef}` on the label `<text>`.

`FlowValuesSwitch`: new optional prop `switchClassName?: string`; the `<label>`'s className becomes
`cn('flex min-h-10 cursor-pointer items-center gap-2.5 text-sm', switchClassName)` (import `cn` from `~/lib/utils`).

`FlowTableFrame`:

```tsx
/** The Flöde / Värde table (or `columns`): `rows` first (the first cell names the row), then `children`. */
export function FlowTableFrame({
  columns = [m.energy_flow_table_flow(), m.energy_flow_table_value()],
  rows,
  children,
}: {
  columns?: string[]
  rows: string[][]
  children?: React.ReactNode
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {columns.map((c, i) => (
              <th key={c} scope="col" className={i === 0 ? 'py-1.5 pr-4 font-medium' : 'py-1.5 pl-4 text-right font-medium'}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ...values]) => (
            <tr key={name} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {name}
              </th>
              {values.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are positional
                <td key={i} className="py-1.5 pl-4 text-right tabular-nums">
                  {v}
                </td>
              ))}
            </tr>
          ))}
          {children}
        </tbody>
      </table>
    </div>
  )
}
```

(The two-column tables keep their look: the value header and cell only gain `pl-4`, invisible in a right-aligned
column. Existing `[string, string][]` rows are assignable to `string[][]`.)

Run: `bunx vitest run --project browser src/components/energy` → PASS unchanged.

- [ ] **Step 3: Write the failing diagram tests** (`EnergyUseFlowDiagram.browser.test.tsx`)

```tsx
import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { energyFigures, type HeatPumpPeriod, type PeriodSums } from '~/lib/houseEnergy/figures'
import { NODE_PADDING } from '~/lib/houseEnergy/flowLayout'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyUseFlowDiagram } from './EnergyUseFlowDiagram'

const unit = (id: string, name: string, kwh: number): HeatPumpPeriod => ({ id, name, kwh, hours: 720, expectedHours: 720 })
const units = [
  { id: 'hp-a', name: 'Matsal' },
  { id: 'hp-b', name: 'Övervåning' },
]
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 900,
  batteryDischargeKwh: 225,
  batteryChargeSolarKwh: 173,
  batteryChargeGridKwh: 68,
  carKwh: 300,
  firstSocPct: 30,
  lastSocPct: 40,
  buckets: 8640,
  expectedBuckets: 8640,
  heatPumps: [unit('hp-a', 'Matsal', 150), unit('hp-b', 'Övervåning', 60)],
  ...over,
})
const draw = (s: PeriodSums, width = 1006, showValues = true, u = units) =>
  renderWithProviders(
    <EnergyUseFlowDiagram sums={s} figures={energyFigures(s)} units={u} width={width} showValues={showValues} />,
  )
const nodeKeys = (c: Element) => [...c.querySelectorAll('[data-flow-node]')].map((n) => n.getAttribute('data-flow-node'))
const stroke = (c: Element, to: string) =>
  c.querySelector(`[data-flow-edge="load>${to}"] path`)?.getAttribute('stroke')

test('one node per consumer: laddning, each heat pump by name, övrigt hus', async () => {
  const { screen } = await draw(sums())
  expect(nodeKeys(screen.container)).toEqual(['load', 'car', 'hp:hp-a', 'hp:hp-b', 'house'])
  await expect.element(screen.getByText(m.energy_heat_pump_name({ name: 'Matsal' }))).toBeVisible()
  await expect.element(screen.getByText(m.energy_use_house())).toBeVisible()
  await expect.element(screen.getByText(m.energy_tile_load())).toBeVisible()
})

test('each consumer node shows its kWh and its share of the load', async () => {
  const { screen } = await draw(sums())
  const node = screen.container.querySelector('[data-flow-node="hp:hp-a"]') as Element
  expect(node.textContent).toContain(formatOneDecimal(150))
  expect(node.textContent).toContain(formatShare(150 / 900))
  const house = screen.container.querySelector('[data-flow-node="house"]') as Element
  expect(house.textContent).toContain(formatOneDecimal(390))
})

test('each arrow takes its consumer’s colour; a unit’s colour is its all-time place, not the period’s', async () => {
  const { screen } = await draw(sums())
  expect(stroke(screen.container, 'car')).toBe('var(--energy-car)')
  expect(stroke(screen.container, 'hp:hp-a')).toBe('var(--energy-heat-pump-1)')
  expect(stroke(screen.container, 'hp:hp-b')).toBe('var(--energy-heat-pump-2)')
  expect(stroke(screen.container, 'house')).toBe('var(--energy-house)')
  // A period where only Övervåning ran: it keeps colour 2.
  const only = await draw(sums({ heatPumps: [unit('hp-b', 'Övervåning', 60)] }))
  expect(stroke(only.screen.container, 'hp:hp-b')).toBe('var(--energy-heat-pump-2)')
})

test('no heat pumps: laddning and övrigt hus only', async () => {
  const { screen } = await draw(sums({ heatPumps: [] }))
  expect(nodeKeys(screen.container)).toEqual(['load', 'car', 'house'])
})

test('a consumer under 0,05 kWh keeps its node but draws no arrow', async () => {
  const { screen } = await draw(sums({ carKwh: 0.01 }))
  expect(nodeKeys(screen.container)).toContain('car')
  expect(screen.container.querySelector('[data-flow-edge="load>car"]')).toBeNull()
})

test('value pills follow showValues on the wide layout; the narrow layout draws none', async () => {
  const on = await draw(sums(), 1006, true)
  expect(on.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(4)
  const off = await draw(sums(), 1006, false)
  expect(off.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  const narrow = await draw(sums(), 311, true)
  expect(narrow.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
})

test('hovering an arrow names it and gives its kWh and share of the load', async () => {
  const { screen } = await draw(sums())
  await userEvent.hover(screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as Element)
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({ from: m.energy_tile_load(), to: m.energy_heat_pump_name({ name: 'Matsal' }) }),
      ),
    )
    .toBeVisible()
  await expect
    .element(screen.getByText(m.energy_flow_share_load({ share: formatShare(150 / 900) })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('a long unit name is cut with … inside its node on a phone; the tooltip names it in full', async () => {
  const long = 'Vardagsrummets stora värmepump vid trappan'
  const u = [{ id: 'hp-a', name: long }]
  const { screen } = await draw(sums({ heatPumps: [unit('hp-a', long, 150)] }), 311, true, u)
  const node = screen.container.querySelector('[data-flow-node="hp:hp-a"]') as SVGGElement
  const label = node.querySelector('text') as SVGTextElement
  await expect.poll(() => label.textContent?.endsWith('…')).toBe(true)
  const box = node.querySelector('rect') as SVGRectElement
  const right = box.getBoundingClientRect().right
  expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(right - NODE_PADDING + 1)
  await userEvent.hover(screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as Element)
  await expect
    .element(screen.getByText(m.energy_flow_arrow({ from: m.energy_tile_load(), to: m.energy_heat_pump_name({ name: long }) })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('the svg is one image named by its description', async () => {
  const { screen } = await draw(sums())
  await expect.element(screen.getByRole('img', { name: m.energy_use_description() })).toBeVisible()
})
```

Run: `bunx vitest run --project browser src/components/energy/EnergyUseFlowDiagram.browser.test.tsx` → FAIL (no module).

- [ ] **Step 4: Implement `EnergyUseFlowDiagram.tsx`**

```tsx
import { Group } from '@visx/group'
import { AirVentIcon, CarIcon, HouseIcon, HousePlugIcon, type LucideIcon } from 'lucide-react'
import type * as React from 'react'
import { useRef } from 'react'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import type { EnergyFigures, PeriodSums } from '~/lib/houseEnergy/figures'
import { arrowHead, flowCurve, NODE_PADDING } from '~/lib/houseEnergy/flowLayout'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import {
  type UseConsumerKey,
  type UseNodeKey,
  usageConsumers,
  usageFlowLayout,
  usageNodeText,
} from '~/lib/houseEnergy/usageFlowLayout'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { NODE_MUTED, NodeFrame, useFittedSize, useFittedText, ValuePill } from './flowParts'

// The Användning card's diagram (heat pumps step 2): the period's load split into laddning, each heat pump and övrigt
// hus. Geometry in usageFlowLayout.ts; this draws it. Colour = the consumer (laddning, the unit by its all-time place,
// övrigt hus); text never wears a series colour.
type Consumer = { label: string; color: string; Icon: LucideIcon; kwh: number; share: number | null }
type Tip = { id: string; label: string; color: string; kwh: number; share: number | null }

const kwh = (v: number) => formatOneDecimal(v)

function consumersOf(
  sums: PeriodSums,
  f: EnergyFigures,
  units: readonly { id: string }[],
): Map<UseConsumerKey, Consumer> {
  const share = (v: number) => (sums.loadKwh > 0 ? v / sums.loadKwh : null)
  const map = new Map<UseConsumerKey, Consumer>()
  map.set('car', { label: m.energy_series_car(), color: 'var(--energy-car)', Icon: CarIcon, kwh: f.car, share: share(f.car) })
  for (const u of f.heatPumps)
    map.set(`hp:${u.id}`, {
      label: m.energy_heat_pump_name({ name: u.name }),
      color: heatPumpColor(units, u.id),
      Icon: AirVentIcon,
      kwh: u.kwh,
      share: u.share,
    })
  map.set('house', {
    label: m.energy_use_house(),
    color: 'var(--energy-house)',
    Icon: HousePlugIcon,
    kwh: f.restOfHouse,
    share: share(f.restOfHouse),
  })
  return map
}

export function EnergyUseFlowDiagram({
  sums,
  figures: f,
  units,
  width,
  showValues,
}: {
  sums: PeriodSums
  figures: EnergyFigures
  /** Every unit in its all-time order: the colour order. */
  units: readonly { id: string }[]
  width: number
  showValues: boolean
}) {
  const layout = usageFlowLayout(width, usageConsumers(f))
  const consumers = consumersOf(sums, f, units)
  const popover = useChartPopover<Tip>()
  const { markProps, containerProps, hide } = popover
  // A mouse leaving an arrow closes its popover (touch keeps it until a tap outside, as in Summering).
  const leaveProps = {
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') hide()
    },
  }
  const active = popover.open ? popover.data?.id : undefined
  const dim = (id: string) => (active !== undefined && active !== id ? 'opacity-25' : undefined)
  const fade = 'transition-opacity motion-reduce:transition-none'
  return (
    <div {...containerProps} className="relative">
      <svg
        width={width}
        height={layout.height}
        role="img"
        aria-label={m.energy_use_description()}
        className="block overflow-visible"
      >
        {/* Arrows under the nodes; pills and hit areas over them. */}
        <Group>
          {layout.flows.map(({ spec, width: w }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const color = consumers.get(spec.to as UseConsumerKey)?.color
            return (
              <g key={id} data-flow-edge={id} className={cn(fade, dim(id))}>
                <path d={c.d} fill="none" stroke={color} strokeWidth={w} />
                <polygon points={arrowHead(c.tip, w)} fill={color} />
              </g>
            )
          })}
        </Group>
        <Group>
          {(Object.keys(layout.nodes) as UseNodeKey[]).map((key) => (
            <UseNode
              key={key}
              nodeKey={key}
              layout={layout}
              consumer={key === 'load' ? null : (consumers.get(key) ?? null)}
              loadKwh={sums.loadKwh}
            />
          ))}
        </Group>
        <Group>
          {/* Narrow: the arrows share a lane, so the values stay on the nodes. */}
          {showValues && !layout.narrow
            ? layout.flows.map(({ spec, kwh: v }) => {
                const id = `${spec.from}>${spec.to}`
                const p = flowCurve(layout, spec).at(spec.labelT)
                return <ValuePill key={id} x={p.x} y={p.y} text={kwh(v)} className={cn(fade, dim(id))} />
              })
            : null}
          {layout.flows.map(({ spec, kwh: v, width: w }) => {
            const id = `${spec.from}>${spec.to}`
            const c = flowCurve(layout, spec)
            const mid = c.at(spec.labelT)
            const consumer = consumers.get(spec.to as UseConsumerKey)
            return (
              <path
                key={id}
                data-flow-hit={id}
                data-slot="flow-hit"
                d={c.d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(22, w)}
                pointerEvents="stroke"
                className="cursor-pointer"
                {...markProps(
                  { id, label: consumer?.label ?? '', color: consumer?.color ?? '', kwh: v, share: consumer?.share ?? null },
                  mid.x,
                  mid.y,
                )}
                {...leaveProps}
              />
            )
          })}
        </Group>
      </svg>
      {/* Above, not over: the arrow's own value pill sits where the pointer anchors the tooltip. */}
      <ChartPopover
        state={popover}
        dataKey={popover.data?.id}
        placement="above"
        className="flex min-w-48 flex-col gap-0.5 whitespace-normal rounded-lg border bg-card px-3 py-2 text-card-foreground text-sm shadow-lg"
      >
        {popover.data ? (
          <>
            <span className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="size-2.5 rounded-xs" style={{ background: popover.data.color }} />
              {m.energy_flow_arrow({ from: m.energy_tile_load(), to: popover.data.label })}
            </span>
            <span className="font-semibold text-base tabular-nums">{kwh(popover.data.kwh)} kWh</span>
            {popover.data.share !== null ? (
              <span className="text-muted-foreground">
                {m.energy_flow_share_load({ share: formatShare(popover.data.share) })}
              </span>
            ) : null}
          </>
        ) : null}
      </ChartPopover>
    </div>
  )
}

function UseNode({
  nodeKey: key,
  layout,
  consumer,
  loadKwh,
}: {
  nodeKey: UseNodeKey
  layout: ReturnType<typeof usageFlowLayout>
  consumer: Consumer | null
  loadKwh: number
}) {
  const n = layout.nodes[key]
  const t = usageNodeText(n, key, layout.narrow)
  const value = kwh(consumer ? consumer.kwh : loadKwh)
  const valueRef = useRef<SVGTextElement>(null)
  const size = useFittedSize(valueRef, value, t.value)
  const labelRef = useRef<SVGTextElement>(null)
  const label = useFittedText(
    labelRef,
    consumer ? consumer.label : m.energy_tile_load(),
    t.label.x,
    n.x + n.w / 2 - NODE_PADDING - t.label.x,
  )
  return (
    <NodeFrame
      data-flow-node={key}
      node={n}
      tile={t.tile}
      label={t.label}
      labelText={label}
      labelRef={labelRef}
      Icon={consumer ? consumer.Icon : HouseIcon}
      tint={consumer?.color}
    >
      {consumer ? (
        <text ref={valueRef} x={t.value.x} y={t.value.y} fontSize={14} style={NODE_MUTED} className="tabular-nums">
          <tspan fontSize={size} fontWeight={600} className="fill-foreground">
            {value}
          </tspan>{' '}
          kWh · {consumer.share === null ? '—' : formatShare(consumer.share)}
        </text>
      ) : (
        <text ref={valueRef} x={t.value.x} y={t.value.y} fontSize={size} fontWeight={600} className="fill-foreground tabular-nums">
          {value}{' '}
          <tspan fontSize={14} fontWeight={400} style={NODE_MUTED}>
            kWh
          </tspan>
        </text>
      )}
    </NodeFrame>
  )
}
```

Run the diagram tests → PASS.

- [ ] **Step 5: Write the failing card-body tests** (`EnergyUseFlow.browser.test.tsx`)

```tsx
import { expect, test } from 'vitest'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import type { HeatPumpPeriod, PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { EnergyUseFlow } from './EnergyUseFlow'

const unit = (id: string, name: string, kwh: number, hours = 720): HeatPumpPeriod => ({
  id,
  name,
  kwh,
  hours,
  expectedHours: 720,
})
const units = [
  { id: 'hp-a', name: 'Matsal' },
  { id: 'hp-b', name: 'Övervåning' },
]
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 900,
  batteryDischargeKwh: 225,
  batteryChargeSolarKwh: 173,
  batteryChargeGridKwh: 68,
  carKwh: 300,
  firstSocPct: 30,
  lastSocPct: 40,
  buckets: 8640,
  expectedBuckets: 8640,
  heatPumps: [unit('hp-a', 'Matsal', 150), unit('hp-b', 'Övervåning', 60)],
  ...over,
})
const box = (c: Element) => c.querySelector('[data-slot="energy-use-box"]') as HTMLElement
const note = (c: Element) => c.querySelector('[data-slot="energy-use-gap"]') as HTMLElement

test('the box reserves its height by container query and keeps it whatever the node count', async () => {
  // No query client needed: vitest-browser-react's own render, for its rerender.
  const screen = await render(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums()} units={units} />
    </div>,
  )
  // Browser tests carry no Tailwind: pin the reservation classes (what holds the height in the app)...
  expect(box(screen.container).className).toContain('h-[436px]')
  expect(box(screen.container).className).toContain('@[860px]:h-[312px]')
  await expect.poll(() => screen.container.querySelectorAll('[data-flow-node]').length).toBe(5)
  const before = box(screen.container).getBoundingClientRect()
  // ...and that two nodes instead of five change nothing.
  await screen.rerender(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums({ heatPumps: [] })} units={units} />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('[data-flow-node]').length).toBe(3)
  const after = box(screen.container).getBoundingClientRect()
  expect(after.height).toBe(before.height)
  expect(after.top).toBe(before.top)
})

test('missing heat pump hours: the note names the most any unit misses; a complete period keeps the line', async () => {
  const gap = await renderWithProviders(
    <EnergyUseFlow sums={sums({ heatPumps: [unit('hp-a', 'Matsal', 150, 714), unit('hp-b', 'Övervåning', 60)] })} units={units} />,
  )
  expect(note(gap.screen.container).textContent).toBe(m.energy_use_missing_hours({ hours: '6' }))
  const full = await renderWithProviders(<EnergyUseFlow sums={sums()} units={units} />)
  expect(note(full.screen.container).textContent).toBe('')
  expect(note(full.screen.container).className).toContain('min-h-[1.5em]')
})

test('the table: consumer, energy and share, with the total', async () => {
  const { screen } = await renderWithProviders(<EnergyUseFlow sums={sums()} units={units} />)
  await screen.getByText(m.energy_flow_table_toggle()).click()
  const table = screen.getByRole('table')
  await expect.element(table.getByRole('columnheader', { name: m.energy_use_table_share() })).toBeVisible()
  const row = (name: string) => table.getByRole('row', { name: new RegExp(`^${name}`) }).element().textContent ?? ''
  expect(row(m.energy_heat_pump_name({ name: 'Matsal' }))).toContain(formatShare(150 / 900))
  expect(row(m.energy_use_house())).toContain(formatOneDecimal(390))
  expect(row(m.energy_tile_load())).toContain(formatOneDecimal(900))
})

test('a failed read or a period without data draws no diagram; only the latter says so', async () => {
  const failed = await renderWithProviders(<EnergyUseFlow sums="unavailable" units={units} />)
  expect(failed.screen.container.querySelector('[data-flow-node]')).toBeNull()
  expect(failed.screen.container.textContent).not.toContain(m.energy_period_no_data())
  const none = await renderWithProviders(<EnergyUseFlow sums={null} units={units} />)
  await expect.element(none.screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('"Visa värden" is Summering’s remembered preference; its switch hides on the narrow layout', async () => {
  window.localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
  const { screen } = await renderWithProviders(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums()} units={units} />
    </div>,
  )
  const toggle = screen.getByRole('switch', { name: m.energy_flow_show_values() })
  await toggle.click()
  expect(window.localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
  const label = toggle.element().closest('label') as HTMLElement
  expect(label.className).toContain('hidden')
  expect(label.className).toContain('@[860px]:flex')
  window.localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
})
```

(Add `import { render } from 'vitest-browser-react'`; `renderWithProviders` returns `{ screen, queryClient }` only.)

Run: `bunx vitest run --project browser src/components/energy/EnergyUseFlow.browser.test.tsx` → FAIL (no module).

- [ ] **Step 6: Implement `EnergyUseFlow.tsx`**

```tsx
import { useParentSize } from '@visx/responsive'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { useLocalStorageFlag } from '~/hooks/useLocalStorageFlag'
import { type EnergyFigures, energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { EnergyUseFlowDiagram } from './EnergyUseFlowDiagram'
import { FlowTableFrame, FlowValuesSwitch } from './flowParts'

// The Användning card's body (heat pumps step 2, spec "Energi › Översikt: Användning"): the diagram in a box whose
// height is reserved per layout by a container query (content 860 px wide → 312 px, else 436 px) whatever the number
// of consumers, the values switch (Summering's preference; wide only, where the values sit on the arrows), the missing
// heat pump hours note on a reserved line, and the table.
export function EnergyUseFlow({
  sums,
  units,
}: {
  sums: PeriodSums | null | 'unavailable'
  /** Every unit in its all-time order: the colour order. */
  units: readonly { id: string; name: string }[]
}) {
  const [showValues, setShowValues] = useLocalStorageFlag(SHOW_FLOW_VALUES_KEY, true)
  const { parentRef, width } = useParentSize({ debounceTime: 50 })
  const s = sums && sums !== 'unavailable' ? sums : null
  const f = s ? energyFigures(s) : null
  const missing = f && f.heatPumpMissingHours >= 1 ? f.heatPumpMissingHours : null
  return (
    <div className="@container flex flex-col gap-3">
      <div ref={parentRef} data-slot="energy-use-box" className="relative h-[436px] w-full @[860px]:h-[312px]">
        {s && f && width > 0 ? (
          <EnergyUseFlowDiagram sums={s} figures={f} units={units} width={width} showValues={showValues} />
        ) : null}
        {sums === null ? (
          <p className="absolute top-0 left-0 text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
        ) : null}
      </div>
      <FlowValuesSwitch
        checked={showValues}
        onCheckedChange={setShowValues}
        hint={m.energy_use_hint()}
        switchClassName="hidden @[860px]:flex"
      />
      {/* Övrigt hus is overstated by the missing hours' heat pump use; Summering's own gap note stays in Summering. */}
      <p data-slot="energy-use-gap" className="min-h-[1.5em] text-muted-foreground text-sm leading-normal">
        {missing === null ? null : m.energy_use_missing_hours({ hours: String(missing) })}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {m.energy_flow_table_toggle()}
        </summary>
        {s && f ? <UseTable sums={s} f={f} /> : null}
      </details>
    </div>
  )
}

function UseTable({ sums: s, f }: { sums: PeriodSums; f: EnergyFigures }) {
  const kwh = (v: number) => `${formatOneDecimal(v)} kWh`
  const share = (v: number) => (s.loadKwh > 0 ? formatShare(v / s.loadKwh) : '—')
  const rows: string[][] = [
    [m.energy_series_car(), kwh(f.car), share(f.car)],
    ...f.heatPumps.map((u) => [m.energy_heat_pump_name({ name: u.name }), kwh(u.kwh), share(u.kwh)]),
    [m.energy_use_house(), kwh(f.restOfHouse), share(f.restOfHouse)],
    [m.energy_tile_load(), kwh(s.loadKwh), s.loadKwh > 0 ? formatShare(1) : '—'],
  ]
  return (
    <FlowTableFrame
      columns={[m.energy_use_table_consumer(), m.energy_use_table_energy(), m.energy_use_table_share()]}
      rows={rows}
    />
  )
}
```

- [ ] **Step 7: Run** `bunx vitest run --project browser src/components/energy` → PASS (Summering's and Batteri's
  suites unchanged).

- [ ] **Step 8: Commit**

```bash
bun run check
git add messages/sv.json messages/en.json src/components/energy/flowParts.tsx \
  src/components/energy/EnergyUseFlowDiagram.tsx src/components/energy/EnergyUseFlowDiagram.browser.test.tsx \
  src/components/energy/EnergyUseFlow.tsx src/components/energy/EnergyUseFlow.browser.test.tsx
git commit -m "feat(energy): draw the Användning flow card" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The month chart's Förbrukning stacks the heat pumps

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told: assume
the parts no longer add up to the load, a unit is repainted when another has no data, or the chart's memoised
geometry churns on every render).

**Files:**
- Modify: `src/components/energy/energyTooltip.ts`, `src/components/energy/energyTooltip.test.ts`,
  `src/components/energy/EnergyMonthlyChart.tsx`, `src/components/energy/EnergyMonthlyChart.browser.test.tsx`

**Interfaces:**
- Consumes: `byHeatPumpName`, `energyFigures` (Task 1); `heatPumpColor` (Task 4); `energy_heat_pump_name`,
  `energy_use_missing_hours` (Task 6).
- Produces:
  - `type HeatPumpSeriesKey = \`heatPump:${string}\``; `SeriesKey` includes it
  - `heatPumpSeriesKey(id: string): HeatPumpSeriesKey`; `isHeatPumpSeries(key: SeriesKey): key is HeatPumpSeriesKey`
  - `metricSeries(metric: EnergyMetric, units: readonly { id: string }[]): SeriesKey[]`
  - `chartUnits(months: readonly (PeriodSums | null)[]): { id: string; name: string }[]`
  - `energyTooltipRows('load', p)`: car, each unit of `energyFigures(p).heatPumps`, house
  - `EnergyMonthlyChart` prop `heatPumpUnits: readonly { id: string; name: string }[]` (the colour order)

- [ ] **Step 1: Write the failing pure tests** (append to `energyTooltip.test.ts`; import the new names)

```ts
const hp = (id: string, name: string, kwh: number) => ({ id, name, kwh, hours: 720, expectedHours: 720 })

test('load rows with heat pumps: laddning, each unit by name, övrigt hus; the parts add up to the load', () => {
  const p = sums({ loadKwh: 800, carKwh: 250, heatPumps: [hp('hp-a', 'Matsal', 150), hp('hp-b', 'Övervåning', 60)] })
  const { parts, totalKwh } = energyTooltipRows('load', p)
  expect(parts).toEqual([
    { key: 'car', kwh: 250, share: 0.3125 },
    { key: 'heatPump:hp-a', kwh: 150, share: 0.1875 },
    { key: 'heatPump:hp-b', kwh: 60, share: 0.075 },
    { key: 'house', kwh: 340, share: 0.425 },
  ])
  expect(parts.reduce((a, r) => a + r.kwh, 0)).toBeCloseTo(totalKwh, 9)
})

test('load rows when the heat pumps exceed load − laddning: scaled, övrigt hus 0, still adding up to the load', () => {
  const p = sums({ loadKwh: 400, carKwh: 300, heatPumps: [hp('hp-a', 'Matsal', 150), hp('hp-b', 'Övervåning', 50)] })
  const { parts, totalKwh } = energyTooltipRows('load', p)
  expect(parts.map((r) => r.kwh)).toEqual([300, 75, 25, 0])
  expect(parts.reduce((a, r) => a + r.kwh, 0)).toBeCloseTo(totalKwh, 9)
  expect(parts.every((r) => (r.share ?? 0) <= 1)).toBe(true)
})

test('metricSeries: Förbrukning puts the units between laddning and övrigt hus; Solel and Nät unchanged', () => {
  expect(metricSeries('load', [{ id: 'hp-a' }, { id: 'hp-b' }])).toEqual([
    'car',
    'heatPump:hp-a',
    'heatPump:hp-b',
    'house',
  ])
  expect(metricSeries('load', [])).toEqual(['car', 'house'])
  expect(metricSeries('solar', [{ id: 'hp-a' }])).toEqual(METRIC_SERIES.solar)
  expect(metricSeries('grid', [{ id: 'hp-a' }])).toEqual(METRIC_SERIES.grid)
})

test('chartUnits: every unit with a figure in any month, once, in name order', () => {
  const months = [
    null,
    sums({ heatPumps: [hp('hp-b', 'Övervåning', 1)] }),
    sums({ heatPumps: [hp('hp-a', 'Matsal', 1), hp('hp-b', 'Övervåning', 1)] }),
  ]
  expect(chartUnits(months)).toEqual([
    { id: 'hp-a', name: 'Matsal' },
    { id: 'hp-b', name: 'Övervåning' },
  ])
  expect(chartUnits([null])).toEqual([])
})

test('chartRows: a unit absent in a month is null there, never 0', () => {
  const rows = chartRows('load', [
    sums({ heatPumps: [hp('hp-a', 'Matsal', 10)] }),
    sums({ heatPumps: [hp('hp-a', 'Matsal', 10), hp('hp-b', 'Övervåning', 5)] }),
  ])
  expect(rows[0]['heatPump:hp-b']).toBeNull()
  expect(rows[1]['heatPump:hp-b']).toBe(5)
  expect(rows[0]['heatPump:hp-a']).toBe(10)
})
```

Run: `bunx vitest run --project node src/components/energy/energyTooltip.test.ts` → FAIL (no `metricSeries`).

- [ ] **Step 2: Implement** (`energyTooltip.ts`)

```ts
import { byHeatPumpName, energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'

export type EnergyMetric = 'solar' | 'grid' | 'load'
/** One series per heat pump on Förbrukning (heat pumps step 2): the unit's id after the prefix. */
export type HeatPumpSeriesKey = `heatPump:${string}`
export type SeriesKey =
  | 'solarDirect'
  | 'solarBattery'
  | 'solarExported'
  | 'importDirect'
  | 'importBattery'
  | 'exported'
  | 'car'
  | 'house'
  | HeatPumpSeriesKey

export const heatPumpSeriesKey = (id: string): HeatPumpSeriesKey => `heatPump:${id}`
export const isHeatPumpSeries = (key: SeriesKey): key is HeatPumpSeriesKey => key.startsWith('heatPump:')

/**
 * Each metric's fixed series in stack order (bottom → top; `exported` on Nät draws below the axis). Förbrukning's
 * heat pumps go between laddning and övrigt hus: see `metricSeries`.
 */
export const METRIC_SERIES: Record<EnergyMetric, SeriesKey[]> = {
  solar: ['solarDirect', 'solarBattery', 'solarExported'],
  grid: ['importDirect', 'importBattery', 'exported'],
  load: ['car', 'house'],
}

/** A metric's series in stack order: on Förbrukning one per heat pump between laddning and övrigt hus. */
export function metricSeries(metric: EnergyMetric, units: readonly { id: string }[]): SeriesKey[] {
  if (metric !== 'load') return METRIC_SERIES[metric]
  return ['car', ...units.map((u) => heatPumpSeriesKey(u.id)), 'house']
}

/** The heat pumps with a figure in any of `months`, once each, in name order: Förbrukning's series (from the data). */
export function chartUnits(months: readonly (PeriodSums | null)[]): { id: string; name: string }[] {
  const byId = new Map<string, { id: string; name: string }>()
  for (const p of months) for (const u of p?.heatPumps ?? []) byId.set(u.id, { id: u.id, name: u.name })
  return [...byId.values()].sort(byHeatPumpName)
}
```

`isBelowAxis` and `TooltipPart` stay. `energyTooltipRows` becomes:

```ts
export function energyTooltipRows(
  metric: EnergyMetric,
  p: PeriodSums,
): { parts: TooltipPart[]; totalKwh: number } {
  const f = energyFigures(p)
  // The parts must add up to the total the tooltip prints: battery charging
  // from solar can overshoot the month's solar (meter noise); cap it here
  // (figures.ts caps the car and the heat pumps at the load itself).
  const solarBattery = Math.min(f.solarToBattery, p.solarKwh)
  const fixed: Record<Exclude<SeriesKey, HeatPumpSeriesKey>, number> = {
    solarDirect: f.solarDirect,
    solarBattery,
    solarExported: f.solarExported,
    importDirect: f.importDirect,
    importBattery: f.importToBattery,
    exported: p.gridExportKwh,
    car: f.car,
    house: f.restOfHouse,
  }
  const units = new Map(f.heatPumps.map((u) => [heatPumpSeriesKey(u.id), u.kwh]))
  const totalKwh = metric === 'solar' ? p.solarKwh : metric === 'grid' ? p.gridImportKwh : p.loadKwh
  // This month's units only: a unit without a figure here has no part (and no tooltip row).
  const parts = metricSeries(metric, f.heatPumps).map((key) => {
    const kwh = isHeatPumpSeries(key) ? (units.get(key) ?? 0) : fixed[key]
    return { key, kwh, share: totalKwh > 0 && !isBelowAxis(metric, key) ? kwh / totalKwh : null }
  })
  return { parts, totalKwh }
}
```

`chartRows`:

```ts
/** One row per month for the stacked bars: null (not 0) without data, or for a unit absent that month; Nät's export negated. */
export function chartRows(metric: EnergyMetric, months: (PeriodSums | null)[]): ChartRow[] {
  const keys = metricSeries(metric, chartUnits(months))
  return months.map((sums, i) => {
    const row: ChartRow = { month: i + 1, sums }
    const parts = sums ? energyTooltipRows(metric, sums).parts : []
    for (const key of keys) {
      const part = parts.find((r) => r.key === key)
      row[key] = part ? (isBelowAxis(metric, key) ? -part.kwh : part.kwh) : null
    }
    return row
  })
}
```

Run the pure tests → PASS.

- [ ] **Step 3: Write the failing chart tests** (append to `EnergyMonthlyChart.browser.test.tsx`; `renderChart` gains a
  `heatPumpUnits = []` option passed through; import `chartUnits` is not needed)

```tsx
const hp = (id: string, name: string, kwh: number) => ({ id, name, kwh, hours: 720, expectedHours: 720 })
const allUnits = [
  { id: 'hp-a', name: 'Matsal' },
  { id: 'hp-b', name: 'Övervåning' },
]
const withUnits = months.map((p) =>
  p ? { ...p, heatPumps: [hp('hp-a', 'Matsal', 120), hp('hp-b', 'Övervåning', 50)] } : p,
)

test('Förbrukning: laddning, one series per heat pump, övrigt hus, in the legend in stack order', async () => {
  const { screen } = await renderChart({ metric: 'load', data: withUnits, heatPumpUnits: allUnits })
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(9 * 4))
  await vi.waitFor(() =>
    inOrder(legendText(screen.container), [
      m.energy_series_car(),
      m.energy_heat_pump_name({ name: 'Matsal' }),
      m.energy_heat_pump_name({ name: 'Övervåning' }),
      m.energy_series_house(),
    ]),
  )
  const fill = (key: string) =>
    screen.container.querySelector(`[data-series="${key}"] [data-bar]`)?.getAttribute('fill')
  expect(fill('heatPump:hp-a')).toBe('var(--energy-heat-pump-1)')
  expect(fill('heatPump:hp-b')).toBe('var(--energy-heat-pump-2)')
})

test('a year where only the later-named unit has data: it keeps its all-time colour', async () => {
  const onlyB = months.map((p) => (p ? { ...p, heatPumps: [hp('hp-b', 'Övervåning', 50)] } : p))
  const { screen } = await renderChart({ metric: 'load', data: onlyB, heatPumpUnits: allUnits })
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[data-series="heatPump:hp-b"] [data-bar]')?.getAttribute('fill'),
    ).toBe('var(--energy-heat-pump-2)'),
  )
  expect(legendText(screen.container)).not.toContain(m.energy_heat_pump_name({ name: 'Matsal' }))
})

test('the Förbrukning tooltip lists the heat pumps and their missing hours', async () => {
  const gappy = withUnits.map((p, i) =>
    i === 3 && p ? { ...p, heatPumps: [{ ...hp('hp-a', 'Matsal', 120), hours: 700 }, hp('hp-b', 'Övervåning', 50)] } : p,
  )
  const { screen } = await renderChart({ metric: 'load', data: gappy, heatPumpUnits: allUnits })
  await vi.waitFor(() => expect(bars(screen.container).length).toBeGreaterThan(0))
  await hoverBar(screen.container, 0)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.energy_heat_pump_name({ name: 'Övervåning' })))
  const tip = tooltipText()
  const order = [
    m.energy_series_car(),
    m.energy_heat_pump_name({ name: 'Matsal' }),
    m.energy_heat_pump_name({ name: 'Övervåning' }),
    m.energy_series_house(),
    m.energy_chart_total_load(),
    m.energy_use_missing_hours({ hours: '20' }),
  ]
  inOrder(tip, order)
})
```

Run: `bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx` → FAIL.

- [ ] **Step 4: Implement** (`EnergyMonthlyChart.tsx`)

- Import `chartUnits`, `type HeatPumpSeriesKey`, `isHeatPumpSeries`, `metricSeries` from `./energyTooltip` (drop
  `METRIC_SERIES`), and `heatPumpColor` from `~/lib/houseEnergy/heatPumpColors`.
- `seriesConfig()` becomes `fixedSeries()` typed `Record<Exclude<SeriesKey, HeatPumpSeriesKey>, { label: string; color: string }>`
  (same entries). Add:

```ts
// A series' legend label and colour. A heat pump is named from the data; its colour is its all-time place
// (`colourUnits`), so it isn't repainted in a year where an earlier-named unit has no data.
function seriesStyle(
  key: SeriesKey,
  units: readonly { id: string; name: string }[],
  colourUnits: readonly { id: string }[],
): { label: string; color: string } {
  if (!isHeatPumpSeries(key)) return fixedSeries()[key]
  const id = key.slice('heatPump:'.length)
  const name = units.find((u) => u.id === id)?.name ?? ''
  return {
    label: m.energy_heat_pump_name({ name }),
    color: heatPumpColor(colourUnits.length > 0 ? colourUnits : units, id),
  }
}
```

- The component gains the prop
  `/** Every unit in its all-time order (overview.allTime.heatPumps): the heat pump colour order. */ heatPumpUnits: readonly { id: string; name: string }[]`.
- Replace `const keys = METRIC_SERIES[metric]` with:

```ts
  // From the data: the year's units, memoised with the months so the chart's geometry survives re-renders.
  const units = useMemo(() => chartUnits(months), [months])
  const keys = useMemo(() => metricSeries(metric, units), [metric, units])
```

  and in the `series` memo use `const style = seriesStyle(key, units, heatPumpUnits)` (`label: style.label`,
  `color: style.color`), deps `[keys, metric, units, heatPumpUnits]`.
- Pass `units` and `heatPumpUnits` to `EnergyTooltip`; there `const style = (key: SeriesKey) => seriesStyle(key, units, heatPumpUnits)`
  replaces `config[key]`, and after the house gap line add:

```tsx
      {metric === 'load' && figures.heatPumpMissingHours >= 1 ? (
        <span className="text-muted-foreground">
          {m.energy_use_missing_hours({ hours: String(figures.heatPumpMissingHours) })}
        </span>
      ) : null}
```

  with `const figures = energyFigures(sums)` (and `const gap = gapHours(figures)`).

Run the chart file → PASS; then `bunx vitest run --project browser src/components/energy` and
`bunx vitest run --project node src/components/energy` → PASS. The page passes `heatPumpUnits` in Task 8 (until then
`bun run typecheck` flags `index.tsx`: add `heatPumpUnits={[]}` there now and replace it in Task 8).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/energyTooltip.ts src/components/energy/energyTooltip.test.ts \
  src/components/energy/EnergyMonthlyChart.tsx src/components/energy/EnergyMonthlyChart.browser.test.tsx \
  src/routes/_authenticated/energy/index.tsx
git commit -m "feat(energy): stack the heat pumps in the month chart's load" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Översikt shows Användning; both Energi pages show the Comfort Cloud alert; skeletons

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told: assume
the new card shifts the page on a period change, a second request is sent, or the alert hides Emaldo's).

**Files:**
- Create: `src/components/energy/EnergySyncAlerts.tsx`, `src/bones/energy-use.bones.json` (generated)
- Modify: `src/routes/_authenticated/energy/index.tsx`, `src/routes/_authenticated/energy/battery.tsx`,
  `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`, `src/lib/houseEnergy/clientSafe.browser.test.tsx`,
  `CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 6, 7; `SyncHealthAlert`, `useSyncNow`, `syncHealthQuery` (existing; `comfortCloud` from step 1b).
- Produces: `EnergySyncAlerts({ health, isAdmin, syncNow })` where `health` is the `syncStatuses` record (or undefined)
  and `syncNow = useSyncNow()`; renders Emaldo's then Comfort Cloud's alert, on Översikt and Batteri.

- [ ] **Step 1: Write the failing page tests** (`-energyPage.browser.test.tsx`)

Give `withData` heat pumps: every month `sums({ solarKwh: 100 + i, heatPumps: [hpA(i), hpB] })` for `i < 9` except
June (`i === 5`), which has `heatPumps: []`; `yearTotal` / `allTime` carry both units. Add at the top:

```ts
const hp = (id: string, name: string, kwh: number) => ({ id, name, kwh, hours: 720, expectedHours: 720 })
const hpA = (i: number) => hp('hp-a', 'Matsal', 100 + i)
const hpB = hp('hp-b', 'Övervåning', 40)
const units = (i: number) => (i === 5 ? [] : [hpA(i), hpB])
```

and in `withData`: `months: Array.from({ length: 12 }, (_, i) => (i < 9 ? sums({ solarKwh: 100 + i, heatPumps: units(i) }) : null))`,
`yearTotal: sums({ solarKwh: 5000, heatPumps: [hp('hp-a', 'Matsal', 900), hpB] })`,
`allTime: sums({ solarKwh: 6000, heatPumps: [hp('hp-a', 'Matsal', 1500), hpB] })`. Then:

```tsx
const use = (screen: Awaited<ReturnType<typeof renderPage>>['screen']) =>
  screen.getByRole('region', { name: m.energy_use_heading() })

test('Användning sits below Summering with the period’s consumers and the period’s label', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  const card = use(screen)
  await expect.element(card).toBeVisible()
  await expect.element(card.getByText(/september 2026/i)).toBeVisible()
  const diagram = screen.getByLabelText(m.energy_use_description())
  await expect.element(diagram.getByText(m.energy_heat_pump_name({ name: 'Matsal' }))).toBeVisible()
  await expect.element(diagram.getByText(m.energy_use_house())).toBeVisible()
  // Below Summering.
  const tiles = screen.getByRole('region', { name: m.energy_tiles_heading() }).element()
  expect(tiles.compareDocumentPosition(card.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(skeleton('energy-use')).toBeNull()
})

test('stepping into a month without heat pumps: their nodes go, the use box keeps its rect, no request', async () => {
  const { screen, qc } = await renderPage(Overview, '/energy?period=2026-07', seedOverview(withData))
  const diagram = screen.getByLabelText(m.energy_use_description())
  await expect.element(diagram.getByText(m.energy_heat_pump_name({ name: 'Matsal' }))).toBeVisible()
  const boxEl = () => screen.container.querySelector('[data-slot="energy-use-box"]') as HTMLElement
  expect(boxEl().className).toContain('h-[436px]')
  expect(boxEl().className).toContain('@[860px]:h-[312px]')
  const before = boxEl().getBoundingClientRect()
  const fetches = recordFetches(qc)
  await screen.getByRole('button', { name: m.energy_period_prev_month() }).click() // June: no heat pumps
  await expect
    .poll(() => screen.container.querySelectorAll('[data-flow-node^="hp:"]').length)
    .toBe(0)
  const after = boxEl().getBoundingClientRect()
  expect(after.height).toBe(before.height)
  expect(after.top).toBe(before.top)
  fetches.stop()
  expect(fetches.fetched).toEqual([])
})

test('the month chart’s Förbrukning stacks the heat pumps', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await screen.getByRole('radio', { name: m.energy_metric_load() }).click()
  await vi.waitFor(() =>
    expect(legendText(screen.container)).toContain(m.energy_heat_pump_name({ name: 'Övervåning' })),
  )
})

test.each([
  [Overview, '/energy'],
  [Battery, '/energy/battery'],
] as const)('%#: a failing Comfort Cloud shows its alert; Emaldo’s heading stays', async (route, path) => {
  const { screen } = await renderPage(route, path, (qc) => {
    seedOverview(withData)(qc)
    seedSourcesHealth(qc, {
      comfortCloud: { state: 'failing', code: 'auth_failed', failingSince: new Date('2026-09-15T06:20:00Z'), consecutiveFailures: 2 },
    })
  })
  await expect
    .element(
      screen.getByText(
        m.charging_health_title({
          source: integrationSourceName('comfortCloud'),
          state: integrationHealthTitle('failing'),
        }),
      ),
    )
    .toBeVisible()
})

test('a healthy Comfort Cloud shows no alert', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(use(screen)).toBeVisible()
  expect(screen.container.textContent).not.toContain(integrationSourceName('comfortCloud'))
})
```

(imports: `integrationHealthTitle`, `integrationSourceName` from `~/lib/integrationHealthMessage`.) Existing tests that
query a load figure page-wide (`getByText` of a kWh that now also sits in Användning, e.g. `947,0 kWh`) must scope to
the Summering region or `figure(screen, …)`; fix any that fail in strict mode that way, without changing what they
assert.

`clientSafe.browser.test.tsx`:

```ts
test('the usage flow geometry and the heat pump colours are importable client-side', async () => {
  const layout = await import('~/lib/houseEnergy/usageFlowLayout')
  expect(typeof layout.usageFlowLayout).toBe('function')
  const colours = await import('~/lib/houseEnergy/heatPumpColors')
  expect(typeof colours.heatPumpColor).toBe('function')
})
```

Run: `bunx vitest run --project browser src/routes/_authenticated/energy src/lib/houseEnergy/clientSafe.browser.test.tsx`
→ FAIL (no Användning region, no Comfort Cloud alert).

- [ ] **Step 2: `EnergySyncAlerts.tsx`**

```tsx
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import type { useSyncNow } from '~/components/evCharging/SyncNowButton'
import type { SourceHealth } from '~/components/evCharging/syncHealth'
import type { IntegrationSource } from '~/lib/integrationHealth'

// The Energi pages' sources (heat pumps step 2): Emaldo (the house) and Comfort Cloud (the heat pumps). Each alert
// renders only when its source is unhealthy; the heading's "senast synkad" stays Emaldo's.
const ENERGY_SOURCES = ['emaldo', 'comfortCloud'] as const satisfies readonly IntegrationSource[]

export function EnergySyncAlerts({
  health,
  isAdmin,
  syncNow,
}: {
  health: Partial<Record<IntegrationSource, SourceHealth>> | undefined
  isAdmin: boolean
  syncNow: ReturnType<typeof useSyncNow>
}) {
  return (
    <>
      {ENERGY_SOURCES.map((source) => {
        const h = health?.[source]
        return h ? (
          <SyncHealthAlert
            key={source}
            health={h}
            isAdmin={isAdmin}
            onRetry={() => syncNow.syncSource(source)}
            retrying={syncNow.isPendingFor(source)}
          />
        ) : null
      })}
    </>
  )
}
```

(If `syncSource` / `isPendingFor` take a narrower union than `IntegrationSource`, type `ENERGY_SOURCES` with that
union instead; step 1b added `comfortCloud` to it.)

- [ ] **Step 3: The pages.** In `index.tsx` and `battery.tsx`, replace the `{health ? <SyncHealthAlert … /> : null}`
  block with `<EnergySyncAlerts health={sourcesHealth} isAdmin={isAdmin} syncNow={syncNow} />` (keep
  `const health = sourcesHealth?.emaldo` for the heading; drop the now-unused `SyncHealthAlert` import). Update the
  comment above the health query: "this page shows Emaldo's and Comfort Cloud's".

In `index.tsx`, add a module-level `const NO_UNITS: { id: string; name: string }[] = []`, in the component
`const heatPumpUnits = e.tiles?.allTime?.heatPumps ?? NO_UNITS` and `const useHeadingId = useId()`, pass
`heatPumpUnits={heatPumpUnits}` to `EnergyMonthlyChart` (replacing Task 7's `[]`), and insert between the Summering
`SectionSkeleton` and the chart's:

```tsx
          <SectionSkeleton name="energy-use" loading={e.pending} fallbackHeight="36rem">
            {e.tiles && e.period ? (
              <section aria-labelledby={useHeadingId}>
                <Card>
                  {/* The period is Summering's: its label here, no second control. */}
                  <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 id={useHeadingId} className="font-semibold text-lg">
                      {m.energy_use_heading()}
                    </h2>
                    <p className="text-muted-foreground text-sm">{periodLabel(e.period, e.now)}</p>
                  </CardHeader>
                  <CardContent
                    className={cn('transition-opacity', e.sumsDimmed && 'opacity-60')}
                    aria-busy={e.sumsStale || undefined}
                  >
                    <EnergyUseFlow sums={e.sums} units={heatPumpUnits} />
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </SectionSkeleton>
```

(imports: `EnergyUseFlow`, `periodLabel` from `~/components/energy/PeriodControl`, `EnergySyncAlerts`.)

- [ ] **Step 4: Run** the files from Step 1 and `bun run typecheck` → PASS.

- [ ] **Step 5: Skeleton.** Start the worktree's dev server on 14611 (Task 0), then
  `BONES_ORIGIN=http://localhost:14611 bun run bones:capture /energy`. Expected: `src/bones/energy-use.bones.json` is
  new; `energy-tiles` and `energy-chart` are skipped as unchanged (their DOM didn't change: the chart opens on Solel).
  If either changed anyway, keep the new capture and say why in the PR. Switch the section to the capture:
  `import energyUseBones from '~/bones/energy-use.bones.json'` and
  `<SectionSkeleton bones={energyUseBones} loading={e.pending} fallbackHeight="36rem">`. Run
  `bunx vitest run test/sectionSkeletonBones.test.ts` → PASS.

- [ ] **Step 6: CLAUDE.md code map.** In the `houseEnergy/` entry, after "`flowLayout.ts` (the Summering flow
  diagram's geometry)", add "+ `usageFlowLayout.ts` (the Användning diagram's, heat pumps step 2) + `heatPumpColors.ts`".

- [ ] **Step 7: Commit**

```bash
bun run check
git add src/components/energy/EnergySyncAlerts.tsx src/routes/_authenticated/energy src/lib/houseEnergy/clientSafe.browser.test.tsx \
  src/bones/energy-use.bones.json CLAUDE.md
git commit -m "feat(energy): show Användning and the Comfort Cloud alert" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verify live, review the branch, record the step, open the PR

- [ ] **Step 1: Live (Phase 6).** Playwright on the worktree's dev server (14611) with the local data from Task 0
  Step 3, signed in through Mailpit (memory: live UI check via Playwright; wait for load + 4 s, never `networkidle`).
  `/energy` at 1440, 820 and 390 px, light and dark:
  - Användning below Summering: load node, Laddning, Värmepump Matsal, Värmepump Övervåning, Övrigt hus; arrows in
    violet / teal / plum / orange; wide pills don't overlap a node or each other; no node text leaves its node; no
    horizontal overflow; console clean.
  - Both cards keep identical rects (± 0,5 px) stepping October → September → February and to Hela 2026 / Totalt, and
    into a month before the first heat pump reading if the local data has one (laddning + övrigt hus only).
  - The current month with a healthy source: no "Värmepumpsdata saknas" note (a trailing lag under 13 h isn't missing,
    Review Focus 1); note in the PR how far the heat pumps trailed the house data at the time.
  - Förbrukning on the chart: four parts per month, adding up to the tooltip's Förbrukat; the legend in stack order.
  - Network: switching a month sends no request.
  - Figures vs SQL (local DB) for 2026-02, 2026-09 and the current month — the checkpoint queries below, with each
    Användning value within 0,1 kWh.
  - Screenshots (wide light, phone dark) for the PR.

- [ ] **Step 2: Branch review (Phase 5).** `code-reviewer` (ADR-0024/0025/0027 adherence: sums only reach the browser,
  figures only in `figures.ts`, no new request) and `test-completeness` (services changed) over the whole diff, plus a
  general correctness pass (`/code-review high`). Fix or rule on every finding in this PR.

- [ ] **Step 3: Pre-PR gate** (`docs/feature-workflow.md`), verbatim:

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

Browser files that fail only after a merge (Vite re-optimising deps) are re-run alone before calling them failures.

- [ ] **Step 4: Prod baseline for checkpoint 3.** From Vercel runtime logs, the last 24 h of `rpc timing` lines for
  procedure `energy/overview` (all `arn1`): median warm `totalMs` (instances already warm, i.e. not the first request
  after a cold start). Put the number in the PR's *Risks / follow-ups* so checkpoint 3 can compare it with
  `heatPumpMs` and the new `totalMs`.

- [ ] **Step 5: Roadmap.** Row 2 of `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`: PR link, status `PR open`;
  a Log line with the live result and any deviation. The planning rulings (the 13 h trailing-gap rule, no value pills
  on the narrow layout, a fourth unit's neutral colour, `byHeatPumpName` as the unit order) are already in the spec;
  amend the spec and ADR-0027 only for a decision that changes during the build.

- [ ] **Step 6: Commit and PR**

```bash
git add docs/superpowers/roadmaps/2026-10-08-heat-pumps.md
git commit -m "docs(heat-pumps): track step 2" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/heat-pumps-overview
gh pr create --title "feat(energy): show what the house's consumption was used for" --body-file <(cat <<'EOF'
## Why

Energi › Översikt showed where the electricity came from but not what it was used for beyond the car. Step 2 of the
heat pumps roadmap ([ADR-0027](docs/adr/0027-heat-pump-energy-data.md), decisions 6–7): an Användning flow card,
the month chart's Förbrukning in four parts, and the Comfort Cloud health alert on the Energi pages.

## What changed

- `heatPump.monthSums` + heat pumps in every `energy.overview` period (expected hours clipped like the buckets),
  timed as `heatPumpMs`, read in parallel with the car.
- `figures.ts`: heat pumps capped at load − laddning; `restOfHouse` now excludes them.
- Användning card (visx, on the shared flow primitives), three validated `--energy-heat-pump-N` tokens.
- Decisions where the spec was silent: see the plan's list (narrow layout has no value pills; fourth unit neutral; …).

## Verification

- [ ] `bun run check` clean
- [ ] `bun run build` passes (tsc + bundle)
- [ ] `bun run test` passes
- [ ] Responsive on desktop + mobile — 1440 / 820 / 390, light + dark (screenshots below)

## Risks / follow-ups

- Prod `energy/overview` warm `totalMs` baseline: … ms (checkpoint 3 compares).
- A trailing heat pump gap counts as missing only from 13 h (the source's stale threshold); shorter lag shows no note.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

Fill the `…` with the measured values and paste the gate output and screenshots before opening.

#### Checkpoint 3 queries (prod, read-only, after the merge's deploy)

Heat pump kWh per unit per Stockholm month, clipped to the house data's range exactly as `energy.overview` reads it
(the month sums view's first day and newest bucket):

```sql
with house as (
  select (date_trunc('day', min(first_bucket) at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm') as from_ts,
         max(last_bucket) + interval '5 minutes' as to_ts
  from house_energy_month
)
select h.name,
       to_char(r.hour_start at time zone 'Europe/Stockholm', 'YYYY-MM') as month,
       round(sum(r.energy_kwh)::numeric, 1) as kwh,
       count(*) as hours
from heat_pump_reading r
join heat_pump h on h.id = r.heat_pump_id
cross join house
where r.hour_start >= house.from_ts and r.hour_start < house.to_ts
  and to_char(r.hour_start at time zone 'Europe/Stockholm', 'YYYY-MM') in ('2026-02', '2026-09', '2026-10')
group by 1, 2
order by 2, 1;
```

The load the page reads, for övrigt hus = load − laddning − heat pumps (laddning: `/charging` › *Alla* for the month):

```sql
select year, month, round(load_kwh::numeric, 1) as load_kwh
from house_energy_month
where (year, month) in ((2026, 2), (2026, 9), (2026, 10))
order by 1, 2;
```

Then: each unit's kWh on Användning equals the first query (± 0,1 kWh); Laddning equals `/charging`'s *Alla*; Övrigt
hus equals load − laddning − the units (when the units fit; otherwise 0); the month chart's Förbrukning parts add up to
the load; switching periods moves nothing at 1440, 820, 390 px; `rpc timing` for `energy/overview` logs `heatPumpMs`
and the warm `totalMs` is within 20 ms of the baseline; the owner reviews Översikt live (desktop + phone). Record the
result in the roadmap (checkpoint 3) in a new session.
