# House energy, step 2: Energi › Batteri — implementation plan

> **Re-check before building (2026-10-05):** step 1b ([period control design](../specs/2026-10-05-energy-period-control-design.md))
> replaces `PeriodTabs`, the `tiles.thisMonth/thisYear/allTime` shape, `?year=` and the colour tokens this plan
> was written against. Task 0 rewrites the affected tasks (2–4) to use the period control, `EnergyOverview`'s
> `months` / `yearTotal` / `allTime`, `?period=`, and step 1b's readout and size rules.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second Energi sub-page, `/energy/battery`, showing what the home battery took in (solar / grid), gave
back, lost and how efficient it was, per period (tiles) and per month (chart), with a note on winter loss.

**Architecture:** No new read: the page uses step 1's `energy.overview` (same query key as Översikt) and step 1's
`energyFigures` (`batteryIn`, `batteryOut`, `deltaStored`, `loss`, `efficiency`, `gridChargedShare`). New here: a
small pure display module (loss/efficiency rounding rules), battery tiles, a two-metric battery chart, the route,
and the sidebar's Översikt / Batteri sub-items.

**Tech Stack:** TanStack Router file routes, TanStack Query, Recharts via shadcn `ChartContainer`, Paraglide,
Vitest (node + browser).

**Spec:** [`docs/superpowers/specs/2026-10-05-house-energy-pages-design.md`](../specs/2026-10-05-house-energy-pages-design.md)
· ADR: [`docs/adr/0024-house-energy-pages.md`](../../adr/0024-house-energy-pages.md)
· Roadmap: [`docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md`](../roadmaps/2026-10-05-house-energy-pages.md) (step 2)
· Step 1 plan (the shapes this builds on): [`2026-10-05-energy-1-overview.md`](./2026-10-05-energy-1-overview.md)

## Global Constraints

- Read-only; no new procedure, no schema change (ADR-0024).
- Loss = in − out − Δstored; efficiency = out ÷ (in − Δstored), capped at 1, hidden below 1 kWh in (`figures.ts`).
- Tile display: loss below 0.5 kWh (including any negative loss) shows "≈ 0 kWh"; the tooltip shows the real
  value. Efficiency of exactly 1 (capped) shows "≈ 100 %". Loss % = max(0, loss) ÷ (in − Δstored), shown only
  when efficiency is shown.
- `charge_ac` is grid-charged (already folded into `batteryChargeGridKwh` by the service).
- The winter note names `C` from `BATTERY_CAPACITY_KWH`, formatted, never a hard-coded number.
- Paraglide sv + en key-complete; URL `/energy/battery`.
- Conventional Commits; PR title `feat(energy): …`.

## Review Focus

1. **A short or partial period with meter noise (the current month on its 1st)**: loss can be slightly negative;
   the tile says "≈ 0 kWh", never "−0,3 kWh". Pinned in Task 1 (`lossTile`).
2. **A summer month with almost no grid charging**: the "nät" part of the in-split reads "< 1 %" (formatShare),
   not "0 %" when there was some. Pinned in Task 2.
3. **A period where the battery barely ran (< 1 kWh in, e.g. a gap-heavy month)**: efficiency, loss % and grid
   share show "—", not "0 %" or "100 %". Pinned in Task 2.
4. **Switching Översikt ↔ Batteri keeps the year and makes no new request**: same query key, the sub-item links
   carry `?year=`. Pinned in Task 4 (page test seeds one cache entry for both) and Task 3 (sidebar href).
5. **A month with readings but no SoC at one end**: Δstored is 0 and the tooltip still shows in/out/loss without a
   "förändrad laddnivå" line of 0. Pinned in Task 3 (`batteryTooltipRows`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/energy/batteryDisplay.ts` (+ `.test.ts`) (create) | Pure: `lossTile`, `lossShare`, `efficiencyText`, `batteryTooltipRows` |
| `src/components/energy/BatteryTiles.tsx` (+ `.browser.test.tsx`) (create) | Period tabs + four readouts |
| `src/components/energy/BatteryMonthlyChart.tsx` (+ `.browser.test.tsx`) (create) | Energi (in stacked beside out) / Verkningsgrad metrics |
| `src/routes/_authenticated/energy/battery.tsx` (create) | The Batteri page |
| `src/routes/_authenticated/energy/-energyPage.browser.test.tsx` (modify) | Battery page cases |
| `src/components/AppSidebar.tsx` (+ test) (modify) | Energi sub-items, year carried between them |
| `src/components/command/commands.ts` (modify) | Palette entry |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` (modify) | Battery route guard |
| `messages/sv.json`, `messages/en.json` (modify) | `nav_energy_*`, `meta_energy_battery_*`, `energy_battery_*`, `cmd_kw_energy_battery` |
| `docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md` (modify) | Row 2 → `PR open` |

---

### Task 0: Verify `main` still matches this plan

- [ ] **Step 1: Check step 1 landed and its checkpoint passed**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "checkpoint passed" docs/superpowers/roadmaps/2026-10-05-house-energy-pages.md | head -1   # row 1
grep -n "export function energyFigures\|export function gapHours\|export type PeriodSums" src/lib/houseEnergy/figures.ts
grep -n "batteryIn\|deltaStored\|gridChargedShare" src/lib/houseEnergy/figures.ts | head -5
grep -n "export const energyOverviewQuery" src/components/energy/energyQueries.ts
grep -n "export const syncHealthQuery" src/components/evCharging/syncHealth.ts  # Emaldo's health: `data?.emaldo` (client-perf step 3)
grep -n "export function EnergyHeading" src/components/energy/EnergyHeading.tsx
grep -n "export function Readout" src/components/evCharging/TotalsTiles.tsx
grep -n "'/energy'" src/components/AppSidebar.tsx src/components/command/commands.ts
ls src/routes/_authenticated/energy/
```

Expected: row 1 is `checkpoint passed` (if not, run checkpoint 1, don't build step 2); every grep prints; the
energy folder has `index.tsx` and `-energyPage.browser.test.tsx`. Also check `src/components/energy/PeriodTabs.tsx` exports `PeriodTabs` and `EnergyTilesData`. If step 1 renamed
anything, adapt this plan's imports first.

- [ ] **Step 2: Worktree**

```bash
git worktree add .claude/worktrees/energy-battery -b feat/energy-battery origin/main
cd .claude/worktrees/energy-battery && bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: Pure battery display rules (`batteryDisplay.ts`)

**Reviewers:** `code-reviewer` + `test-completeness`.

**Files:**
- Create: `src/components/energy/batteryDisplay.ts`, `src/components/energy/batteryDisplay.test.ts`

**Interfaces:**
- Consumes: `EnergyFigures`, `energyFigures`, `PeriodSums` from `~/lib/houseEnergy/figures`; `formatShare`,
  `formatOneDecimal` from `~/components/evCharging/format`.
- Produces:
  - `LOSS_NOISE_KWH = 0.5`
  - `lossTile(f: EnergyFigures): { approxZero: boolean; kwh: number }`
  - `lossShare(f: EnergyFigures): number | null`
  - `efficiencyText(efficiency: number | null): string` ("—", "≈ 100 %" or `formatShare`)
  - `batteryTooltipRows(p: PeriodSums): { inSolar: number; inGrid: number; out: number; loss: number; deltaStored: number | null; efficiency: number | null }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/energy/batteryDisplay.test.ts
import { expect, test } from 'vitest'
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { BATTERY_CAPACITY_KWH } from '~/lib/houseEnergy/mix/pool'
import { batteryTooltipRows, efficiencyText, lossShare, lossTile } from './batteryDisplay'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 0, gridExportKwh: 0, solarKwh: 0, loadKwh: 0,
  batteryDischargeKwh: 0, batteryChargeSolarKwh: 0, batteryChargeGridKwh: 0, carKwh: 0,
  firstSocPct: null, lastSocPct: null, buckets: 0, expectedBuckets: 0, ...over,
})

test('lossTile: a real loss is shown, noise and negative loss read ≈ 0', () => {
  expect(lossTile(energyFigures(sums({ batteryChargeSolarKwh: 240, batteryDischargeKwh: 225 })))).toEqual({
    approxZero: false,
    kwh: 15,
  })
  expect(lossTile(energyFigures(sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 9.7 }))).approxZero).toBe(true)
  expect(lossTile(energyFigures(sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 11 }))).approxZero).toBe(true)
})

test('lossShare: loss over SoC-corrected in, only alongside efficiency, never negative', () => {
  const f = energyFigures(sums({ batteryChargeSolarKwh: 200, batteryDischargeKwh: 150 }))
  expect(lossShare(f)).toBeCloseTo(0.25, 12)
  expect(lossShare(energyFigures(sums({ batteryChargeSolarKwh: 0.5 })))).toBeNull()
  expect(lossShare(energyFigures(sums({ batteryChargeSolarKwh: 10, batteryDischargeKwh: 11 })))).toBe(0)
})

test('efficiencyText: dash without a value, ≈ 100 % when capped, a share otherwise', () => {
  expect(efficiencyText(null)).toBe('—')
  expect(efficiencyText(1)).toBe('≈ 100 %')
  expect(efficiencyText(0.94)).toMatch(/^94\s%$/)
})

test('batteryTooltipRows: in by origin, out, loss, Δstored and efficiency', () => {
  const rows = batteryTooltipRows(
    sums({ batteryChargeSolarKwh: 173, batteryChargeGridKwh: 68, batteryDischargeKwh: 225, firstSocPct: 30, lastSocPct: 40 }),
  )
  const delta = 0.1 * BATTERY_CAPACITY_KWH
  expect(rows.inSolar).toBe(173)
  expect(rows.inGrid).toBe(68)
  expect(rows.out).toBe(225)
  expect(rows.deltaStored).toBeCloseTo(delta, 12)
  expect(rows.loss).toBeCloseTo(241 - 225 - delta, 12)
  expect(rows.efficiency).toBeCloseTo(225 / (241 - delta), 12)
})

test('batteryTooltipRows: no SoC at an end → no Δstored row (null, not 0)', () => {
  expect(batteryTooltipRows(sums({ batteryChargeSolarKwh: 5, firstSocPct: 20 })).deltaStored).toBeNull()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/components/energy/batteryDisplay.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/energy/batteryDisplay.ts
// Client-safe, pure: how the battery figures read on the page (spec "Display
// rules"). The definitions themselves live in ~/lib/houseEnergy/figures.
import { formatShare } from '~/components/evCharging/format'
import { type EnergyFigures, energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'

/** Below this a loss is meter noise over the period (± one SoC step ≈ 0.08 kWh, plus the balance residual). */
export const LOSS_NOISE_KWH = 0.5

/** The tile's loss: "≈ 0 kWh" for noise or a negative loss, else the kWh. */
export function lossTile(f: EnergyFigures): { approxZero: boolean; kwh: number } {
  return { approxZero: f.loss < LOSS_NOISE_KWH, kwh: f.loss }
}

/** Loss as a share of what went in net of Δstored; null whenever efficiency is. */
export function lossShare(f: EnergyFigures): number | null {
  if (f.efficiency === null) return null
  return Math.max(0, f.loss) / (f.batteryIn - f.deltaStored)
}

/** "—" without a value, "≈ 100 %" when capped at 1 (out ≥ in: noise), else the share. */
export function efficiencyText(efficiency: number | null): string {
  if (efficiency === null) return '—'
  if (efficiency >= 1) return `≈ ${formatShare(1)}`
  return formatShare(efficiency)
}

/** One month's battery tooltip figures; `deltaStored` is null without a SoC at both ends. */
export function batteryTooltipRows(p: PeriodSums) {
  const f = energyFigures(p)
  return {
    inSolar: f.solarToBattery,
    inGrid: p.batteryChargeGridKwh,
    out: f.batteryOut,
    loss: f.loss,
    deltaStored: p.firstSocPct !== null && p.lastSocPct !== null ? f.deltaStored : null,
    efficiency: f.efficiency,
  }
}
```

`formatShare(1)` is "100 %" in sv-SE (narrow no-break space); the test's `toBe('≈ 100 %')` must use the same space:
if it fails only on whitespace, change the assertion to `toMatch(/^≈ 100\s%$/)`.

- [ ] **Step 4: Run the tests** — `bunx vitest run src/components/energy/batteryDisplay.test.ts` → PASS (5).

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/components/energy/batteryDisplay.ts src/components/energy/batteryDisplay.test.ts
git commit -m "feat(energy): add the battery display rules"
```

---

### Task 2: Battery tiles (`BatteryTiles`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/energy/BatteryTiles.tsx`, `src/components/energy/BatteryTiles.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (this task's keys and Task 3–4's, all at once)

**Interfaces:**
- Consumes: `energyFigures`, `gapHours`, `PeriodSums`; Task 1's helpers; `Readout`; `PeriodTabs` and
  `EnergyTilesData` (step 1, `src/components/energy/PeriodTabs.tsx`).
- Produces: `BatteryTiles({ tiles }: { tiles: EnergyTilesData })`.

- [ ] **Step 1: Add every step-2 message**

`messages/sv.json` (append):

```json
  "nav_energy_overview": "Översikt",
  "nav_energy_battery": "Batteri",
  "nav_energy_battery_long": "Hemmabatteri",
  "cmd_kw_energy_battery": "batteri hemmabatteri förlust verkningsgrad laddning urladdning laddnivå emaldo",
  "meta_energy_battery_title": "Hemmabatteri",
  "meta_energy_battery_description": "Vad hemmabatteriet laddade in, gav tillbaka och förlorade.",
  "energy_battery_title": "Hemmabatteri",
  "energy_battery_tile_in": "In",
  "energy_battery_tile_in_split": "Sol {solar} · nät {grid}",
  "energy_battery_tile_out": "Ut",
  "energy_battery_tile_loss": "Förlust",
  "energy_battery_tile_loss_share": "{share} av det som laddades in",
  "energy_battery_tile_efficiency": "Verkningsgrad",
  "energy_battery_tile_efficiency_detail": "ut ÷ in, rättat för laddnivån",
  "energy_battery_approx_zero": "≈ 0",
  "energy_battery_chart_title": "Per månad",
  "energy_battery_metric_energy": "Energi",
  "energy_battery_metric_efficiency": "Verkningsgrad",
  "energy_battery_series_in_solar": "In från sol",
  "energy_battery_series_in_grid": "In från nätet",
  "energy_battery_series_out": "Ut",
  "energy_battery_series_efficiency": "Verkningsgrad",
  "energy_battery_tooltip_loss": "Förlust",
  "energy_battery_tooltip_delta": "Förändrad laddnivå",
  "energy_battery_note": "Vintertid förloras mer: batteriet värmer sig självt och drar ström i vila. Förlusten räknas som in − ut − förändrad laddnivå, med {capacity} kWh per 100 % laddnivå."
```

`messages/en.json` (append):

```json
  "nav_energy_overview": "Overview",
  "nav_energy_battery": "Battery",
  "nav_energy_battery_long": "Home battery",
  "cmd_kw_energy_battery": "battery home battery loss efficiency charge discharge state of charge emaldo",
  "meta_energy_battery_title": "Home battery",
  "meta_energy_battery_description": "What the home battery took in, gave back and lost.",
  "energy_battery_title": "Home battery",
  "energy_battery_tile_in": "In",
  "energy_battery_tile_in_split": "Solar {solar} · grid {grid}",
  "energy_battery_tile_out": "Out",
  "energy_battery_tile_loss": "Loss",
  "energy_battery_tile_loss_share": "{share} of what went in",
  "energy_battery_tile_efficiency": "Efficiency",
  "energy_battery_tile_efficiency_detail": "out ÷ in, corrected for state of charge",
  "energy_battery_approx_zero": "≈ 0",
  "energy_battery_chart_title": "By month",
  "energy_battery_metric_energy": "Energy",
  "energy_battery_metric_efficiency": "Efficiency",
  "energy_battery_series_in_solar": "In from solar",
  "energy_battery_series_in_grid": "In from the grid",
  "energy_battery_series_out": "Out",
  "energy_battery_series_efficiency": "Efficiency",
  "energy_battery_tooltip_loss": "Loss",
  "energy_battery_tooltip_delta": "Change in charge",
  "energy_battery_note": "More is lost in winter: the battery heats itself and draws power while idle. Loss is in − out − change in state of charge, at {capacity} kWh per 100 % charge."
```

Run `bun run i18n:compile` and the sv/en key check. Expected: keys match.

- [ ] **Step 2: Write the failing test**

```tsx
// src/components/energy/BatteryTiles.browser.test.tsx
import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { BatteryTiles } from './BatteryTiles'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561, gridExportKwh: 114, solarKwh: 509, loadKwh: 947,
  batteryDischargeKwh: 225, batteryChargeSolarKwh: 173, batteryChargeGridKwh: 68, carKwh: 312,
  firstSocPct: 40, lastSocPct: 40, buckets: 8640, expectedBuckets: 8640, ...over,
})

test('in with its solar/grid split, out, loss with its share, efficiency', async () => {
  const { screen } = await renderWithProviders(
    <BatteryTiles tiles={{ thisMonth: sums(), thisYear: sums(), allTime: sums() }} />,
  )
  await expect.element(screen.getByText('241,0 kWh')).toBeVisible()
  await expect.element(screen.getByText(/^Sol 72\s% · nät 28\s%$/)).toBeVisible()
  await expect.element(screen.getByText('225,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('16,0 kWh')).toBeVisible() // 241 − 225, Δstored 0
  await expect.element(screen.getByText(/^7\s% av det som laddades in$/)).toBeVisible()
  await expect.element(screen.getByText(/^93\s%$/)).toBeVisible() // 225 / 241
})

test('noise loss reads ≈ 0 kWh; a capped efficiency reads ≈ 100 %', async () => {
  const { screen } = await renderWithProviders(
    <BatteryTiles
      tiles={{
        thisMonth: sums({ batteryChargeSolarKwh: 10, batteryChargeGridKwh: 0, batteryDischargeKwh: 10.2 }),
        thisYear: null,
        allTime: null,
      }}
    />,
  )
  await expect.element(screen.getByText(/^≈ 0 kWh$/)).toBeVisible()
  await expect.element(screen.getByText(/^≈ 100\s%$/)).toBeVisible()
})

test('a battery that barely ran: dashes, no shares', async () => {
  const { screen } = await renderWithProviders(
    <BatteryTiles
      tiles={{
        thisMonth: sums({ batteryChargeSolarKwh: 0.4, batteryChargeGridKwh: 0.2, batteryDischargeKwh: 0.1 }),
        thisYear: null,
        allTime: null,
      }}
    />,
  )
  expect(screen.getByText('—').elements().length).toBeGreaterThanOrEqual(1)
  expect(screen.getByText(/av det som laddades in/).elements()).toHaveLength(0)
  expect(screen.getByText(/^Sol /).elements()).toHaveLength(0)
})

test('a little grid charging reads "< 1 %", not 0 %', async () => {
  const { screen } = await renderWithProviders(
    <BatteryTiles
      tiles={{ thisMonth: sums({ batteryChargeSolarKwh: 200, batteryChargeGridKwh: 0.5 }), thisYear: null, allTime: null }}
    />,
  )
  await expect.element(screen.getByText(/nät < 1\s%$/)).toBeVisible()
})

test('switches period; a period without data says so', async () => {
  const { screen } = await renderWithProviders(
    <BatteryTiles tiles={{ thisMonth: sums(), thisYear: null, allTime: sums() }} />,
  )
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
})
```

Run: `bunx vitest run --project browser src/components/energy/BatteryTiles.browser.test.tsx` → FAIL (module).

- [ ] **Step 3: Implement**

Step 1 built the shared period shell (`PeriodTabs`, `EnergyTilesData` in `src/components/energy/PeriodTabs.tsx`); use it as-is.

```tsx
// src/components/energy/BatteryTiles.tsx
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, FlameIcon, GaugeIcon } from 'lucide-react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { Readout } from '~/components/evCharging/TotalsTiles'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { efficiencyText, lossShare, lossTile } from './batteryDisplay'
import { type EnergyTilesData, PeriodTabs } from './PeriodTabs'

// This month / this year / all time of the home battery: what went in (by
// origin), what came out, what was lost and the efficiency (ADR-0024).
export function BatteryTiles({ tiles }: { tiles: EnergyTilesData }) {
  return <PeriodTabs tiles={tiles}>{(sums) => <BatteryReadouts sums={sums} />}</PeriodTabs>
}

function BatteryReadouts({ sums }: { sums: PeriodSums }) {
  const f = energyFigures(sums)
  const loss = lossTile(f)
  const share = lossShare(f)
  const gap = gapHours(f)
  return (
    <div className="@container flex flex-col gap-3">
      <div className="grid @3xl:grid-cols-4 @sm:grid-cols-2 gap-4">
        <Readout
          icon={ArrowDownToLineIcon}
          label={m.energy_battery_tile_in()}
          value={formatOneDecimal(f.batteryIn)}
          unit="kWh"
          detail={
            f.gridChargedShare === null
              ? undefined
              : m.energy_battery_tile_in_split({
                  solar: formatShare(1 - f.gridChargedShare),
                  grid: formatShare(f.gridChargedShare),
                })
          }
        />
        <Readout
          icon={ArrowUpFromLineIcon}
          label={m.energy_battery_tile_out()}
          value={formatOneDecimal(f.batteryOut)}
          unit="kWh"
        />
        <Readout
          icon={FlameIcon}
          label={m.energy_battery_tile_loss()}
          value={loss.approxZero ? m.energy_battery_approx_zero() : formatOneDecimal(loss.kwh)}
          unit="kWh"
          detail={
            share === null ? undefined : m.energy_battery_tile_loss_share({ share: formatShare(share) })
          }
        />
        <Readout
          icon={GaugeIcon}
          label={m.energy_battery_tile_efficiency()}
          value={efficiencyText(f.efficiency)}
          muted={f.efficiency === null}
          detail={f.efficiency === null ? undefined : m.energy_battery_tile_efficiency_detail()}
        />
      </div>
      {gap === null ? null : (
        <p className="text-muted-foreground text-xs">{m.energy_missing_hours({ hours: String(gap) })}</p>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run** `bunx vitest run --project browser src/components/energy/` → PASS.

- [ ] **Step 5: Commit**

```bash
bun run check
git add messages src/components/energy
git commit -m "feat(energy): show the home battery per period"
```


---

### Task 3: Battery monthly chart (`BatteryMonthlyChart`)

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/components/energy/BatteryMonthlyChart.tsx`, `src/components/energy/BatteryMonthlyChart.browser.test.tsx`

**Interfaces:**
- Consumes: `batteryTooltipRows`, `efficiencyText` (Task 1); `ChartFrame`, `TooltipRow`, `CHART_HEIGHT`;
  `MetricOption`; `monthLabel`, `monthName`, `formatOneDecimal`, `formatCount`, `formatShare`.
- Produces: `type BatteryMetric = 'energy' | 'efficiency'`; `batteryMetricOptions()`;
  `BatteryMonthlyChart({ year, months, metric, currentMonth })` (same props shape as `EnergyMonthlyChart`).

Shape: *Energi* draws per month an "in" stack (`inSolar` `--energy-solar` + `inGrid` `--energy-grid`,
`stackId="in"`) beside an "ut" bar (`out`, `--energy-battery`, `stackId="out"`); Recharts places two stacks side by
side per category. *Verkningsgrad* draws one bar per month (`--energy-battery`), y domain `[0, 1]`, ticks via
`formatShare`; months with `efficiency === null` get `null` (no bar).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/energy/BatteryMonthlyChart.browser.test.tsx
import { expect, test, vi } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type BatteryMetric, BatteryMonthlyChart } from './BatteryMonthlyChart'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 500, gridExportKwh: 100, solarKwh: 400, loadKwh: 800,
  batteryDischargeKwh: 150, batteryChargeSolarKwh: 120, batteryChargeGridKwh: 40, carKwh: 250,
  firstSocPct: 20, lastSocPct: 30, buckets: 100, expectedBuckets: 100, ...over,
})
// Jan empty; Feb with a battery that barely ran (efficiency null); Mar–Dec normal.
const months = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? null : i === 1 ? sums({ batteryChargeSolarKwh: 0.3, batteryChargeGridKwh: 0.2, batteryDischargeKwh: 0.1 }) : sums(),
)
const render = (metric: BatteryMetric, data = months) =>
  renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <BatteryMonthlyChart year={2026} months={data} metric={metric} currentMonth={null} />
    </div>,
  )

test('energy: in (solar + grid) and out per month with data', async () => {
  const { screen } = await render('energy')
  await vi.waitFor(() => {
    // 11 months × 3 bars (inSolar, inGrid, out).
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(33)
  })
  await expect.element(screen.getByText(m.energy_battery_series_in_solar())).toBeVisible()
  await expect.element(screen.getByText(m.energy_battery_series_in_grid())).toBeVisible()
  await expect.element(screen.getByText(m.energy_battery_series_out())).toBeVisible()
})

test('efficiency: one bar per month that has one (not the near-idle February)', async () => {
  const { screen } = await render('efficiency')
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(10)
  })
})

test('no data in the year: the no-data state', async () => {
  const { screen } = await render('energy', Array(12).fill(null))
  await expect.element(screen.getByText(m.energy_chart_no_data({ year: '2026' }))).toBeVisible()
})
```

Run: `bunx vitest run --project browser src/components/energy/BatteryMonthlyChart.browser.test.tsx` → FAIL.

- [ ] **Step 2: Implement**

```tsx
// src/components/energy/BatteryMonthlyChart.tsx
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { CHART_HEIGHT, ChartFrame, TooltipRow } from '~/components/evCharging/ChartFrame'
import { formatCount, formatOneDecimal, formatShare, monthLabel, monthName } from '~/components/evCharging/format'
import type { MetricOption } from '~/components/evCharging/MetricToggle'
import { type ChartConfig, ChartLegend, ChartLegendContent, ChartTooltip } from '~/components/ui/chart'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { batteryTooltipRows, efficiencyText } from './batteryDisplay'

export type BatteryMetric = 'energy' | 'efficiency'

export function batteryMetricOptions(): MetricOption<BatteryMetric>[] {
  return [
    { value: 'energy', label: m.energy_battery_metric_energy() },
    { value: 'efficiency', label: m.energy_battery_metric_efficiency() },
  ]
}

type Row = {
  label: string
  month: number
  sums: PeriodSums | null
  inSolar: number | null
  inGrid: number | null
  out: number | null
  efficiency: number | null
}

// The battery per month of `year`: in (by origin) beside out, or the
// efficiency. Months without data, or with too little in for an efficiency,
// draw no bar. The tooltip carries loss, Δ laddnivå and efficiency.
export function BatteryMonthlyChart({
  year,
  months,
  metric,
  currentMonth,
}: {
  year: number
  months: (PeriodSums | null)[]
  metric: BatteryMetric
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
  const data: Row[] = months.map((p, i) => {
    const rows = p ? batteryTooltipRows(p) : null
    return {
      label: monthLabel(i + 1),
      month: i + 1,
      sums: p,
      inSolar: rows?.inSolar ?? null,
      inGrid: rows?.inGrid ?? null,
      out: rows?.out ?? null,
      efficiency: rows?.efficiency ?? null,
    }
  })
  const seam = { stroke: 'var(--background)', strokeWidth: 1 }
  const config = (
    metric === 'energy'
      ? {
          inSolar: { label: m.energy_battery_series_in_solar(), color: 'var(--energy-solar)' },
          inGrid: { label: m.energy_battery_series_in_grid(), color: 'var(--energy-grid)' },
          out: { label: m.energy_battery_series_out(), color: 'var(--energy-battery)' },
        }
      : { efficiency: { label: m.energy_battery_series_efficiency(), color: 'var(--energy-battery)' } }
  ) satisfies ChartConfig

  return (
    <ChartFrame config={config}>
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        {metric === 'energy' ? (
          <YAxis width="auto" tickLine={false} tickMargin={4} allowDecimals={false} tickFormatter={(v) => formatCount(Number(v))} />
        ) : (
          <YAxis width="auto" tickLine={false} tickMargin={4} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => formatShare(Number(v))} />
        )}
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => (
            <BatteryTooltip active={active} row={payload?.[0]?.payload as Row | undefined} currentMonth={currentMonth} />
          )}
        />
        {metric === 'energy' ? (
          <>
            <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
            <Bar dataKey="inSolar" stackId="in" fill="var(--color-inSolar)" {...seam} isAnimationActive={false} />
            <Bar dataKey="inGrid" stackId="in" fill="var(--color-inGrid)" radius={[4, 4, 0, 0]} {...seam} isAnimationActive={false} />
            <Bar dataKey="out" stackId="out" fill="var(--color-out)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </>
        ) : (
          <Bar dataKey="efficiency" fill="var(--color-efficiency)" radius={4} isAnimationActive={false} />
        )}
      </BarChart>
    </ChartFrame>
  )
}

function BatteryTooltip({
  active,
  row,
  currentMonth,
}: {
  active?: boolean
  row: Row | undefined
  currentMonth: number | null
}) {
  if (!active || !row?.sums) return null
  const t = batteryTooltipRows(row.sums)
  const gap = gapHours(energyFigures(row.sums))
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {monthName(row.month)}
        {row.month === currentMonth ? ` (${m.energy_chart_so_far()})` : ''}
      </div>
      <TooltipRow label={m.energy_battery_series_in_solar()} color="var(--energy-solar)">
        {formatOneDecimal(t.inSolar)} kWh
      </TooltipRow>
      <TooltipRow label={m.energy_battery_series_in_grid()} color="var(--energy-grid)">
        {formatOneDecimal(t.inGrid)} kWh
      </TooltipRow>
      <TooltipRow label={m.energy_battery_series_out()} color="var(--energy-battery)">
        {formatOneDecimal(t.out)} kWh
      </TooltipRow>
      {t.deltaStored === null ? null : (
        <TooltipRow label={m.energy_battery_tooltip_delta()}>{formatOneDecimal(t.deltaStored)} kWh</TooltipRow>
      )}
      <TooltipRow label={m.energy_battery_tooltip_loss()} strong>
        {formatOneDecimal(t.loss)} kWh
      </TooltipRow>
      <TooltipRow label={m.energy_battery_tile_efficiency()}>{efficiencyText(t.efficiency)}</TooltipRow>
      {gap === null ? null : (
        <span className="text-muted-foreground">{m.energy_missing_hours({ hours: String(gap) })}</span>
      )}
    </div>
  )
}
```

The tooltip shows the real (possibly negative) loss, per the spec. Run Biome after: the long JSX lines get wrapped.

- [ ] **Step 3: Run** the test file → PASS (3).

- [ ] **Step 4: Commit**

```bash
bun run check
git add src/components/energy/BatteryMonthlyChart.tsx src/components/energy/BatteryMonthlyChart.browser.test.tsx
git commit -m "feat(energy): chart the home battery per month"
```

---

### Task 4: The Batteri page, sub-items, palette

**Reviewers:** `code-reviewer` + reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Create: `src/routes/_authenticated/energy/battery.tsx`
- Modify: `src/routes/_authenticated/energy/-energyPage.browser.test.tsx`, `src/components/AppSidebar.tsx`,
  `src/components/AppSidebar.browser.test.tsx`, `src/components/command/commands.ts`,
  `src/lib/houseEnergy/clientSafe.browser.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/routes/_authenticated/energy/-energyPage.browser.test.tsx` (step 1's `renderPage`, `seedOverview`,
`withData`, `empty`): add `import { Route as Battery } from './battery'`, widen
`type AnyRoute = typeof Overview | typeof Battery`, and add:

```tsx
test('Batteri: tiles, chart and the winter note naming C', async () => {
  const { screen } = await renderPage(Battery, '/energy/battery', seedOverview(withData))
  await expect.element(screen.getByRole('heading', { name: m.energy_battery_title() })).toBeVisible()
  await expect.element(screen.getByRole('tablist', { name: m.energy_tiles_heading() })).toBeVisible()
  await expect.element(screen.getByRole('heading', { name: m.energy_battery_chart_title() })).toBeVisible()
  await expect.element(screen.getByText(/7,58 kWh per 100/)).toBeVisible()
})

test('Batteri: Verkningsgrad drops the in/out legend', async () => {
  const { screen } = await renderPage(Battery, '/energy/battery', seedOverview(withData))
  await expect.element(screen.getByText(m.energy_battery_series_in_solar())).toBeVisible()
  await screen.getByRole('radio', { name: m.energy_battery_metric_efficiency() }).click()
  await expect.element(screen.getByText(m.energy_battery_series_in_solar())).not.toBeInTheDocument()
})

test('Batteri: empty and failed reads', async () => {
  const emptyPage = await renderPage(Battery, '/energy/battery', seedOverview(empty))
  await expect.element(emptyPage.screen.getByText(m.energy_empty_title())).toBeVisible()
  emptyPage.screen.unmount()
  const failed = await renderPage(Battery, '/energy/battery', () => {})
  await expect.element(failed.screen.getByRole('heading', { name: m.energy_battery_title() })).toBeVisible()
  await expect.element(failed.screen.getByText(m.energy_error_title())).toBeVisible()
})
```

In `src/components/AppSidebar.browser.test.tsx`: with Energi's sub-items there are **two links named
"Översikt"** (charging's and energy's). Two test-only changes keep the file unambiguous:
1. The `Link` mock records props by target instead of label: `linkProps.set(to, { search, activeOptions })`
   (delete the `label` computation), and the existing link-props test reads `linkProps.get('/charging')`,
   `linkProps.get('/charging/patterns')` (the section link and its Översikt share `/charging` and the same props)
   and `linkProps.get('/sensors')`.
2. Sub-item lookups go through a helper that pins the href:

```tsx
const subLink = (screen: Awaited<ReturnType<typeof renderSidebar>>['screen'], name: string, href: string) => {
  const el = [...screen.container.querySelectorAll('a')].find(
    (a) => a.textContent === name && a.getAttribute('href') === href,
  )
  if (!el) throw new Error(`no link ${name} → ${href}`)
  return el
}
```

Replace `screen.getByRole('link', { name: m.nav_charging_overview(), exact: true })` in the existing tests with
`subLink(screen, m.nav_charging_overview(), '/charging')` (and its `.element()` uses with the element itself;
`expect.element(...)` becomes `expect(...).toHaveAttribute(...)`). Then add:

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

test('energy links match exactly and carry the year, never the vehicle scope', async () => {
  current.path = '/energy/battery'
  await renderSidebar()
  for (const to of ['/energy', '/energy/battery']) {
    const props = linkProps.get(to)
    expect(props?.activeOptions, to).toEqual({ exact: true, includeSearch: false })
    const search = props?.search as (prev: object) => object
    expect(search({ year: 2025, vehicle: 'other' })).toEqual({ year: 2025 })
    expect(Object.entries(search({})).filter(([, v]) => v !== undefined)).toEqual([])
  }
})
```

Add to `clientSafe.browser.test.tsx`:

```tsx
test('the /energy/battery route module evaluates client-side without a db leak', async () => {
  const mod = await import('~/routes/_authenticated/energy/battery')
  expect(mod.Route).toBeDefined()
})
```

Run them → FAIL (no battery route, no sub-items).

- [ ] **Step 2: The route**

`battery.tsx` is `index.tsx` with the battery parts swapped in. Copy step 1's final `index.tsx` and change:
- `createFileRoute('/_authenticated/energy/battery')`; `head` uses `m.meta_energy_battery_title()` /
  `m.meta_energy_battery_description()`; component `EnergyBatteryPage`.
- Heading title `m.energy_battery_title()`.
- `EnergyTiles` → `BatteryTiles`; `EnergyMonthlyChart`/`energyMetricOptions`/`EnergyMetric` →
  `BatteryMonthlyChart`/`batteryMetricOptions`/`BatteryMetric` with `useState<BatteryMetric>('energy')`; chart
  heading `m.energy_battery_chart_title()`.
- Under the chart card, the note:

```tsx
<p className="text-pretty text-muted-foreground text-xs">
  {m.energy_battery_note({ capacity: formatDecimal(BATTERY_CAPACITY_KWH) })}
</p>
```

(`formatDecimal` from `~/components/evCharging/format`, `BATTERY_CAPACITY_KWH` from
`~/lib/houseEnergy/mix/pool`; both client-safe.) The search schema, loader, query keys, health alert, empty and
error states stay identical. If the duplication between the two route files exceeds the page body, extract
`src/components/energy/EnergyPageFrame.tsx` (heading + health + empty + error around a `children(overview)`
render prop) and use it from both, in this task.

- [ ] **Step 3: Sidebar sub-items and palette**

`src/components/AppSidebar.tsx`:

```ts
const energySubItems = linkOptions([
  { to: '/energy', label: m.nav_energy_overview },
  { to: '/energy/battery', label: m.nav_energy_battery },
])
```

Set `subItems: energySubItems` on the `/energy` item; widen `type NavSubItem = (typeof chargingSubItems)[number] |
(typeof energySubItems)[number]`. Split the link props so the energy section never carries `vehicle`:

```ts
const activeOptions = { exact: true, includeSearch: false } as const
// Charging views keep the chosen year and vehicle scope (ADR-0021) between them.
const chargingLinkProps = {
  search: (prev: { year?: number; vehicle?: VehicleScope }) => ({ year: prev.year, vehicle: prev.vehicle }),
  activeOptions,
} as const
// Energy views keep the chosen year; they have no vehicle scope.
const energyLinkProps = {
  search: (prev: { year?: number }) => ({ year: prev.year }),
  activeOptions,
} as const
const sectionLinkProps = (to: string) => (to.startsWith('/energy') ? energyLinkProps : chargingLinkProps)
```

and use `{...('subItems' in item ? sectionLinkProps(item.to) : {})}` / `{...sectionLinkProps(item.to)}` in
`renderItem` / `renderSubItem`. Run `bun run typecheck`; if spreading the union into `<Link>` fails, give each
section item and its sub-items a `linkProps` field in `linkOptions` instead and spread `item.linkProps`.

`src/components/command/commands.ts`, after the `/energy` entry (`BatteryChargingIcon` import):

```ts
  {
    to: '/energy/battery',
    label: m.nav_energy_battery_long,
    keywords: m.cmd_kw_energy_battery,
    icon: BatteryChargingIcon,
    adminOnly: false,
  },
```

- [ ] **Step 4: Run** the four test files and `bun run typecheck` → PASS. Regenerate `src/routeTree.gen.ts`
(`bun run build` or the dev server) and include it.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/routes/_authenticated/energy src/routeTree.gen.ts src/components/AppSidebar.tsx \
  src/components/AppSidebar.browser.test.tsx src/components/command/commands.ts \
  src/lib/houseEnergy/clientSafe.browser.test.tsx src/components/energy
git commit -m "feat(energy): add the home battery page"
```

---

### Task 5: Verify live, record the step

- [ ] **Step 1: Live (Phase 6)** — Playwright on the local dev server with the full local history (same recipe as
step 1's Task 7): `/energy/battery` at 1440 / 820 / 390, light and dark:
- tiles: four readouts wrap 4 → 2 → 1; In's split, Loss's share, Efficiency;
- *Energi* metric: in-stack beside the out bar per month, February's grid-heavy in-bar vs May's solar-heavy one;
- *Verkningsgrad*: winter months visibly lower; hover a month: in/out/Δ/loss/efficiency, gap note on 2026-08;
- the note reads well and shows `7,58`;
- sidebar: Energi › Översikt / Batteri, active state on each, year kept when switching
  (`/energy?year=2026` → Batteri → `/energy/battery?year=2026`), no second `energy.overview` request in the
  network log on the switch;
- compare 2026-02, 2026-05, 2026-09 tooltip figures with

```sql
with r as (select date_trunc('month', bucket_start at time zone 'Europe/Stockholm') m, * from house_energy_reading)
select to_char(m,'YYYY-MM'),
  sum(battery_charge_solar_kwh) in_solar, sum(battery_charge_grid_kwh + battery_charge_ac_kwh) in_grid,
  sum(battery_discharge_kwh) out_kwh,
  (array_agg(battery_soc_pct order by bucket_start) filter (where battery_soc_pct is not null))[1] first_soc,
  (array_agg(battery_soc_pct order by bucket_start desc) filter (where battery_soc_pct is not null))[1] last_soc
from r group by 1 order by 1;
```

(loss = in − out − (last − first) / 100 × 7.58).

- [ ] **Step 2: Roadmap, gate, PR** — row 2: plan link, PR, `PR open`; a Log line with the live result. Pre-PR
gate, Phase 5 branch review (`code-reviewer`, `test-completeness`). Commit `docs(energy): track step 2`. PR title
`feat(energy): add the home battery page`. Checkpoint 2 runs after merge, in a new session.
