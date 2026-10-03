# Solar-aware charging cost, step 5: value of own solar. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under the cash cost, show one more line, "Värde av egen sol: 212 kr (vad den hade gett vid försäljning)":
what the solar energy the car used would have earned if exported. It goes on the overview tiles, in the monthly
chart's kr tooltip and on the session page. It is hidden when no solar was used, says "minst" when some solar lacked
a spot price, and says "okänt" when none of it had one.

**Architecture:** Display only, on top of step 4. Step 4 already computes `solarValueSek` in the pure cost math
(`src/lib/evCharging/cost/priceIntervals.ts`), and `CostSummary` (`src/lib/evCharging/costing.ts`) spreads
`CostTotals`, so the figure already reaches `costOverview` and the session page. Step 4 also ships
`solarPricedKwh` / `solarUnpricedKwh` (CONTRACT "Amendment A"), the solar-origin kWh the value does or doesn't
cover. Task 1 only verifies them. This step adds:
- a client-safe view helper (`src/components/evCharging/solarValue.ts`) that turns a total into
  hidden / value / at-least / unknown;
- one `SolarValueLine` component used by the tiles and the session hero, plus a tooltip row in `MonthlyChart`.

No schema, procedure, service or effect changes.

**Tech Stack:** React 19, TanStack Start/Query, Recharts 3.8 (`ChartTooltipContent`), Paraglide (sv source + en),
lucide-react, Tailwind v4 container queries, Vitest 4 (node + browser projects, `vitest/browser`).

**Spec:** docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md ("Cost and display", "Step 5"), plus
ADR-0023 decision 7 and roadmap step 5 (docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md).

## Contract deviations

1. **"Hidden when no solar was used" uses a display threshold.** The line is hidden below 0.05 kWh of solar-origin
   energy (`solarPricedKwh + solarUnpricedKwh`, per Amendment A), which is what one-decimal kWh shows as "0,0".
   Float crumbs from the proportional mix would otherwise print "Värde av egen sol: 0 kr". Visibility deliberately
   uses solar-origin kWh, not `solarKwh` (direct solar only), so a night session charged from a solar-filled battery
   still shows its value.

## Global Constraints

- Display only: no schema, migration, service, procedure or effect change in this PR. If one seems needed, stop and
  re-plan.
- The value is ex VAT with no fees, at the slot's spot price (or the battery's stored spot). It is never added to or
  subtracted from the cash cost (ADR-0023 decision 7).
- A missing price is never shown as 0 kr (ADR-0020): unpriced solar gives "minst …", or "okänt" when there's no
  priced solar at all.
- Money uses the existing helpers in `src/components/evCharging/format.ts`: `formatSignedSek` (no-break space before
  "kr", typographic minus, never "−0 kr"). Tiles and the chart use whole kronor; the session page uses 2 decimals,
  like its hero. "minst" comes from the existing `charging_cost_min`.
- All copy lives in `messages/sv.json` (source of truth) and `messages/en.json` (key-complete), with keys in
  alphabetical order. Run `bun run i18n:compile` after editing them.
- Client code may only `import type` from `~/lib/services/*`. `~/lib/evCharging/cost` is client-safe.
- Never `console.*`. This PR adds no logging.
- Every screen is responsive. Check at 360 / 820 / 1600 px with no horizontal page scroll.
- Never commit real household figures or screenshots of them: the repo is public. Test fixtures are synthetic.
- Conventional Commits, ≤ 72 characters, one hat per commit. End every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB for the node project: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **Night charging from a solar-filled battery** has `solarKwh` 0 but a real value. The line must show. Tests:
   step 4's priceIntervals tests (verified in Task 1) and Task 2 ("battery-only solar still shows").
2. **Partly or wholly unpriced solar** must read "minst …" or "okänt", never a bare partial figure or "0 kr".
   Tests: step 4's unpriced-solar tests (Task 1), Task 2 ("some solar lacks a price…", "only unpriced solar…"),
   Task 3 (tile "minst" and "okänt") and Task 4 (tooltip on an unpriced month).
3. **Negative spot prices** (sunny summer middays, exactly when solar charging happens) give a negative value. It
   must read "−3 kr", with no rounding to "−0 kr" and no dropped sign. Test: Task 2 ("a negative value keeps its
   sign…").
4. **Float crumbs**: a 0.01 kWh solar sliver must not print a line, and a 1e-9 kWh unpriced crumb must not trigger
   "minst". Tests: Task 2 ("solar that rounds to 0,0 kWh is hidden", "a float crumb of unpriced solar is not
   'minst'").
5. **Months whose cash readout is "Pris saknas"** (a no-tariff month, or an all-solar month that step 4 may still
   draw as a stub) must still show a known solar value in the tooltip. The tooltip must not overflow at 360 px.
   Tests: Task 4 ("an unpriced stub month still shows its solar value"), plus the live check in Task 8.

---

### Task 0: Verify main matches this plan

**Files:** none (only this plan, if it needs fixing)
**Reviewers:** none (a read-only gate)

- [ ] **Step 1: Make an isolated worktree from up-to-date main**

```bash
cd /Users/lukas/prog/videbacken
git fetch origin
git worktree add .claude/worktrees/charging-solar-value -b feat/charging-solar-value origin/main
cd .claude/worktrees/charging-solar-value
cp ../../../.env .env
# .env.local holds secrets: copy it, never print it. It must not carry a prod DATABASE_URL (CLAUDE.md gotcha):
[ -f ../../../.env.local ] && cp ../../../.env.local .env.local && grep -c '^DATABASE_URL' .env.local
bun install
```
Expected: the `grep -c` prints `0`. If it prints anything else, delete those lines from `.env.local` before running
anything.

- [ ] **Step 2: Steps 1–4 are merged and checkpoint 4 passed.** In
  `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, rows 1–4 must read `checkpoint passed`. If
  row 4 doesn't, **stop**: run checkpoint 4 per the roadmap instead, and don't start this step.

- [ ] **Step 3: Confirm what this plan consumes.** Run every grep and compare its output with the expectation.

```bash
# Step 4's CostTotals fields, emptyTotals and mergeTotals
grep -n "solarKwh\|batteryKwh\|noHouseDataKwh\|solarValueSek" src/lib/evCharging/cost/priceIntervals.ts
# PieceMix is exported and EnergyInterval has `mix?: PieceMix`
grep -n "export type PieceMix\|mix?: PieceMix" src/lib/evCharging/cost/priceIntervals.ts
# Amendment A fields shipped by step 4, with tests
grep -n "solarPricedKwh\|solarUnpricedKwh" src/lib/evCharging/cost/priceIntervals.ts src/lib/evCharging/cost/priceIntervals.test.ts
# CostSummary still spreads CostTotals
grep -n "export type CostSummary\|function summarize" src/lib/evCharging/costing.ts
# Format helpers this plan uses
grep -n "export function formatSignedSek\|export function formatSek\|export function formatKronor" src/components/evCharging/format.ts
# The tooltip formatter's 'fees' and 'unpriced' branches
grep -n "name === 'unpriced'\|name === 'fees'\|missingShare" src/components/evCharging/MonthlyChart.tsx
# Where the session page gets its cash CostSummary (step 4)
grep -rn "solarValueSek\|CostSummary\|SessionCost" src/lib/evCharging/economy/sessionEconomy.ts src/lib/orpc/procedures/evCharging.ts 'src/routes/_authenticated/charging/sessions/$sessionId.tsx' src/components/evCharging/SessionSummary.tsx
# Step 3's derive entrypoint (Task 8 uses it for local data)
grep -rn "deriveFrom" scripts src --include='*.ts' -l
```

Expected:
- `CostTotals` has the four step-4 fields, and `emptyTotals` / `mergeTotals` cover them.
- `PieceMix` is exported, with fields `gridKwh, solarKwh, batteryGridKwh, batteryGridSpotSek, batterySolarKwh,
  batterySolarSpotSek, batteryUnpricedKwh, noHouseDataKwh`.
- `solarPricedKwh` / `solarUnpricedKwh` are in `CostTotals`, `emptyTotals`, `mergeTotals` and the pure math, and
  `priceIntervals.test.ts` covers them (Task 1 checks this in detail).
- `CostSummary = CostTotals & { avgOre, complete }`.

- [ ] **Step 4: Re-read the merged step-4 versions** of `TotalsTiles.tsx`, `MonthlyChart.tsx`,
  `SessionSummary.tsx` and `src/routes/_authenticated/charging/sessions/$sessionId.tsx`, and adjust this plan's code
  before building:
  - **Tiles:** step 4 adds a subline under the cost readout ("34 % från sol och batteri"). The solar line goes
    **directly after that subline**, inside the same cost column.
  - **Session page:** this plan calls the session's cash `CostSummary` `detail.cost`, typed
    `RouterOutputs['evCharging']['session']['cost']`.
    - If step 4 named it differently, or the page reads it from a `sessionCosts` query, substitute that object.
      `SolarValueLine` takes any object with the three solar fields.
    - If it's nullable, guard with `cost ? … : null`.
    - Place the line under the hero's cash-cost figure (after step 4's unit-price line and before its mix bar,
      if the bar is inside the hero).
  - **Monthly chart:** check whether step 4 still treats an all-solar month (`gridKwh` 0) as an unpriced stub
    (`unpriced(c)` testing `fullKwh === 0` instead of `gridKwh > 0 && fullKwh === 0`). Either way, Task 4 renders
    the solar row in both branches. Note the finding for the PR's Risks section; fixing step 4's stub is out of
    scope here.
  - **Fixtures:** in the browser-test fixtures (`priced` in `TotalsTiles.browser.test.tsx`, `costMonths` in
    `MonthlyChart.browser.test.tsx`, `detail()` in `SessionSummary.browser.test.tsx`), note what step 4 added. This
    plan's tests spread those fixtures.

- [ ] **Step 5: Baseline is green.** `bun run db:up && bun run db:migrate && bun run test`. Expected: PASS. If it
  fails on main, stop and report: don't build on a red base.

---

### Task 1: Verify step 4 shipped the solar coverage counters (no code)

**Files:** none. Read `src/lib/evCharging/cost/priceIntervals.ts` and `priceIntervals.test.ts`.
**Interfaces:**
- Consumes (from step 4, CONTRACT "Amendment A"):
  - `CostTotals.solarPricedKwh: number`: solar-origin kWh whose value is priced (direct solar with a slot spot,
    plus battery-solar with a stored spot).
  - `CostTotals.solarUnpricedKwh: number`: solar-origin kWh without a spot. Their value is unknown, never 0.
  - `solarKwh` is direct solar only; `batteryKwh` is all battery kWh; `solarValueSek` covers direct solar plus
    battery-solar.
- Both reach `CostSummary`, `costOverview.tiles.*`, `costOverview.months[]`, `sessionCosts[]` and the session
  detail's cost through `summarize`'s spread.
**Reviewers:** none (a read-only gate, like Task 0).

- [ ] **Step 1: The fields exist end to end.**

```bash
grep -n "solarPricedKwh\|solarUnpricedKwh" src/lib/evCharging/cost/priceIntervals.ts
```
Expected: declared on `CostTotals` (with doc comments), zeroed in `emptyTotals`, summed in `mergeTotals`, and
accumulated in `priceIntervals`'s mix handling.

- [ ] **Step 2: Step 4 tested them.**

```bash
grep -n "solarPricedKwh\|solarUnpricedKwh" src/lib/evCharging/cost/priceIntervals.test.ts
bunx vitest run src/lib/evCharging/cost/priceIntervals.test.ts
```
Expected: PASS. The tests must cover, at minimum:
- (a) direct solar in a priced slot → priced, and `solarValueSek` = kWh × slot spot (ex VAT, no fees);
- (b) direct solar where no slot covers it → unpriced, and left out of `solarValueSek`;
- (c) battery-solar with a stored spot → priced, even in an unpriced slot;
- (d) battery-solar with a null stored spot → unpriced;
- (e) a missing tariff leaves solar priced;
- (f) grid / battery-grid / unpriced-battery / no-house-data parts count no solar;
- (g) the invariant `solarPricedKwh + solarUnpricedKwh = Σ (mix.solarKwh + mix.batterySolarKwh)`;
- (h) `emptyTotals` / `mergeTotals` cover both fields.

- [ ] **Step 3: If anything is missing or failing, STOP.** Don't add the fields or tests in this PR (Global
  Constraints: display only). Report it. The fix belongs in step 4, as a `fix(charging): …` PR against step 4's
  code with the missing tests. Resume this plan after it merges.

- [ ] **Step 4:** No commit: this task changes nothing.

---

### Task 2: The solar-value view helper (pure, client-safe)

**Files:**
- Create: `src/components/evCharging/solarValue.ts`
- Test: `src/components/evCharging/solarValue.test.ts` (node project, like `format.test.ts`)

**Interfaces:**
- Consumes: `type CostTotals` from `~/lib/evCharging/cost`; `formatSignedSek` from `./format`; `m.charging_cost_min`.
- Produces:
  ```ts
  export const SOLAR_VALUE_MIN_KWH = 0.05
  export type SolarValueInput = Pick<CostTotals, 'solarValueSek' | 'solarPricedKwh' | 'solarUnpricedKwh'>
  export type SolarValueAmount = { kind: 'value'; sek: number; atLeast: boolean }
  export type SolarValueView = { kind: 'hidden' } | { kind: 'unknown' } | SolarValueAmount
  export function solarValueView(t: SolarValueInput): SolarValueView
  export function formatSolarValue(v: SolarValueAmount, fractionDigits?: number): string
  ```

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/evCharging/solarValue.test.ts
import { afterEach, describe, expect, test } from 'vitest'
import { getLocale, overwriteGetLocale } from '~/paraglide/runtime'
import { formatSolarValue, SOLAR_VALUE_MIN_KWH, solarValueView } from './solarValue'

const original = getLocale
afterEach(() => overwriteGetLocale(original))

const totals = (solarPricedKwh: number, solarUnpricedKwh: number, solarValueSek: number) => ({
  solarPricedKwh,
  solarUnpricedKwh,
  solarValueSek,
})

describe('solarValueView', () => {
  test('no solar is hidden', () => {
    expect(solarValueView(totals(0, 0, 0))).toEqual({ kind: 'hidden' })
  })

  test('solar that rounds to 0,0 kWh is hidden, even with a value', () => {
    expect(solarValueView(totals(SOLAR_VALUE_MIN_KWH - 0.01, 0, 0.05))).toEqual({ kind: 'hidden' })
  })

  test('from 0,05 kWh it shows', () => {
    expect(solarValueView(totals(SOLAR_VALUE_MIN_KWH, 0, 0.04))).toEqual({
      kind: 'value',
      sek: 0.04,
      atLeast: false,
    })
  })

  test('fully priced solar is its value', () => {
    expect(solarValueView(totals(300, 0, 212))).toEqual({ kind: 'value', sek: 212, atLeast: false })
  })

  test('battery-only solar still shows: visibility counts solar-origin kWh, not direct solar', () => {
    // A night session from a solar-filled battery: no direct solar, a real value.
    expect(solarValueView(totals(6, 0, 4.62))).toEqual({ kind: 'value', sek: 4.62, atLeast: false })
  })

  test('some solar lacks a price: the value is a floor, "minst"', () => {
    expect(solarValueView(totals(10, 2, 9))).toEqual({ kind: 'value', sek: 9, atLeast: true })
  })

  test('only unpriced solar: the value is unknown, never 0 kr', () => {
    expect(solarValueView(totals(0, 3, 0))).toEqual({ kind: 'unknown' })
  })

  test('a float crumb of unpriced solar is not "minst"', () => {
    expect(solarValueView(totals(10, 1e-9, 9))).toEqual({ kind: 'value', sek: 9, atLeast: false })
  })

  test('a non-finite total is hidden rather than printed', () => {
    expect(solarValueView(totals(Number.NaN, 0, 0))).toEqual({ kind: 'hidden' })
  })
})

describe('formatSolarValue', () => {
  test('whole kronor by default, the unit joined by a no-break space', () => {
    expect(formatSolarValue({ kind: 'value', sek: 212.4, atLeast: false })).toBe('212 kr')
  })

  test('two decimals for a session', () => {
    expect(formatSolarValue({ kind: 'value', sek: 4.62, atLeast: false }, 2)).toBe('4,62 kr')
  })

  test('"minst" when part of the solar lacks a price', () => {
    expect(formatSolarValue({ kind: 'value', sek: 212, atLeast: true })).toBe('minst 212 kr')
  })

  test('a negative value keeps its sign; a tiny negative is 0 kr, never −0 kr', () => {
    expect(formatSolarValue({ kind: 'value', sek: -3.4, atLeast: false })).toBe('−3 kr')
    expect(formatSolarValue({ kind: 'value', sek: -0.2, atLeast: false })).toBe('0 kr')
  })

  test('follows the UI locale', () => {
    overwriteGetLocale(() => 'en')
    expect(formatSolarValue({ kind: 'value', sek: 1234.5, atLeast: true }, 2)).toBe(
      'at least 1,234.50 kr',
    )
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bunx vitest run src/components/evCharging/solarValue.test.ts
```
Expected: FAIL, `Failed to resolve import "./solarValue"`.

- [ ] **Step 3: Implement**

```ts
// src/components/evCharging/solarValue.ts
import type { CostTotals } from '~/lib/evCharging/cost'
import { m } from '~/paraglide/messages'
import { formatSignedSek } from './format'

// The value of own solar used (ADR-0023 decision 7): what the solar energy the
// car used would have earned if exported, at its slot's spot (or the
// battery's stored spot), ex VAT, no fees. Shown beside the cash cost, never
// folded into it. Pure and client-safe: tiles, the chart tooltip and the
// session page share these rules.

/**
 * Below this much solar-origin energy there's no line: it would show as
 * "0,0 kWh" wherever kWh are shown, and the proportional mix leaves float
 * crumbs that would otherwise print "0 kr" of solar.
 */
export const SOLAR_VALUE_MIN_KWH = 0.05

/** Unpriced solar below this is float noise, not a reason to say "minst" (cf. the cost math's 1e-6). */
const UNPRICED_EPSILON_KWH = 1e-6

export type SolarValueInput = Pick<
  CostTotals,
  'solarValueSek' | 'solarPricedKwh' | 'solarUnpricedKwh'
>
export type SolarValueAmount = { kind: 'value'; sek: number; atLeast: boolean }
export type SolarValueView = { kind: 'hidden' } | { kind: 'unknown' } | SolarValueAmount

/**
 * How a total's solar value reads: hidden when no solar was used; unknown when
 * none of it had a spot price (never 0 kr, ADR-0020); otherwise the value,
 * marked as a floor ("minst") when part of the solar lacked a price.
 */
export function solarValueView(t: SolarValueInput): SolarValueView {
  const solarKwh = t.solarPricedKwh + t.solarUnpricedKwh
  if (!(solarKwh >= SOLAR_VALUE_MIN_KWH)) return { kind: 'hidden' }
  if (!(t.solarPricedKwh > UNPRICED_EPSILON_KWH)) return { kind: 'unknown' }
  return {
    kind: 'value',
    sek: t.solarValueSek,
    atLeast: t.solarUnpricedKwh > UNPRICED_EPSILON_KWH,
  }
}

/**
 * "212 kr", "minst 212 kr", or "−3 kr" when spot was negative (exporting would
 * have cost money). Whole kronor by default (tiles, chart); the session page
 * passes 2.
 */
export function formatSolarValue(v: SolarValueAmount, fractionDigits = 0): string {
  const total = formatSignedSek(v.sek, fractionDigits)
  return v.atLeast ? m.charging_cost_min({ total }) : total
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run src/components/evCharging/solarValue.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(charging): add the solar-value view rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Messages, `SolarValueLine`, and the overview tiles

**Files:**
- Modify: `messages/sv.json`, `messages/en.json` (4 keys, alphabetical, after the last `charging_sessions_*` key)
- Create: `src/components/evCharging/SolarValueLine.tsx`
- Modify: `src/components/evCharging/TotalsTiles.tsx` (the cost column in `TileReadouts`)
- Test: `src/components/evCharging/TotalsTiles.browser.test.tsx`

**Interfaces:**
- Consumes: `solarValueView`, `formatSolarValue`, `SolarValueInput` (Task 2); the `Cost` tile type (which carries
  step 4's solar fields).
- Produces:
  `export function SolarValueLine(props: { cost: SolarValueInput; fractionDigits?: number; estimated?: boolean }): JSX.Element | null`

**Reviewers:** A = `code-reviewer`, B = a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Messages.** Add them and keep both files in alphabetical key order:

| key | sv | en |
|---|---|---|
| `charging_solar_value` | `Värde av egen sol: {value} (vad den hade gett vid försäljning)` | `Value of own solar: {value} (what it would have earned if sold)` |
| `charging_solar_value_hint` | `vad den hade gett vid försäljning` | `what it would have earned if sold` |
| `charging_solar_value_label` | `Värde av egen sol` | `Value of own solar` |
| `charging_solar_value_unknown` | `Värde av egen sol: okänt, spotpris saknas` | `Value of own solar: unknown, no spot price` |

```bash
bun run i18n:compile
```

- [ ] **Step 2: Write the failing browser tests.** Append to `TotalsTiles.browser.test.tsx`. Add
  `import { formatSek } from './format'` to the imports. `priced` is the existing fixture, which already includes
  step 4's solar fields.

```tsx
const sunny: Cost = { ...priced, solarPricedKwh: 300, solarUnpricedKwh: 0, solarValueSek: 212 }

test('a tile with solar shows its value under the cash cost', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(sunny)} />,
  )
  const line = m.charging_solar_value({ value: formatSek(212) })
  expect(screen.getByText(line, { exact: true }).elements()).toHaveLength(3)
  await expect.element(screen.getByText(line, { exact: true }).first()).toBeVisible()
})

test('no solar, no line', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(priced)} />,
  )
  expect(screen.getByText(/Värde av egen sol/).elements()).toHaveLength(0)
})

test('solar partly without a spot price reads "minst"; wholly without, "okänt"', async () => {
  const partly: Cost = { ...sunny, solarPricedKwh: 250, solarUnpricedKwh: 50 }
  const none: Cost = { ...sunny, solarPricedKwh: 0, solarUnpricedKwh: 300, solarValueSek: 0 }
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={{ thisMonth: none, thisYear: partly, allTime: sunny }} />,
  )
  await expect
    .element(
      screen.getByText(
        m.charging_solar_value({ value: m.charging_cost_min({ total: formatSek(212) }) }),
        { exact: true },
      ),
    )
    .toBeVisible()
  await expect
    .element(screen.getByText(m.charging_solar_value_unknown(), { exact: true }))
    .toBeVisible()
  // Never a bare 0 kr of solar.
  expect(
    screen.getByText(m.charging_solar_value({ value: formatSek(0) }), { exact: true }).elements(),
  ).toHaveLength(0)
})

test('the solar line also shows when the cash cost is unknown', async () => {
  const unpricedSunny: Cost = {
    ...sunny,
    fullKwh: 0,
    noTariffKwh: 100,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
    complete: false,
  }
  const { screen } = await renderWithProviders(
    <TotalsTiles
      tiles={zeroTiles}
      cost={{ thisMonth: unpricedSunny, thisYear: priced, allTime: priced }}
    />,
  )
  await expect.element(screen.getByText(m.charging_cost_unknown(), { exact: true })).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_solar_value({ value: formatSek(212) }), { exact: true }))
    .toBeVisible()
})
```

- [ ] **Step 3: Run it, expect FAIL**

```bash
bunx vitest run --project browser src/components/evCharging/TotalsTiles.browser.test.tsx
```
Expected: the four new tests fail (the line isn't found). The existing tests pass.

- [ ] **Step 4: Implement `SolarValueLine`**

```tsx
// src/components/evCharging/SolarValueLine.tsx
import { SunIcon } from 'lucide-react'
import { m } from '~/paraglide/messages'
import { formatSolarValue, type SolarValueInput, solarValueView } from './solarValue'

// One line under a cash cost: the value of own solar used (ADR-0023). Plain
// muted text with a decorative sun, so it reads as a note on the cost and not
// as a second price. Nothing when no solar was used. An estimated session
// (no hourly readings) marks it "≈" like its cost (see Estimated).
export function SolarValueLine({
  cost,
  fractionDigits = 0,
  estimated = false,
}: {
  cost: SolarValueInput
  fractionDigits?: number
  estimated?: boolean
}) {
  const view = solarValueView(cost)
  if (view.kind === 'hidden') return null
  const marked = estimated && view.kind === 'value'
  return (
    <p
      className="flex items-start gap-1.5 text-muted-foreground text-sm"
      title={marked ? m.charging_sessions_cost_estimated() : undefined}
    >
      <SunIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 text-pretty">
        {view.kind === 'unknown'
          ? m.charging_solar_value_unknown()
          : m.charging_solar_value({
              value: `${marked ? '≈ ' : ''}${formatSolarValue(view, fractionDigits)}`,
            })}
        {marked ? (
          <span className="sr-only"> ({m.charging_sessions_cost_estimated()})</span>
        ) : null}
      </span>
    </p>
  )
}
```

- [ ] **Step 5: Wire it into the tiles.** In `TotalsTiles.tsx` `TileReadouts`, the cost column becomes a vertical
  stack. The solar line goes last, after step 4's subline if that sits in this column (Task 0 Step 4):

```tsx
        <div className="flex flex-col gap-2 @[16rem]/tile:border-l @[16rem]/tile:pl-4">
          {unpriced ? (
            <Readout
              label={m.charging_tile_cost()}
              value="—"
              muted
              detail={m.charging_cost_unknown()}
            />
          ) : (
            <Readout
              label={m.charging_tile_cost()}
              qualifier={short ? m.charging_cost_min_prefix() : undefined}
              value={formatKronor(cost.totalSek)}
              unit="kr"
              detail={
                cost.kwh === 0
                  ? undefined
                  : m.charging_cost_spot_share({ spot: formatSek(cost.spotSek) })
              }
            />
          )}
          <SolarValueLine cost={cost} />
        </div>
```

Add `import { SolarValueLine } from './SolarValueLine'`. In the comment above `TileReadouts`, add one sentence:
"Under the cost, the value of own solar used when there was any (a separate figure, never part of the cost)."

- [ ] **Step 6: Run, expect PASS**

```bash
bunx vitest run --project browser src/components/evCharging/TotalsTiles.browser.test.tsx && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(charging): show the value of own solar on the overview tiles" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The monthly chart's kr tooltip

**Files:**
- Modify: `src/components/evCharging/MonthlyChart.tsx` (`CostChart` data + tooltip formatter; a private
  `SolarTooltipRows`)
- Test: `src/components/evCharging/MonthlyChart.browser.test.tsx`

**Interfaces:**
- Consumes: `solarValueView`, `formatSolarValue`, `SolarValueView` (Task 2); `TooltipRow` (`./ChartFrame`);
  `Unknown` (`./Unknown`).
- Produces: each `CostChart` datum gains `solar: SolarValueView`.

**Reviewers:** A = `code-reviewer`, B = a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Write the failing browser tests.** Append to `MonthlyChart.browser.test.tsx`. Add
  `import { formatSek } from './format'`.

```tsx
// Moves the pointer onto the index-th bar rectangle (DOM order: all spot bars, then all fees bars).
const hoverBar = async (container: Element, index: number) => {
  const rects = () => [...container.querySelectorAll('.recharts-bar-rectangle')]
  await vi.waitFor(() => expect(rects().length).toBeGreaterThan(index))
  const box = rects()[index].getBoundingClientRect()
  rects()[index].dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    }),
  )
}
const tooltipText = () => document.querySelector('.recharts-tooltip-wrapper')?.textContent ?? ''

test('a month with solar shows its value in the tooltip, under the total', async () => {
  const sunny = costMonths.map((c) =>
    c.month === 6 ? { ...c, solarPricedKwh: 300, solarUnpricedKwh: 0, solarValueSek: 212 } : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: sunny }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5) // June's spot bar
  await vi.waitFor(() => {
    expect(tooltipText()).toContain(m.charging_solar_value_label())
    expect(tooltipText()).toContain(formatSek(212))
    expect(tooltipText()).toContain(m.charging_solar_value_hint())
  })
  // The total comes first, then the solar value.
  const text = tooltipText()
  expect(text.indexOf(m.charging_chart_total())).toBeLessThan(
    text.indexOf(m.charging_solar_value_label()),
  )
})

test('a month without solar has no solar row', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: costMonths }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.charging_chart_total()))
  expect(tooltipText()).not.toContain(m.charging_solar_value_label())
})

test('partly unpriced solar reads "minst" in the tooltip', async () => {
  const partly = costMonths.map((c) =>
    c.month === 6 ? { ...c, solarPricedKwh: 250, solarUnpricedKwh: 50, solarValueSek: 212 } : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: partly }} metric="sek" />
    </div>,
  )
  await hoverBar(screen.container, 5)
  await vi.waitFor(() =>
    expect(tooltipText()).toContain(m.charging_cost_min({ total: formatSek(212) })),
  )
})

test('an unpriced stub month still shows its solar value', async () => {
  // No tariff in force: the cash cost is a "Pris saknas" stub, but spot prices exist, so solar is valued.
  const stubbed = costMonths.map((c) =>
    c.month === 6
      ? {
          ...c,
          fullKwh: 0,
          noTariffKwh: c.kwh,
          spotSek: 0,
          feesSek: 0,
          totalSek: 0,
          avgOre: null,
          complete: false,
          solarPricedKwh: 300,
          solarUnpricedKwh: 0,
          solarValueSek: 212,
        }
      : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: stubbed }} metric="sek" />
    </div>,
  )
  // 11 priced months × 2 + 1 stub = 23 rectangles; hover each until the stub's tooltip shows.
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(23),
  )
  let i = 0
  await vi.waitFor(async () => {
    if (!tooltipText().includes(m.charging_chart_no_price())) await hoverBar(screen.container, i++ % 23)
    expect(tooltipText()).toContain(m.charging_chart_no_price())
    expect(tooltipText()).toContain(m.charging_solar_value_label())
    expect(tooltipText()).toContain(formatSek(212))
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
bunx vitest run --project browser src/components/evCharging/MonthlyChart.browser.test.tsx
```
Expected: the solar tests fail; "a month without solar has no solar row" passes already.

- [ ] **Step 3: Implement.** In `MonthlyChart.tsx`:

Imports:

```tsx
import { formatSolarValue, type SolarValueView, solarValueView } from './solarValue'
import { Unknown } from './Unknown'
```

In `CostChart`'s `data` map, add the view to each datum (after `missingShare`):

```tsx
      // The value of own solar used, under the total (ADR-0023); hidden without solar.
      solar: solarValueView(c),
```

Change the formatter so that both branches end with the solar rows:

```tsx
              formatter={(value, name, item) => {
                const { totalSek, missingShare, solar } = item.payload
                if (name === 'unpriced') {
                  return (
                    <div className="flex w-full flex-col gap-0.5">
                      <TooltipRow label={config.unpriced.label} color={config.unpriced.color} />
                      <SolarTooltipRows view={solar} />
                    </div>
                  )
                }
                const series = config[name as 'spot' | 'fees']
                const total = formatSek(totalSek)
                return (
                  <div className="flex w-full flex-col gap-0.5">
                    <TooltipRow label={series.label} color={series.color}>
                      {formatSek(Number(value))}
                    </TooltipRow>
                    {name === 'fees' ? (
                      <>
                        <TooltipRow label={m.charging_chart_total()} strong>
                          {missingShare === null ? total : m.charging_cost_min({ total })}
                        </TooltipRow>
                        {missingShare === null ? null : (
                          <span className="text-muted-foreground text-xs">
                            {m.charging_cost_partial_hint({ share: formatShare(missingShare) })}
                          </span>
                        )}
                        <SolarTooltipRows view={solar} />
                      </>
                    ) : null}
                  </div>
                )
              }}
```

Add the private component below `CostChart`:

```tsx
// The month's value of own solar as tooltip rows: a label/value row and the
// "what it would have earned" hint beneath it (a separate figure from the
// total, so no swatch). Unknown is a dash with its reason for screen readers.
function SolarTooltipRows({ view }: { view: SolarValueView }) {
  if (view.kind === 'hidden') return null
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t pt-1">
      <TooltipRow label={m.charging_solar_value_label()}>
        {view.kind === 'unknown' ? (
          <Unknown label={m.charging_solar_value_unknown()} />
        ) : (
          formatSolarValue(view)
        )}
      </TooltipRow>
      {view.kind === 'unknown' ? null : (
        <span className="text-muted-foreground text-xs">{m.charging_solar_value_hint()}</span>
      )}
    </div>
  )
}
```

Update the comment above `MonthlyChart` with one sentence: "The tooltip adds the month's value of own solar under
its total when there was solar."

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run --project browser src/components/evCharging/MonthlyChart.browser.test.tsx && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(charging): show the value of own solar in the monthly tooltip" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The session page

**Files:**
- Modify: `src/components/evCharging/SessionSummary.tsx` (`Hero`, plus the `Pick` types on `SessionSummary` and
  `Hero`)
- Test: `src/components/evCharging/SessionSummary.browser.test.tsx`

**Interfaces:**
- Consumes: `SolarValueLine` (Task 3); the session's cash `CostSummary` (`detail.cost` per Task 0 Step 4), which
  carries step 4's solar fields.
- Produces: nothing new.

**Reviewers:** A = `code-reviewer`, B = a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Write the failing browser tests.** Append to `SessionSummary.browser.test.tsx`. Add
  `type SolarValueInput` from `./solarValue` to the imports (`formatSek` and `m` are imported already).

```tsx
// Step 4's detail() builder carries the session's cash cost; this adds solar to it.
const withSolar = (solar: SolarValueInput, over: Parameters<typeof detail>[0] = {}) => {
  const d = detail(over)
  return { ...d, cost: { ...d.cost, ...solar } }
}

describe('value of own solar', () => {
  test('shows under the cash cost, to the öre', async () => {
    const { screen } = await renderWithProviders(
      <SessionSummary
        detail={withSolar({ solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: 4.62 })}
      />,
    )
    await expect
      .element(
        screen.getByText(m.charging_solar_value({ value: formatSek(4.62, 2) }), { exact: true }),
      )
      .toBeVisible()
  })

  test('a session without solar has no line', async () => {
    const { screen } = await renderWithProviders(
      <SessionSummary
        detail={withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 0, solarValueSek: 0 })}
      />,
    )
    expect(screen.getByText(/Värde av egen sol/).elements()).toHaveLength(0)
  })

  test('a negative value (export would have cost money) keeps its sign', async () => {
    const { screen } = await renderWithProviders(
      <SessionSummary
        detail={withSolar({ solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: -0.37 })}
      />,
    )
    await expect.element(screen.getByText(/Värde av egen sol: −0,37\skr/)).toBeVisible()
  })

  test('an estimated session marks the value "≈", with the reason for screen readers', async () => {
    const { screen } = await renderWithProviders(
      <SessionSummary
        detail={withSolar(
          { solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: 4.62 },
          { estimated: true },
        )}
      />,
    )
    const line = screen.getByText(/Värde av egen sol: ≈ 4,62\skr/)
    await expect.element(line).toBeVisible()
    // The hero's own Estimated also has this sr-only text, so check inside the solar line itself.
    expect(line.element().textContent).toContain(`(${m.charging_sessions_cost_estimated()})`)
  })

  test('solar with no spot price at all reads "okänt"', async () => {
    const { screen } = await renderWithProviders(
      <SessionSummary
        detail={withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 6, solarValueSek: 0 })}
      />,
    )
    await expect
      .element(screen.getByText(m.charging_solar_value_unknown(), { exact: true }))
      .toBeVisible()
  })
})
```

If step 4's `detail()` builder takes the estimated flag under a different option name, use that name. Step 4 may
also have changed how `estimated` reaches the hero; adjust the call to match.

- [ ] **Step 2: Run it, expect FAIL**

```bash
bunx vitest run --project browser src/components/evCharging/SessionSummary.browser.test.tsx
```
Expected: the four tests that look for the line fail; "a session without solar has no line" passes.

- [ ] **Step 3: Implement.** In `SessionSummary.tsx`, add `import { SolarValueLine } from './SolarValueLine'`.
  Then widen the `Pick`s:
  - `SessionSummary`'s prop: `Pick<Detail, 'session' | 'economy' | 'optimalSchedule' | 'rateKw' | 'cost'>`;
  - `Hero`'s prop: `Pick<Detail, 'session' | 'economy' | 'cost'>`.

  In step 4's `Hero`, render the line as the last child of the hero's figure column, below the cash-cost figure and
  its unit-price line:

```tsx
      {/* The value of own solar used: a separate figure, never part of the cost (ADR-0023). */}
      <SolarValueLine cost={detail.cost} fractionDigits={2} estimated={session.estimated} />
```

  If `detail.cost` is nullable (Task 0 Step 4), use
  `{detail.cost ? <SolarValueLine cost={detail.cost} fractionDigits={2} estimated={session.estimated} /> : null}`.

- [ ] **Step 4: Run, expect PASS**

```bash
bunx vitest run --project browser src/components/evCharging/SessionSummary.browser.test.tsx 'src/routes/_authenticated/charging/sessions' && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(charging): show the value of own solar on the session page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs (spec rules, roadmap log)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` ("Cost and display")
- Modify: `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md` (Log)
- Check only: `CLAUDE.md`, `docs/adr/0023-solar-aware-charging-cost.md`

**Reviewers:** A = `code-reviewer` (ADR/spec consistency), B = none (docs only; the branch review covers it).

- [ ] **Step 1: Spec.**
  - In **Math**, check that step 4 already lists `solarPricedKwh` / `solarUnpricedKwh` in the "`CostTotals` gains …"
    bullet (Amendment A). If it doesn't, add them there: "the solar-origin kWh (direct solar plus
    battery-from-solar) that the value does or doesn't cover".
  - Replace the **Step 5** paragraph with:

```markdown
**Step 5: value of own solar.** One line under the cash cost: "Värde av egen sol: 212 kr (vad den hade gett vid
försäljning)". Shown on the overview tiles, in the monthly chart's kr tooltip (under the total) and on the session
page (to the öre). Display rules (`src/components/evCharging/solarValue.ts`):
- Hidden below 0.05 kWh of solar-origin energy (direct solar + battery-from-solar), so a night session charged from
  a solar-filled battery still shows its value.
- Some solar without a spot price → "minst …"; none priced → "Värde av egen sol: okänt, spotpris saknas". Never 0 kr.
- A negative spot gives a negative value ("−3 kr": exporting would have cost money).
- An estimated session marks it "≈", like its cost.
```

- [ ] **Step 2: Roadmap Log.** Append:

```markdown
- 2026-10-XX: step 5 (value of own solar) built on step 4's `solarPricedKwh`/`solarUnpricedKwh` ("minst"/"okänt"
  states, 0.05 kWh hide threshold). **Next phase, the solar-aware economy page, needs its own brainstorm**
  (`superpowers:brainstorming`, then a spec and its own roadmap) before any plan. The stored mix is its input; this
  roadmap ends at checkpoint 5.
```
(Use the actual date.)

- [ ] **Step 3: Check, don't force.**
  - ADR-0023: decision 7 already defines the value. Change it only if a build decision contradicted it (none
    expected).
  - CLAUDE.md: the code map's `components/` and `evCharging/` lines stay accurate. Add nothing unless a gotcha came
    up while building.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs(charging): record the solar-value display rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Branch review (feature-workflow Phase 5)

**Reviewers (in parallel, each told to assume the branch is wrong and off-spec):**
- `code-reviewer` (always): ADR-0020 (missing ≠ 0 kr), ADR-0023 decision 7 (ex VAT, no fees, never folded into the
  cash cost), client-safe imports, i18n completeness.
- `test-completeness`: Task 2's helper. Every view `kind` and both `atLeast` values
  must be exercised.
- A reviewer loading `web-design-guidelines` + `vercel-react-best-practices`: the tiles at third width, tooltip
  width, `text-pretty` wrapping, the decorative icon's `aria-hidden`, and the screen-reader text for "≈" and "okänt".
- A general correctness pass over `git diff origin/main...HEAD`, scaled to the diff (`/code-review high`). Cover the
  Review Focus items 1–5 above.

No schema / `drizzle/` change, so no migration-guard or schema-design gate. No auth or permission boundary, so no
security pass.

- [ ] Fix every confirmed finding in this branch (one commit per hat), or rule on it explicitly in the PR's Risks
  section.

---

### Task 8: Pre-PR gate + live responsive check

- [ ] **Step 1: The gate** (from `docs/feature-workflow.md`):

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```
Expected: all green, and "sv/en keys match".

- [ ] **Step 2: Local data with solar.** Local DB only. Never point any of this at prod.

  Check what's there:

```bash
docker compose exec db psql -U videbacken -d videbacken -c "select (select count(*) from house_energy_reading) readings, (select count(*) from ev_charge_energy_mix) mix_rows, (select count(*) from ev_charge_energy_mix where solar_kwh > 0 or battery_solar_kwh > 0) solar_rows"
```

  If `solar_rows` is 0:
  - **(a) Preferred.** Fill readings with the local Emaldo sync (needs `EMALDO_*` in `.env.local`; never print
    them), then run the derive.

    ```bash
    bun run dev:up && bun run dev   # in another terminal
    curl -s -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env | cut -d= -f2-)" http://localhost:14600/api/cron/emaldo-sync
    ```
    Repeat until the backfill reaches yesterday (the run JSON's `backfillDaysLeft` is 0). Then run step 3's
    one-off derive entrypoint, the one Task 0's `deriveFrom` grep found (its PR describes the invocation), from
    the first session's day. Re-run the count; summer sessions should have `solar_rows` > 0.
  - **(b) Fallback, only without Emaldo credentials.** Synthesize a 50/50 grid/solar mix for the latest counted
    session's intervals. Column names follow the spec's "Data model"; check them first with
    `\d ev_charge_energy_mix`. Remove the rows afterwards with
    `delete from ev_charge_energy_mix where session_id = '<id>'`.

    ```sql
    WITH s AS (
      SELECT id FROM ev_charge_session WHERE NOT voided ORDER BY start_at DESC LIMIT 1
    ), iv AS (
      SELECT i.session_id, i.start_at, i.end_at, i.energy_kwh
      FROM ev_charge_interval i JOIN s ON s.id = i.session_id
      WHERE i.end_at > i.start_at
    ), parts AS (
      SELECT iv.session_id, g AS slot_start,
        iv.energy_kwh
          * EXTRACT(EPOCH FROM (LEAST(g + interval '15 min', iv.end_at) - GREATEST(g, iv.start_at)))
          / EXTRACT(EPOCH FROM (iv.end_at - iv.start_at)) AS kwh
      FROM iv,
        generate_series(date_trunc('hour', iv.start_at), iv.end_at - interval '1 microsecond', interval '15 min') g
      WHERE g + interval '15 min' > iv.start_at
    )
    INSERT INTO ev_charge_energy_mix (session_id, slot_start, kwh, grid_kwh, solar_kwh, battery_grid_kwh,
      battery_solar_kwh, battery_unpriced_kwh, no_house_data_kwh, battery_grid_spot_sek, battery_solar_spot_sek)
    SELECT session_id, slot_start, SUM(kwh), SUM(kwh) / 2, SUM(kwh) / 2, 0, 0, 0, 0, NULL, NULL
    FROM parts GROUP BY session_id, slot_start;
    ```
    If the page shows no solar for that session, step 4's read-time guard rejected the mix (Σ kWh ≠ the session's
    counted energy; the dev log says so). Pick a session whose intervals are all counted.

- [ ] **Step 3: Drive the real app** with `claude-in-chrome` (load the core tool set per its instructions) or the
  playwright plugin. Sign in locally as the seeded admin. At **360, 820 and 1600** px wide, in sv, then once in en
  (LocaleSwitcher), check:
  - `/charging`: each tile with solar shows the line under the cost. It wraps cleanly in a third-width tile (≈820 px
    with the sidebar open) and is absent in tiles without solar.
  - `/charging`, kr metric: hover (desktop) or tap (360) a sunny month's bar. The tooltip shows the total, then
    "Värde av egen sol 212 kr" and the hint, and stays inside the window.
  - `/charging/sessions/<sunny id>`: the line sits under the hero cost, to the öre, and doesn't collide with the
    verdict pill or step 4's mix bar. A winter-night session has no line.
  - No horizontal page scroll at any width:
    `document.documentElement.scrollWidth <= window.innerWidth` in the console tool.
  - Dark mode once (ModeToggle): the muted text and the sun icon stay legible.

  Write what you checked in the PR's Verification section. **Don't commit or attach screenshots that show real
  household figures** (the repo is public).

- [ ] **Step 4:** If fallback (b) was used, delete the synthetic rows now and confirm with the count query.

---

### Task 9: Roadmap row + open the PR

- [ ] **Step 1:** Push the branch and open the PR (`.github/PULL_REQUEST_TEMPLATE.md`):

```bash
git push -u origin feat/charging-solar-value
gh pr create --title "feat(charging): show the value of own solar used" --body-file - <<'EOF'
## Why

Step 5 of the solar-aware cost roadmap (ADR-0023 decision 7): next to the cash cost, show what the own solar the car
used would have earned if exported, so the cheaper cash cost doesn't hide the export income given up.

## What changed

- Uses step 4's `solarPricedKwh` / `solarUnpricedKwh` so the line says "minst" or "okänt" instead of showing a
  partial value as whole (ADR-0020).
- One "Värde av egen sol: … (vad den hade gett vid försäljning)" line on the overview tiles, in the monthly kr
  tooltip and on the session page. Hidden without solar.
- Spec "Step 5" records the display rules; the roadmap log notes that the next phase needs its own brainstorm.

## Verification

- [ ] `bun run check` clean
- [ ] `bun run build` passes (tsc + bundle)
- [ ] `bun run test` passes
- [ ] Responsive on desktop + mobile: 360 / 820 / 1600 px, sv + en, dark mode once (what was checked: …)

## Risks / follow-ups

- (Task 0/7 findings, e.g. step 4's all-solar month drawn as a "Pris saknas" stub, if still so.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```
Fill in the Verification boxes with real evidence (gate output, widths checked) before you mark them.

- [ ] **Step 2:** In `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`, set row 5's PR to the new
  link (`[#NN](https://github.com/<owner>/<repo>/pull/NN)`, from `gh pr view --json url -q .url`) and its status to
  `PR open`. Commit and push:

```bash
git add docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md
git commit -m "docs(charging): mark solar-value step as PR open" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 3:** Wait for CI (`gh pr checks --watch`): `CI Success` and `Validate Conventional Commit title` must
  be green. The owner squash-merges; after the merge the row becomes `merged` (in the checkpoint PR).

---

### Task 10: Stop: checkpoint 5 is the owner's

**STOP here. Don't start anything else in this session** (roadmap: one step = one session = one PR).

Hand-off for the owner and the next session:
- **Checkpoint 5 (prod, live), from the roadmap:** "The owner reviews the solar-value copy and figures." After the
  merge deploys:
  - The owner opens `/charging` and a sunny midday session (expect a clear solar value) and a winter-night session
    (expect no line).
  - They read the sv and en copy, including "minst"/"okänt" if any period lacks spot prices, and a negative value
    if a negative-spot day occurred.
  - They check the tiles and tooltip at phone width.
- Record the result in the roadmap's Status table (row 5: `checkpoint passed` plus a one-line result) in a small
  `docs(charging): …` PR, with row 5 set to `merged` there too.
- Copy changes the owner asks for are a follow-up `fix(charging): …` PR.
- After checkpoint 5 this roadmap is done. The **later phase (solar-aware economy page) starts with its own
  brainstorm** (`superpowers:brainstorming`), not a plan from this roadmap.
