# House energy, step 1: read model + Energi › Översikt — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new *Energi* nav section whose first page, `/energy`, shows the house's solar, grid, self-sufficiency
and car-vs-house figures per period (tiles) and per month (chart), read on demand from `house_energy_reading`.

**Architecture:** One service (`getEnergyOverview`) runs a single `GROUP BY` Stockholm-month query over all
readings and reuses the charging overview for the car's kWh; a pure client-safe module (`figures.ts`) holds every
definition and the period arithmetic; a thin `energy.overview` procedure; a route that renders tiles and a
three-metric monthly chart. Only monthly sums cross the wire (ADR-0024).

**Tech Stack:** Drizzle (`pg`), oRPC + TanStack Query, TanStack Router file routes, Recharts via shadcn
`ChartContainer`, Paraglide, Vitest (node + browser projects).

**Spec:** [`docs/superpowers/specs/2026-10-05-house-energy-pages-design.md`](../specs/2026-10-05-house-energy-pages-design.md)
· ADR: [`docs/adr/0024-house-energy-pages.md`](../../adr/0024-house-energy-pages.md)
· Roadmap: [`docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md`](../roadmaps/2026-10-05-house-energy-pages.md) (step 1)

## Global Constraints

- Read-only: `protectedProcedure` only; no mutations, no admin-only data (ADR-0017).
- Only period sums leave the server; never a bucket, never a per-bucket array (ADR-0024 decision 3).
- All DB access in `src/lib/services/`; client code only `import type` from services (CLAUDE.md gotcha).
- No `refetchInterval` on the overview query; the Emaldo health query keeps 60 s (ADR-0018).
- Self-sufficiency = max(0, 1 − import ÷ load); `charge_ac` counts as grid-charged.
- `BATTERY_CAPACITY_KWH` (7.58) is the only `C`; import it from `src/lib/houseEnergy/mix/pool.ts`.
- Coverage below **0.99** shows "Data saknas för N h" (N rounded, at least 1).
- User-facing text via Paraglide, sv source + en key-complete; URL paths English (`/energy`).
- Synthetic readings only in tests (the repo is public).
- Logging via `~/lib/logger` (none expected here); `context.timings.getEnergyOverviewMs` on the procedure.
- Conventional Commits, one hat per commit; PR title `feat(energy): …`.

## Review Focus

1. **A month whose newest reading is mid-month (the current month, or a sync outage start)**: expected buckets
   end at the newest reading, so the hour before the next sync is not a gap. Pinned in Task 2 (`current month`).
2. **The first, partial month (readings start 2026-01-20)**: coverage counts from the first reading's day, so
   January isn't "missing 19 days". Pinned in Task 2 (`first reading day`).
3. **`?year=` naming a year without readings (2021, or a future year)**: the service falls back to the current
   year, the selector never shows a year with no data. Pinned in Task 2 (`year fallback`) and Task 3.
4. **import > load (January: 671 vs 620)**: self-sufficiency is 0 %, never negative. Pinned in Task 1.
5. **A DST month (March 743 h, October 745 h)**: expected buckets come from instants, so a full March is
   complete (coverage 1). Pinned in Task 2 (`spring-forward`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/houseEnergy/figures.ts` (create) | Client-safe: `PeriodSums` type, `addPeriodSums`, `energyFigures`, `gapHours`, thresholds |
| `src/lib/houseEnergy/figures.test.ts` (create) | Node unit tests for every formula |
| `src/lib/services/houseEnergy/energyOverview.ts` (create) | `getEnergyOverview`: the month query, coverage, car kWh, tiles, year fallback |
| `src/lib/services/houseEnergy/energyOverview.test.ts` (create) | Service tests on a per-test schema |
| `src/lib/services/houseEnergy/index.ts` (modify) | Re-export `energyOverview` |
| `src/lib/orpc/procedures/energy.ts` (create) | `energyRouter.overview` |
| `src/lib/orpc/procedures/energy.test.ts` (create) | Auth, validation, privacy shape |
| `src/lib/orpc/router.ts` (modify) | Register `energy` |
| `src/components/energy/energyQueries.ts` (create) | Shared query options for both Energi pages |
| `src/components/energy/EnergyHeading.tsx` (create) | Title, description, last synced |
| `src/components/energy/PeriodTabs.tsx` (create) | The period segmented control + card, shared with step 2 |
| `src/components/energy/EnergyTiles.tsx` (+ `.browser.test.tsx`) (create) | Five readouts + gap note per period |
| `src/components/energy/EnergyMonthlyChart.tsx` (+ `.browser.test.tsx`) (create) | 12-month stacked chart, three metrics, custom tooltip |
| `src/components/evCharging/TotalsTiles.tsx` (modify) | `export` the existing `Readout` (no other change) |
| `src/routes/_authenticated/energy/index.tsx` (create) | The Översikt page |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (create) | Client-safe guard for `figures.ts` + the route |
| `src/components/AppSidebar.tsx` (+ test) (modify) | *Energi* item (no sub-items until step 2) |
| `src/components/command/commands.ts` (modify) | Palette entry |
| `messages/sv.json`, `messages/en.json` (modify) | `energy_*`, `nav_energy`, `meta_energy_*`, `cmd_kw_energy` |
| `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` (modify) | Row 1 → `PR open` |

---

### Task 0: Verify `main` still matches this plan

**Files:** none (read-only), then the worktree.

- [ ] **Step 1: Check the seams this plan names**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "export const BATTERY_CAPACITY_KWH" src/lib/houseEnergy/mix/pool.ts
grep -n "export async function getOverview" src/lib/services/evCharging/overview.ts
grep -n "export function replaceDay\|export async function replaceDay" src/lib/services/houseEnergy/houseEnergy.ts
grep -n "export function syntheticDay" test/fixtures/houseEnergy.ts
grep -n "export function stockholmMonthBounds\|export function stockholmYearMonth\|export function stockholmDayOf\|export function stockholmDayBounds" src/lib/time/stockholm.ts
grep -n "^function Readout\|^export function Readout" src/components/evCharging/TotalsTiles.tsx
grep -n "export function useSyncNow" src/components/evCharging/SyncNowButton.tsx
grep -n "OVERVIEW_MIN_YEAR\|OVERVIEW_MAX_YEAR" src/lib/evCharging/counting.ts
ls src/routes/_authenticated/energy 2>/dev/null || echo "no energy routes yet (expected)"
```

Expected: every grep prints one line; `getOverview` still takes `{ year?, now?, vehicle? }` and returns
`tiles.{thisMonth,thisYear,allTime}.kwh` and `months[i].kwh` (12 entries, `month` 1–12). If a name moved, fix this
plan's references before building.

- [ ] **Step 2: Create the worktree** (feature-workflow Phase 3; no `+` in the path, it hangs Vitest browser mode)

```bash
git worktree add .claude/worktrees/energy-overview -b feat/energy-overview origin/main
cd .claude/worktrees/energy-overview && bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: Pure figures (`figures.ts`)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/houseEnergy/figures.ts`
- Test: `src/lib/houseEnergy/figures.test.ts`

**Interfaces:**
- Consumes: `BATTERY_CAPACITY_KWH` from `./mix/pool`.
- Produces (used by Tasks 2, 5, 6 and step 2):
  - `type PeriodSums = { gridImportKwh; gridExportKwh; solarKwh; loadKwh; batteryDischargeKwh; batteryChargeSolarKwh; batteryChargeGridKwh; carKwh: number; firstSocPct: number | null; lastSocPct: number | null; buckets: number; expectedBuckets: number }`
  - `addPeriodSums(earlier: PeriodSums, later: PeriodSums): PeriodSums`
  - `energyFigures(p: PeriodSums, capacityKwh?: number): EnergyFigures`
  - `gapHours(f: EnergyFigures): number | null`
  - `MIN_BATTERY_IN_KWH = 1`, `COVERAGE_COMPLETE = 0.99`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/houseEnergy/figures.test.ts
import { expect, test } from 'vitest'
import { addPeriodSums, energyFigures, gapHours, type PeriodSums } from './figures'
import { BATTERY_CAPACITY_KWH } from './mix/pool'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 0,
  gridExportKwh: 0,
  solarKwh: 0,
  loadKwh: 0,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  carKwh: 0,
  firstSocPct: null,
  lastSocPct: null,
  buckets: 0,
  expectedBuckets: 0,
  ...over,
})

test('splits solar into battery, exported and direct use', () => {
  const f = energyFigures(sums({ solarKwh: 500, batteryChargeSolarKwh: 170, gridExportKwh: 110 }))
  expect(f.solarToBattery).toBe(170)
  expect(f.solarExported).toBe(110)
  expect(f.solarDirect).toBe(220)
})

test('export beyond the solar surplus is not counted as solar', () => {
  // 10 kWh solar, 8 to the battery: at most 2 kWh of the 5 exported was solar.
  const f = energyFigures(sums({ solarKwh: 10, batteryChargeSolarKwh: 8, gridExportKwh: 5 }))
  expect(f.solarExported).toBe(2)
  expect(f.solarDirect).toBe(0)
})

test('battery charging from solar above production never makes direct use negative', () => {
  const f = energyFigures(sums({ solarKwh: 5, batteryChargeSolarKwh: 6 }))
  expect(f.solarExported).toBe(0)
  expect(f.solarDirect).toBe(0)
})

test('splits import into battery charging and direct use', () => {
  const f = energyFigures(sums({ gridImportKwh: 560, batteryChargeGridKwh: 68 }))
  expect(f.importToBattery).toBe(68)
  expect(f.importDirect).toBe(492)
})

test('grid charging above import is capped at import', () => {
  const f = energyFigures(sums({ gridImportKwh: 3, batteryChargeGridKwh: 4 }))
  expect(f.importToBattery).toBe(3)
  expect(f.importDirect).toBe(0)
})

test('self-sufficiency is the share of load not bought', () => {
  expect(energyFigures(sums({ gridImportKwh: 364, loadKwh: 898 })).selfSufficiency).toBeCloseTo(
    1 - 364 / 898,
    12,
  )
})

test('self-sufficiency is 0 when import exceeds load, and null without load', () => {
  expect(energyFigures(sums({ gridImportKwh: 671, loadKwh: 620 })).selfSufficiency).toBe(0)
  expect(energyFigures(sums({ gridImportKwh: 1 })).selfSufficiency).toBeNull()
})

test('car and the rest of the house; car above load leaves 0 for the house', () => {
  const f = energyFigures(sums({ loadKwh: 947, carKwh: 312 }))
  expect(f.car).toBe(312)
  expect(f.restOfHouse).toBe(635)
  expect(energyFigures(sums({ loadKwh: 2, carKwh: 3 })).restOfHouse).toBe(0)
})

test('battery in/out, SoC-corrected loss and efficiency', () => {
  const f = energyFigures(
    sums({
      batteryChargeSolarKwh: 170,
      batteryChargeGridKwh: 70,
      batteryDischargeKwh: 220,
      firstSocPct: 20,
      lastSocPct: 70,
    }),
  )
  const delta = (50 / 100) * BATTERY_CAPACITY_KWH
  expect(f.batteryIn).toBe(240)
  expect(f.batteryOut).toBe(220)
  expect(f.deltaStored).toBeCloseTo(delta, 12)
  expect(f.loss).toBeCloseTo(240 - 220 - delta, 12)
  expect(f.efficiency).toBeCloseTo(220 / (240 - delta), 12)
  expect(f.gridChargedShare).toBeCloseTo(70 / 240, 12)
})

test('a missing SoC at either end means no SoC correction', () => {
  const f = energyFigures(
    sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 8, firstSocPct: 40 }),
  )
  expect(f.deltaStored).toBe(0)
  expect(f.loss).toBe(2)
})

test('efficiency is capped at 1 and hidden below 1 kWh in; grid share hidden below 1 kWh in', () => {
  expect(
    energyFigures(sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 11 })).efficiency,
  ).toBe(1)
  const small = energyFigures(sums({ batteryChargeGridKwh: 0.9, batteryDischargeKwh: 0.5 }))
  expect(small.efficiency).toBeNull()
  expect(small.gridChargedShare).toBeNull()
})

test('a capacity can be passed (the default is BATTERY_CAPACITY_KWH)', () => {
  const f = energyFigures(sums({ firstSocPct: 0, lastSocPct: 100 }), 10)
  expect(f.deltaStored).toBe(10)
})

test('coverage, missing hours and the gap note', () => {
  const f = energyFigures(sums({ buckets: 288 * 30 - 113, expectedBuckets: 288 * 30 }))
  expect(f.coverage).toBeCloseTo(1 - 113 / (288 * 30), 12)
  expect(f.missingHours).toBeCloseTo((113 * 5) / 60, 12)
  expect(gapHours(f)).toBe(9)
  // 99 % or better: no note.
  expect(gapHours(energyFigures(sums({ buckets: 99, expectedBuckets: 100 })))).toBeNull()
  // Under an hour but below 99 %: at least 1 h.
  expect(gapHours(energyFigures(sums({ buckets: 3, expectedBuckets: 6 })))).toBe(1)
  expect(energyFigures(sums()).coverage).toBeNull()
})

test('addPeriodSums adds flows and buckets and keeps the outer SoCs', () => {
  const jan = sums({ gridImportKwh: 1, buckets: 2, expectedBuckets: 3, firstSocPct: 10, lastSocPct: 20, carKwh: 1 })
  const feb = sums({ gridImportKwh: 2, buckets: 4, expectedBuckets: 4, firstSocPct: 30, lastSocPct: 40, carKwh: 2 })
  expect(addPeriodSums(jan, feb)).toEqual(
    sums({ gridImportKwh: 3, buckets: 6, expectedBuckets: 7, firstSocPct: 10, lastSocPct: 40, carKwh: 3 }),
  )
  // A month without SoC doesn't erase the other's.
  const noSoc = sums({ gridImportKwh: 1 })
  expect(addPeriodSums(jan, noSoc).lastSocPct).toBe(20)
  expect(addPeriodSums(noSoc, feb).firstSocPct).toBe(30)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/houseEnergy/figures.test.ts`
Expected: FAIL, `Cannot find module './figures'`.

- [ ] **Step 3: Implement `figures.ts`**

```ts
// src/lib/houseEnergy/figures.ts
// Client-safe, pure (ADR-0024). The single home of the house-energy page
// definitions: what a period's sums mean as solar use, grid use,
// self-sufficiency, car vs house and battery in / out / loss. The service
// fills `PeriodSums` from SQL sums; the pages call `energyFigures` on them.
import { BATTERY_CAPACITY_KWH } from './mix/pool'

/** Below this many kWh into the battery, efficiency and grid share mean nothing. */
export const MIN_BATTERY_IN_KWH = 1
/** At or above this share of expected buckets a period counts as complete. */
export const COVERAGE_COMPLETE = 0.99
const BUCKET_HOURS = 5 / 60

/** One period's (a month, a year, all time) raw sums over the house readings, kWh. */
export type PeriodSums = {
  gridImportKwh: number
  gridExportKwh: number
  solarKwh: number
  loadKwh: number
  batteryDischargeKwh: number
  batteryChargeSolarKwh: number
  /** Emaldo `charge_grid` + `charge_ac` (ac counts as grid, as in the derive). */
  batteryChargeGridKwh: number
  /** Counted charging of every vehicle (the /charging overview's kWh rule). */
  carKwh: number
  /** SoC % of the period's first / last bucket that has one. */
  firstSocPct: number | null
  lastSocPct: number | null
  /** Readings in the period, and how many there would be without gaps. */
  buckets: number
  expectedBuckets: number
}

export type EnergyFigures = {
  solarToBattery: number
  solarExported: number
  solarDirect: number
  importToBattery: number
  importDirect: number
  /** 0–1, or null without load. */
  selfSufficiency: number | null
  car: number
  restOfHouse: number
  batteryIn: number
  batteryOut: number
  /** Change in stored energy over the period, kWh (negative when it emptied). */
  deltaStored: number
  /** in − out − Δstored; may be slightly negative over a short period (meter noise). */
  loss: number
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  efficiency: number | null
  /** 0–1, or null below MIN_BATTERY_IN_KWH. */
  gridChargedShare: number | null
  /** 0–1, or null when no bucket was expected. */
  coverage: number | null
  missingHours: number
}

/** Two adjacent periods as one; `earlier` must precede `later`. */
export function addPeriodSums(earlier: PeriodSums, later: PeriodSums): PeriodSums {
  return {
    gridImportKwh: earlier.gridImportKwh + later.gridImportKwh,
    gridExportKwh: earlier.gridExportKwh + later.gridExportKwh,
    solarKwh: earlier.solarKwh + later.solarKwh,
    loadKwh: earlier.loadKwh + later.loadKwh,
    batteryDischargeKwh: earlier.batteryDischargeKwh + later.batteryDischargeKwh,
    batteryChargeSolarKwh: earlier.batteryChargeSolarKwh + later.batteryChargeSolarKwh,
    batteryChargeGridKwh: earlier.batteryChargeGridKwh + later.batteryChargeGridKwh,
    carKwh: earlier.carKwh + later.carKwh,
    firstSocPct: earlier.firstSocPct ?? later.firstSocPct,
    lastSocPct: later.lastSocPct ?? earlier.lastSocPct,
    buckets: earlier.buckets + later.buckets,
    expectedBuckets: earlier.expectedBuckets + later.expectedBuckets,
  }
}

export function energyFigures(p: PeriodSums, capacityKwh = BATTERY_CAPACITY_KWH): EnergyFigures {
  const solarToBattery = p.batteryChargeSolarKwh
  const solarExported = Math.min(p.gridExportKwh, Math.max(0, p.solarKwh - solarToBattery))
  const solarDirect = Math.max(0, p.solarKwh - solarToBattery - solarExported)
  const importToBattery = Math.min(p.gridImportKwh, p.batteryChargeGridKwh)
  const batteryIn = solarToBattery + p.batteryChargeGridKwh
  const deltaStored =
    p.firstSocPct !== null && p.lastSocPct !== null
      ? ((p.lastSocPct - p.firstSocPct) / 100) * capacityKwh
      : 0
  const netIn = batteryIn - deltaStored
  const enough = batteryIn >= MIN_BATTERY_IN_KWH && netIn >= MIN_BATTERY_IN_KWH
  return {
    solarToBattery,
    solarExported,
    solarDirect,
    importToBattery,
    importDirect: p.gridImportKwh - importToBattery,
    selfSufficiency: p.loadKwh > 0 ? Math.max(0, 1 - p.gridImportKwh / p.loadKwh) : null,
    car: p.carKwh,
    restOfHouse: Math.max(0, p.loadKwh - p.carKwh),
    batteryIn,
    batteryOut: p.batteryDischargeKwh,
    deltaStored,
    loss: batteryIn - p.batteryDischargeKwh - deltaStored,
    efficiency: enough ? Math.min(1, p.batteryDischargeKwh / netIn) : null,
    gridChargedShare: batteryIn >= MIN_BATTERY_IN_KWH ? p.batteryChargeGridKwh / batteryIn : null,
    coverage: p.expectedBuckets > 0 ? p.buckets / p.expectedBuckets : null,
    missingHours: Math.max(0, p.expectedBuckets - p.buckets) * BUCKET_HOURS,
  }
}

/** Hours to name in "Data saknas för N h" (rounded, at least 1), or null when the period is complete. */
export function gapHours(f: EnergyFigures): number | null {
  if (f.coverage === null || f.coverage >= COVERAGE_COMPLETE) return null
  return Math.max(1, Math.round(f.missingHours))
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/lib/houseEnergy/figures.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/houseEnergy/figures.ts src/lib/houseEnergy/figures.test.ts
git commit -m "feat(energy): add the house-energy figure definitions"
```

---

### Task 2: The read service (`getEnergyOverview`)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/lib/services/houseEnergy/energyOverview.ts`
- Modify: `src/lib/services/houseEnergy/index.ts`
- Test: `src/lib/services/houseEnergy/energyOverview.test.ts`

**Interfaces:**
- Consumes: `PeriodSums`, `addPeriodSums` (Task 1); `getOverview` from `~/lib/services/evCharging`
  (`{ year?, now?, vehicle? }` → `{ tiles: { thisMonth, thisYear, allTime }: { kwh }, months: { month, kwh }[] }`);
  `stockholmMonthBounds`, `stockholmDayBounds`, `stockholmDayOf`, `stockholmYearMonth`.
- Produces (Task 3, pages):

```ts
export type EnergyOverview = {
  year: number                 // the chart's year (the requested one, or the current one as fallback)
  availableYears: number[]     // first reading's year … current year, newest first; [current] without readings
  firstReadingDay: string | null
  tiles: { thisMonth: PeriodSums | null; thisYear: PeriodSums | null; allTime: PeriodSums | null }
  months: (PeriodSums | null)[] // 12 entries, Jan → Dec; null = no reading that month
}
export async function getEnergyOverview(input?: { year?: number; now?: Date }): Promise<EnergyOverview>
```

**Car kWh (spec "Service"):** call the charging overview's `getOverview({ year, now, vehicle: 'all' })` and take
its kWh. It already implements the interval-with-fallback rule for the chart year's months and the three tiles, so
the Energi car figure equals `/charging`'s *Alla* figure by construction. Cost: its few small queries (≈ ms).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/services/houseEnergy/energyOverview.test.ts
import { expect, test } from 'vitest'
import { insertCharger, insertInterval, insertSession } from '~test/fixtures/evCharging'
import { type Flows, syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { getEnergyOverview } from './energyOverview'
import { replaceDay } from './houseEnergy'

setupDatabase()

const FIVE_MIN = 300_000
const dayOf = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return { dayStart: new Date(startMs), dayEnd: new Date(endMs) }
}
/** Stores `day` with `flows` on every bucket (or only the first `keep` buckets). */
async function storeDay(day: string, flows: Flows = {}, keep?: number) {
  const buckets = syntheticDay(day, () => flows)
  await replaceDay(dayOf(day), keep === undefined ? buckets : buckets.slice(0, keep))
}

test('an empty house: no periods, no months, the current year only', async () => {
  const o = await getEnergyOverview({ now: new Date('2026-06-15T12:00:00Z') })
  expect(o).toEqual({
    year: 2026,
    availableYears: [2026],
    firstReadingDay: null,
    tiles: { thisMonth: null, thisYear: null, allTime: null },
    months: Array(12).fill(null),
  })
})

test('sums each Stockholm month and keeps months apart', async () => {
  await storeDay('2026-03-31', { gridImportKwh: 0.1, loadKwh: 0.2, solarKwh: 0.05, batteryChargeAcKwh: 0.01 })
  await storeDay('2026-04-01', { gridImportKwh: 0.2, loadKwh: 0.3 })
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-01T20:00:00Z') })
  const march = o.months[2]
  const april = o.months[3]
  expect(march?.gridImportKwh).toBeCloseTo(288 * 0.1, 9)
  expect(march?.loadKwh).toBeCloseTo(288 * 0.2, 9)
  expect(march?.solarKwh).toBeCloseTo(288 * 0.05, 9)
  // charge_ac counts as grid-charged.
  expect(march?.batteryChargeGridKwh).toBeCloseTo(288 * 0.01, 9)
  expect(april?.gridImportKwh).toBeCloseTo(288 * 0.2, 9)
  expect(o.months[1]).toBeNull()
  expect(o.months[4]).toBeNull()
  expect(o.firstReadingDay).toBe('2026-03-31')
})

test('first and last SoC of a month come from its first and last buckets with a SoC', async () => {
  const day = '2026-05-10'
  const buckets = syntheticDay(day, (_t, i) => ({ batterySocPct: i === 0 ? null : i === 287 ? null : i % 100 }))
  await replaceDay(dayOf(day), buckets)
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-05-11T12:00:00Z') })
  expect(o.months[4]?.firstSocPct).toBe(1) // bucket 0 has none, bucket 1 → 1
  expect(o.months[4]?.lastSocPct).toBe(86) // bucket 287 has none, bucket 286 → 86
})

test('spring-forward: a full March is complete', async () => {
  // Every day of March 2026 stored (743 h); now is in April so March isn't the newest month… plus one April day.
  for (let d = 1; d <= 31; d++) await storeDay(`2026-03-${String(d).padStart(2, '0')}`)
  await storeDay('2026-04-01')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-04-02T12:00:00Z') })
  expect(o.months[2]?.buckets).toBe((743 * 60) / 5)
  expect(o.months[2]?.expectedBuckets).toBe((743 * 60) / 5)
})

test('first reading day: coverage counts from the day readings start, not the 1st', async () => {
  await storeDay('2026-01-20')
  await storeDay('2026-02-01')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-02-02T12:00:00Z') })
  // 2026-01-20 → 2026-02-01 00:00 = 12 days; one stored.
  expect(o.months[0]?.buckets).toBe(288)
  expect(o.months[0]?.expectedBuckets).toBe(12 * 288)
})

test('current month: expected buckets end at the newest reading', async () => {
  await storeDay('2026-06-01')
  await storeDay('2026-06-02', {}, 100) // newest bucket = 2026-06-02 00:00 + 99 × 5 min
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-06-02T15:00:00Z') })
  expect(o.months[5]?.buckets).toBe(388)
  expect(o.months[5]?.expectedBuckets).toBe(388)
})

test('a gap inside a month is counted', async () => {
  await storeDay('2026-08-05')
  await storeDay('2026-08-06', {}, 175) // the rest of the day missing (113 buckets ≈ 9.4 h)
  await storeDay('2026-08-07')
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-09-01T12:00:00Z') })
  const aug = o.months[7]
  expect(aug && aug.expectedBuckets - aug.buckets).toBe(113)
})

test('car kWh per month and in the tiles: every vehicle, by interval month', async () => {
  await storeDay('2026-03-10', { loadKwh: 0.2 })
  const chargerId = await insertCharger()
  const ours = await insertSession({
    chargerId,
    startAt: new Date('2026-03-10T18:00:00Z'),
    endAt: new Date('2026-03-10T20:00:00Z'),
    energyKwh: 7,
  })
  await insertInterval(ours, new Date('2026-03-10T18:00:00Z'), new Date('2026-03-10T20:00:00Z'), 7)
  // A guest session with no intervals: its own energy_kwh, in its start month.
  await insertSession({
    chargerId,
    vehicle: 'other',
    startAt: new Date('2026-03-11T08:00:00Z'),
    endAt: new Date('2026-03-11T09:00:00Z'),
    energyKwh: 3,
  })
  const o = await getEnergyOverview({ year: 2026, now: new Date('2026-03-20T12:00:00Z') })
  expect(o.months[2]?.carKwh).toBe(10)
  expect(o.tiles.thisMonth?.carKwh).toBe(10)
  expect(o.tiles.thisYear?.carKwh).toBe(10)
  expect(o.tiles.allTime?.carKwh).toBe(10)
})

test('tiles are the current periods whatever year the chart shows; all time spans years', async () => {
  await storeDay('2025-12-31', { gridImportKwh: 0.1 })
  await storeDay('2026-01-01', { gridImportKwh: 0.2 })
  const o = await getEnergyOverview({ year: 2025, now: new Date('2026-01-01T20:00:00Z') })
  expect(o.year).toBe(2025)
  expect(o.availableYears).toEqual([2026, 2025])
  expect(o.months[11]?.gridImportKwh).toBeCloseTo(28.8, 9)
  expect(o.months[0]).toBeNull() // January 2025
  expect(o.tiles.thisMonth?.gridImportKwh).toBeCloseTo(57.6, 9)
  expect(o.tiles.thisYear?.gridImportKwh).toBeCloseTo(57.6, 9)
  expect(o.tiles.allTime?.gridImportKwh).toBeCloseTo(86.4, 9)
  expect(o.tiles.allTime?.buckets).toBe(576)
})

test('year fallback: a year without readings shows the current year', async () => {
  await storeDay('2026-02-10')
  const now = new Date('2026-02-11T12:00:00Z')
  expect((await getEnergyOverview({ year: 2021, now })).year).toBe(2026)
  expect((await getEnergyOverview({ year: 2030, now })).year).toBe(2026)
  expect((await getEnergyOverview({ now })).year).toBe(2026)
})

test('the current month without a reading yet is null, the year tile still sums', async () => {
  await storeDay('2026-02-10', { gridImportKwh: 0.1 })
  const o = await getEnergyOverview({ now: new Date('2026-03-01T00:30:00Z') })
  expect(o.tiles.thisMonth).toBeNull()
  expect(o.tiles.thisYear?.gridImportKwh).toBeCloseTo(28.8, 9)
})
```

Note on the fixture flows: `syntheticDay` fills every flow not given with 0 and the SoC with null; `replaceDay`
validates and also queues a derive request (harmless here).

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts`
Expected: FAIL, `Cannot find module './energyOverview'`.

- [ ] **Step 3: Implement the service**

```ts
// src/lib/services/houseEnergy/energyOverview.ts
import { count, max, min, sql } from 'drizzle-orm'
import { db } from '~/lib/db'
import { houseEnergyReading } from '~/lib/db/schema'
import { addPeriodSums, type PeriodSums } from '~/lib/houseEnergy/figures'
import { getOverview as getChargingOverview } from '~/lib/services/evCharging'
import {
  stockholmDayBounds,
  stockholmDayOf,
  stockholmMonthBounds,
  stockholmYearMonth,
} from '~/lib/time/stockholm'

const BUCKET_MS = 5 * 60_000

export type EnergyOverview = {
  /** The chart's year: the requested one when it has readings, else the current Stockholm year. */
  year: number
  /** First reading's year … the current year, newest first; just the current year without readings. */
  availableYears: number[]
  /** Stockholm day of the first reading, or null with none. */
  firstReadingDay: string | null
  /** The current month / current year / all time, whatever year the chart shows (like /charging). */
  tiles: { thisMonth: PeriodSums | null; thisYear: PeriodSums | null; allTime: PeriodSums | null }
  /** Jan → Dec of `year`; null = no reading that month. */
  months: (PeriodSums | null)[]
}

type MonthRow = {
  year: number
  month: number
  sums: Omit<PeriodSums, 'carKwh' | 'expectedBuckets'>
  firstBucket: Date
  lastBucket: Date
}

const r = houseEnergyReading
const local = sql`(${r.bucketStart} AT TIME ZONE 'Europe/Stockholm')`
const num = (v: string | number | null) => (v === null ? 0 : Number(v))
const numOrNull = (v: string | number | null) => (v === null ? null : Number(v))

// Every month with readings, oldest first: one scan of the table (ADR-0024;
// ≈40 ms per year of readings locally). Grouped by Stockholm month, so a DST
// day stays in its own month. Returns sums only, never a bucket.
async function monthRows(): Promise<MonthRow[]> {
  const rows = await db
    .select({
      year: sql<number>`extract(year from ${local})::int`,
      month: sql<number>`extract(month from ${local})::int`,
      gridImportKwh: sql<string>`sum(${r.gridImportKwh})`,
      gridExportKwh: sql<string>`sum(${r.gridExportKwh})`,
      solarKwh: sql<string>`sum(${r.solarKwh})`,
      loadKwh: sql<string>`sum(${r.loadKwh})`,
      batteryDischargeKwh: sql<string>`sum(${r.batteryDischargeKwh})`,
      batteryChargeSolarKwh: sql<string>`sum(${r.batteryChargeSolarKwh})`,
      batteryChargeGridKwh: sql<string>`sum(${r.batteryChargeGridKwh} + ${r.batteryChargeAcKwh})`,
      firstSocPct: sql<string | null>`(array_agg(${r.batterySocPct} ORDER BY ${r.bucketStart}) FILTER (WHERE ${r.batterySocPct} IS NOT NULL))[1]`,
      lastSocPct: sql<string | null>`(array_agg(${r.batterySocPct} ORDER BY ${r.bucketStart} DESC) FILTER (WHERE ${r.batterySocPct} IS NOT NULL))[1]`,
      buckets: count(),
      firstBucket: min(r.bucketStart),
      lastBucket: max(r.bucketStart),
    })
    .from(r)
    .groupBy(sql`1, 2`)
    .orderBy(sql`1, 2`)
  return rows.map((row) => ({
    year: row.year,
    month: row.month,
    sums: {
      gridImportKwh: num(row.gridImportKwh),
      gridExportKwh: num(row.gridExportKwh),
      solarKwh: num(row.solarKwh),
      loadKwh: num(row.loadKwh),
      batteryDischargeKwh: num(row.batteryDischargeKwh),
      batteryChargeSolarKwh: num(row.batteryChargeSolarKwh),
      batteryChargeGridKwh: num(row.batteryChargeGridKwh),
      firstSocPct: numOrNull(row.firstSocPct),
      lastSocPct: numOrNull(row.lastSocPct),
      buckets: row.buckets,
    },
    // min/max over a non-empty group are never null.
    firstBucket: row.firstBucket as Date,
    lastBucket: row.lastBucket as Date,
  }))
}

/**
 * The house-energy pages' read model (ADR-0024): monthly sums of the chart's
 * year plus the current month, current year and all time. Expected buckets
 * count from the first reading's day, and the newest reading's month ends at
 * that reading (the sync runs hourly; the last hour isn't a gap). Car kWh is
 * the /charging overview's own figure for every vehicle, so the two pages
 * always agree.
 */
export async function getEnergyOverview(
  input: { year?: number; now?: Date } = {},
): Promise<EnergyOverview> {
  const now = input.now ?? new Date()
  const current = stockholmYearMonth(now.getTime())
  const rows = await monthRows()
  if (rows.length === 0) {
    return {
      year: current.year,
      availableYears: [current.year],
      firstReadingDay: null,
      tiles: { thisMonth: null, thisYear: null, allTime: null },
      months: Array(12).fill(null),
    }
  }

  const first = rows[0]
  const newest = rows[rows.length - 1]
  const firstReadingDay = stockholmDayOf(first.firstBucket.getTime())
  const coverageStartMs = stockholmDayBounds(firstReadingDay).startMs
  const availableYears: number[] = []
  for (let y = Math.max(current.year, newest.year); y >= first.year; y--) availableYears.push(y)
  const year =
    input.year !== undefined && availableYears.includes(input.year) ? input.year : current.year

  const car = await getChargingOverview({ year, now, vehicle: 'all' })

  const withExpected = (row: MonthRow): PeriodSums => {
    const bounds = stockholmMonthBounds(row.year, row.month)
    const startMs = Math.max(bounds.startMs, coverageStartMs)
    const endMs = row === newest ? row.lastBucket.getTime() + BUCKET_MS : bounds.endMs
    const expected = Math.round((endMs - startMs) / BUCKET_MS)
    return { ...row.sums, carKwh: 0, expectedBuckets: Math.max(expected, row.sums.buckets) }
  }
  const total = (selected: MonthRow[]): PeriodSums | null =>
    selected.length === 0 ? null : selected.map(withExpected).reduce(addPeriodSums)
  const withCar = (sums: PeriodSums | null, carKwh: number) => (sums ? { ...sums, carKwh } : null)

  const months: (PeriodSums | null)[] = Array(12).fill(null)
  for (const row of rows) {
    if (row.year !== year) continue
    months[row.month - 1] = withCar(withExpected(row), car.months[row.month - 1]?.kwh ?? 0)
  }

  return {
    year,
    availableYears,
    firstReadingDay,
    tiles: {
      thisMonth: withCar(
        total(rows.filter((row) => row.year === current.year && row.month === current.month)),
        car.tiles.thisMonth.kwh,
      ),
      thisYear: withCar(total(rows.filter((row) => row.year === current.year)), car.tiles.thisYear.kwh),
      allTime: withCar(total(rows), car.tiles.allTime.kwh),
    },
    months,
  }
}
```

Add to `src/lib/services/houseEnergy/index.ts` (keep alphabetical):

```ts
export * from './batteryPool'
export * from './energyOverview'
export * from './errors'
export * from './houseEnergy'
```

If `~/lib/services/evCharging` importing into `services/houseEnergy` creates an import cycle at module init
(`bunx vitest run` shows `undefined` for `getChargingOverview`), import from `~/lib/services/evCharging/overview`
directly instead.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/lib/services/houseEnergy/energyOverview.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/services/houseEnergy
git commit -m "feat(energy): read monthly house-energy sums"
```

---

### Task 3: The procedure (`energy.overview`)

**Reviewers:** `code-reviewer` + reviewer loading `better-auth-security-best-practices` (permission boundary).

**Files:**
- Create: `src/lib/orpc/procedures/energy.ts`, `src/lib/orpc/procedures/energy.test.ts`
- Modify: `src/lib/orpc/router.ts`

**Interfaces:**
- Consumes: `getEnergyOverview` (Task 2); `OVERVIEW_MIN_YEAR`/`OVERVIEW_MAX_YEAR` (2020/2100).
- Produces: `orpc.energy.overview` with input `{ year?: number }`, output `EnergyOverview`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/orpc/procedures/energy.test.ts
import { call } from '@orpc/server'
import { afterEach, expect, test, vi } from 'vitest'
import { auth } from '~/lib/auth'
import { db } from '~/lib/db'
import { user } from '~/lib/db/schema'
import type { Logger } from '~/lib/logger'
import { replaceDay } from '~/lib/services/houseEnergy'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import { syntheticDay } from '~test/fixtures/houseEnergy'
import { setupDatabase } from '~test/setup'
import { energyRouter } from './energy'

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

test('a signed-in member reads the overview, and the timing is recorded', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await signIn('user')
  const timings: Record<string, number> = {}
  const o = await call(energyRouter.overview, { year: 2026 }, { context: context(timings) })
  expect(o.year).toBe(2026)
  expect(o.months).toHaveLength(12)
  expect(typeof timings.getEnergyOverviewMs).toBe('number')
})

test('rejects an unauthenticated caller', async () => {
  await expect(call(energyRouter.overview, {}, { context: context() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
})

test('rejects a year outside 2020–2100 and a non-integer year', async () => {
  await signIn('user')
  for (const year of [2019, 2101, 2026.5]) {
    await expect(
      call(energyRouter.overview, { year }, { context: context() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  }
})

test('privacy: the output holds period sums only, never buckets', async () => {
  const day = '2026-02-10'
  const { startMs, endMs } = stockholmDayBounds(day)
  await replaceDay({ dayStart: new Date(startMs), dayEnd: new Date(endMs) }, syntheticDay(day))
  await signIn('user')
  const o = await call(energyRouter.overview, {}, { context: context() })
  expect(Object.keys(o).sort()).toEqual(['availableYears', 'firstReadingDay', 'months', 'tiles', 'year'])
  // The only arrays are the 12 months and the years; every period is a flat object of numbers.
  const flat = (p: unknown) =>
    p === null || Object.values(p as object).every((v) => v === null || typeof v === 'number')
  expect(o.months.every(flat)).toBe(true)
  expect(Object.values(o.tiles).every(flat)).toBe(true)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/lib/orpc/procedures/energy.test.ts`
Expected: FAIL, `Cannot find module './energy'`.

- [ ] **Step 3: Implement the procedure and register it**

```ts
// src/lib/orpc/procedures/energy.ts
import { z } from 'zod'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { protectedProcedure } from '~/lib/orpc/context'
import { getEnergyOverview } from '~/lib/services/houseEnergy'

export const energyRouter = {
  // The Energi pages' one read (ADR-0024): monthly sums for the chart's year
  // plus this month / this year / all time. Any signed-in member: read-only.
  // One grouped scan + the charging overview's queries → its own timing.
  overview: protectedProcedure
    .input(
      z.object({ year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional() }),
    )
    .handler(async ({ input, context }) => {
      const startedAt = performance.now()
      const overview = await getEnergyOverview({ year: input.year })
      if (context.timings)
        context.timings.getEnergyOverviewMs = Math.round(performance.now() - startedAt)
      return overview
    }),
}
```

In `src/lib/orpc/router.ts`, add `import { energyRouter } from './procedures/energy'` just above the
`./procedures/evCharging` import (Biome's sort order: `energy` < `evCharging`) and `energy: energyRouter,` as the
first key of `appRouter` (the keys are alphabetical).

- [ ] **Step 4: Run the tests and the type check**

Run: `bunx vitest run src/lib/orpc/procedures/energy.test.ts && bun run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/lib/orpc/procedures/energy.ts src/lib/orpc/procedures/energy.test.ts src/lib/orpc/router.ts
git commit -m "feat(energy): serve the house-energy overview"
```

---

### Task 4: Messages, the route shell, navigation and the palette

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`
- Create: `src/components/energy/energyQueries.ts`, `src/components/energy/EnergyHeading.tsx`,
  `src/routes/_authenticated/energy/index.tsx`, `src/lib/houseEnergy/clientSafe.browser.test.tsx`
- Modify: `src/components/AppSidebar.tsx`, `src/components/AppSidebar.browser.test.tsx`,
  `src/components/command/commands.ts`

**Interfaces:**
- Produces: `energyOverviewQuery(year)`, `emaldoHealthQuery` (both pages); `EnergyHeading({ title, lastSuccessAt })`;
  the `/_authenticated/energy/` route with search `{ year?: number }`.

- [ ] **Step 1: Add the messages**

Append to `messages/sv.json` (the file is a flat object, not sorted; add before the closing brace):

```json
  "nav_energy": "Energi",
  "cmd_kw_energy": "energi sol solel solceller batteri nät köpt såld export import självförsörjning förbrukning emaldo",
  "meta_energy_title": "Energi",
  "meta_energy_description": "Husets solel, el från och till nätet och hemmabatteriet.",
  "energy_title": "Energi",
  "energy_description": "Husets solel, el från och till nätet och förbrukning, från Emaldo. Datan synkas varje timme.",
  "energy_error_title": "Energidatan kunde inte hämtas",
  "energy_empty_title": "Ingen energidata ännu",
  "energy_empty_description": "Siffrorna visas när Emaldo-synken har hämtat husets första dag.",
  "energy_tiles_heading": "Summering",
  "energy_period_no_data": "Ingen energidata för perioden.",
  "energy_tile_solar": "Solel",
  "energy_tile_solar_split": "Direkt {direct} · batteri {battery} · såld {exported}",
  "energy_tile_import": "Köpt el",
  "energy_tile_import_to_battery": "varav {kwh} kWh till batteriet",
  "energy_tile_export": "Såld el",
  "energy_tile_self_sufficiency": "Självförsörjning",
  "energy_tile_self_sufficiency_detail": "av förbrukningen var inte köpt",
  "energy_tile_load": "Förbrukning",
  "energy_tile_load_car": "varav laddning {kwh} kWh",
  "energy_missing_hours": "Data saknas för {hours} h",
  "energy_chart_title": "Per månad",
  "energy_metric_label": "Visa i diagrammet",
  "energy_metric_solar": "Solel",
  "energy_metric_grid": "Nät",
  "energy_metric_load": "Förbrukning",
  "energy_series_solar_direct": "Använd direkt",
  "energy_series_solar_battery": "Till batteriet",
  "energy_series_solar_exported": "Såld",
  "energy_series_import_direct": "Köpt, använd direkt",
  "energy_series_import_battery": "Köpt till batteriet",
  "energy_series_export": "Såld",
  "energy_series_car": "Laddning",
  "energy_series_house": "Övrigt i huset",
  "energy_chart_total_solar": "Producerat",
  "energy_chart_total_grid": "Köpt totalt",
  "energy_chart_total_load": "Förbrukat",
  "energy_chart_so_far": "hittills",
  "energy_chart_no_data": "Ingen energidata för {year}"
```

Append the same keys to `messages/en.json`:

```json
  "nav_energy": "Energy",
  "cmd_kw_energy": "energy solar panels battery grid bought sold export import self-sufficiency consumption emaldo",
  "meta_energy_title": "Energy",
  "meta_energy_description": "The house's solar, grid import and export, and home battery.",
  "energy_title": "Energy",
  "energy_description": "The house's solar, grid import and export, and consumption, from Emaldo. Synced every hour.",
  "energy_error_title": "Couldn't load the energy data",
  "energy_empty_title": "No energy data yet",
  "energy_empty_description": "The figures appear once the Emaldo sync has fetched the house's first day.",
  "energy_tiles_heading": "Summary",
  "energy_period_no_data": "No energy data for this period.",
  "energy_tile_solar": "Solar",
  "energy_tile_solar_split": "Direct {direct} · battery {battery} · sold {exported}",
  "energy_tile_import": "Bought",
  "energy_tile_import_to_battery": "of which {kwh} kWh into the battery",
  "energy_tile_export": "Sold",
  "energy_tile_self_sufficiency": "Self-sufficiency",
  "energy_tile_self_sufficiency_detail": "of consumption wasn't bought",
  "energy_tile_load": "Consumption",
  "energy_tile_load_car": "of which charging {kwh} kWh",
  "energy_missing_hours": "Data missing for {hours} h",
  "energy_chart_title": "By month",
  "energy_metric_label": "Show in the chart",
  "energy_metric_solar": "Solar",
  "energy_metric_grid": "Grid",
  "energy_metric_load": "Consumption",
  "energy_series_solar_direct": "Used directly",
  "energy_series_solar_battery": "Into the battery",
  "energy_series_solar_exported": "Sold",
  "energy_series_import_direct": "Bought, used directly",
  "energy_series_import_battery": "Bought into the battery",
  "energy_series_export": "Sold",
  "energy_series_car": "Charging",
  "energy_series_house": "Rest of the house",
  "energy_chart_total_solar": "Produced",
  "energy_chart_total_grid": "Bought in total",
  "energy_chart_total_load": "Consumed",
  "energy_chart_so_far": "so far",
  "energy_chart_no_data": "No energy data for {year}"
```

Run: `bun run i18n:compile` and the sv/en key check from the pre-PR gate. Expected: "sv/en keys match".

- [ ] **Step 2: Shared queries and the heading**

```ts
// src/components/energy/energyQueries.ts
import { orpc } from '~/lib/orpc/client'

// Shared by both Energi pages: one cache entry per year, so switching between
// Översikt and Batteri costs no request (spec "Pages").
export const energyOverviewQuery = (year: number | undefined) =>
  orpc.energy.overview.queryOptions({ input: { year } })

export const emaldoHealthQuery = orpc.evCharging.syncStatus.queryOptions({
  input: { source: 'emaldo' },
})
```

```tsx
// src/components/energy/EnergyHeading.tsx
import { formatAgo } from '~/components/evCharging/format'
import { m } from '~/paraglide/messages'

// The Energi pages' heading: the view's title, what the data is, and when
// Emaldo last synced (ChargingHeading's shape, without its charging notes).
export function EnergyHeading({ title, lastSuccessAt }: { title: string; lastSuccessAt: Date | null }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">{title}</h1>
      <p className="max-w-2xl text-muted-foreground text-sm">{m.energy_description()}</p>
      {/* Relative time differs slightly between SSR and hydration (as in ChargingHeading). */}
      <p className="text-muted-foreground text-xs" suppressHydrationWarning>
        {lastSuccessAt
          ? m.charging_last_synced({ time: formatAgo(lastSuccessAt) })
          : m.charging_never_synced()}
      </p>
    </header>
  )
}
```

- [ ] **Step 3: The route shell (heading, health, empty and error states; tiles and chart come in Tasks 5–7)**

```tsx
// src/routes/_authenticated/energy/index.tsx
import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SunIcon } from 'lucide-react'
import { z } from 'zod'
import { EnergyHeading } from '~/components/energy/EnergyHeading'
import { emaldoHealthQuery, energyOverviewQuery } from '~/components/energy/energyQueries'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { useSyncNow } from '~/components/evCharging/SyncNowButton'
import { PageContainer } from '~/components/layout/PageContainer'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/energy/')({
  head: () => ({
    meta: seo({ title: m.meta_energy_title(), description: m.meta_energy_description() }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year }),
  // Prefetched, not ensured: a failed read shows its own alert under a
  // working heading and health alert (like /charging/economy).
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.prefetchQuery(energyOverviewQuery(deps.year)),
      queryClient.ensureQueryData(emaldoHealthQuery),
    ])
  },
  component: EnergyOverviewPage,
})

function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({ ...emaldoHealthQuery, refetchInterval: 60_000 })
  const year = Route.useSearch({ select: (s) => s.year })
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({ ...energyOverviewQuery(year), placeholderData: keepPreviousData })
  const { data: overview } = result

  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health.lastSuccessAt} />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('emaldo')}
        retrying={syncNow.isPendingFor('emaldo')}
      />
      {overview && !loadFailed(result) ? (
        overview.firstReadingDay === null ? (
          <Empty className="brand-wash rounded-lg border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SunIcon />
              </EmptyMedia>
              <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null
      ) : (
        <LoadErrorAlert title={m.energy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
```

Check `LoadErrorAlert` renders nothing while the query is still pending (read `loadFailed` and
`LoadErrorAlert` in `src/components/evCharging/LoadErrorAlert.tsx`; economy uses the same ternary). Run
`bun run dev` once (or `bun run build`) so the router plugin regenerates `src/routeTree.gen.ts`; commit the
regenerated file.

- [ ] **Step 4: Sidebar and palette**

In `src/components/AppSidebar.tsx`: add `SunIcon` to the lucide import and an item after Laddning (no sub-items
yet; step 2 adds Översikt / Batteri):

```ts
const mainNavItems = linkOptions([
  { to: '/', label: m.nav_home, icon: HomeIcon },
  { to: '/sensors', label: m.nav_sensors, icon: ThermometerIcon },
  { to: '/charging', label: m.nav_charging, icon: ZapIcon, subItems: chargingSubItems },
  { to: '/energy', label: m.nav_energy, icon: SunIcon },
  { to: '/users', label: m.nav_users, icon: UsersIcon },
])
```

In `src/components/command/commands.ts`: add `SunIcon` to the import and, after the `/charging/economy` entry:

```ts
  {
    to: '/energy',
    label: m.nav_energy,
    keywords: m.cmd_kw_energy,
    icon: SunIcon,
    adminOnly: false,
  },
```

- [ ] **Step 5: Tests: sidebar link + client-safe guard**

Add to `src/components/AppSidebar.browser.test.tsx` (it already has `renderSidebar`, the router-free `Link` mock
and `useMatchRoute` scripted by `current.path`):

```tsx
test('lists Energi after Laddning, linking to /energy, active on /energy', async () => {
  current.path = '/energy'
  const { screen } = await renderSidebar()
  const energy = screen.getByRole('link', { name: m.nav_energy(), exact: true })
  await expect.element(energy).toHaveAttribute('href', '/energy')
  expect(active(energy.element())).toBe(true)
  const hrefs = [...screen.container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(hrefs.indexOf('/energy')).toBeGreaterThan(hrefs.lastIndexOf('/charging/economy'))
  expect(hrefs.indexOf('/energy')).toBeLessThan(hrefs.indexOf('/users'))
})
```

Create the guard:

```tsx
// src/lib/houseEnergy/clientSafe.browser.test.tsx
import { expect, test } from 'vitest'

// Regression guard (see src/lib/sensor/clientSafe.browser.test.tsx): the Energi
// pages and the definitions they use must evaluate in a real browser without
// pulling a server-only module (services → db → pg, or effects).
test('the house-energy figures are importable client-side', async () => {
  const mod = await import('~/lib/houseEnergy/figures')
  expect(typeof mod.energyFigures).toBe('function')
})

test('the /energy route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/index')
  expect(mod.Route).toBeDefined()
})
```

Run: `bunx vitest run --project browser src/lib/houseEnergy/clientSafe.browser.test.tsx src/components/AppSidebar.browser.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add messages src/components/energy src/routes/_authenticated/energy src/routeTree.gen.ts \
  src/components/AppSidebar.tsx src/components/AppSidebar.browser.test.tsx src/components/command/commands.ts \
  src/lib/houseEnergy/clientSafe.browser.test.tsx
git commit -m "feat(energy): add the Energi section shell"
```

---

### Task 5: Period tiles (`EnergyTiles`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/components/evCharging/TotalsTiles.tsx` (`function Readout` → `export function Readout`, nothing else)
- Create: `src/components/energy/PeriodTabs.tsx`, `src/components/energy/EnergyTiles.tsx`, `src/components/energy/EnergyTiles.browser.test.tsx`

**Interfaces:**
- Consumes: `energyFigures`, `gapHours`, `PeriodSums` (Task 1); `Readout`; `formatOneDecimal`, `formatShare`.
- Produces: `PeriodTabs({ tiles, children: (sums: PeriodSums) => ReactNode })` and `type EnergyTilesData = Record<'thisMonth' | 'thisYear' | 'allTime', PeriodSums | null>` (step 2 reuses both); `EnergyTiles({ tiles }: { tiles: EnergyTilesData })`.

Layout decision: one card with the period as a segmented control (always, not only narrow): five readouts per
period don't fit three side-by-side cards. Readouts sit in a container-query grid: 1 column, 2 from `@sm`, 5 from
`@4xl`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/energy/EnergyTiles.browser.test.tsx
import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyTiles } from './EnergyTiles'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
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
  buckets: 8640,
  expectedBuckets: 8640,
  ...over,
})

test('shows this month by default with all five readouts', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles tiles={{ thisMonth: sums(), thisYear: sums({ solarKwh: 5000 }), allTime: sums() }} />,
  )
  await expect.element(screen.getByText('509,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('561,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('114,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('947,0 kWh')).toBeVisible()
  await expect.element(screen.getByText(m.energy_tile_import_to_battery({ kwh: '68,0' }))).toBeVisible()
  await expect.element(screen.getByText(m.energy_tile_load_car({ kwh: '312,0' }))).toBeVisible()
  // 1 − 561 / 947 ≈ 41 %
  await expect.element(screen.getByText(/^41\s%$/)).toBeVisible()
})

test('switching to I år shows the year', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles tiles={{ thisMonth: sums(), thisYear: sums({ solarKwh: 5000 }), allTime: sums() }} />,
  )
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
})

test('a period without data says so', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles tiles={{ thisMonth: null, thisYear: sums(), allTime: sums() }} />,
  )
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('a gap of 9 h is named; a complete period has no note', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{ thisMonth: sums({ buckets: 8640 - 113 }), thisYear: sums(), allTime: sums() }}
    />,
  )
  await expect.element(screen.getByText(m.energy_missing_hours({ hours: '9' }))).toBeVisible()
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
  expect(screen.getByText(m.energy_missing_hours({ hours: '9' })).elements()).toHaveLength(0)
})

test('no solar means no split line; no grid charging means no "varav" line', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{
        thisMonth: sums({ solarKwh: 0, batteryChargeSolarKwh: 0, gridExportKwh: 0, batteryChargeGridKwh: 0 }),
        thisYear: null,
        allTime: null,
      }}
    />,
  )
  expect(screen.getByText(/^Direkt /).elements()).toHaveLength(0)
  expect(screen.getByText(/till batteriet/).elements()).toHaveLength(0)
})
```

`renderWithProviders` uses the sv locale (TotalsTiles' test relies on it). Message params are strings: the
component formats numbers before passing them.

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run --project browser src/components/energy/EnergyTiles.browser.test.tsx`
Expected: FAIL, `Cannot find module './EnergyTiles'`.

- [ ] **Step 3: Implement the shared period shell, then the tiles**

The period tabs are their own component so step 2's battery tiles reuse them unchanged.

```tsx
// src/components/energy/PeriodTabs.tsx
import { CalendarDaysIcon, CalendarRangeIcon, InfinityIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'

type Period = 'thisMonth' | 'thisYear' | 'allTime'
export type EnergyTilesData = Record<Period, PeriodSums | null>

const PERIODS: { key: Period; icon: LucideIcon; label: () => string }[] = [
  { key: 'thisMonth', icon: CalendarDaysIcon, label: m.charging_tile_this_month },
  { key: 'thisYear', icon: CalendarRangeIcon, label: m.charging_tile_this_year },
  { key: 'allTime', icon: InfinityIcon, label: m.charging_tile_all_time },
]

// This month / this year / all time, one period at a time (five readouts don't
// fit three side-by-side cards). Opens on this month; the choice isn't
// persisted, as on /charging. A period without data says so; `children` only
// ever gets a period's sums. Shared by the Översikt and Batteri tiles.
export function PeriodTabs({
  tiles,
  children,
}: {
  tiles: EnergyTilesData
  children: (sums: PeriodSums) => ReactNode
}) {
  return (
    <Tabs defaultValue="thisMonth">
      <Card>
        <CardHeader className="pb-2">
          <TabsList
            className="w-full group-data-horizontal/tabs:h-10 sm:w-auto"
            aria-label={m.energy_tiles_heading()}
          >
            {PERIODS.map(({ key, icon: Icon, label }) => (
              <TabsTrigger key={key} value={key} className="min-w-0 flex-auto">
                <Icon aria-hidden className="size-3.5 max-[360px]:hidden" />
                <span className="truncate">{label()}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        <CardContent>
          {PERIODS.map(({ key }) => {
            const sums = tiles[key]
            return (
              <TabsContent
                key={key}
                value={key}
                className="rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {sums ? (
                  children(sums)
                ) : (
                  <p className="text-muted-foreground text-sm">{m.energy_period_no_data()}</p>
                )}
              </TabsContent>
            )
          })}
        </CardContent>
      </Card>
    </Tabs>
  )
}
```

```tsx
// src/components/energy/EnergyTiles.tsx
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GaugeIcon,
  HouseIcon,
  SunIcon,
} from 'lucide-react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { Readout } from '~/components/evCharging/TotalsTiles'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { type EnergyTilesData, PeriodTabs } from './PeriodTabs'

export type { EnergyTilesData } from './PeriodTabs'

// The house's energy per period: solar and where it went, bought, sold,
// self-sufficiency and consumption with the car's part (ADR-0024).
export function EnergyTiles({ tiles }: { tiles: EnergyTilesData }) {
  return <PeriodTabs tiles={tiles}>{(sums) => <PeriodReadouts sums={sums} />}</PeriodTabs>
}

const kwh = (value: number) => formatOneDecimal(value)

function PeriodReadouts({ sums }: { sums: PeriodSums }) {
  const f = energyFigures(sums)
  const gap = gapHours(f)
  const share = (part: number) => formatShare(part / sums.solarKwh)
  return (
    <div className="@container flex flex-col gap-3">
      <div className="grid @4xl:grid-cols-5 @sm:grid-cols-2 gap-4">
        <Readout
          icon={SunIcon}
          label={m.energy_tile_solar()}
          value={kwh(sums.solarKwh)}
          unit="kWh"
          detail={
            sums.solarKwh > 0
              ? m.energy_tile_solar_split({
                  direct: share(f.solarDirect),
                  battery: share(f.solarToBattery),
                  exported: share(f.solarExported),
                })
              : undefined
          }
        />
        <Readout
          icon={ArrowDownToLineIcon}
          label={m.energy_tile_import()}
          value={kwh(sums.gridImportKwh)}
          unit="kWh"
          detail={
            f.importToBattery > 0
              ? m.energy_tile_import_to_battery({ kwh: kwh(f.importToBattery) })
              : undefined
          }
        />
        <Readout
          icon={ArrowUpFromLineIcon}
          label={m.energy_tile_export()}
          value={kwh(sums.gridExportKwh)}
          unit="kWh"
        />
        <Readout
          icon={GaugeIcon}
          label={m.energy_tile_self_sufficiency()}
          value={f.selfSufficiency === null ? '—' : formatShare(f.selfSufficiency)}
          muted={f.selfSufficiency === null}
          detail={f.selfSufficiency === null ? undefined : m.energy_tile_self_sufficiency_detail()}
        />
        <Readout
          icon={HouseIcon}
          label={m.energy_tile_load()}
          value={kwh(sums.loadKwh)}
          unit="kWh"
          detail={f.car > 0 ? m.energy_tile_load_car({ kwh: kwh(f.car) }) : undefined}
        />
      </div>
      {gap === null ? null : (
        <p className="text-muted-foreground text-xs">
          {m.energy_missing_hours({ hours: String(gap) })}
        </p>
      )}
    </div>
  )
}
```

All icons exist in the installed `lucide-react` (checked 2026-10-05). The `max-[360px]:hidden` icon rule
mirrors TotalsTiles' `@max-xs:hidden` intent with a viewport breakpoint (no container on the tab list).

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run --project browser src/components/energy/EnergyTiles.browser.test.tsx src/components/evCharging/TotalsTiles.browser.test.tsx`
Expected: PASS (both files; TotalsTiles unchanged in behaviour).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/PeriodTabs.tsx src/components/energy/EnergyTiles.tsx src/components/energy/EnergyTiles.browser.test.tsx src/components/evCharging/TotalsTiles.tsx
git commit -m "feat(energy): show the house's energy per period"
```

---

### Task 6: Monthly chart (`EnergyMonthlyChart`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/energy/EnergyMonthlyChart.tsx`, `src/components/energy/EnergyMonthlyChart.browser.test.tsx`

**Interfaces:**
- Consumes: `energyFigures`, `gapHours`, `PeriodSums`; `ChartFrame`, `TooltipRow`, `CHART_HEIGHT`;
  `MetricOption`; `monthLabel`, `monthName`, `formatOneDecimal`, `formatShare`, `formatCount`; `minBarFor`.
- Produces:
  - `type EnergyMetric = 'solar' | 'grid' | 'load'`
  - `energyMetricOptions(): MetricOption<EnergyMetric>[]`
  - `EnergyMonthlyChart({ year, months, metric, currentMonth }: { year: number; months: (PeriodSums | null)[]; metric: EnergyMetric; currentMonth: number | null })`

Colours (spec "Shared UI rules"; check contrast live in Task 7): solar direct `--energy-solar`, into the battery
`--energy-battery`, exported `color-mix(in oklab, var(--energy-solar) 50%, var(--background))` (a lighter solar, with
the hairline seam), import direct `--energy-grid`, import into the battery `--energy-battery`, charging `--brand`,
rest of the house `--chart-1`. Export draws **below** the axis on the Nät metric (`stackOffset="sign"`).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/energy/EnergyMonthlyChart.browser.test.tsx
import { expect, test, vi } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyMonthlyChart, type EnergyMetric } from './EnergyMonthlyChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500,
  gridExportKwh: 100,
  solarKwh: 400,
  loadKwh: 800,
  batteryDischargeKwh: 150,
  batteryChargeSolarKwh: 120,
  batteryChargeGridKwh: 40,
  carKwh: 250,
  firstSocPct: 20,
  lastSocPct: 30,
  buckets: 100,
  expectedBuckets: 100,
  ...over,
})

// Jan–Mar empty (before the first reading), Apr–Dec with data.
const months = Array.from({ length: 12 }, (_, i) => (i < 3 ? null : sums()))

const render = (metric: EnergyMetric, data = months) =>
  renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <EnergyMonthlyChart year={2026} months={data} metric={metric} currentMonth={null} />
    </div>,
  )

test('solar: three stacked series, one bar per month with data', async () => {
  const { screen } = await render('solar')
  await vi.waitFor(() => {
    // 9 months × 3 series.
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(27)
  })
  await expect.element(screen.getByText(m.energy_series_solar_direct())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_solar_battery())).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_solar_exported())).toBeVisible()
})

test('grid and load metrics name their series in the legend', async () => {
  const grid = await render('grid')
  await expect.element(grid.screen.getByText(m.energy_series_import_direct())).toBeVisible()
  await expect.element(grid.screen.getByText(m.energy_series_import_battery())).toBeVisible()
  await expect.element(grid.screen.getByText(m.energy_series_export())).toBeVisible()
  grid.screen.unmount()
  const load = await render('load')
  await expect.element(load.screen.getByText(m.energy_series_car())).toBeVisible()
  await expect.element(load.screen.getByText(m.energy_series_house())).toBeVisible()
})

test('a year without any data shows the no-data state, not an empty chart', async () => {
  const { screen } = await render('solar', Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
  expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(0)
})
```

If `screen.unmount` isn't on the render result, use the `unmount` the helper returns (read
`test/browser/render.tsx`). The tooltip itself is verified live (hovering in browser tests is order-sensitive, see
memory on the ClimateChart flake); `energyTooltipRows` (below) is a pure function and gets a node test instead.

```ts
// src/components/energy/energyTooltip.test.ts
import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { energyTooltipRows } from './energyTooltip'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500, gridExportKwh: 100, solarKwh: 400, loadKwh: 800,
  batteryDischargeKwh: 150, batteryChargeSolarKwh: 120, batteryChargeGridKwh: 40, carKwh: 250,
  firstSocPct: 20, lastSocPct: 30, buckets: 100, expectedBuckets: 100, ...over,
})

test('solar rows: parts and the produced total', () => {
  expect(energyTooltipRows('solar', sums())).toEqual({
    parts: [
      { key: 'solarDirect', kwh: 180 },
      { key: 'solarBattery', kwh: 120 },
      { key: 'solarExported', kwh: 100 },
    ],
    totalKwh: 400,
  })
})

test('grid rows: export as a positive part; total is what was bought', () => {
  expect(energyTooltipRows('grid', sums())).toEqual({
    parts: [
      { key: 'importDirect', kwh: 460 },
      { key: 'importBattery', kwh: 40 },
      { key: 'exported', kwh: 100 },
    ],
    totalKwh: 500,
  })
})

test('load rows: charging and the rest of the house', () => {
  expect(energyTooltipRows('load', sums())).toEqual({
    parts: [
      { key: 'car', kwh: 250 },
      { key: 'house', kwh: 550 },
    ],
    totalKwh: 800,
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/components/energy/energyTooltip.test.ts && bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the series model (pure) and the chart**

```ts
// src/components/energy/energyTooltip.ts
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'

export type EnergyMetric = 'solar' | 'grid' | 'load'
export type SeriesKey =
  | 'solarDirect' | 'solarBattery' | 'solarExported'
  | 'importDirect' | 'importBattery' | 'exported'
  | 'car' | 'house'

/** Each metric's series in stack order (bottom → top; `exported` on Nät draws below the axis). */
export const METRIC_SERIES: Record<EnergyMetric, SeriesKey[]> = {
  solar: ['solarDirect', 'solarBattery', 'solarExported'],
  grid: ['importDirect', 'importBattery', 'exported'],
  load: ['car', 'house'],
}

/** A month's parts (positive kWh) and the metric's total, for the bars and the tooltip. */
export function energyTooltipRows(
  metric: EnergyMetric,
  p: PeriodSums,
): { parts: { key: SeriesKey; kwh: number }[]; totalKwh: number } {
  const f = energyFigures(p)
  const value: Record<SeriesKey, number> = {
    solarDirect: f.solarDirect,
    solarBattery: f.solarToBattery,
    solarExported: f.solarExported,
    importDirect: f.importDirect,
    importBattery: f.importToBattery,
    exported: p.gridExportKwh,
    car: f.car,
    house: f.restOfHouse,
  }
  const totalKwh = metric === 'solar' ? p.solarKwh : metric === 'grid' ? p.gridImportKwh : p.loadKwh
  return { parts: METRIC_SERIES[metric].map((key) => ({ key, kwh: value[key] })), totalKwh }
}
```

```tsx
// src/components/energy/EnergyMonthlyChart.tsx
import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts'
import { CHART_HEIGHT, ChartFrame, TooltipRow } from '~/components/evCharging/ChartFrame'
import {
  formatCount,
  formatOneDecimal,
  formatShare,
  monthLabel,
  monthName,
} from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import {
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from '~/components/ui/chart'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { type EnergyMetric, energyTooltipRows, METRIC_SERIES, type SeriesKey } from './energyTooltip'

export type { EnergyMetric } from './energyTooltip'

export function energyMetricOptions(): MetricOption<EnergyMetric>[] {
  return [
    { value: 'solar', label: m.energy_metric_solar() },
    { value: 'grid', label: m.energy_metric_grid() },
    { value: 'load', label: m.energy_metric_load() },
  ]
}

const EXPORT_COLOR = 'color-mix(in oklab, var(--energy-solar) 50%, var(--background))'

function seriesConfig(): Record<SeriesKey, { label: string; color: string }> {
  return {
    solarDirect: { label: m.energy_series_solar_direct(), color: 'var(--energy-solar)' },
    solarBattery: { label: m.energy_series_solar_battery(), color: 'var(--energy-battery)' },
    solarExported: { label: m.energy_series_solar_exported(), color: EXPORT_COLOR },
    importDirect: { label: m.energy_series_import_direct(), color: 'var(--energy-grid)' },
    importBattery: { label: m.energy_series_import_battery(), color: 'var(--energy-battery)' },
    exported: { label: m.energy_series_export(), color: EXPORT_COLOR },
    car: { label: m.energy_series_car(), color: 'var(--brand)' },
    house: { label: m.energy_series_house(), color: 'var(--chart-1)' },
  }
}

const TOTAL_LABEL: Record<EnergyMetric, () => string> = {
  solar: m.energy_chart_total_solar,
  grid: m.energy_chart_total_grid,
  load: m.energy_chart_total_load,
}

type Row = { label: string; month: number; sums: PeriodSums | null } & Partial<Record<SeriesKey, number | null>>

// The house's energy per month of `year` for one metric: stacked bars, export
// below the axis on Nät, a legend (touch can't hover), and a tooltip with the
// month's parts, its total, self-sufficiency and any gap. Months without data
// draw no bar (never a zero bar). The page owns the metric and the year.
export function EnergyMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  metric: EnergyMetric
  /** The current Stockholm month when `year` is the current year (its tooltip says "hittills"), else null. */
  currentMonth: number | null
}) {
  if (months.every((p) => p === null)) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm"
        style={{ height: CHART_HEIGHT }}
      >
        {m.energy_chart_no_data({ year: String(year) })}
      </div>
    )
  }
  const series = METRIC_SERIES[metric]
  const all = seriesConfig()
  const config = Object.fromEntries(series.map((k) => [k, all[k]])) satisfies ChartConfig
  const data: Row[] = months.map((p, i) => {
    const row: Row = { label: monthLabel(i + 1), month: i + 1, sums: p }
    const rows = p ? energyTooltipRows(metric, p).parts : []
    for (const key of series) {
      const part = rows.find((r) => r.key === key)
      // null (not 0) for a month without data: no bar, no tooltip row.
      row[key] = part ? (metric === 'grid' && key === 'exported' ? -part.kwh : part.kwh) : null
    }
    return row
  })
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }
  const top = series[series.length - (metric === 'grid' ? 2 : 1)]

  return (
    <ChartFrame config={config}>
      <BarChart
        data={data}
        stackOffset={metric === 'grid' ? 'sign' : 'none'}
        margin={{ left: 4, right: 12, top: 8, bottom: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          width="auto"
          tickLine={false}
          tickMargin={4}
          allowDecimals={false}
          tickFormatter={(v) => formatCount(Number(v))}
        />
        {metric === 'grid' ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => (
            <EnergyTooltip
              active={active}
              row={payload?.[0]?.payload as Row | undefined}
              metric={metric}
              currentMonth={currentMonth}
            />
          )}
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        {series.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="kwh"
            fill={`var(--color-${key})`}
            radius={key === top || (metric === 'grid' && key === 'exported') ? 4 : 0}
            {...seam}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartFrame>
  )
}

function EnergyTooltip({
  active,
  row,
  metric,
  currentMonth,
}: {
  active?: boolean
  row: Row | undefined
  metric: EnergyMetric
  currentMonth: number | null
}) {
  if (!active || !row?.sums) return null
  const { parts, totalKwh } = energyTooltipRows(metric, row.sums)
  const f = energyFigures(row.sums)
  const gap = gapHours(f)
  const config = seriesConfig()
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      {parts.map(({ key, kwh }) => (
        <TooltipRow key={key} label={config[key].label} color={config[key].color}>
          {formatOneDecimal(kwh)} kWh
        </TooltipRow>
      ))}
      <TooltipRow label={TOTAL_LABEL[metric]()} strong>
        {formatOneDecimal(totalKwh)} kWh
      </TooltipRow>
      {f.selfSufficiency === null ? null : (
        <TooltipRow label={m.energy_tile_self_sufficiency()}>{formatShare(f.selfSufficiency)}</TooltipRow>
      )}
      {gap === null ? null : (
        <span className="text-muted-foreground">{m.energy_missing_hours({ hours: String(gap) })}</span>
      )}
    </div>
  )
}
```

Notes for the implementer:
- `radius={4}` on every segment's top would round inner seams; only the topmost stacked series (and the export bar
  below the axis) gets it. Recharts rounds a negative bar's bottom when given a number, so the export bar reads right.
- Recharts 3 types: if `content={({ active, payload }) => …}` fails to type-check, type the parameter as
  `TooltipContentProps<number, string>` from `recharts`.
- If the legend lists series in a different order than the stack, pass `itemSorter` the way `MonthlyChart` does.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/components/energy/energyTooltip.test.ts && bunx vitest run --project browser src/components/energy/EnergyMonthlyChart.browser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/energyTooltip.ts src/components/energy/energyTooltip.test.ts \
  src/components/energy/EnergyMonthlyChart.tsx src/components/energy/EnergyMonthlyChart.browser.test.tsx
git commit -m "feat(energy): chart the house's energy per month"
```

---

### Task 7: Wire the page, verify live, record the step

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/routes/_authenticated/energy/index.tsx`
- Create: `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`
- Modify: `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md`

- [ ] **Step 1: Write the failing page test**

Mount the real route under a bare root with a seeded cache, the way
`src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` does (the `-` prefix keeps the file out of
the route tree; anything unseeded fails, which is how a failed read is staged):

```tsx
// src/routes/_authenticated/energy/-energyPage.browser.test.tsx
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { emaldoHealthQuery, energyOverviewQuery } from '~/components/energy/energyQueries'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Overview } from './index'

// Step 2 widens this union with the battery route.
type AnyRoute = typeof Overview

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
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
  buckets: 8640,
  expectedBuckets: 8640,
  ...over,
})

const withData = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: '2026-01-20',
  tiles: { thisMonth: sums(), thisYear: sums(), allTime: sums() },
  months: Array.from({ length: 12 }, (_, i) => (i < 9 ? sums() : null)),
}
const empty = {
  year: 2026,
  availableYears: [2026],
  firstReadingDay: null,
  tiles: { thisMonth: null, thisYear: null, allTime: null },
  months: Array(12).fill(null),
}

const seedOverview = (data: unknown) => (qc: QueryClient) =>
  qc.setQueryData(energyOverviewQuery(undefined).queryKey, data as never)

async function renderPage(route: AnyRoute, path: string, prepare: (qc: QueryClient) => void) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  qc.setQueryData(emaldoHealthQuery.queryKey, {
    source: 'emaldo',
    state: 'ok',
    lastSuccessAt: null,
    lastError: null,
  } as never)
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(route as unknown as { update: (o: unknown) => void }).update({
    id: path,
    path,
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([route as never]),
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

test('no readings yet: the empty state, no tiles', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(empty))
  await expect.element(screen.getByText(m.energy_empty_title())).toBeVisible()
  expect(screen.getByRole('tablist').elements()).toHaveLength(0)
})

test('with data: tiles, the chart with its metric toggle and year', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await expect.element(screen.getByRole('tablist', { name: m.energy_tiles_heading() })).toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.energy_chart_title() })).toBeVisible()
  await expect.element(screen.getByRole('radio', { name: m.energy_metric_solar() })).toBeVisible()
  await expect.element(screen.getByRole('combobox', { name: m.charging_year_label() })).toBeVisible()
})

test('Nät switches the chart to the grid series', async () => {
  const { screen } = await renderPage(Overview, '/energy', seedOverview(withData))
  await screen.getByRole('radio', { name: m.energy_metric_grid() }).click()
  await expect.element(screen.getByText(m.energy_series_import_direct())).toBeVisible()
})

test('a failed read: the error under a working heading', async () => {
  const { screen } = await renderPage(Overview, '/energy', () => {})
  await expect.element(screen.getByRole('heading', { name: m.energy_title() })).toBeVisible()
  await expect.element(screen.getByText(m.energy_error_title())).toBeVisible()
})
```

Radix's single-choice `ToggleGroup` renders its items as `radio`s (the charging scope test queries them so).
Run: `bunx vitest run --project browser src/routes/_authenticated/energy/-energyPage.browser.test.tsx`
Expected: the two data cases FAIL (no tiles or chart yet); the empty and error cases pass.

- [ ] **Step 2: Render tiles, filter row and chart**

Replace the `: null` branch of the data ternary in `EnergyOverviewPage` with the content, and add the year/metric
state. Final component body (imports: add `useCallback`, `useId`, `useState` from react; `Card`, `CardContent`,
`CardHeader`; `MetricToggle`; `YearSelector`; `EnergyTiles`; `EnergyMonthlyChart`, `energyMetricOptions`,
`type EnergyMetric`; `stockholmYearMonth`; `cn`):

```tsx
function EnergyOverviewPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({ ...emaldoHealthQuery, refetchInterval: 60_000 })
  const year = Route.useSearch({ select: (s) => s.year })
  const navigate = Route.useNavigate()
  // Hourly data: focus refetch only, no polling interval (ADR-0018).
  const result = useQuery({ ...energyOverviewQuery(year), placeholderData: keepPreviousData })
  const { data: overview, isPlaceholderData: stale } = result
  const [metric, setMetric] = useState<EnergyMetric>('solar')
  const chartHeadingId = useId()
  const metricLabelId = useId()
  const setYear = useCallback(
    (y: number) =>
      navigate({ to: '.', search: (s) => ({ ...s, year: y }), replace: true, resetScroll: false }),
    [navigate],
  )
  const now = stockholmYearMonth(Date.now())

  return (
    <PageContainer>
      <EnergyHeading title={m.energy_title()} lastSuccessAt={health.lastSuccessAt} />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('emaldo')}
        retrying={syncNow.isPendingFor('emaldo')}
      />
      {overview && !loadFailed(result) ? (
        overview.firstReadingDay === null ? (
          <Empty className="brand-wash rounded-lg border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SunIcon />
              </EmptyMedia>
              <EmptyTitle>{m.energy_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.energy_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Tiles are always the current periods: they don't dim on a year switch. */}
            <EnergyTiles tiles={overview.tiles} />
            <section aria-labelledby={chartHeadingId}>
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={chartHeadingId} className="font-medium text-sm">
                    {m.energy_chart_title()}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <span id={metricLabelId} className="sr-only">
                      {m.energy_metric_label()}
                    </span>
                    <MetricToggle
                      value={metric}
                      options={energyMetricOptions()}
                      onChange={setMetric}
                      aria-labelledby={metricLabelId}
                    />
                    <YearSelector
                      years={overview.availableYears}
                      value={overview.year}
                      onChange={setYear}
                    />
                  </div>
                </CardHeader>
                <CardContent
                  className={cn('transition-opacity', stale && 'opacity-60')}
                  aria-busy={stale}
                >
                  <EnergyMonthlyChart
                    year={overview.year}
                    months={overview.months}
                    metric={metric}
                    currentMonth={overview.year === now.year ? now.month : null}
                  />
                </CardContent>
              </Card>
            </section>
          </div>
        )
      ) : (
        <LoadErrorAlert title={m.energy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
```

`Date.now()` in render: the month only changes at a month boundary; an SSR/hydration mismatch there is a
once-a-month tooltip suffix, acceptable (it's inside the tooltip, which isn't SSR'd).

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/-energyPage.browser.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
bun run check
git add src/routes/_authenticated/energy
git commit -m "feat(energy): show tiles and the monthly chart on Energi"
```

- [ ] **Step 4: Live verification (Phase 6)**

Local DB has the full Emaldo history (memory: `scripts/deriveEnergyMix.ts` run; readings since 2026-01-20). Start
`bun run dev:up && bun run dev`, sign in via Mailpit magic link with Playwright (memory "Live UI check via
Playwright": BETTER_AUTH_URL override, wait load + 4 s, never networkidle), open `/energy`:
- desktop 1440, tablet 820, phone 390: tiles readable, readouts wrap 5 → 2 → 1, tab list fits, chart keeps 12
  months, legend wraps, no horizontal scroll;
- each metric; hover 2026-08 (scroll the chart into view first): "Data saknas för 9 h" (or the real gap hours);
  hover the current month: "(hittills)"; Nät shows export below the axis;
- dark mode: the export tint is distinguishable from solar direct in both themes; if not, darken the mix
  (`60%`) and re-check;
- Cmd+K "sol" finds Energi; the sidebar item is active on `/energy`;
- compare three months' tooltip figures with
  `psql "$LOCAL_DB" -c "select to_char(date_trunc('month', bucket_start at time zone 'Europe/Stockholm'),'YYYY-MM'), sum(grid_import_kwh), sum(grid_export_kwh), sum(solar_kwh), sum(load_kwh) from house_energy_reading group by 1 order by 1"`;
- `rpc timing` line for `energy.overview` in the dev server's log shows `getEnergyOverviewMs`.

- [ ] **Step 5: Roadmap row and pre-PR gate**

In `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` set row 1's Plan link to this file, PR link (once
opened) and status `PR open`; add a Log line with what the live check showed. Then run the
[pre-PR gate](../../feature-workflow.md#pre-pr-gate) and the Phase 5 branch review (`code-reviewer`,
`test-completeness`; no schema change, so no migration review). Commit:

```bash
git add docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md
git commit -m "docs(energy): track step 1"
```

PR title: `feat(energy): add the Energi overview page`. Stop here; step 2 is a new session.
