# EV charging Phase 4 — how economically we charge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how well we time charging against the spot price: per session and per month, what charging
immediately at plug-in would have cost, what we paid, what the cheapest (and dearest) schedule inside the plug-in
window would have cost, a 0–100 % timing score, and paid spot vs average spot — on a new `/charging/economy` page
and a per-session page with an energy + spot-price chart.

**Architecture:** A pure, client-safe module (`src/lib/evCharging/economy/`) builds hypothetical schedules
(`immediate` / `optimal` / `dearest`) as `EnergyInterval`s and prices them with the existing ADR-0020
`priceIntervals`. A server-only orchestrator (`src/lib/evCharging/chargingEconomy.ts`, next to `costing.ts`) loads session
energy, window-wide spot slots, tariff periods and per-day average spot through services, then runs the math. Two
`protectedProcedure` reads feed a Recharts page and a visx session chart.

**Tech stack:** TanStack Start + Router, oRPC + TanStack Query, Drizzle (node-postgres), Vitest (node + browser),
`d3-array` / `d3-scale`, `date-fns` + `@date-fns/tz`, `@visx/{axis,group,responsive,shape,tooltip}` 4.0, Recharts 3
via shadcn `ChartContainer`, Paraglide.

**Spec (binding):** `docs/superpowers/specs/2026-09-30-ev-charging-phase4-design.md`.

### Delivery

| PR | Branch | Title | Tasks |
|---|---|---|---|
| A | `feat/charging-economy-read-models` | `feat(charging): add charging economy read models` | A1–A5 |
| B | `feat/charging-economy-page` | `feat(charging): show charging economy on /charging/economy` | B1–B3 |
| C | `feat/charging-session-page` | `feat(charging): add a session page with a price overlay` | C1–C2 |

The spec commits already sit on `feat/charging-economy-read-models`; this plan is committed there too (before A1), so both
ride in PR A. B branches off `main` after A is squash-merged; C after B. Work in a git worktree per PR
(`superpowers:using-git-worktrees`). Stacked-PR recipe if reviewing ahead (no force-push): after each squash-merge,
PATCH the next PR's base to `main`, then `git merge origin/main` into it (keep the later PR's side on add/add
conflicts, regenerate `routeTree.gen.ts`).

### Deviations from the spec (decided while mapping seams — flag them in PR A's description)

1. **Month average spot comes from a new aggregate query**, `dailyAverageSpot(zone, fromDay, toDay)` in the
   spotPrice service (one row per Stockholm day: time-weighted average SEK/kWh + covered ms), instead of loading
   every slot of the year through `listSlotsOverlapping` (~35 000 rows → 365). `listSlotsOverlapping` still loads
   the sessions' window slots.
2. **The domain error is exposed under its own code** `EV_SESSION_NOT_FOUND` (status 404), following the
   `tariffErrors` pattern in `procedures/tariff.ts`, not as a generic `NOT_FOUND`.
3. **The energy rescheduled is the sum of the session's stretches' kWh** (exactly what the actual cost prices), so
   `EconomySession` has no separate `kwh` field.
4. **`SessionEconomy` has `counterfactual: null` iff the session is excluded**, instead of four always-present
   totals; the optimal schedule is returned only by the session detail read (`optimalSchedule`), not per row.
5. **A malformed `$sessionId` URL param is a not-found page** (checked with `z.uuid()` in the loader) rather than a
   `BAD_REQUEST` load error.
6. **`test/browser/render.tsx` gains `renderWithRouter`** (a memory-history `RouterProvider`), because the economy
   table and `SessionList` now render `<Link>`s; the helper's own comment anticipates this.
7. **The orchestrator is `src/lib/evCharging/chargingEconomy.ts`**, not `economy.ts` as the spec says: beside the
   `economy/` folder that name would shadow it in module resolution (client imports would pull in the server code).

## Global Constraints

- CLAUDE.md non-negotiables: all DB access in `src/lib/services/`; reads are `protectedProcedure`; logging via
  `~/lib/logger` only (never `console.*`); every screen responsive (desktop + tablet + mobile, no fixed pixel
  widths); user-facing text via Paraglide (`messages/sv.json` source of truth, `messages/en.json` key-complete);
  route paths English (`/charging/economy`, `/charging/sessions/$sessionId`); components PascalCase in
  `src/components/evCharging/`; `src/components/ui/` untouched except via `bunx shadcn@latest add`.
- **Client code may only `import type` from services.** `src/lib/evCharging/economy/` imports no `db` / services /
  effects — guarded by `src/lib/evCharging/clientSafe.browser.test.tsx`.
- **No schema change, no migration.** If a task seems to need one, stop and ask.
- **Missing ≠ 0 kr** (ADR-0020): a session lacking a price or tariff anywhere in its window is excluded and counted,
  never priced at 0. Nothing excluded shows "0 kr" or "0 %"; it shows "—" with the reason.
- **Spot timing only** (owner decision): every score and kronor comparison carries the caveat that all energy is
  treated as grid-bought (`gridShare = 1`) and solar is not included.
- Score = `(dearest − actual) ÷ (dearest − optimal)` clamped to 0…1; **null when `dearest − optimal < 0.01` kr**.
- Rate cap = `max(highest observed kW over any stretch, session kWh ÷ window hours)`.
- Ranking price = `(spot + markup + grid + tax) × (1 + VAT)` of the tariff at the slot's Stockholm day.
- Month buckets = the Stockholm month the **session started**.
- Freshness: no `refetchInterval` on the new reads (ADR-0018); `useSyncNow` already invalidates
  `orpc.evCharging.key()`.
- **Timing rule:** both procedures forward sub-timings `economyEnergyMs`, `economySlotsMs`, `economyTariffMs`,
  `economyComputeMs` (and `economyDailySpotMs` for the overview) via `recordPrefixedTimings(…, 'economy', …)`.
- **Reuse before hand-rolling:** sums/maxima with `d3-array`; time axis with `d3-scale` `scaleTime`; drawing with
  visx; plain charts with Recharts via `~/components/ui/chart`; dates with date-fns + `@date-fns/tz` through the
  helpers in `src/components/evCharging/format.ts`. Hand-rolled (and why): the greedy slot fill (~20 lines; no
  library does "fill capacity-limited slots by price"), and the test-only seeded PRNG (4 lines; not worth a
  dependency).
- Commits: Conventional Commits, one hat each, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Reviewers per task (feature-workflow pairings): pure/service/orchestrator tasks → `code-reviewer` +
  `test-completeness`; procedure task → `code-reviewer` + a reviewer loading `better-auth-security-best-practices`;
  UI tasks → `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`. Each
  reviewer starts from the assumption that the task is wrong and not up to spec.

## Review Focus

1. **A session URL with an unknown, voided or malformed id** (`/charging/sessions/nope`) → the app's not-found page,
   never a 500 or a generic "couldn't load" alert. Pinned in A5 (procedure: unknown uuid → `EV_SESSION_NOT_FOUND`,
   non-uuid → `BAD_REQUEST`) and C1 (loader maps both to `notFound()`).
2. **A year where every session is excluded** (e.g. no tariff entered yet) → tiles show "—" with the reason, never
   "0 kr" or "0 %". Pinned in B1 (`EconomyTiles` test with `included: 0`).
3. **Charging immediately would have been cheaper** (negative saving) → shown as "−12 kr", not as a saving and
   never clamped. Pinned in A2 (negative `savedVsImmediateSek` survives) and B1 (tile renders the minus sign).
4. **Clock-quirk intervals slightly outside the plug-in window** → the window widens, so `optimal ≤ actual ≤ dearest`
   and the score stays within 0…1. Pinned in A1 (`economyWindow` widening) and A2 (a quirk case in the invariant
   test).
5. **A price day missing in the middle of an overnight window** (an elpris day that failed to sync) → the session is
   `no_price`, excluded and counted, not priced over the remaining hours. Pinned in A1 (`windowPieces` gap → null)
   and A4 (orchestrator counts it under `excluded.noPrice`).

---

## PR A — read models (`feat/charging-economy-read-models`)

### Task A1: unit price + schedule math

**Files:**
- Modify: `src/lib/evCharging/cost/priceIntervals.ts` (add `unitPrice`, use it in `priceIntervals`)
- Modify: `src/lib/evCharging/cost/index.ts` (export `unitPrice`)
- Modify: `src/lib/evCharging/cost/priceIntervals.test.ts` (one `unitPrice` test)
- Create: `src/lib/evCharging/economy/types.ts`
- Create: `src/lib/evCharging/economy/schedule.ts`
- Create: `src/lib/evCharging/economy/schedule.test.ts`
- Create: `src/lib/evCharging/economy/index.ts`
- Modify: `src/lib/spotPrice/slots.ts` (add the `DailySpot` type)

**Interfaces:**
- Consumes: `SlotIndex`, `tariffAt`, `TariffPeriod`, `EnergyInterval` from `~/lib/evCharging/cost`;
  `stockholmDayOf` from `~/lib/time/stockholm`.
- Produces:
  - `unitPrice(sekPerKwh: number, tariff: TariffPeriod): { spotSek: number; feesSek: number }` — SEK per kWh incl VAT.
  - types `EconomyStretch`, `EconomySession`, `EconomyWindow`, `ScheduleKind`, `PricedPiece`, `EconomyExclusion`,
    `Counterfactual`, `SessionEconomy`, `EconomyTotals` (in `economy/types.ts`); `DailySpot` (in `spotPrice/slots.ts`).
  - `economyWindow(s: EconomySession): EconomyWindow`
  - `sessionKwh(s: EconomySession): number`
  - `rateCapKw(s: EconomySession, window: EconomyWindow): number`
  - `windowPieces(window: EconomyWindow, slots: SlotIndex, tariffsAsc: readonly TariffPeriod[]): PricedPiece[] | null`
  - `schedule(kind: ScheduleKind, kwh: number, rateKw: number, pieces: readonly PricedPiece[]): EnergyInterval[]`

- [ ] **Step 1: Write the failing `unitPrice` test** — append to `src/lib/evCharging/cost/priceIntervals.test.ts`
  (add `unitPrice` to the file's `./index` import):

```ts
describe('unitPrice', () => {
  test('is the slot’s spot and the tariff’s fees per kWh, both incl VAT', () => {
    const u = unitPrice(0.8, TARIFF)
    expect(u.spotSek).toBeCloseTo(0.8 * 1.25)
    expect(u.feesSek).toBeCloseTo((FEES_ORE / 100) * 1.25)
  })

  test('keeps a negative spot price negative', () => {
    expect(unitPrice(-0.2, TARIFF).spotSek).toBeCloseTo(-0.25)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`unitPrice` is not exported)

Run: `bunx vitest run src/lib/evCharging/cost/priceIntervals.test.ts`

- [ ] **Step 3: Implement `unitPrice` and use it in `priceIntervals`** — in `priceIntervals.ts`, add above
  `priceIntervals`:

```ts
/**
 * SEK per kWh incl VAT of a slot's spot price and of a tariff's per-kWh fees
 * (markup + grid transfer + energy tax). The one formula every kronor figure
 * uses — priced energy here, and slot ranking in the Phase 4 counterfactuals.
 */
export function unitPrice(sekPerKwh: number, tariff: TariffPeriod): { spotSek: number; feesSek: number } {
  const vat = 1 + tariff.vatPercent / 100
  const feesOre = tariff.retailMarkupOre + tariff.gridTransferOre + tariff.energyTaxOre
  return { spotSek: sekPerKwh * vat, feesSek: (feesOre / 100) * vat }
}
```

  and replace the four lines computing `vat` / `spotSek` / `feesOre` / `feesSek` inside the slot loop with:

```ts
      const unit = unitPrice(slot.sekPerKwh, tariff)
      const spotSek = kwh * unit.spotSek
      const feesSek = kwh * unit.feesSek
```

  In `cost/index.ts` add `unitPrice,` to the `./priceIntervals` export list.

- [ ] **Step 4: Run the whole cost suite — expect PASS** (the existing `priceIntervals` tests pin that pricing is
  unchanged)

Run: `bunx vitest run src/lib/evCharging/cost`

- [ ] **Step 5: Add `DailySpot`** to `src/lib/spotPrice/slots.ts` (after `PriceSlot`):

```ts
/** One Stockholm day's time-weighted average spot price (SEK/kWh ex VAT) and how much of it has prices. */
export type DailySpot = { day: string; avgSekPerKwh: number; coveredMs: number }
```

- [ ] **Step 6: Create the types** — `src/lib/evCharging/economy/types.ts`:

```ts
// Types for the Phase 4 counterfactuals (ADR-0020 "Counterfactuals"). Client-safe.
import type { CostTotals } from '~/lib/evCharging/cost'

/** A stretch of delivered energy, as the cost math consumes it. */
export type EconomyStretch = { startMs: number; endMs: number; kwh: number }

/** A counted session as the counterfactuals need it — its own type, no import from services. */
export type EconomySession = {
  /** Plug-in. */
  startMs: number
  /** Plug-out. */
  endMs: number
  /** Zaptec intervals, or one even stretch over the window when `estimated`. */
  stretches: EconomyStretch[]
  /** No Zaptec intervals: the energy is spread evenly, so there's nothing to compare (`no_hourly`). */
  estimated: boolean
}

/** Plug-in → plug-out, widened to cover every stretch. */
export type EconomyWindow = { startMs: number; endMs: number }

export type ScheduleKind = 'immediate' | 'optimal' | 'dearest'

/** A slot's part of a window with its full price: SEK/kWh incl fees + VAT. */
export type PricedPiece = { startMs: number; endMs: number; sekPerKwh: number }

export type EconomyExclusion = 'no_hourly' | 'no_price'

export type Counterfactual = {
  immediate: CostTotals
  optimal: CostTotals
  dearest: CostTotals
  /** 0…1, or null when the window left nothing to choose between (gap < 0.01 kr). */
  score: number | null
  /** immediate − actual; negative when charging at once would have been cheaper. */
  savedVsImmediateSek: number
  /** actual − optimal, never negative. */
  leftOnTableSek: number
}

export type SessionEconomy = {
  /** Partial (priced hours only) when `actualComplete` is false — never show it as the session's cost then. */
  actual: CostTotals
  /** `isComplete(actual)`: every kWh priced. Gate any kronor figure on it (an excluded `no_price` session may be partial). */
  actualComplete: boolean
  /** Spot paid, öre/kWh incl VAT, over the session's energy; null when the actual is incomplete or empty. */
  paidSpotOre: number | null
  /** Time-weighted average spot over the window, öre/kWh incl VAT; null without prices. */
  windowAvgSpotOre: number | null
  excluded: EconomyExclusion | null
  /** Present iff `excluded` is null. */
  counterfactual: Counterfactual | null
}

/** Sums over a set of sessions (a month, a year). Kronor cover only the included sessions. */
export type EconomyTotals = {
  sessions: number
  included: number
  excluded: { noHourly: number; noPrice: number }
  /** kWh of the included sessions. */
  kwh: number
  actualSek: number
  immediateSek: number
  optimalSek: number
  dearestSek: number
  savedVsImmediateSek: number
  leftOnTableSek: number
  score: number | null
  /** Over the included sessions. */
  paidSpotOre: number | null
  /** Time-weighted average spot of the whole period incl VAT, whether or not we charged. */
  avgSpotOre: number | null
}
```

- [ ] **Step 7: Write the failing schedule tests** — `src/lib/evCharging/economy/schedule.test.ts`:

```ts
import { sum } from 'd3-array'
import { describe, expect, test } from 'vitest'
import { SlotIndex, type TariffPeriod } from '~/lib/evCharging/cost'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import {
  economyWindow,
  rateCapKw,
  schedule,
  sessionKwh,
  windowPieces,
} from './schedule'
import type { EconomySession } from './types'

const MIN = 60_000
const utc = (iso: string) => new Date(iso).getTime()
const TARIFF: TariffPeriod = {
  validFrom: '2025-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
// 2026-09-28 is CEST: local 10:00 = 08:00Z; slot i starts at local i×15 min.
// Window local 10:00–12:00 = slots 40..47 with these spot prices, 9 SEK elsewhere.
const WINDOW_PRICES = [5, 1, 4, 2, 8, -0.5, 7, 6]
const day = new SlotIndex(daySlots('2026-09-28', 15, (i) => WINDOW_PRICES[i - 40] ?? 9))
const WINDOW = { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T10:00Z') }
const span = (iv: { startMs: number; endMs: number }) => [
  new Date(iv.startMs).toISOString().slice(11, 16),
  new Date(iv.endMs).toISOString().slice(11, 16),
]

describe('windowPieces', () => {
  test('covers the window slot by slot with each slot’s full price', () => {
    const pieces = windowPieces(WINDOW, day, [TARIFF])
    expect(pieces).toHaveLength(8)
    // (spot + 76,931 öre fees) × 1,25
    expect(pieces?.[1].sekPerKwh).toBeCloseTo((1 + 0.76931) * 1.25)
    expect(pieces?.[0].startMs).toBe(WINDOW.startMs)
    expect(pieces?.[7].endMs).toBe(WINDOW.endMs)
  })

  test('clips the edge slots to the window', () => {
    const pieces = windowPieces(
      { startMs: utc('2026-09-28T08:05Z'), endMs: utc('2026-09-28T08:40Z') },
      day,
      [TARIFF],
    )
    expect(pieces?.map(span)).toEqual([
      ['08:05', '08:15'],
      ['08:15', '08:30'],
      ['08:30', '08:40'],
    ])
  })

  test('is null when any part of the window has no price slot', () => {
    const holey = new SlotIndex(daySlots('2026-09-28', 15).filter((_, i) => i !== 43))
    expect(windowPieces(WINDOW, holey, [TARIFF])).toBeNull()
  })

  test('is null when the window runs past the last stored slot', () => {
    const partial = new SlotIndex(daySlots('2026-09-28', 15).slice(0, 44)) // ends 09:00Z
    expect(windowPieces(WINDOW, partial, [TARIFF])).toBeNull()
  })

  test('is null when a slot has no tariff in force', () => {
    expect(windowPieces(WINDOW, day, [{ ...TARIFF, validFrom: '2026-10-01' }])).toBeNull()
  })
})

describe('schedule', () => {
  const pieces = windowPieces(WINDOW, day, [TARIFF]) ?? []

  test('immediate fills from plug-in in time order and stops at the energy', () => {
    // 10 kW → 2,5 kWh per quarter.
    const s = schedule('immediate', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:00', '08:15'],
      ['08:15', '08:30'],
    ])
    expect(sum(s, (iv) => iv.kwh)).toBeCloseTo(5)
    expect(s.every((iv) => iv.gridShare === 1)).toBe(true)
  })

  test('optimal takes the cheapest quarters first — a negative price first of all — in time order', () => {
    const s = schedule('optimal', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:15', '08:30'], // 1 SEK
      ['09:15', '09:30'], // −0,5 SEK
    ])
  })

  test('the last quarter is filled partly, from its start, at the rate cap', () => {
    // 2,5 kWh at −0,5, then 1 kWh of the 1-SEK quarter = 6 min at 10 kW.
    const s = schedule('optimal', 3.5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:15', '08:21'],
      ['09:15', '09:30'],
    ])
    expect(s[0].kwh).toBeCloseTo(1)
  })

  test('dearest takes the most expensive quarters first', () => {
    const s = schedule('dearest', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['09:00', '09:15'], // 8
      ['09:30', '09:45'], // 7
    ])
  })

  test('a partial edge piece holds only rate × its own length', () => {
    const edge = windowPieces(
      { startMs: utc('2026-09-28T08:05Z'), endMs: utc('2026-09-28T09:00Z') },
      day,
      [TARIFF],
    ) ?? []
    // 10 min at 10 kW = 1,667 kWh, the rest (0,333 kWh = 2 min) in the next quarter.
    const s = schedule('immediate', 2, 10, edge)
    expect(s.map(span)).toEqual([
      ['08:05', '08:15'],
      ['08:15', '08:17'],
    ])
  })

  test('a tariff change at local midnight re-ranks flat spot prices', () => {
    // Local 23:00 Sep 30 → 01:00 Oct 1 (21:00Z–23:00Z); grid fee drops at midnight.
    const slots = new SlotIndex([
      ...daySlots('2026-09-30', 15, () => 1),
      ...daySlots('2026-10-01', 15, () => 1),
    ])
    const tariffs = [TARIFF, { ...TARIFF, validFrom: '2026-10-01', gridTransferOre: 10 }]
    const window = { startMs: utc('2026-09-30T21:00Z'), endMs: utc('2026-09-30T23:00Z') }
    const s = schedule('optimal', 5, 10, windowPieces(window, slots, tariffs) ?? [])
    expect(s.map(span)).toEqual([
      ['22:00', '22:15'],
      ['22:15', '22:30'],
    ])
  })

  test('hourly slots (before 2025-10-01) hold rate × one hour each', () => {
    // 2025-09-15 CEST: local 10:00 = 08:00Z; hourly slot h at local h:00.
    const slots = new SlotIndex(daySlots('2025-09-15', 60, (h) => (h === 11 ? 0.5 : 2)))
    const window = { startMs: utc('2025-09-15T08:00Z'), endMs: utc('2025-09-15T10:00Z') }
    const s = schedule('optimal', 5, 10, windowPieces(window, slots, [TARIFF]) ?? [])
    expect(s.map(span)).toEqual([['09:00', '09:30']])
  })

  test('a window across the autumn DST change keeps every one of its four real hours', () => {
    // Local 01:00 CEST → 04:00 CET on 2026-10-25 = 23:00Z–03:00Z, 4 h (16 quarters).
    const slots = new SlotIndex([
      ...daySlots('2026-10-24', 15, () => 1),
      ...daySlots('2026-10-25', 15, () => 1),
    ])
    const window = { startMs: utc('2026-10-24T23:00Z'), endMs: utc('2026-10-25T03:00Z') }
    const pieces4h = windowPieces(window, slots, [TARIFF]) ?? []
    expect(pieces4h).toHaveLength(16)
    const s = schedule('immediate', 4, 1, pieces4h)
    expect(sum(s, (iv) => iv.kwh)).toBeCloseTo(4)
    expect(s.at(-1)?.endMs).toBe(window.endMs)
  })

  test('no energy → no schedule', () => {
    expect(schedule('optimal', 0, 10, pieces)).toEqual([])
  })

  test('more energy than the window can take at the rate is a caller bug', () => {
    expect(() => schedule('optimal', 50, 10, pieces)).toThrow(RangeError)
  })
})

describe('rate cap and window', () => {
  const session = (stretches: EconomySession['stretches']): EconomySession => ({
    startMs: utc('2026-09-28T08:00Z'),
    endMs: utc('2026-09-28T12:00Z'),
    stretches,
    estimated: false,
  })

  test('the rate cap is the highest observed kW', () => {
    const s = session([
      { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10.8 },
      { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:20Z'), kwh: 2 }, // 6 kW
    ])
    expect(rateCapKw(s, economyWindow(s))).toBeCloseTo(10.8)
  })

  test('the rate cap is at least the energy spread over the window', () => {
    // 20 kWh reported in a zero-length stretch (a clock quirk) over a 4 h window.
    const s = session([{ startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 20 }])
    expect(rateCapKw(s, economyWindow(s))).toBeCloseTo(5)
  })

  test('the window widens to stretches just outside plug-in → plug-out', () => {
    const s = session([
      { startMs: utc('2026-09-28T07:58Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 5 },
      { startMs: utc('2026-09-28T11:00Z'), endMs: utc('2026-09-28T12:03Z'), kwh: 5 },
    ])
    expect(economyWindow(s)).toEqual({
      startMs: utc('2026-09-28T07:58Z'),
      endMs: utc('2026-09-28T12:03Z'),
    })
    expect(sessionKwh(s)).toBe(10)
  })

  test('no energy → a zero rate cap', () => {
    const s = session([{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 }])
    expect(rateCapKw(s, economyWindow(s))).toBe(0)
  })
})
```

- [ ] **Step 8: Run it — expect FAIL** (`./schedule` does not exist)

Run: `bunx vitest run src/lib/evCharging/economy/schedule.test.ts`

- [ ] **Step 9: Implement** — `src/lib/evCharging/economy/schedule.ts`:

```ts
// Client-safe: the hypothetical schedules behind the Phase 4 counterfactuals
// (ADR-0020 "Counterfactuals"). A session's energy is re-delivered inside its
// plug-in window, at most at its rate cap, filling the window's price pieces in
// time order (immediate), cheapest first (optimal) or dearest first (dearest).
// Greedy is exactly optimal: cost is linear in kWh and each piece's capacity is
// independent (a fractional knapsack). Hand-rolled — no library fills
// capacity-limited slots by price.
import { max, sum } from 'd3-array'
import { millisecondsInHour } from 'date-fns/constants'
import {
  type EnergyInterval,
  type SlotIndex,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from '~/lib/evCharging/cost'
import { stockholmDayOf } from '~/lib/time/stockholm'
import type { EconomySession, EconomyWindow, PricedPiece, ScheduleKind } from './types'

/** Leftover energy below this is float noise, not a shortfall. */
const FILL_EPSILON_KWH = 1e-6

/**
 * Plug-in → plug-out, widened to cover every stretch: a clock quirk can put an
 * interval slightly outside the window, and the actual schedule must be one the
 * counterfactuals could have picked (`optimal ≤ actual ≤ dearest`).
 */
export function economyWindow(s: EconomySession): EconomyWindow {
  return {
    startMs: Math.min(s.startMs, ...s.stretches.map((x) => x.startMs)),
    endMs: Math.max(s.endMs, ...s.stretches.map((x) => x.endMs)),
  }
}

/** The energy to re-deliver: exactly what the actual cost prices. */
export function sessionKwh(s: EconomySession): number {
  return sum(s.stretches, (x) => x.kwh)
}

/**
 * The fastest the session may charge in a counterfactual: its highest observed
 * kW, or its energy spread over the window if that's higher (so the energy
 * always fits). Using the highest observed rate keeps the actual schedule
 * feasible.
 */
export function rateCapKw(s: EconomySession, window: EconomyWindow): number {
  const kwh = sessionKwh(s)
  if (kwh <= 0) return 0
  const observed =
    max(
      s.stretches.filter((x) => x.endMs > x.startMs),
      (x) => (x.kwh / (x.endMs - x.startMs)) * millisecondsInHour,
    ) ?? 0
  const windowHours = (window.endMs - window.startMs) / millisecondsInHour
  return Math.max(observed, windowHours > 0 ? kwh / windowHours : 0)
}

/**
 * The window split at its price slots, each piece with its full price (spot +
 * fees, incl VAT, under the tariff of the slot's Stockholm day). Null when any
 * part of the window lacks a price or a tariff — it can't be ranked, so the
 * session is excluded rather than priced as if that stretch were free.
 */
export function windowPieces(
  window: EconomyWindow,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): PricedPiece[] | null {
  const pieces: PricedPiece[] = []
  let cursor = window.startMs
  for (const slot of slots.between(window.startMs, window.endMs)) {
    const startMs = Math.max(slot.startMs, window.startMs)
    const endMs = Math.min(slot.endMs, window.endMs)
    if (startMs > cursor) return null
    const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
    if (!tariff) return null
    const unit = unitPrice(slot.sekPerKwh, tariff)
    pieces.push({ startMs, endMs, sekPerKwh: unit.spotSek + unit.feesSek })
    cursor = endMs
  }
  return pieces.length > 0 && cursor >= window.endMs ? pieces : null
}

/**
 * `kwh` delivered at most at `rateKw`, filling `pieces` in the kind's order;
 * a partly used piece is filled from its start. Returned in time order, all
 * grid-bought (`gridShare` 1, the same seam as the actual cost).
 */
export function schedule(
  kind: ScheduleKind,
  kwh: number,
  rateKw: number,
  pieces: readonly PricedPiece[],
): EnergyInterval[] {
  if (kwh <= 0) return []
  if (!(rateKw > 0)) throw new RangeError('Rate cap must be positive')
  const order =
    kind === 'immediate'
      ? pieces
      : pieces.toSorted(
          (a, b) =>
            (kind === 'optimal' ? a.sekPerKwh - b.sekPerKwh : b.sekPerKwh - a.sekPerKwh) ||
            a.startMs - b.startMs,
        )
  const out: EnergyInterval[] = []
  let remaining = kwh
  for (const p of order) {
    if (remaining <= FILL_EPSILON_KWH) break
    const capacity = (rateKw * (p.endMs - p.startMs)) / millisecondsInHour
    if (capacity <= 0) continue
    if (capacity <= remaining) {
      out.push({ startMs: p.startMs, endMs: p.endMs, kwh: capacity, gridShare: 1 })
      remaining -= capacity
    } else {
      const endMs = p.startMs + (remaining / rateKw) * millisecondsInHour
      out.push({ startMs: p.startMs, endMs, kwh: remaining, gridShare: 1 })
      remaining = 0
    }
  }
  if (remaining > FILL_EPSILON_KWH) {
    throw new RangeError('The window cannot take this energy at this rate')
  }
  return out.toSorted((a, b) => a.startMs - b.startMs)
}
```

  `src/lib/evCharging/economy/index.ts`:

```ts
// Client-safe counterfactual math (no db import). The server-only composer
// that feeds it is `~/lib/evCharging/chargingEconomy.ts`.
export * from './schedule'
export type * from './types'
```

- [ ] **Step 10: Run — expect PASS**, then typecheck + lint

Run: `bunx vitest run src/lib/evCharging/economy src/lib/evCharging/cost && bun run typecheck && bun run check`

- [ ] **Step 11: Commit**

```bash
git add src/lib/evCharging/cost src/lib/evCharging/economy src/lib/spotPrice/slots.ts
git commit -m "feat(charging): add counterfactual charging schedules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12: Review** — dispatch `code-reviewer` + `test-completeness` in parallel (assume the task is wrong);
  fix or rule on every finding before A2.

---

### Task A2: session economy, score and totals

**Files:**
- Create: `src/lib/evCharging/economy/sessionEconomy.ts`
- Create: `src/lib/evCharging/economy/sessionEconomy.test.ts`
- Create: `src/lib/evCharging/economy/totals.ts`
- Create: `src/lib/evCharging/economy/totals.test.ts`
- Modify: `src/lib/evCharging/economy/index.ts`
- Modify: `src/lib/evCharging/clientSafe.browser.test.tsx`

**Interfaces:**
- Consumes: A1's `economyWindow`, `sessionKwh`, `rateCapKw`, `windowPieces`, `schedule`, the types;
  `priceIntervals`, `isComplete`, `unitPrice`, `tariffAt` from `~/lib/evCharging/cost`; `DailySpot`.
- Produces:
  - `SCORE_MIN_GAP_SEK = 0.01`
  - `timingScore(actualSek: number, optimalSek: number, dearestSek: number): number | null`
  - `windowAvgSpotOre(window: EconomyWindow, slots: SlotIndex, tariffsAsc: readonly TariffPeriod[]): number | null`
  - `analyzeSession(session: EconomySession, slots: SlotIndex, tariffsAsc: readonly TariffPeriod[]): { economy: SessionEconomy; optimalSchedule: EnergyInterval[] | null }`
  - `sumEconomy(items: readonly SessionEconomy[], avgSpotOre: number | null): EconomyTotals`
  - `averageSpotOre(days: readonly DailySpot[], tariffsAsc: readonly TariffPeriod[]): number | null`

- [ ] **Step 1: Write the failing session tests** — `src/lib/evCharging/economy/sessionEconomy.test.ts`:

```ts
import { sum } from 'd3-array'
import { describe, expect, test } from 'vitest'
import { SlotIndex, type TariffPeriod } from '~/lib/evCharging/cost'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { analyzeSession, timingScore } from './sessionEconomy'
import type { EconomySession } from './types'

const HOUR = 3_600_000
const utc = (iso: string) => new Date(iso).getTime()
const TARIFF: TariffPeriod = {
  validFrom: '2025-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
// Local 10:00–12:00 on 2026-09-28 (08:00Z–10:00Z): 10:xx costs 3 SEK, 11:xx 1 SEK.
const slots = new SlotIndex(daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 1)))
const session = (over: Partial<EconomySession> = {}): EconomySession => ({
  startMs: utc('2026-09-28T08:00Z'),
  endMs: utc('2026-09-28T10:00Z'),
  // Charged the dear hour at 10 kW, idle through the cheap one.
  stretches: [
    { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10 },
    { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 0 },
  ],
  estimated: false,
  ...over,
})
const unit = (spot: number) => (spot + 0.76931) * 1.25

describe('analyzeSession', () => {
  test('charging the dear hour: immediate = actual = dearest, optimal is the cheap hour', () => {
    const { economy, optimalSchedule } = analyzeSession(session(), slots, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    expect(economy.actual.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.immediate.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.dearest.totalSek).toBeCloseTo(10 * unit(3))
    expect(cf?.optimal.totalSek).toBeCloseTo(10 * unit(1))
    expect(cf?.savedVsImmediateSek).toBeCloseTo(0)
    expect(cf?.leftOnTableSek).toBeCloseTo(10 * (unit(3) - unit(1)))
    expect(cf?.score).toBeCloseTo(0)
    expect(optimalSchedule?.map((iv) => iv.startMs)).toEqual([
      utc('2026-09-28T09:00Z'),
      utc('2026-09-28T09:15Z'),
      utc('2026-09-28T09:30Z'),
      utc('2026-09-28T09:45Z'),
    ])
  })

  test('waiting for the cheap hour scores 100 % and saves against charging at once', () => {
    const waited = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 },
      ],
    })
    const cf = analyzeSession(waited, slots, [TARIFF]).economy.counterfactual
    expect(cf?.score).toBeCloseTo(1)
    expect(cf?.savedVsImmediateSek).toBeCloseTo(10 * (unit(3) - unit(1)))
    expect(cf?.leftOnTableSek).toBeCloseTo(0)
  })

  test('a negative saving survives: charging at once would have been cheaper', () => {
    // Prices reversed: 10:xx cheap, 11:xx dear; we charged the dear hour.
    const reversed = new SlotIndex(daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 1 : 3)))
    const late = session({
      stretches: [
        { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
        { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 },
      ],
    })
    const cf = analyzeSession(late, reversed, [TARIFF]).economy.counterfactual
    expect(cf?.savedVsImmediateSek).toBeCloseTo(-10 * (unit(3) - unit(1)))
  })

  test('paid spot and window average spot are öre/kWh incl VAT', () => {
    const { economy } = analyzeSession(session(), slots, [TARIFF])
    expect(economy.paidSpotOre).toBeCloseTo(3 * 1.25 * 100)
    expect(economy.windowAvgSpotOre).toBeCloseTo(2 * 1.25 * 100)
  })

  test('a session without hourly data is excluded as no_hourly, its actual cost still shown', () => {
    const flat = session({
      stretches: [{ startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T10:00Z'), kwh: 10 }],
      estimated: true,
    })
    const { economy, optimalSchedule } = analyzeSession(flat, slots, [TARIFF])
    expect(economy.excluded).toBe('no_hourly')
    expect(economy.counterfactual).toBeNull()
    expect(economy.actual.totalSek).toBeGreaterThan(0)
    expect(optimalSchedule).toBeNull()
  })

  test('a window with an unpriced stretch is excluded as no_price — even where we did not charge', () => {
    const holey = new SlotIndex(daySlots('2026-09-28', 15).filter((_, i) => i !== 46))
    expect(analyzeSession(session(), holey, [TARIFF]).economy.excluded).toBe('no_price')
  })

  test('a window without a tariff is excluded as no_price', () => {
    const later = [{ ...TARIFF, validFrom: '2026-10-01' }]
    expect(analyzeSession(session(), slots, later).economy.excluded).toBe('no_price')
  })
})

describe('timingScore', () => {
  test('is where actual sits between dearest (0) and optimal (1)', () => {
    expect(timingScore(15, 10, 20)).toBeCloseTo(0.5)
  })
  test('is null when there was nothing to choose between', () => {
    expect(timingScore(10, 10, 10.005)).toBeNull()
  })
  test('is clamped to 0…1 against float noise', () => {
    expect(timingScore(9.9999999, 10, 20)).toBe(1)
    expect(timingScore(20.0000001, 10, 20)).toBe(0)
  })
})

// Seeded PRNG (mulberry32) — test-only, so the invariant test is reproducible.
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('invariant: optimal ≤ actual ≤ dearest, optimal ≤ immediate ≤ dearest', () => {
  test.each(Array.from({ length: 200 }, (_, i) => i + 1))('seed %i', (seed) => {
    const r = rng(seed)
    const dayStart = utc('2026-09-27T22:00Z') // local midnight, 2026-09-28
    const prices = new SlotIndex(daySlots('2026-09-28', 15, () => r() * 4.5 - 0.5))
    const startMs = dayStart + Math.floor(r() * 12 * 4) * 15 * 60_000 + Math.floor(r() * 14) * 60_000
    const endMs = startMs + (1 + Math.floor(r() * 10)) * HOUR + Math.floor(r() * 50) * 60_000
    const stretches: EconomySession['stretches'] = []
    // Hour-aligned stretches like Zaptec's, plus sometimes a clock-quirk one outside the window.
    for (let a = startMs; a < endMs; ) {
      const b = Math.min(endMs, Math.floor(a / HOUR) * HOUR + HOUR)
      stretches.push({ startMs: a, endMs: b, kwh: r() * 11 * ((b - a) / HOUR) })
      a = b
    }
    if (r() < 0.2) stretches.push({ startMs: endMs, endMs: endMs + 5 * 60_000, kwh: r() * 0.5 })
    const s: EconomySession = { startMs, endMs, stretches, estimated: false }

    const { economy, optimalSchedule } = analyzeSession(s, prices, [TARIFF])
    const cf = economy.counterfactual
    expect(economy.excluded).toBeNull()
    const eps = 1e-9
    expect(cf?.optimal.totalSek).toBeLessThanOrEqual(economy.actual.totalSek + eps)
    expect(economy.actual.totalSek).toBeLessThanOrEqual((cf?.dearest.totalSek ?? 0) + eps)
    expect(cf?.optimal.totalSek).toBeLessThanOrEqual((cf?.immediate.totalSek ?? 0) + eps)
    expect(cf?.immediate.totalSek).toBeLessThanOrEqual((cf?.dearest.totalSek ?? 0) + eps)
    if (cf?.score != null) {
      expect(cf.score).toBeGreaterThanOrEqual(0)
      expect(cf.score).toBeLessThanOrEqual(1)
    }
    expect(sum(optimalSchedule ?? [], (iv) => iv.kwh)).toBeCloseTo(sum(stretches, (x) => x.kwh), 6)
  })
})
```

- [ ] **Step 2: Write the failing totals tests** — `src/lib/evCharging/economy/totals.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { type CostTotals, emptyTotals, type TariffPeriod } from '~/lib/evCharging/cost'
import { averageSpotOre, sumEconomy } from './totals'
import type { SessionEconomy } from './types'

const TARIFF: TariffPeriod = {
  validFrom: '2026-01-01',
  retailMarkupOre: 0,
  gridTransferOre: 0,
  energyTaxOre: 0,
  vatPercent: 25,
}
const totals = (totalSek: number, extra: Partial<CostTotals> = {}): CostTotals => ({
  ...emptyTotals(),
  kwh: 10,
  gridKwh: 10,
  fullKwh: 10,
  spotSek: totalSek / 2,
  totalSek,
  ...extra,
})
const included = (actual: number, immediate: number, optimal: number, dearest: number): SessionEconomy => ({
  actual: totals(actual),
  actualComplete: true,
  paidSpotOre: null,
  windowAvgSpotOre: null,
  excluded: null,
  counterfactual: {
    immediate: totals(immediate),
    optimal: totals(optimal),
    dearest: totals(dearest),
    score: null,
    savedVsImmediateSek: immediate - actual,
    leftOnTableSek: actual - optimal,
  },
})
const excluded = (reason: 'no_hourly' | 'no_price'): SessionEconomy => ({
  actual: totals(99),
  actualComplete: true,
  paidSpotOre: null,
  windowAvgSpotOre: null,
  excluded: reason,
  counterfactual: null,
})

describe('sumEconomy', () => {
  test('sums the included sessions and scores the sums', () => {
    const t = sumEconomy([included(15, 20, 10, 20), included(10, 10, 10, 20)], 120)
    expect(t).toMatchObject({
      sessions: 2,
      included: 2,
      excluded: { noHourly: 0, noPrice: 0 },
      kwh: 20,
      actualSek: 25,
      immediateSek: 30,
      optimalSek: 20,
      dearestSek: 40,
      savedVsImmediateSek: 5,
      leftOnTableSek: 5,
      avgSpotOre: 120,
    })
    expect(t.score).toBeCloseTo((40 - 25) / (40 - 20))
    expect(t.paidSpotOre).toBeCloseTo((12.5 / 20) * 100)
  })

  test('excluded sessions are counted by reason and left out of every kronor figure', () => {
    const t = sumEconomy([included(15, 20, 10, 20), excluded('no_hourly'), excluded('no_price')], null)
    expect(t).toMatchObject({ sessions: 3, included: 1, excluded: { noHourly: 1, noPrice: 1 }, actualSek: 15 })
  })

  test('nothing included → zero sums, null score and null paid spot (the UI says "—")', () => {
    const t = sumEconomy([excluded('no_price')], null)
    expect(t).toMatchObject({ included: 0, actualSek: 0, score: null, paidSpotOre: null })
  })

  test('a negative month saving stays negative', () => {
    expect(sumEconomy([included(20, 15, 10, 20)], null).savedVsImmediateSek).toBe(-5)
  })
})

describe('averageSpotOre', () => {
  test('weights each day by the time it has prices, incl that day’s VAT', () => {
    const avg = averageSpotOre(
      [
        { day: '2026-09-01', avgSekPerKwh: 1, coveredMs: 24 * 3_600_000 },
        { day: '2026-09-02', avgSekPerKwh: 2, coveredMs: 12 * 3_600_000 },
      ],
      [TARIFF],
    )
    expect(avg).toBeCloseTo(((1 * 24 + 2 * 12) / 36) * 1.25 * 100)
  })

  test('skips days without a tariff; none left → null', () => {
    const days = [{ day: '2025-12-31', avgSekPerKwh: 1, coveredMs: 3_600_000 }]
    expect(averageSpotOre(days, [TARIFF])).toBeNull()
    expect(averageSpotOre([], [TARIFF])).toBeNull()
  })
})
```

- [ ] **Step 3: Run both — expect FAIL** (modules missing)

Run: `bunx vitest run src/lib/evCharging/economy`

- [ ] **Step 4: Implement** — `src/lib/evCharging/economy/sessionEconomy.ts`:

```ts
// Client-safe: one session's counterfactuals (ADR-0020 "Counterfactuals").
// Everything is priced by the same `priceIntervals` as the actual cost, so the
// four figures can only differ by *when* the energy is delivered.
import {
  type EnergyInterval,
  isComplete,
  priceIntervals,
  type SlotIndex,
  type TariffPeriod,
  tariffAt,
  unitPrice,
} from '~/lib/evCharging/cost'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { economyWindow, rateCapKw, schedule, sessionKwh, windowPieces } from './schedule'
import type { EconomyExclusion, EconomySession, EconomyWindow, SessionEconomy } from './types'

/** Below this dearest − optimal gap (kr) the window left nothing to choose between. */
export const SCORE_MIN_GAP_SEK = 0.01

/** Where `actual` sits between dearest (0) and optimal (1); null when the gap is too small to mean anything. */
export function timingScore(actualSek: number, optimalSek: number, dearestSek: number): number | null {
  const gap = dearestSek - optimalSek
  if (gap < SCORE_MIN_GAP_SEK) return null
  return Math.min(1, Math.max(0, (dearestSek - actualSek) / gap))
}

/** Time-weighted average spot over the window, öre/kWh incl each slot day's VAT; null without any. */
export function windowAvgSpotOre(
  window: EconomyWindow,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): number | null {
  let weighted = 0
  let coveredMs = 0
  for (const slot of slots.between(window.startMs, window.endMs)) {
    const overlapMs = Math.min(slot.endMs, window.endMs) - Math.max(slot.startMs, window.startMs)
    const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
    if (overlapMs <= 0 || !tariff) continue
    weighted += unitPrice(slot.sekPerKwh, tariff).spotSek * overlapMs
    coveredMs += overlapMs
  }
  return coveredMs > 0 ? (weighted / coveredMs) * 100 : null
}

export function analyzeSession(
  session: EconomySession,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): { economy: SessionEconomy; optimalSchedule: EnergyInterval[] | null } {
  const actual = priceIntervals(
    session.stretches.map((s) => ({ ...s, gridShare: 1 })),
    slots,
    tariffsAsc,
  )
  const window = economyWindow(session)
  const actualComplete = isComplete(actual)
  const common = {
    actual,
    actualComplete,
    // Not over a partly priced actual: that would be the paid spot of only the priced hours.
    paidSpotOre:
      actualComplete && actual.fullKwh > 0 ? (actual.spotSek / actual.fullKwh) * 100 : null,
    windowAvgSpotOre: windowAvgSpotOre(window, slots, tariffsAsc),
  }
  const exclude = (excluded: EconomyExclusion) => ({
    economy: { ...common, excluded, counterfactual: null },
    optimalSchedule: null,
  })

  if (session.estimated) return exclude('no_hourly')
  const pieces = windowPieces(window, slots, tariffsAsc)
  // A partly priced actual can't be compared either (e.g. a stretch past the last price).
  if (!pieces || !isComplete(actual)) return exclude('no_price')

  const kwh = sessionKwh(session)
  const rate = rateCapKw(session, window)
  const price = (ivs: EnergyInterval[]) => priceIntervals(ivs, slots, tariffsAsc)
  const optimalSchedule = schedule('optimal', kwh, rate, pieces)
  const optimal = price(optimalSchedule)
  const immediate = price(schedule('immediate', kwh, rate, pieces))
  const dearest = price(schedule('dearest', kwh, rate, pieces))
  return {
    economy: {
      ...common,
      excluded: null,
      counterfactual: {
        immediate,
        optimal,
        dearest,
        score: timingScore(actual.totalSek, optimal.totalSek, dearest.totalSek),
        savedVsImmediateSek: immediate.totalSek - actual.totalSek,
        leftOnTableSek: Math.max(0, actual.totalSek - optimal.totalSek),
      },
    },
    optimalSchedule,
  }
}
```

  `src/lib/evCharging/economy/totals.ts`:

```ts
// Client-safe: month / year sums of session counterfactuals.
import { sum } from 'd3-array'
import { type TariffPeriod, tariffAt, unitPrice } from '~/lib/evCharging/cost'
import type { DailySpot } from '~/lib/spotPrice/slots'
import { timingScore } from './sessionEconomy'
import type { Counterfactual, EconomyTotals, SessionEconomy } from './types'

export function sumEconomy(items: readonly SessionEconomy[], avgSpotOre: number | null): EconomyTotals {
  const included = items.flatMap((e) =>
    e.counterfactual ? [{ actual: e.actual, cf: e.counterfactual as Counterfactual }] : [],
  )
  const actualSek = sum(included, (e) => e.actual.totalSek)
  const immediateSek = sum(included, (e) => e.cf.immediate.totalSek)
  const optimalSek = sum(included, (e) => e.cf.optimal.totalSek)
  const dearestSek = sum(included, (e) => e.cf.dearest.totalSek)
  const fullKwh = sum(included, (e) => e.actual.fullKwh)
  return {
    sessions: items.length,
    included: included.length,
    excluded: {
      noHourly: items.filter((e) => e.excluded === 'no_hourly').length,
      noPrice: items.filter((e) => e.excluded === 'no_price').length,
    },
    kwh: sum(included, (e) => e.actual.kwh),
    actualSek,
    immediateSek,
    optimalSek,
    dearestSek,
    savedVsImmediateSek: immediateSek - actualSek,
    leftOnTableSek: Math.max(0, actualSek - optimalSek),
    score: included.length > 0 ? timingScore(actualSek, optimalSek, dearestSek) : null,
    paidSpotOre: fullKwh > 0 ? (sum(included, (e) => e.actual.spotSek) / fullKwh) * 100 : null,
    avgSpotOre,
  }
}

/** Time-weighted average spot over whole days, öre/kWh incl each day's VAT; days without a tariff are skipped. */
export function averageSpotOre(
  days: readonly DailySpot[],
  tariffsAsc: readonly TariffPeriod[],
): number | null {
  let weighted = 0
  let coveredMs = 0
  for (const d of days) {
    const tariff = tariffAt(tariffsAsc, d.day)
    if (!tariff || d.coveredMs <= 0) continue
    weighted += unitPrice(d.avgSekPerKwh, tariff).spotSek * d.coveredMs
    coveredMs += d.coveredMs
  }
  return coveredMs > 0 ? (weighted / coveredMs) * 100 : null
}
```

  Update `src/lib/evCharging/economy/index.ts`:

```ts
// Client-safe counterfactual math (no db import). The server-only composer
// that feeds it is `~/lib/evCharging/chargingEconomy.ts`.
export * from './schedule'
export * from './sessionEconomy'
export * from './totals'
export type * from './types'
```

- [ ] **Step 5: Guard client-safety** — append to `src/lib/evCharging/clientSafe.browser.test.tsx`:

```ts
test('the charging economy math is importable client-side', async () => {
  const economy = await import('~/lib/evCharging/economy')
  expect(typeof economy.analyzeSession).toBe('function')
  expect(economy.SCORE_MIN_GAP_SEK).toBe(0.01)
})
```

- [ ] **Step 6: Run — expect PASS**

Run: `bunx vitest run src/lib/evCharging/economy && bunx vitest run --project browser src/lib/evCharging/clientSafe.browser.test.tsx && bun run typecheck && bun run check`

- [ ] **Step 7: Commit**

```bash
git add src/lib/evCharging/economy src/lib/evCharging/clientSafe.browser.test.tsx
git commit -m "feat(charging): score session timing against its counterfactuals

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Review** — `code-reviewer` + `test-completeness` in parallel; fix or rule on every finding.

---

### Task A3: service reads — one session's energy, daily average spot

**Files:**
- Create: `src/lib/services/evCharging/errors.ts`
- Modify: `src/lib/services/evCharging/index.ts`
- Modify: `src/lib/services/evCharging/sessionEnergy.ts` (add `getSessionEnergy`)
- Modify: `src/lib/services/evCharging/sessionEnergy.test.ts`
- Modify: `src/lib/services/spotPrice/spotPrice.ts` (add `dailyAverageSpot`)
- Modify: `src/lib/services/spotPrice/spotPrice.test.ts`

**Interfaces:**
- Produces:
  - `type EvChargingDomainErrorCode = 'EV_SESSION_NOT_FOUND'`; `class EvChargingDomainError extends Error { code }`
  - `getSessionEnergy(sessionId: string): Promise<SessionEnergy>` — throws `EvChargingDomainError('EV_SESSION_NOT_FOUND')`
  - `dailyAverageSpot(zone: PriceZone, fromDay: string, toDay: string): Promise<DailySpot[]>` — inclusive Stockholm days, ordered.

- [ ] **Step 1: Write the failing tests.** Append to `src/lib/services/evCharging/sessionEnergy.test.ts` (extend
  the `./sessionEnergy` import with `getSessionEnergy`; add `import { EvChargingDomainError } from './errors'`):

```ts
test('getSessionEnergy returns one counted session with its stretches', async () => {
  const id = await insertSession({ startAt: new Date('2026-09-03T20:00:00Z') })
  await db.insert(evChargeInterval).values({
    sessionId: id,
    startAt: new Date('2026-09-03T20:00:00Z'),
    endAt: new Date('2026-09-03T21:00:00Z'),
    energyKwh: 10,
  })
  const s = await getSessionEnergy(id)
  expect(s).toMatchObject({ sessionId: id, energyKwh: 10, estimated: false })
  expect(s.stretches).toHaveLength(1)
})

test('getSessionEnergy throws EV_SESSION_NOT_FOUND for an unknown id', async () => {
  await expect(getSessionEnergy('00000000-0000-4000-8000-000000000000')).rejects.toEqual(
    new EvChargingDomainError('EV_SESSION_NOT_FOUND'),
  )
})

test('getSessionEnergy throws EV_SESSION_NOT_FOUND for an uncounted (voided or noise) session', async () => {
  const voided = await insertSession({ voided: true })
  const noise = await insertSession({ energyKwh: 0.2 })
  for (const id of [voided, noise]) {
    await expect(getSessionEnergy(id)).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND' })
  }
})
```

  Append to `src/lib/services/spotPrice/spotPrice.test.ts` (add `dailyAverageSpot` to the `./spotPrice` import):

```ts
test('dailyAverageSpot averages each Stockholm day, weighting by slot length', async () => {
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15, (i) => i / 100))
  await replaceDay('SE3', '2025-09-15', daySlots('2025-09-15', 60, () => 2))
  await replaceDay('SE3', '2026-09-29', daySlots('2026-09-29', 15, () => 7)) // outside the range

  const days = await dailyAverageSpot('SE3', '2025-09-01', '2026-09-28')
  expect(days.map((d) => d.day)).toEqual(['2025-09-15', '2026-09-28'])
  expect(days[0]).toEqual({ day: '2025-09-15', avgSekPerKwh: 2, coveredMs: 24 * 3_600_000 })
  expect(days[1].avgSekPerKwh).toBeCloseTo(0.475) // mean of 0.00 … 0.95
  expect(days[1].coveredMs).toBe(24 * 3_600_000)
})

test('dailyAverageSpot counts a 25-hour DST day as 25 hours', async () => {
  await replaceDay('SE3', '2026-10-25', daySlots('2026-10-25', 60, () => 1))
  const [d] = await dailyAverageSpot('SE3', '2026-10-25', '2026-10-25')
  expect(d.coveredMs).toBe(25 * 3_600_000)
})

test('dailyAverageSpot is empty without stored slots', async () => {
  expect(await dailyAverageSpot('SE3', '2026-01-01', '2026-12-31')).toEqual([])
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run db:up && bun run db:migrate && bunx vitest run src/lib/services/evCharging/sessionEnergy.test.ts src/lib/services/spotPrice/spotPrice.test.ts`

- [ ] **Step 3: Implement.** `src/lib/services/evCharging/errors.ts`:

```ts
export type EvChargingDomainErrorCode =
  // A session id that doesn't exist or isn't counted (noise, voided, replaced).
  'EV_SESSION_NOT_FOUND'

export class EvChargingDomainError extends Error {
  constructor(public readonly code: EvChargingDomainErrorCode) {
    super(code)
    this.name = 'EvChargingDomainError'
  }
}
```

  `src/lib/services/evCharging/index.ts` — add `export * from './errors'`.

  `src/lib/services/evCharging/sessionEnergy.ts` — add `import { EvChargingDomainError } from './errors'` and, after
  `listSessionEnergy`:

```ts
/** One counted session's energy; throws `EV_SESSION_NOT_FOUND` for an unknown or uncounted id. */
export async function getSessionEnergy(sessionId: string): Promise<SessionEnergy> {
  const [session] = await listSessionEnergy({ sessionIds: [sessionId] })
  if (!session) throw new EvChargingDomainError('EV_SESSION_NOT_FOUND')
  return session
}
```

  `src/lib/services/spotPrice/spotPrice.ts` — import `type DailySpot` from `~/lib/spotPrice/slots` and
  `stockholmDayBounds` from `~/lib/time/stockholm` (if not already), then add:

```ts
/**
 * Per Stockholm day in `[fromDay, toDay]` (inclusive) with stored slots: the
 * time-weighted average SEK/kWh (ex VAT) and how long the day has prices.
 * Aggregated in Postgres — a year is ~35 000 slots but only 365 rows here —
 * over a PK range scan. Slots never straddle local midnight (the sync stores
 * whole validated days), so grouping by the slot start's local day is exact.
 */
export async function dailyAverageSpot(
  zone: PriceZone,
  fromDay: string,
  toDay: string,
): Promise<DailySpot[]> {
  const from = new Date(stockholmDayBounds(fromDay).startMs).toISOString()
  const to = new Date(stockholmDayBounds(toDay).endMs).toISOString()
  const seconds = sql`extract(epoch FROM ${spotPrice.slotEnd} - ${spotPrice.slotStart})`
  const { rows } = await db.execute<{ day: string; avg: string; covered_s: string }>(sql`
    SELECT to_char(${spotPrice.slotStart} AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD') AS day,
           sum(${spotPrice.sekPerKwh} * ${seconds}) / sum(${seconds}) AS avg,
           sum(${seconds}) AS covered_s
    FROM ${spotPrice}
    WHERE ${spotPrice.zone} = ${zone}
      AND ${spotPrice.slotStart} >= ${from}::timestamptz
      AND ${spotPrice.slotStart} < ${to}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `)
  return rows.map((r) => ({
    day: r.day,
    avgSekPerKwh: Number(r.avg),
    coveredMs: Math.round(Number(r.covered_s) * 1000),
  }))
}
```

- [ ] **Step 4: Run — expect PASS**; typecheck + lint

Run: `bunx vitest run src/lib/services/evCharging src/lib/services/spotPrice && bun run typecheck && bun run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/evCharging src/lib/services/spotPrice
git commit -m "feat(charging): read one session's energy and daily average spot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Review** — `code-reviewer` + `test-completeness` (every `EvChargingDomainErrorCode` literal
  exercised); fix or rule on every finding.

---

### Task A4: shared cost inputs + the economy orchestrator

**Files:**
- Create: `src/lib/evCharging/costInputs.ts`
- Modify: `src/lib/evCharging/costing.ts` (use `costInputs.ts`; behavior unchanged)
- Create: `src/lib/evCharging/chargingEconomy.ts`
- Create: `src/lib/evCharging/chargingEconomy.test.ts`

**Interfaces:**
- Consumes: A1/A2 (`~/lib/evCharging/economy`), A3 (`getSessionEnergy`, `dailyAverageSpot`), `listSessionEnergy`,
  `distinctCountedYears`, `listSlotsOverlapping`, `sessionPeakKw` (`~/lib/evCharging/patterns`).
- Produces:
  - `costInputs.ts`: `timed(timings, key, fn)`, `loadTariffs(): Promise<TariffPeriod[]>`, `toIntervals(session: SessionEnergy): EnergyInterval[]`
  - `chargingEconomy.ts`: `type EconomyTimings`, `type EconomySessionRow`, `type EconomyOverview`, `type SessionEconomyDetail`,
    `getEconomyOverview({ year?, now?, timings? }): Promise<EconomyOverview>`,
    `getSessionEconomy({ sessionId, timings? }): Promise<SessionEconomyDetail>`

- [ ] **Step 1: Extract the shared inputs (refactor hat, tests green before and after).** Create
  `src/lib/evCharging/costInputs.ts` by **moving** `timed`, `loadTariffs` and `toIntervals` out of `costing.ts`:

```ts
import type { EnergyInterval, TariffPeriod } from '~/lib/evCharging/cost'
import type { SessionEnergy } from '~/lib/services/evCharging'
import * as tariffService from '~/lib/services/tariff'

// Server-only. Inputs shared by the cost read models (`costing.ts`,
// `chargingEconomy.ts`): each loaded through its own service, as the cost math wants it.

/** Runs `fn`, recording its duration under `key` when a timings sink is given. */
export async function timed<K extends string, T>(
  timings: { [P in K]?: number } | undefined,
  key: K,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    if (timings) timings[key] = Math.round(performance.now() - start)
  }
}

/** All tariff periods, oldest first. */
export async function loadTariffs(): Promise<TariffPeriod[]> {
  const tariffs = await tariffService.list()
  return tariffs.map((t) => ({
    validFrom: t.validFrom,
    retailMarkupOre: t.retailMarkupOre,
    gridTransferOre: t.gridTransferOre,
    energyTaxOre: t.energyTaxOre,
    vatPercent: t.vatPercent,
  }))
}

// Every counted session is bought from the grid for now (gridShare 1) — the
// seam where a solar/battery source (Emaldo) would supply a real share.
export function toIntervals(session: SessionEnergy): EnergyInterval[] {
  return session.stretches.map((s) => ({ ...s, gridShare: 1 }))
}
```

  In `costing.ts`: delete the three local functions and the `tariffService` import; import
  `{ loadTariffs, timed, toIntervals }` from `./costInputs`; replace both `loadTariffs(input.timings)` calls with
  `timed(input.timings, 'tariffMs', loadTariffs)`.

  Run: `bunx vitest run src/lib/evCharging/costing.test.ts && bun run typecheck` — expect PASS. Commit:

```bash
git add src/lib/evCharging/costInputs.ts src/lib/evCharging/costing.ts
git commit -m "refactor(charging): share the cost read models' inputs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing orchestrator tests** — `src/lib/evCharging/chargingEconomy.test.ts`:

```ts
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { evChargeInterval, evCharger, evChargeSession } from '~/lib/db/schema'
import { EvChargingDomainError } from '~/lib/services/evCharging'
import { replaceDay } from '~/lib/services/spotPrice'
import * as tariffService from '~/lib/services/tariff'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { setupDatabase } from '~test/setup'
import { getSessionCosts } from './costing'
import { getEconomyOverview, getSessionEconomy } from './chargingEconomy'

setupDatabase()

const NOW = new Date('2026-09-30T12:00:00Z')
const TARIFF = {
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
const unit = (spot: number) => (spot + 0.76931) * 1.25

let counter = 0
async function session(
  startIso: string,
  endIso: string,
  kwh: number,
  intervals: [string, string, number][] = [],
  overrides: Partial<typeof evChargeSession.$inferInsert> = {},
) {
  counter += 1
  await db
    .insert(evCharger)
    .values({ id: 'charger-1', name: 'Charger', installationId: 'install-1' })
    .onConflictDoNothing()
  const [row] = await db
    .insert(evChargeSession)
    .values({
      zaptecSessionId: `zap-${counter}`,
      chargerId: 'charger-1',
      startAt: new Date(startIso),
      endAt: new Date(endIso),
      energyKwh: kwh,
      ...overrides,
    })
    .returning({ id: evChargeSession.id })
  if (intervals.length > 0) {
    await db.insert(evChargeInterval).values(
      intervals.map(([s, e, k]) => ({
        sessionId: row.id,
        startAt: new Date(s),
        endAt: new Date(e),
        energyKwh: k,
      })),
    )
  }
  return row.id
}

// 2026-09-28: local 10:xx (08:00Z–09:00Z) costs 3 SEK, everything else 1 SEK.
async function seedPrices() {
  await tariffService.create(TARIFF)
  await replaceDay('SE3', '2026-09-28', daySlots('2026-09-28', 15, (i) => (i >= 40 && i < 44 ? 3 : 1)))
}

test('the optimum uses window slots outside the charged hours', async () => {
  await seedPrices()
  // Plugged in 08:00Z–10:00Z, charged only the dear hour: slots of 09:00Z–10:00Z
  // must be loaded even though no stretch covers them.
  await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const { sessions } = await getEconomyOverview({ year: 2026, now: NOW })
  const cf = sessions[0].counterfactual
  expect(cf?.optimal.totalSek).toBeCloseTo(10 * unit(1))
  expect(cf?.leftOnTableSek).toBeCloseTo(10 * (unit(3) - unit(1)))
})

test('the actual cost equals the session list’s cost (parity with getSessionCosts)', async () => {
  await seedPrices()
  const id = await session('2026-09-28T07:30:00Z', '2026-09-28T09:40:00Z', 12, [
    ['2026-09-28T07:30:00Z', '2026-09-28T08:00:00Z', 2],
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 7],
    ['2026-09-28T09:00:00Z', '2026-09-28T09:40:00Z', 3],
  ])
  const [{ sessions }, [cost]] = await Promise.all([
    getEconomyOverview({ year: 2026, now: NOW }),
    getSessionCosts({ sessionIds: [id] }),
  ])
  expect(sessions[0].actual.totalSek).toBeCloseTo(cost.totalSek, 9)
  expect(sessions[0].actual.fullKwh).toBeCloseTo(cost.fullKwh, 9)
})

test('only counted sessions of the selected year, newest first, bucketed by start month', async () => {
  await seedPrices()
  await replaceDay('SE3', '2026-08-31', daySlots('2026-08-31', 15, () => 1))
  await replaceDay('SE3', '2026-09-01', daySlots('2026-09-01', 15, () => 1))
  // Overnight across the month end (local 23:00 Aug 31 → 01:00 Sep 1): August.
  const overnight = await session('2026-08-31T21:00:00Z', '2026-08-31T23:00:00Z', 10, [
    ['2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z', 5],
    ['2026-08-31T22:00:00Z', '2026-08-31T23:00:00Z', 5],
  ])
  const september = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  await session('2026-09-28T11:00:00Z', '2026-09-28T12:00:00Z', 9, [], { voided: true })
  await session('2026-09-28T13:00:00Z', '2026-09-28T14:00:00Z', 0.2) // noise
  await session('2025-09-28T08:00:00Z', '2025-09-28T09:00:00Z', 5) // another year

  const o = await getEconomyOverview({ year: 2026, now: NOW })
  expect(o.sessions.map((s) => s.sessionId)).toEqual([september, overnight])
  expect(o.months[7]).toMatchObject({ month: 8, sessions: 1, included: 1 })
  expect(o.months[8]).toMatchObject({ month: 9, sessions: 1, included: 1 })
  expect(o.tiles).toMatchObject({ sessions: 2, included: 2 })
  expect(o.years).toEqual([2026, 2025])
})

test('excluded sessions are counted by reason: no hourly data, or a price day missing mid-window', async () => {
  await seedPrices()
  // No intervals.
  await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10)
  // Overnight into 2026-09-29, which has no prices (its sync failed).
  await session('2026-09-28T20:00:00Z', '2026-09-28T23:00:00Z', 10, [
    ['2026-09-28T20:00:00Z', '2026-09-28T21:00:00Z', 10],
  ])
  const { tiles, sessions } = await getEconomyOverview({ year: 2026, now: NOW })
  expect(tiles.excluded).toEqual({ noHourly: 1, noPrice: 1 })
  expect(tiles.included).toBe(0)
  expect(tiles.score).toBeNull()
  expect(sessions.map((s) => s.excluded).sort()).toEqual(['no_hourly', 'no_price'])
})

test('the month and year average spot cover every priced day, charged or not', async () => {
  await seedPrices()
  const { months, tiles } = await getEconomyOverview({ year: 2026, now: NOW })
  // One day stored: 4 of 96 quarters at 3 SEK, the rest at 1.
  const avg = ((4 * 3 + 92 * 1) / 96) * 1.25 * 100
  expect(months[8].avgSpotOre).toBeCloseTo(avg)
  expect(tiles.avgSpotOre).toBeCloseTo(avg)
  expect(months[0].avgSpotOre).toBeNull()
})

test('the selected year defaults to the current Stockholm year and the list always offers it', async () => {
  const o = await getEconomyOverview({ now: NOW })
  expect(o.year).toBe(2026)
  expect(o.years).toEqual([2026])
  expect(o.months).toHaveLength(12)
})

test('getSessionEconomy returns the chart data: stretches, prices ±1 h, the optimal schedule', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 10, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 10],
  ])
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.session).toMatchObject({ id, kwh: 10, estimated: false })
  expect(d.session.peakKw).toBeCloseTo(10)
  expect(d.intervals).toHaveLength(1)
  // 07:00Z–11:00Z of 15-min slots.
  expect(d.prices).toHaveLength(16)
  expect(d.prices[4].spotOre).toBeCloseTo(3 * 1.25 * 100)
  expect(d.optimalSchedule?.[0].startMs).toBe(new Date('2026-09-28T09:00:00Z').getTime())
  expect(d.economy.counterfactual?.score).toBeCloseTo(0)
})

test('getSessionEconomy throws EV_SESSION_NOT_FOUND for an unknown id', async () => {
  await expect(
    getSessionEconomy({ sessionId: '00000000-0000-4000-8000-000000000000' }),
  ).rejects.toBeInstanceOf(EvChargingDomainError)
})

test('both reads fill their timings sink', async () => {
  const timings: Record<string, number> = {}
  await getEconomyOverview({ now: NOW, timings })
  expect(timings).toMatchObject({
    energyMs: expect.any(Number),
    tariffMs: expect.any(Number),
    slotsMs: expect.any(Number),
    dailySpotMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
})
```

- [ ] **Step 3: Run — expect FAIL** (`./economy` missing)

Run: `bunx vitest run src/lib/evCharging/chargingEconomy.test.ts`

- [ ] **Step 4: Implement** — `src/lib/evCharging/chargingEconomy.ts`:

```ts
import { millisecondsInHour } from 'date-fns/constants'
import { SlotIndex, tariffAt, unitPrice } from '~/lib/evCharging/cost'
import {
  analyzeSession,
  averageSpotOre,
  type EconomySession,
  type EconomyStretch,
  type EconomyTotals,
  type EconomyWindow,
  economyWindow,
  type SessionEconomy,
  sumEconomy,
} from '~/lib/evCharging/economy'
import { sessionPeakKw } from '~/lib/evCharging/patterns'
import {
  distinctCountedYears,
  getSessionEnergy,
  listSessionEnergy,
  type SessionEnergy,
} from '~/lib/services/evCharging'
import { dailyAverageSpot, listSlotsOverlapping } from '~/lib/services/spotPrice'
import { SPOT_ZONE } from '~/lib/spotPrice/zones'
import { stockholmDayOf, stockholmYearMonth } from '~/lib/time/stockholm'
import { loadTariffs, timed } from './costInputs'

// Server-only. The charging-economy read model (Phase 4, ADR-0020
// "Counterfactuals"): session energy, the spot slots of each plug-in window,
// per-day average spot and tariff periods — each through its own service —
// run through the pure counterfactual math. Spot timing only: every kWh is
// treated as grid-bought.

export type EconomyTimings = {
  energyMs?: number
  tariffMs?: number
  slotsMs?: number
  dailySpotMs?: number
  computeMs?: number
}

export type EconomySessionRow = SessionEconomy & {
  sessionId: string
  startAt: Date
  endAt: Date
  kwh: number
}

export type EconomyOverview = {
  year: number
  /** Years with counted sessions plus the current one, newest first. */
  years: number[]
  tiles: EconomyTotals
  /** The selected year's 12 Stockholm months (by session start), zero-filled. */
  months: (EconomyTotals & { month: number })[]
  /** The selected year's counted sessions, newest first. */
  sessions: EconomySessionRow[]
}

export type SessionEconomyDetail = {
  session: {
    id: string
    startAt: Date
    endAt: Date
    kwh: number
    peakKw: number | null
    estimated: boolean
  }
  window: EconomyWindow
  /** Zaptec intervals; empty when the session has none. */
  intervals: EconomyStretch[]
  /** Spot slots over the window ± 1 h, öre/kWh incl VAT; null on a day without a tariff. */
  prices: { startMs: number; endMs: number; spotOre: number | null }[]
  optimalSchedule: EconomyStretch[] | null
  economy: SessionEconomy
}

/** Chart context either side of the plug-in window. */
const CONTEXT_MS = millisecondsInHour

function toEconomySession(s: SessionEnergy): EconomySession {
  return {
    startMs: s.startAt.getTime(),
    endMs: s.endAt.getTime(),
    stretches: s.stretches,
    estimated: s.estimated,
  }
}

export async function getEconomyOverview(input: {
  year?: number
  now?: Date
  timings?: EconomyTimings
}): Promise<EconomyOverview> {
  const t = input.timings
  const now = input.now ?? new Date()
  const currentYear = stockholmYearMonth(now.getTime()).year
  const year = input.year ?? currentYear

  const [all, tariffsAsc, years] = await Promise.all([
    timed(t, 'energyMs', () => listSessionEnergy({ all: true })),
    timed(t, 'tariffMs', loadTariffs),
    distinctCountedYears(),
  ])
  years.add(currentYear)
  const inYear = all.filter((s) => stockholmYearMonth(s.startAt.getTime()).year === year)
  const sessions = inYear.map(toEconomySession)

  const [slots, days] = await Promise.all([
    timed(t, 'slotsMs', () => listSlotsOverlapping(SPOT_ZONE, sessions.map(economyWindow))),
    timed(t, 'dailySpotMs', () => dailyAverageSpot(SPOT_ZONE, `${year}-01-01`, `${year}-12-31`)),
  ])

  const computeStart = performance.now()
  const index = new SlotIndex(slots)
  const rows: EconomySessionRow[] = inYear.map((s, i) => ({
    sessionId: s.sessionId,
    startAt: s.startAt,
    endAt: s.endAt,
    kwh: s.energyKwh,
    ...analyzeSession(sessions[i], index, tariffsAsc).economy,
  }))
  const rowsByMonth = Map.groupBy(rows, (r) => stockholmYearMonth(r.startAt.getTime()).month)
  const daysByMonth = Map.groupBy(days, (d) => Number(d.day.slice(5, 7)))
  const overview: EconomyOverview = {
    year,
    years: [...years].sort((a, b) => b - a),
    tiles: sumEconomy(rows, averageSpotOre(days, tariffsAsc)),
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      ...sumEconomy(
        rowsByMonth.get(i + 1) ?? [],
        averageSpotOre(daysByMonth.get(i + 1) ?? [], tariffsAsc),
      ),
    })),
    sessions: rows.toReversed(),
  }
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return overview
}

export async function getSessionEconomy(input: {
  sessionId: string
  timings?: EconomyTimings
}): Promise<SessionEconomyDetail> {
  const t = input.timings
  const [energy, tariffsAsc] = await Promise.all([
    timed(t, 'energyMs', () => getSessionEnergy(input.sessionId)),
    timed(t, 'tariffMs', loadTariffs),
  ])
  const session = toEconomySession(energy)
  const window = economyWindow(session)
  const slots = await timed(t, 'slotsMs', () =>
    listSlotsOverlapping(SPOT_ZONE, [
      { startMs: window.startMs - CONTEXT_MS, endMs: window.endMs + CONTEXT_MS },
    ]),
  )

  const computeStart = performance.now()
  const { economy, optimalSchedule } = analyzeSession(session, new SlotIndex(slots), tariffsAsc)
  const intervals = energy.estimated ? [] : energy.stretches
  const detail: SessionEconomyDetail = {
    session: {
      id: energy.sessionId,
      startAt: energy.startAt,
      endAt: energy.endAt,
      kwh: energy.energyKwh,
      peakKw: sessionPeakKw(
        intervals.map((s) => ({
          startAt: new Date(s.startMs),
          endAt: new Date(s.endMs),
          energyKwh: s.kwh,
        })),
      ),
      estimated: energy.estimated,
    },
    window,
    intervals,
    prices: slots.map((slot) => {
      const tariff = tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))
      return {
        startMs: slot.startMs,
        endMs: slot.endMs,
        spotOre: tariff ? unitPrice(slot.sekPerKwh, tariff).spotSek * 100 : null,
      }
    }),
    optimalSchedule: optimalSchedule?.map(({ startMs, endMs, kwh }) => ({ startMs, endMs, kwh })) ?? null,
    economy,
  }
  if (t) t.computeMs = Math.round(performance.now() - computeStart)
  return detail
}
```

  (The orchestrator is deliberately *not* named `economy.ts`: a file beside the `economy/` folder would win module
  resolution, and every client import of `~/lib/evCharging/economy` would pull in the server read model.)

- [ ] **Step 5: Run — expect PASS**; full node suite for the charging area; typecheck + lint

Run: `bunx vitest run src/lib/evCharging src/lib/services && bun run typecheck && bun run check`

- [ ] **Step 6: Commit**

```bash
git add src/lib/evCharging/chargingEconomy.ts src/lib/evCharging/chargingEconomy.test.ts
git commit -m "feat(charging): add the charging economy read model

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Review** — `code-reviewer` + `test-completeness`; fix or rule on every finding.

---

### Task A5: procedures and ADR amendment

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts`
- Modify: `src/lib/orpc/procedures/evCharging.test.ts`
- Modify: `docs/adr/0020-spot-prices-and-cost-model.md`

**Interfaces:**
- Consumes: A4 `getEconomyOverview`, `getSessionEconomy`, `EconomyTimings`; A3 `EvChargingDomainError`,
  `EvChargingDomainErrorCode`.
- Produces: `evCharging.economy({ year? })` → `EconomyOverview`;
  `evCharging.session({ sessionId: uuid })` → `SessionEconomyDetail`, error code `EV_SESSION_NOT_FOUND` (404).

- [ ] **Step 1: Write the failing procedure tests** — append to `src/lib/orpc/procedures/evCharging.test.ts`:

```ts
test('economy and session reject an unauthenticated caller', async () => {
  await expect(call(evChargingRouter.economy, {}, { context: baseContext() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await expect(
    call(
      evChargingRouter.session,
      { sessionId: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})

test('economy returns 12 empty months for a signed-in user with no data', async () => {
  await signIn('user')
  const result = await call(evChargingRouter.economy, {}, { context: baseContext() })
  expect(result.months).toHaveLength(12)
  expect(result.tiles).toMatchObject({ sessions: 0, included: 0, score: null })
})

test('economy rejects an out-of-range year as BAD_REQUEST', async () => {
  await signIn('user')
  await expect(
    call(evChargingRouter.economy, { year: 2019 }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('session maps an unknown id to EV_SESSION_NOT_FOUND (404) and a malformed one to BAD_REQUEST', async () => {
  await signIn('user')
  await expect(
    call(
      evChargingRouter.session,
      { sessionId: '00000000-0000-4000-8000-000000000000' },
      { context: baseContext() },
    ),
  ).rejects.toMatchObject({ code: 'EV_SESSION_NOT_FOUND', status: 404, defined: true })
  await expect(
    call(evChargingRouter.session, { sessionId: 'nope' }, { context: baseContext() }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})

test('economy records its sub-timings', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(evChargingRouter.economy, {}, { context: { ...baseContext(), timings } })
  expect(timings).toMatchObject({
    economyEnergyMs: expect.any(Number),
    economyTariffMs: expect.any(Number),
    economySlotsMs: expect.any(Number),
    economyDailySpotMs: expect.any(Number),
    economyComputeMs: expect.any(Number),
  })
})

test('session records its sub-timings even when it fails', async () => {
  await signIn('user')
  const timings: Record<string, number> = {}
  await call(
    evChargingRouter.session,
    { sessionId: '00000000-0000-4000-8000-000000000000' },
    { context: { ...baseContext(), timings } },
  ).catch(() => {})
  expect(timings).toMatchObject({ economyEnergyMs: expect.any(Number) })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts`

- [ ] **Step 3: Implement** in `src/lib/orpc/procedures/evCharging.ts`. Imports:

```ts
import {
  type EconomyTimings,
  getEconomyOverview,
  getSessionEconomy,
} from '~/lib/evCharging/chargingEconomy'
import { EvChargingDomainError, type EvChargingDomainErrorCode } from '~/lib/services/evCharging'
```

  Above `evChargingRouter`:

```ts
const evChargingErrors = {
  EV_SESSION_NOT_FOUND: { status: 404 },
} satisfies Record<EvChargingDomainErrorCode, { status: number }>
```

  Inside the router, after `timeline`:

```ts
  // How economically we charge (/charging/economy): counterfactual schedules
  // over each plug-in window. Several queries + the pure math → sub-timings.
  economy: protectedProcedure
    .input(z.object({ year: yearInput }))
    .handler(async ({ input, context }) => {
      const timings: EconomyTimings = {}
      const result = await getEconomyOverview({ year: input.year, timings })
      recordPrefixedTimings(context.timings, 'economy', timings)
      return result
    }),

  // One session's economy + chart data (/charging/sessions/$sessionId). An
  // unknown or uncounted id is a typed 404 the page turns into "not found".
  session: protectedProcedure
    .errors(evChargingErrors)
    .input(z.object({ sessionId: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      const timings: EconomyTimings = {}
      try {
        return await getSessionEconomy({ sessionId: input.sessionId, timings })
      } catch (err) {
        if (err instanceof EvChargingDomainError) throw errors[err.code]()
        throw err
      } finally {
        recordPrefixedTimings(context.timings, 'economy', timings)
      }
    }),
```

- [ ] **Step 4: Run — expect PASS**

Run: `bunx vitest run src/lib/orpc/procedures/evCharging.test.ts && bun run typecheck && bun run check`

- [ ] **Step 5: Amend ADR-0020** — append before `## Alternatives considered`:

```md
### Counterfactuals (Phase 4, 2026-09-30)

[Phase 4 design](../superpowers/specs/2026-09-30-ev-charging-phase4-design.md). `src/lib/evCharging/economy/`
(client-safe) re-delivers a session's energy inside its plug-in window — widened to cover every interval, so the
actual schedule is always one of the candidates — at most at its **rate cap** (the highest observed kW, or kWh ÷
window hours if higher), and prices the result with `priceIntervals`:

- **immediate** fills the window's price pieces in time order from plug-in; **optimal** cheapest first; **dearest**
  most expensive first. Pieces are ranked by the full price `(spot + fees) × (1 + VAT)` of the tariff at the slot's
  Stockholm day (`unitPrice`, shared with `priceIntervals`). Greedy is exactly optimal: cost is linear in kWh with
  independent per-slot capacity.
- **Score** = (dearest − actual) ÷ (dearest − optimal), clamped to 0…1, null below a 0,01 kr gap. Saved =
  immediate − actual (may be negative); left on the table = actual − optimal.
- A session without intervals (`no_hourly`) or with any part of its window lacking a price or tariff (`no_price`) is
  **excluded and counted** — never priced over what remains.
- Month/year sums bucket by the **session's start month** (counterfactuals only exist per session), so they can
  differ by öre from the cost overview, which buckets by interval.
- **Spot timing only**: everything is grid-bought (`gridShare` 1). Actual spreads each hour's energy over its
  quarters while optimal can pick single quarters, so "left on the table" is slightly overstated (and the hourly-average rate cap pulls the other way). Both caveats are
  stated on the page.
- Month average spot comes from `dailyAverageSpot` (per-day time-weighted average, aggregated in Postgres).
```

- [ ] **Step 6: Commit** (ADR, docs hat) and the procedures (feat hat):

```bash
git add src/lib/orpc/procedures/evCharging.ts src/lib/orpc/procedures/evCharging.test.ts
git commit -m "feat(charging): expose charging economy and session reads

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git add docs/adr/0020-spot-prices-and-cost-model.md
git commit -m "docs(charging): record the Phase 4 counterfactual model

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Review** — `code-reviewer` + a reviewer loading `better-auth-security-best-practices` (both reads
  are `protectedProcedure`; nothing admin-only leaks); fix or rule on every finding.

- [ ] **Step 8: PR A** — branch review (Phase 5 of the feature workflow: `code-reviewer`, `test-completeness`, a
  correctness pass), the [pre-PR gate](../../feature-workflow.md#pre-pr-gate), then open PR A titled
  `feat(charging): add charging economy read models` using `.github/PULL_REQUEST_TEMPLATE.md`, listing the
  deviations above.

---

## PR B — `/charging/economy` (`feat/charging-economy-page`)

### Task B1: route, navigation, tiles, footnote, empty and error states

**Files:**
- Create: `src/routes/_authenticated/charging/economy.tsx` (then `bun run dev` or `bunx tsr generate` regenerates
  `src/routeTree.gen.ts` — never hand-edit)
- Modify: `src/components/AppSidebar.tsx` (third `chargingSubItems` entry)
- Modify: `src/components/command/commands.ts` (entry after `/charging/patterns`)
- Create: `src/components/evCharging/EconomyTiles.tsx` + `EconomyTiles.browser.test.tsx`
- Create: `src/components/evCharging/EconomyFootnote.tsx`
- Modify: `src/components/evCharging/format.ts` (`formatSignedSek`, `formatScore`)
- Modify: `src/components/evCharging/format.test.ts`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `orpc.evCharging.economy`, `RouterOutputs['evCharging']['economy']`; existing `ChargingHeading`,
  `SyncHealthAlert`, `SyncNowButton` / `useSyncNow`, `YearSelector`, `LoadErrorAlert` / `loadFailed`, `PriceFootnote`,
  `PageContainer`, `Empty*`, `Card*`.
- Produces: `EconomyTiles({ tiles })`, `EconomyFootnote({ excluded })`, `formatSignedSek(value, fractionDigits?)`,
  `formatScore(score: number | null)`; route `/charging/economy` with search `{ year? }`.

- [ ] **Step 1: Messages.** Add to `messages/sv.json` (and the English equivalents, same keys, to `messages/en.json`):

```json
  "nav_charging_economy_short": "Ekonomi",
  "nav_charging_economy": "Laddekonomi",
  "cmd_kw_charging_economy": "ekonomi spotpris besparing smart laddning pristajming",
  "meta_charging_economy_title": "Laddekonomi",
  "meta_charging_economy_description": "Hur väl vi prickar spotpriset när vi laddar bilen.",
  "charging_economy_title": "Laddekonomi",
  "charging_economy_tile_saved": "Sparat mot direktladdning",
  "charging_economy_tile_saved_hint": "Jämfört med att ladda direkt vid inkoppling",
  "charging_economy_tile_left": "Kvar att hämta",
  "charging_economy_tile_left_hint": "Jämfört med de billigaste kvartarna medan bilen var inkopplad",
  "charging_economy_tile_score": "Pristajming",
  "charging_economy_tile_score_hint": "100 % = billigast möjliga, 0 % = dyrast möjliga",
  "charging_economy_tile_spot": "Betalt spotpris",
  "charging_economy_tile_spot_avg": "Snittspot {avg} öre/kWh",
  "charging_economy_tile_none": "Inga sessioner med fullständiga priser",
  "charging_economy_ore": "{value} öre/kWh",
  "charging_economy_caveat": "Mäter bara pristajming: all el räknas som köpt från elnätet, så solel ingår inte. Den faktiska kostnaden fördelar varje timmes energi jämnt över timmens kvartspriser, och laddtakten är en timmedel, så ”Kvar att hämta” kan vara något över- eller underskattad.",
  "charging_economy_bucketing": "Sessioner räknas till månaden de startade.",
  "charging_economy_error_title": "Kunde inte läsa laddekonomin",
  "charging_economy_empty_title": "Inga laddsessioner {year}",
  "charging_economy_empty_description": "När bilen har laddats visas här hur väl laddningen prickade spotpriset.",
  "charging_economy_excluded_no_hourly": [ …plural like charging_patterns_unhourly_note:
      one: "{countFormatted} session saknar timdata och ingår inte i jämförelsen.",
      other: "{countFormatted} sessioner saknar timdata och ingår inte i jämförelsen." ],
  "charging_economy_excluded_no_price": [ …plural:
      one: "{countFormatted} session saknar spotpris eller tariff under inkopplingen och ingår inte.",
      other: "{countFormatted} sessioner saknar spotpris eller tariff under inkopplingen och ingår inte." ]
```

  Write the two plural messages in full in the same `declarations` / `selectors` / `match` shape as
  `charging_patterns_unhourly_note` (`messages/sv.json` ~line 423). English:
  `"Economy"`, `"Charging economy"`, `"economy spot price savings smart charging price timing"`,
  `"Charging economy"`, `"How well we hit the spot price when charging the car."`, `"Charging economy"`,
  `"Saved vs charging at once"`, `"Compared with charging at plug-in"`, `"Left on the table"`,
  `"Compared with the cheapest quarters while plugged in"`, `"Price timing"`,
  `"100 % = cheapest possible, 0 % = dearest possible"`, `"Spot price paid"`, `"Average spot {avg} öre/kWh"`,
  `"No sessions with complete prices"`, `"{value} öre/kWh"`, the caveat
  (`"Measures price timing only: all electricity counts as bought from the grid, so solar isn't included. Actual cost spreads each hour's energy evenly over its quarter-hour prices, and the charge rate is an hourly average, so “Left on the table” may be somewhat over- or understated."`),
  `"Sessions count toward the month they started."`, `"Couldn't load the charging economy"`,
  `"No charging sessions in {year}"`, `"Once the car has charged, this shows how well charging hit the spot price."`,
  and the plurals (`"… session has no hourly data and isn't compared."` / `"… sessions have no hourly data …"`,
  `"… session lacks a spot price or tariff while plugged in and isn't compared."` / plural).

  Run: `bun run i18n:compile` and the pre-PR gate's sv/en key-match one-liner — expect "sv/en keys match".

- [ ] **Step 2: Failing format tests** — append to `src/components/evCharging/format.test.ts` (sv locale is the test
  default; mirror the file's existing locale setup):

```ts
test('formatSignedSek prefixes a real minus and never shows −0', () => {
  expect(formatSignedSek(-12.4)).toBe('−12 kr')
  expect(formatSignedSek(12.4)).toBe('12 kr')
  expect(formatSignedSek(-0.2)).toBe('0 kr')
})

test('formatScore is a whole percent, "—" when null', () => {
  expect(formatScore(0.724)).toMatch(/^72\s?%$/)
  expect(formatScore(null)).toBe('—')
})
```

- [ ] **Step 3: Implement the formatters** in `format.ts`:

```ts
/** Kronor with a typographic minus for a negative amount; rounds −0,2 kr to "0 kr", never "−0 kr". */
export function formatSignedSek(value: number, fractionDigits = 0): string {
  const factor = 10 ** fractionDigits
  const rounded = Math.round(value * factor) / factor
  return rounded < 0 ? `−${formatSek(-rounded, fractionDigits)}` : formatSek(Math.abs(rounded), fractionDigits)
}

/** A timing score (0…1) as a whole percent; "—" when there was nothing to compare. */
export function formatScore(score: number | null): string {
  if (score === null) return '—'
  return new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(score)
}
```

  Run: `bunx vitest run src/components/evCharging/format.test.ts` — expect PASS.

- [ ] **Step 4: Failing tiles tests** — `src/components/evCharging/EconomyTiles.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyTiles } from './EconomyTiles'

type Totals = RouterOutputs['evCharging']['economy']['tiles']
const base: Totals = {
  sessions: 3,
  included: 3,
  excluded: { noHourly: 0, noPrice: 0 },
  kwh: 60,
  actualSek: 90,
  immediateSek: 120,
  optimalSek: 70,
  dearestSek: 140,
  savedVsImmediateSek: 30,
  leftOnTableSek: 20,
  score: 0.714,
  paidSpotOre: 62.4,
  avgSpotOre: 80.2,
}

test('shows saved, left on the table, score and paid vs average spot', async () => {
  const { screen } = await renderWithProviders(<EconomyTiles tiles={base} />)
  await expect.element(screen.getByText(m.charging_economy_tile_saved())).toBeVisible()
  await expect.element(screen.getByText('30 kr')).toBeVisible()
  await expect.element(screen.getByText('20 kr')).toBeVisible()
  await expect.element(screen.getByText(/^71\s?%$/)).toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_ore({ value: '62' }))).toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_tile_spot_avg({ avg: '80' }))).toBeVisible()
})

test('a negative saving keeps its minus sign', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles tiles={{ ...base, savedVsImmediateSek: -12 }} />,
  )
  await expect.element(screen.getByText('−12 kr')).toBeVisible()
})

test('nothing included → "—" with the reason, never 0 kr or 0 %', async () => {
  const { screen } = await renderWithProviders(
    <EconomyTiles
      tiles={{
        ...base,
        included: 0,
        excluded: { noHourly: 0, noPrice: 3 },
        actualSek: 0,
        immediateSek: 0,
        optimalSek: 0,
        dearestSek: 0,
        savedVsImmediateSek: 0,
        leftOnTableSek: 0,
        score: null,
        paidSpotOre: null,
      }}
    />,
  )
  expect(screen.getByText('0 kr').elements()).toHaveLength(0)
  expect(screen.getByText(/^0\s?%$/).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_economy_tile_none()).elements().length).toBeGreaterThan(0)
})
```

- [ ] **Step 5: Implement `EconomyTiles`** — `src/components/evCharging/EconomyTiles.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOre, formatScore, formatSignedSek } from './format'

type Totals = RouterOutputs['evCharging']['economy']['tiles']

// The selected year's four headline figures. Spot timing only — the caveat
// lives in EconomyFootnote under the page. Nothing comparable (every session
// excluded) is said in words, never shown as 0 kr / 0 % (ADR-0020).
export function EconomyTiles({ tiles }: { tiles: Totals }) {
  const none = tiles.included === 0
  const items = [
    {
      label: m.charging_economy_tile_saved(),
      value: none ? null : formatSignedSek(tiles.savedVsImmediateSek),
      hint: m.charging_economy_tile_saved_hint(),
    },
    {
      label: m.charging_economy_tile_left(),
      value: none ? null : formatSignedSek(tiles.leftOnTableSek),
      hint: m.charging_economy_tile_left_hint(),
    },
    {
      label: m.charging_economy_tile_score(),
      value: none || tiles.score === null ? null : formatScore(tiles.score),
      hint: m.charging_economy_tile_score_hint(),
    },
    {
      label: m.charging_economy_tile_spot(),
      value:
        tiles.paidSpotOre === null ? null : m.charging_economy_ore({ value: formatOre(tiles.paidSpotOre) }),
      hint:
        tiles.avgSpotOre === null
          ? null
          : m.charging_economy_tile_spot_avg({ avg: formatOre(tiles.avgSpotOre) }),
    },
  ]
  // Container query like TotalsTiles: 4 across only when the column is wide.
  return (
    <div className="@container">
      <div className="grid @3xl:grid-cols-4 @md:grid-cols-2 grid-cols-1 gap-3">
        {items.map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm">{item.label}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {item.value === null ? (
                <>
                  <span className="font-semibold text-2xl tabular-nums" aria-hidden>
                    —
                  </span>
                  <span className="text-muted-foreground text-xs">{m.charging_economy_tile_none()}</span>
                </>
              ) : (
                <>
                  <span className="font-semibold text-2xl tabular-nums">{item.value}</span>
                  {item.hint ? <span className="text-muted-foreground text-xs">{item.hint}</span> : null}
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
```

  Run: `bunx vitest run --project browser src/components/evCharging/EconomyTiles.browser.test.tsx` — expect PASS.

- [ ] **Step 6: `EconomyFootnote`** — `src/components/evCharging/EconomyFootnote.tsx`:

```tsx
import { m } from '~/paraglide/messages'
import { PriceFootnote } from './PriceFootnote'

// What the economy figures mean and what they leave out (spec decisions 8–10),
// then the elpris attribution. `excluded` lists sessions left out, by reason.
export function EconomyFootnote({ excluded }: { excluded: { noHourly: number; noPrice: number } }) {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <p>{m.charging_economy_caveat()}</p>
      <p>{m.charging_economy_bucketing()}</p>
      {excluded.noHourly > 0 ? (
        <p>{m.charging_economy_excluded_no_hourly({ count: excluded.noHourly })}</p>
      ) : null}
      {excluded.noPrice > 0 ? (
        <p>{m.charging_economy_excluded_no_price({ count: excluded.noPrice })}</p>
      ) : null}
      <PriceFootnote />
    </div>
  )
}
```

- [ ] **Step 7: Route** — `src/routes/_authenticated/charging/economy.tsx`:

```tsx
import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PiggyBankIcon } from 'lucide-react'
import { useCallback } from 'react'
import { z } from 'zod'
import { ChargingHeading } from '~/components/evCharging/ChargingHeading'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { EconomyTiles } from '~/components/evCharging/EconomyTiles'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SyncHealthAlert } from '~/components/evCharging/SyncHealthAlert'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { YearSelector } from '~/components/evCharging/YearSelector'
import { PageContainer } from '~/components/layout/PageContainer'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { OVERVIEW_MAX_YEAR, OVERVIEW_MIN_YEAR } from '~/lib/evCharging/counting'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const searchSchema = z.object({
  year: z.number().int().min(OVERVIEW_MIN_YEAR).max(OVERVIEW_MAX_YEAR).optional().catch(undefined),
})

const economyQuery = (year?: number) => orpc.evCharging.economy.queryOptions({ input: { year } })
const pricesHealthQuery = orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } })

export const Route = createFileRoute('/_authenticated/charging/economy')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_economy_title(),
      description: m.meta_charging_economy_description(),
    }),
  }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ year: search.year }),
  // Prefetched, not ensured: a failed economy read shows its own alert under a
  // working heading and sync health, like /charging/patterns.
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.prefetchQuery(economyQuery(deps.year)),
      queryClient.ensureQueryData(orpc.evCharging.syncStatus.queryOptions()),
      queryClient.ensureQueryData(pricesHealthQuery),
    ])
  },
  component: EconomyPage,
})

function EconomyPage() {
  const { user } = Route.useRouteContext()
  const isAdmin = user.role === 'admin'
  const syncNow = useSyncNow()
  const { data: health } = useSuspenseQuery({
    ...orpc.evCharging.syncStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  const { data: pricesHealth } = useSuspenseQuery({ ...pricesHealthQuery, refetchInterval: 60_000 })
  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const result = useQuery({ ...economyQuery(search.year), placeholderData: keepPreviousData })
  const { data: economy, isPlaceholderData: stale } = result
  const setYear = useCallback(
    (year: number) =>
      navigate({ to: '.', search: (s) => ({ ...s, year }), replace: true, resetScroll: false }),
    [navigate],
  )
  return (
    <PageContainer>
      <ChargingHeading
        title={m.charging_economy_title()}
        lastSuccessAt={health.lastSuccessAt}
        action={isAdmin ? <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} /> : null}
      />
      <SyncHealthAlert
        health={health}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('zaptec')}
        retrying={syncNow.isPendingFor('zaptec')}
      />
      <SyncHealthAlert
        health={pricesHealth}
        isAdmin={isAdmin}
        onRetry={() => syncNow.syncSource('elpris')}
        retrying={syncNow.isPendingFor('elpris')}
      />
      {economy && !loadFailed(result) ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <YearSelector years={economy.years} value={economy.year} onChange={setYear} />
          </div>
          {economy.tiles.sessions > 0 ? (
            <div
              className={cn('flex flex-col gap-4 transition-opacity', stale && 'opacity-60')}
              aria-busy={stale}
            >
              <EconomyTiles tiles={economy.tiles} />
              {/* B2: monthly charts; B3: session table */}
              <EconomyFootnote excluded={economy.tiles.excluded} />
            </div>
          ) : (
            <Empty className="brand-wash rounded-lg border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PiggyBankIcon />
                </EmptyMedia>
                <EmptyTitle>{m.charging_economy_empty_title({ year: economy.year })}</EmptyTitle>
                <EmptyDescription>{m.charging_economy_empty_description()}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </>
      ) : (
        <LoadErrorAlert title={m.charging_economy_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
```

  Check how `/charging/index.tsx` renders the elpris `SyncHealthAlert` (prop names, whether it hides when healthy)
  and match it exactly. Replace the `{/* B2 … B3 … */}` comment in B2/B3 — it's a marker for those tasks, not
  shipped code.

- [ ] **Step 8: Navigation.** In `AppSidebar.tsx` `chargingSubItems`, append
  `{ to: '/charging/economy', label: m.nav_charging_economy_short },`. In `commands.ts`, after the
  `/charging/patterns` entry:

```ts
  {
    to: '/charging/economy',
    label: m.nav_charging_economy,
    keywords: m.cmd_kw_charging_economy,
    icon: PiggyBankIcon,
    adminOnly: false,
  },
```

  (import `PiggyBankIcon` from `lucide-react`). If a commands test enumerates entries, extend it.

- [ ] **Step 9: Verify** — `bun run typecheck && bun run check && bunx vitest run --project browser src/components/evCharging src/components/command`;
  then `bun run dev` with `ZAPTEC_ADAPTER=fake` and look at `/charging/economy` (sidebar "Ekonomi" active, year
  switch, empty year).

- [ ] **Step 10: Commit**

```bash
git add src/routes/_authenticated/charging/economy.tsx src/routeTree.gen.ts src/components messages
git commit -m "feat(charging): add the charging economy page with its tiles

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Review** — `code-reviewer` + a reviewer loading `web-design-guidelines` +
  `vercel-react-best-practices`; fix or rule on every finding.

---

### Task B2: monthly kronor chart and spot comparison chart

**Files:**
- Create: `src/components/evCharging/EconomyMonthlyChart.tsx` + `EconomyMonthlyChart.browser.test.tsx`
- Create: `src/components/evCharging/SpotComparisonChart.tsx` + `SpotComparisonChart.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/economy.tsx` (two cards replace the B2 marker)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `RouterOutputs['evCharging']['economy']['months']`; `ChartContainer` & co from `~/components/ui/chart`;
  `monthLabel`, `formatSek`, `formatOre` from `format.ts`.
- Produces: `EconomyMonthlyChart({ months })`, `SpotComparisonChart({ months })`.

- [ ] **Step 1: Messages** (sv / en): `charging_economy_chart_sek_title` "Kronor per månad" / "Kronor per month";
  `charging_economy_series_immediate` "Direkt" / "At once"; `charging_economy_series_actual` "Faktiskt" /
  "Actual"; `charging_economy_series_optimal` "Optimalt" / "Optimal"; `charging_economy_chart_spot_title`
  "Spotpris per månad" / "Spot price per month"; `charging_economy_series_paid` "Betalt" / "Paid";
  `charging_economy_series_avg` "Månadens snitt" / "Month average"; `charging_economy_chart_no_data`
  "Ingen jämförbar laddning" / "No comparable charging". Run `bun run i18n:compile`.

- [ ] **Step 2: Failing tests** — `EconomyMonthlyChart.browser.test.tsx` (model on `MonthlyChart.browser.test.tsx`,
  which counts `.recharts-bar-rectangle` paths per series):

```tsx
import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyMonthlyChart } from './EconomyMonthlyChart'

type Month = RouterOutputs['evCharging']['economy']['months'][number]
const month = (mo: number, over: Partial<Month> = {}): Month => ({
  month: mo,
  sessions: 0,
  included: 0,
  excluded: { noHourly: 0, noPrice: 0 },
  kwh: 0,
  actualSek: 0,
  immediateSek: 0,
  optimalSek: 0,
  dearestSek: 0,
  savedVsImmediateSek: 0,
  leftOnTableSek: 0,
  score: null,
  paidSpotOre: null,
  avgSpotOre: null,
  ...over,
})
const months = Array.from({ length: 12 }, (_, i) =>
  i === 8
    ? month(9, { sessions: 2, included: 2, actualSek: 90, immediateSek: 120, optimalSek: 70 })
    : month(i + 1),
)

test('draws three bar series and a legend naming them', async () => {
  const { screen } = await renderWithProviders(<EconomyMonthlyChart months={months} />)
  for (const label of [
    m.charging_economy_series_immediate(),
    m.charging_economy_series_actual(),
    m.charging_economy_series_optimal(),
  ]) {
    await expect.element(screen.getByText(label)).toBeVisible()
  }
  expect(document.querySelectorAll('.recharts-bar').length).toBe(3)
})

test('a year with nothing comparable says so instead of an empty 0 kr chart', async () => {
  const { screen } = await renderWithProviders(
    <EconomyMonthlyChart months={Array.from({ length: 12 }, (_, i) => month(i + 1))} />,
  )
  await expect.element(screen.getByText(m.charging_economy_chart_no_data())).toBeVisible()
})
```

  `SpotComparisonChart.browser.test.tsx`: same `month()` fixture (copy it); assert one `.recharts-bar` +
  one `.recharts-line`, the two legend labels, and the "no data" message when every `paidSpotOre` and `avgSpotOre`
  is null.

- [ ] **Step 3: Implement** — `EconomyMonthlyChart.tsx`:

```tsx
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatSek, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Per month: what charging at once would have cost, what we paid and the
// cheapest schedule — side by side, over the month's comparable sessions only
// (a month with none gets no bars; its tooltip-free gap is the honest state).
export function EconomyMonthlyChart({ months }: { months: Month[] }) {
  const config = {
    immediate: { label: m.charging_economy_series_immediate(), color: 'var(--chart-3)' },
    actual: { label: m.charging_economy_series_actual(), color: 'var(--chart-1)' },
    optimal: { label: m.charging_economy_series_optimal(), color: 'var(--chart-2)' },
  } satisfies ChartConfig
  if (!months.some((mo) => mo.included > 0)) return <NoData />
  const data = months.map((mo) => ({
    label: monthLabel(mo.month),
    // null (not 0): a month without comparable sessions has no bars, not 0 kr ones.
    immediate: mo.included > 0 ? mo.immediateSek : null,
    actual: mo.included > 0 ? mo.actualSek : null,
    optimal: mo.included > 0 ? mo.optimalSek : null,
  }))
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => formatSek(Number(v))} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent formatter={(value, name) => `${config[name as keyof typeof config].label} ${formatSek(Number(value))}`} />}
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar dataKey="immediate" fill="var(--color-immediate)" radius={3} isAnimationActive={false} />
        <Bar dataKey="actual" fill="var(--color-actual)" radius={3} isAnimationActive={false} />
        <Bar dataKey="optimal" fill="var(--color-optimal)" radius={3} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  )
}

export function NoData() {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-lg border px-4 text-center text-muted-foreground text-sm">
      {m.charging_economy_chart_no_data()}
    </div>
  )
}
```

  Before writing, read `MonthlyChart.tsx`'s `ChartFrame` / `CountAxis` helpers: if they're exported (or trivially
  exportable), reuse them instead of the inline `ChartContainer` / `YAxis` above so the charts match exactly.

  `SpotComparisonChart.tsx`:

```tsx
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { NoData } from './EconomyMonthlyChart'
import { formatOre, monthLabel } from './format'

type Month = RouterOutputs['evCharging']['economy']['months'][number]

// Spot we paid (energy-weighted, comparable sessions) vs the month's
// time-weighted average spot, both öre/kWh incl VAT. Below the line = we
// charged in cheaper-than-average hours.
export function SpotComparisonChart({ months }: { months: Month[] }) {
  const config = {
    paid: { label: m.charging_economy_series_paid(), color: 'var(--chart-1)' },
    avg: { label: m.charging_economy_series_avg(), color: 'var(--chart-4)' },
  } satisfies ChartConfig
  if (!months.some((mo) => mo.paidSpotOre !== null || mo.avgSpotOre !== null)) return <NoData />
  const data = months.map((mo) => ({ label: monthLabel(mo.month), paid: mo.paidSpotOre, avg: mo.avgSpotOre }))
  return (
    <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v) => formatOre(Number(v))} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent formatter={(value, name) => `${config[name as keyof typeof config].label} ${m.charging_economy_ore({ value: formatOre(Number(value)) })}`} />}
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar dataKey="paid" fill="var(--color-paid)" radius={3} isAnimationActive={false} />
        <Line
          dataKey="avg"
          type="monotone"
          stroke="var(--color-avg)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  )
}
```

- [ ] **Step 4: Wire into the page** — replace the B2 marker in `economy.tsx` with two `<section>` cards (same
  `Card` / `CardHeader` / `<h2 className="font-medium text-sm">` shape and `useId` labelling as
  `/charging/patterns`): "Kronor per månad" → `<EconomyMonthlyChart months={economy.months} />`, "Spotpris per
  månad" → `<SpotComparisonChart months={economy.months} />`.

- [ ] **Step 5: Run — expect PASS**: `bunx vitest run --project browser src/components/evCharging && bun run typecheck && bun run check`

- [ ] **Step 6: Commit** — `feat(charging): chart charging economy per month` (with the Co-Authored-By trailer).

- [ ] **Step 7: Review** — `code-reviewer` + UI reviewer (`web-design-guidelines` + `vercel-react-best-practices`).

---

### Task B3: economy session table (+ router-aware test render)

**Files:**
- Modify: `test/browser/render.tsx` (add `renderWithRouter`), `test/browser/render.browser.test.tsx`
- Create: `src/components/evCharging/EconomySessionTable.tsx` + `EconomySessionTable.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/economy.tsx` (table card replaces the B3 marker)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `RouterOutputs['evCharging']['economy']['sessions']`; `formatDate`, `formatTime`, `formatOneDecimal`,
  `formatSek`, `formatSignedSek`, `formatScore`.
- Produces: `renderWithRouter(ui, options?)`; `EconomySessionTable({ sessions })`. The date cell is plain
  text in B3; C1 turns it into a link once `/charging/sessions/$sessionId` exists (a `<Link>` to a route that
  doesn't exist yet fails typecheck).

- [ ] **Step 1: `renderWithRouter`** — append to `test/browser/render.tsx`:

```tsx
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

// Like renderWithProviders, inside a memory-history router so <Link> and
// route hooks work. The ui renders as the root route's component at
// `initialPath`; hrefs are built as in the app (paths aren't matched).
export async function renderWithRouter(
  ui: ReactNode,
  { queryClient = makeTestQueryClient(), initialPath = '/' }: RenderOptions & { initialPath?: string } = {},
) {
  const rootRoute = createRootRoute({ component: () => ui })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, queryClient, router }
}
```

  and a test in `render.browser.test.tsx`: render `<Link to="/charging/economy">x</Link>` and assert the anchor's
  `href` is `/charging/economy`. Update the file comment ("out of scope for v1") to point at `renderWithRouter`.
  Run it — expect PASS.

- [ ] **Step 2: Messages** (sv / en): `charging_economy_sessions_title` "Sessioner" / "Sessions";
  `charging_economy_col_date` "Datum" / "Date"; `charging_economy_col_energy` "Energi" / "Energy";
  `charging_economy_col_actual` "Kostnad" / "Cost"; `charging_economy_col_vs_immediate` "Mot direkt" /
  "Vs at once"; `charging_economy_col_left` "Kvar" / "Left"; `charging_economy_col_score` "Tajming" / "Timing";
  `charging_economy_reason_no_hourly` "ingen timdata" / "no hourly data"; `charging_economy_reason_no_price`
  "pris saknas" / "price missing". Run `bun run i18n:compile`.

- [ ] **Step 3: Failing tests** — `EconomySessionTable.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { EconomySessionTable } from './EconomySessionTable'

type Row = RouterOutputs['evCharging']['economy']['sessions'][number]
const cost = (totalSek: number) => ({ ...emptyTotals(), kwh: 10, gridKwh: 10, fullKwh: 10, totalSek })
const row = (over: Partial<Row> = {}): Row => ({
  sessionId: '11111111-1111-4111-8111-111111111111',
  startAt: new Date('2026-09-05T19:10:00Z'),
  endAt: new Date('2026-09-06T05:02:00Z'),
  kwh: 32.1,
  actual: cost(41.2),
  actualComplete: true,
  paidSpotOre: 40,
  windowAvgSpotOre: 55,
  excluded: null,
  counterfactual: {
    immediate: cost(53.6),
    optimal: cost(38),
    dearest: cost(70),
    score: 0.9,
    savedVsImmediateSek: 12.4,
    leftOnTableSek: 3.2,
  },
  ...over,
})

test('a comparable session shows cost, vs at once, left and timing', async () => {
  const { screen } = await renderWithRouter(<EconomySessionTable sessions={[row()]} />)
  await expect.element(screen.getByText('41,20 kr')).toBeVisible()
  await expect.element(screen.getByText('12,40 kr')).toBeVisible()
  await expect.element(screen.getByText('3,20 kr')).toBeVisible()
  await expect.element(screen.getByText(/^90\s?%$/)).toBeVisible()
})

test('an excluded session shows its actual cost and "—" with the reason for the rest', async () => {
  const { screen } = await renderWithRouter(
    <EconomySessionTable sessions={[row({ excluded: 'no_price', counterfactual: null })]} />,
  )
  await expect.element(screen.getByText('41,20 kr')).toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_reason_no_price())).toBeVisible()
})

test('on a phone the comparison columns fold under the date', async () => {
  const { screen } = await renderWithRouter(<EconomySessionTable sessions={[row()]} />)
  await page.viewport(375, 800) // from '@vitest/browser/context'
  expect(screen.getByRole('columnheader', { name: m.charging_economy_col_left() }).element()).not.toBeVisible()
  await expect.element(screen.getByText(/12,40 kr/).first()).toBeVisible()
})
```

  (`import { page } from '@vitest/browser/context'` — check how `SessionList.browser.test.tsx` resizes for its
  "on a phone" test and use the same call.)

- [ ] **Step 4: Implement** — `EconomySessionTable.tsx`:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate, formatOneDecimal, formatScore, formatSek, formatSignedSek, formatTime } from './format'

type Row = RouterOutputs['evCharging']['economy']['sessions'][number]

const reason = (r: Row) =>
  r.excluded === 'no_hourly' ? m.charging_economy_reason_no_hourly() : m.charging_economy_reason_no_price()

// The selected year's sessions, newest first (~100/yr → no paging). Excluded
// sessions keep their actual cost (it's real) and say why the comparison is
// missing. < sm the comparison folds under the date, like SessionList.
export function EconomySessionTable({ sessions }: { sessions: Row[] }) {
  return (
    <div className="rounded-lg border bg-surface-raised">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m.charging_economy_col_date()}</TableHead>
            <TableHead className="text-right">{m.charging_economy_col_energy()}</TableHead>
            <TableHead className="text-right">{m.charging_economy_col_actual()}</TableHead>
            <TableHead className="hidden text-right sm:table-cell">{m.charging_economy_col_vs_immediate()}</TableHead>
            <TableHead className="hidden text-right sm:table-cell">{m.charging_economy_col_left()}</TableHead>
            <TableHead className="hidden text-right sm:table-cell">{m.charging_economy_col_score()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((r) => {
            const cf = r.counterfactual
            return (
              <TableRow key={r.sessionId}>
                <TableCell className="whitespace-nowrap">
                  <SessionDate row={r} />
                  <div className="text-muted-foreground text-xs tabular-nums">
                    {formatTime(r.startAt)}–{formatTime(r.endAt)}
                  </div>
                  <div className="text-muted-foreground text-xs tabular-nums sm:hidden">
                    {cf
                      ? `${formatSignedSek(cf.savedVsImmediateSek, 2)} · ${formatSignedSek(cf.leftOnTableSek, 2)} · ${formatScore(cf.score)}`
                      : reason(r)}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {formatOneDecimal(r.kwh)} kWh
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {r.actualComplete ? formatSek(r.actual.totalSek, 2) : '—'}
                </TableCell>
                {cf ? (
                  <>
                    <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                      {formatSignedSek(cf.savedVsImmediateSek, 2)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                      {formatSignedSek(cf.leftOnTableSek, 2)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">
                      {formatScore(cf.score)}
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={3} className="hidden text-right text-muted-foreground text-xs sm:table-cell">
                    — {reason(r)}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// C1 turns this into a link to the session page.
function SessionDate({ row }: { row: Row }) {
  return <span>{formatDate(row.startAt)}</span>
}
```

- [ ] **Step 5: Wire into the page** — replace the B3 marker with a `Sessioner` card holding
  `<EconomySessionTable sessions={economy.sessions} />`.

- [ ] **Step 6: Run — expect PASS**: `bunx vitest run --project browser test/browser src/components/evCharging && bun run typecheck && bun run check`

- [ ] **Step 7: Commit** — `feat(charging): list charging economy per session` (with trailer).

- [ ] **Step 8: Review** — `code-reviewer` + UI reviewer.

- [ ] **Step 9: PR B** — branch review; pre-PR gate incl. live check at desktop / tablet / mobile with
  `ZAPTEC_ADAPTER=fake` + locally synced elpris prices + a tariff entered at `/charging`; open PR B.

---

## PR C — session page (`feat/charging-session-page`)

### Task C1: `/charging/sessions/$sessionId` — route, header, figures, not-found, row links

**Files:**
- Create: `src/routes/_authenticated/charging/sessions/$sessionId.tsx` (+ regenerated `routeTree.gen.ts`)
- Create: `src/components/evCharging/SessionEconomyFigures.tsx` + `.browser.test.tsx`
- Modify: `src/components/evCharging/EconomySessionTable.tsx` (`SessionDate` → `<Link>`)
- Modify: `src/components/evCharging/SessionList.tsx` (date cell → `<Link>`) + its browser test (switch to
  `renderWithRouter`)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `orpc.evCharging.session`, `RouterOutputs['evCharging']['session']`; `isDefinedError` from
  `@orpc/client`; `notFound` from `@tanstack/react-router`.
- Produces: route `/charging/sessions/$sessionId`; `SessionEconomyFigures({ economy })`.

- [ ] **Step 1: Messages** (sv / en): `meta_charging_session_title` "Laddsession" / "Charging session";
  `meta_charging_session_description` "En laddsession: energi, spotpris och vad den kunde ha kostat." / "One
  charging session: energy, spot price and what it could have cost."; `charging_session_back` "Tillbaka" / "Back";
  `charging_session_summary` "{kwh} kWh · topp {peak} kW" / "{kwh} kWh · peak {peak} kW";
  `charging_session_fig_actual` "Kostade" / "Cost"; `charging_session_fig_immediate` "Direkt vid inkoppling" /
  "Charged at plug-in"; `charging_session_fig_optimal` "Billigast möjligt" / "Cheapest possible";
  `charging_session_fig_score` "Pristajming" / "Price timing"; `charging_session_excluded_no_hourly`
  "Sessionen saknar timdata, så den kan inte jämföras med andra laddtider." / "…no hourly data, so it can't be
  compared with other charging times."; `charging_session_excluded_no_price` "Spotpris eller tariff saknas för
  delar av inkopplingen, så sessionen kan inte jämföras." / "…";
  `charging_session_error_title` "Kunde inte läsa sessionen" / "Couldn't load the session";
  `charging_session_link_label` "Visa session {date}" / "Show session {date}". Compile.

- [ ] **Step 2: Failing figures tests** — `SessionEconomyFigures.browser.test.tsx`: an included economy renders
  the four figures (actual 41,20 kr, immediate 53,60 kr, optimal 38,00 kr, 90 %); an excluded one (`no_hourly`)
  renders only `charging_session_excluded_no_hourly` and the actual cost; score `null` renders "—". Use the `row()`
  fixture shape from `EconomySessionTable.browser.test.tsx` (copy its `cost()` helper).

- [ ] **Step 3: Implement `SessionEconomyFigures`**:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatScore, formatSek } from './format'

type Economy = RouterOutputs['evCharging']['session']['economy']

export function SessionEconomyFigures({ economy }: { economy: Economy }) {
  const cf = economy.counterfactual
  const actual = economy.actualComplete ? formatSek(economy.actual.totalSek, 2) : '—'
  const items = cf
    ? [
        { label: m.charging_session_fig_actual(), value: actual },
        { label: m.charging_session_fig_immediate(), value: formatSek(cf.immediate.totalSek, 2) },
        { label: m.charging_session_fig_optimal(), value: formatSek(cf.optimal.totalSek, 2) },
        { label: m.charging_session_fig_score(), value: formatScore(cf.score) },
      ]
    : [{ label: m.charging_session_fig_actual(), value: actual }]
  return (
    <div className="flex flex-col gap-3">
      <div className="@container">
        <div className="grid @2xl:grid-cols-4 grid-cols-2 gap-3">
          {items.map((item) => (
            <Card key={item.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-sm">{item.label}</CardTitle>
              </CardHeader>
              <CardContent className="font-semibold text-2xl tabular-nums">{item.value}</CardContent>
            </Card>
          ))}
        </div>
      </div>
      {economy.excluded ? (
        <p className="rounded-lg border px-4 py-3 text-muted-foreground text-sm">
          {economy.excluded === 'no_hourly'
            ? m.charging_session_excluded_no_hourly()
            : m.charging_session_excluded_no_price()}
        </p>
      ) : null}
    </div>
  )
}
```

  Run the test — expect PASS.

- [ ] **Step 4: Route** — `src/routes/_authenticated/charging/sessions/$sessionId.tsx`:

```tsx
import { isDefinedError } from '@orpc/client'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { z } from 'zod'
import { EconomyFootnote } from '~/components/evCharging/EconomyFootnote'
import { formatOneDecimal, formatTime, formatWeekdayDay } from '~/components/evCharging/format'
import { LoadErrorAlert, loadFailed } from '~/components/evCharging/LoadErrorAlert'
import { SessionEconomyFigures } from '~/components/evCharging/SessionEconomyFigures'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const sessionQuery = (sessionId: string) => orpc.evCharging.session.queryOptions({ input: { sessionId } })

export const Route = createFileRoute('/_authenticated/charging/sessions/$sessionId')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_session_title(),
      description: m.meta_charging_session_description(),
    }),
  }),
  // Unknown, uncounted or malformed ids are "not found" (the root NotFound);
  // any other failure is left to the page's load-error alert.
  loader: async ({ context: { queryClient }, params }) => {
    if (!z.uuid().safeParse(params.sessionId).success) throw notFound()
    try {
      await queryClient.ensureQueryData(sessionQuery(params.sessionId))
    } catch (err) {
      if (isDefinedError(err) && err.code === 'EV_SESSION_NOT_FOUND') throw notFound()
    }
  },
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const result = useQuery(sessionQuery(sessionId))
  const detail = result.data
  return (
    <PageContainer>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          {/* History back would leave the app on a deep link; the overview is the section's home. */}
          <Link to="/charging">
            <ArrowLeftIcon />
            {m.charging_session_back()}
          </Link>
        </Button>
      </div>
      {detail && !loadFailed(result) ? (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
              {formatWeekdayDay(detail.session.startAt)} · {formatTime(detail.session.startAt)}–
              {formatTime(detail.session.endAt)}
            </h1>
            <p className="text-muted-foreground text-sm">
              {m.charging_session_summary({
                kwh: formatOneDecimal(detail.session.kwh),
                peak: detail.session.peakKw === null ? '—' : formatOneDecimal(detail.session.peakKw),
              })}
            </p>
          </header>
          <SessionEconomyFigures economy={detail.economy} />
          {/* C2: SessionPriceChart */}
          <EconomyFootnote excluded={{ noHourly: 0, noPrice: 0 }} />
        </>
      ) : (
        <LoadErrorAlert title={m.charging_session_error_title()} query={result} />
      )}
    </PageContainer>
  )
}
```

  The sidebar needs no change: "Laddning" matches `/charging/sessions/…` with `fuzzy: true`; no sub-item is exact.

- [ ] **Step 5: Links from both lists.** In `EconomySessionTable.tsx` replace `SessionDate` with:

```tsx
function SessionDate({ row }: { row: Row }) {
  return (
    <Link
      to="/charging/sessions/$sessionId"
      params={{ sessionId: row.sessionId }}
      className="font-medium underline-offset-4 hover:underline"
    >
      {formatDate(row.startAt)}
    </Link>
  )
}
```

  In `SessionList.tsx` wrap `{formatDate(s.startAt)}` in the same `<Link … params={{ sessionId: s.id }}>`. Switch
  `SessionList.browser.test.tsx` and `EconomySessionTable.browser.test.tsx` renders to `renderWithRouter` (the
  latter already uses it), and add one assertion each: the date is a link whose `href` is
  `/charging/sessions/<id>`. Re-run the screenshot tests; update baselines only if the only diff is the link
  styling.

- [ ] **Step 6: Verify not-found live** — `bun run dev`, open `/charging/sessions/nope` and
  `/charging/sessions/00000000-0000-4000-8000-000000000000` → the app's NotFound page, no console error.

- [ ] **Step 7: Run & commit** — `bunx vitest run --project browser src/components/evCharging && bun run typecheck && bun run check`;
  commit `feat(charging): add a charging session page` (with trailer).

- [ ] **Step 8: Review** — `code-reviewer` + UI reviewer.

---

### Task C2: `SessionPriceChart` (visx) with a table fallback

**Files:**
- Create: `src/components/evCharging/SessionPriceChart.tsx` + `SessionPriceChart.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/sessions/$sessionId.tsx` (chart card replaces the C2 marker)
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `RouterOutputs['evCharging']['session']` (`window`, `intervals`, `prices`, `optimalSchedule`);
  `@visx/{axis,group,responsive,shape,tooltip}`, `d3-scale` `scaleTime` / `scaleLinear`, `d3-array` `max`,
  `formatTime`, `formatOneDecimal`, `formatOre`.
- Produces: `SessionPriceChart({ detail })`.

- [ ] **Step 1: Messages** (sv / en): `charging_session_chart_title` "Energi och spotpris" / "Energy and spot price";
  `charging_session_chart_actual` "Laddat" / "Charged"; `charging_session_chart_optimal` "Billigaste schemat" /
  "Cheapest schedule"; `charging_session_chart_spot` "Spotpris inkl. moms" / "Spot price incl. VAT";
  `charging_session_chart_show_optimal` "Visa billigaste schemat" / "Show cheapest schedule";
  `charging_session_chart_tooltip` "{from}–{to} · {kwh} kWh · {ore} öre" / same;
  `charging_session_chart_table_caption` "Energi och spotpris per intervall" / "Energy and spot price per interval";
  `charging_session_chart_col_time` "Tid" / "Time"; `charging_session_chart_col_kwh` "kWh";
  `charging_session_chart_col_ore` "öre/kWh". Compile.

- [ ] **Step 2: Failing tests** — `SessionPriceChart.browser.test.tsx`, with a fixture detail over
  08:00Z–10:00Z: two intervals (10 kWh, 0 kWh), 16 price slots 07:00Z–11:00Z (`spotOre` 375 for 08:00–09:00, else
  125, one slot `null`), `optimalSchedule` of four quarters 09:00–10:00:

```tsx
test('draws a bar per charged interval, ghost bars for the optimal schedule and a stepped price line', async () => {
  const { screen } = await renderWithProviders(<SessionPriceChart detail={detail} />)
  await expect.element(screen.getByText(m.charging_session_chart_title())).toBeVisible()
  expect(document.querySelectorAll('[data-series="actual"]')).toHaveLength(1) // the 0-kWh hour draws nothing
  expect(document.querySelectorAll('[data-series="optimal"]')).toHaveLength(4)
  expect(document.querySelectorAll('[data-series="spot"]')).toHaveLength(1)
})

test('the optimal schedule can be hidden', async () => {
  const { screen } = await renderWithProviders(<SessionPriceChart detail={detail} />)
  await screen.getByRole('checkbox', { name: m.charging_session_chart_show_optimal() }).click()
  expect(document.querySelectorAll('[data-series="optimal"]')).toHaveLength(0)
})

test('exposes the same data as a screen-reader table', async () => {
  const { screen } = await renderWithProviders(<SessionPriceChart detail={detail} />)
  expect(screen.getByRole('table', { name: m.charging_session_chart_table_caption() }).element()).toBeTruthy()
  expect(screen.getByRole('row').elements().length).toBe(1 + 16)
})

test('an excluded session without an optimal schedule shows no toggle', async () => {
  const { screen } = await renderWithProviders(
    <SessionPriceChart detail={{ ...detail, optimalSchedule: null }} />,
  )
  expect(screen.getByRole('checkbox').elements()).toHaveLength(0)
})
```

- [ ] **Step 3: Implement** — `SessionPriceChart.tsx`:

```tsx
import { AxisBottom, AxisLeft, AxisRight } from '@visx/axis'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { Bar, LinePath } from '@visx/shape'
import { TooltipWithBounds, useTooltip } from '@visx/tooltip'
import { max } from 'd3-array'
import { scaleLinear, scaleTime } from 'd3-scale'
import { curveStepAfter } from '@visx/curve'
import { useId, useMemo, useState } from 'react'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatOneDecimal, formatOre, formatTime } from './format'

type Detail = RouterOutputs['evCharging']['session']
const HEIGHT = 260
const MARGIN = { top: 12, right: 44, bottom: 28, left: 40 }
const HOUR_MS = 3_600_000

// A session's hourly energy (bars at their true times) against the 15-min
// spot price (a step line), with the cheapest schedule as outlined ghost bars.
// Mixed resolution needs a real time axis, hence visx + d3-scale rather than
// Recharts' category axis. Outside the plug-in window is shaded.
export function SessionPriceChart({ detail }: { detail: Detail }) {
  const { parentRef, width } = useParentSize({ debounceTime: 100 })
  const [showOptimal, setShowOptimal] = useState(true)
  const toggleId = useId()
  const captionId = useId()
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<{
    startMs: number
    endMs: number
    kwh: number | null
    ore: number | null
  }>()
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right)
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom
  const domainStart = Math.min(detail.window.startMs - HOUR_MS, detail.prices[0]?.startMs ?? Infinity)
  const domainEnd = Math.max(detail.window.endMs + HOUR_MS, detail.prices.at(-1)?.endMs ?? -Infinity)
  const x = useMemo(
    () => scaleTime().domain([domainStart, domainEnd]).range([0, innerW]),
    [domainStart, domainEnd, innerW],
  )
  // kWh as average kW over the bar, so an hour and a quarter compare fairly.
  const kw = (iv: { startMs: number; endMs: number; kwh: number }) => (iv.kwh / (iv.endMs - iv.startMs)) * HOUR_MS
  const optimal = detail.optimalSchedule ?? []
  const yKw = scaleLinear()
    .domain([0, Math.max(1, max([...detail.intervals, ...optimal], kw) ?? 0)])
    .nice()
    .range([innerH, 0])
  const ores = detail.prices.flatMap((p) => (p.spotOre === null ? [] : [p.spotOre]))
  const yOre = scaleLinear()
    .domain([Math.min(0, ...ores), Math.max(1, ...ores)])
    .nice()
    .range([innerH, 0])
  const ticks = width < 480 ? 4 : 8
  // Step line: each slot's price from its start, holding to its end.
  const steps = detail.prices.flatMap((p) =>
    p.spotOre === null ? [] : [{ t: p.startMs, v: p.spotOre }, { t: p.endMs, v: p.spotOre }],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-sm">{m.charging_session_chart_title()}</h2>
        {detail.optimalSchedule ? (
          <div className="flex items-center gap-2">
            <Checkbox id={toggleId} checked={showOptimal} onCheckedChange={(v) => setShowOptimal(v === true)} />
            <Label htmlFor={toggleId} className="text-sm">
              {m.charging_session_chart_show_optimal()}
            </Label>
          </div>
        ) : null}
      </div>
      <div ref={parentRef} className="relative w-full" style={{ height: HEIGHT }}>
        {width > 0 ? (
          <svg width={width} height={HEIGHT} role="img" aria-labelledby={captionId}>
            <Group left={MARGIN.left} top={MARGIN.top}>
              {/* Outside the plug-in window. */}
              <Bar x={0} y={0} width={Math.max(0, x(detail.window.startMs))} height={innerH} style={{ fill: 'var(--muted)' }} opacity={0.5} />
              <Bar x={x(detail.window.endMs)} y={0} width={Math.max(0, innerW - x(detail.window.endMs))} height={innerH} style={{ fill: 'var(--muted)' }} opacity={0.5} />
              {detail.intervals.filter((iv) => iv.kwh > 0).map((iv) => (
                <Bar
                  key={`a${iv.startMs}`}
                  data-series="actual"
                  x={x(iv.startMs)}
                  y={yKw(kw(iv))}
                  width={Math.max(1, x(iv.endMs) - x(iv.startMs) - 1)}
                  height={innerH - yKw(kw(iv))}
                  style={{ fill: 'var(--chart-1)' }}
                  rx={2}
                />
              ))}
              {showOptimal
                ? optimal.map((iv) => (
                    <Bar
                      key={`o${iv.startMs}`}
                      data-series="optimal"
                      x={x(iv.startMs)}
                      y={yKw(kw(iv))}
                      width={Math.max(1, x(iv.endMs) - x(iv.startMs) - 1)}
                      height={innerH - yKw(kw(iv))}
                      style={{ fill: 'none', stroke: 'var(--chart-2)', strokeDasharray: '4 2' }}
                      strokeWidth={1.5}
                    />
                  ))
                : null}
              <LinePath
                data-series="spot"
                data={steps}
                x={(d) => x(d.t)}
                y={(d) => yOre(d.v)}
                curve={curveStepAfter}
                style={{ stroke: 'var(--chart-4)' }}
                strokeWidth={2}
              />
              {/* Hover/focus targets, one per price slot. */}
              {detail.prices.map((p) => {
                const iv = detail.intervals.find((i) => i.startMs < p.endMs && i.endMs > p.startMs)
                return (
                  <rect
                    key={`h${p.startMs}`}
                    x={x(p.startMs)}
                    y={0}
                    width={Math.max(1, x(p.endMs) - x(p.startMs))}
                    height={innerH}
                    fill="transparent"
                    onMouseMove={() =>
                      showTooltip({
                        tooltipData: { startMs: p.startMs, endMs: p.endMs, kwh: iv ? iv.kwh : null, ore: p.spotOre },
                        tooltipLeft: MARGIN.left + x(p.startMs),
                        tooltipTop: MARGIN.top,
                      })
                    }
                    onMouseLeave={hideTooltip}
                  />
                )
              })}
              <AxisBottom top={innerH} scale={x} numTicks={ticks} tickFormat={(d) => formatTime(new Date(Number(d)))} stroke="var(--border)" tickStroke="var(--border)" tickLabelProps={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
              <AxisLeft scale={yKw} numTicks={4} tickFormat={(v) => `${formatOneDecimal(Number(v))}`} stroke="var(--border)" tickStroke="var(--border)" tickLabelProps={{ fill: 'var(--muted-foreground)', fontSize: 11 }} label="kW" />
              <AxisRight left={innerW} scale={yOre} numTicks={4} tickFormat={(v) => formatOre(Number(v))} stroke="var(--border)" tickStroke="var(--border)" tickLabelProps={{ fill: 'var(--muted-foreground)', fontSize: 11 }} label="öre" />
            </Group>
          </svg>
        ) : null}
        {tooltipData ? (
          <TooltipWithBounds left={tooltipLeft} top={tooltipTop} className="text-xs">
            {m.charging_session_chart_tooltip({
              from: formatTime(new Date(tooltipData.startMs)),
              to: formatTime(new Date(tooltipData.endMs)),
              kwh: tooltipData.kwh === null ? '—' : formatOneDecimal(tooltipData.kwh),
              ore: tooltipData.ore === null ? '—' : formatOre(tooltipData.ore),
            })}
          </TooltipWithBounds>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <li><span className="mr-1 inline-block size-2.5 rounded-sm" style={{ background: 'var(--chart-1)' }} />{m.charging_session_chart_actual()}</li>
        {detail.optimalSchedule ? (
          <li><span className="mr-1 inline-block size-2.5 rounded-sm border border-dashed" style={{ borderColor: 'var(--chart-2)' }} />{m.charging_session_chart_optimal()}</li>
        ) : null}
        <li><span className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: 'var(--chart-4)' }} />{m.charging_session_chart_spot()}</li>
      </ul>
      <table className="sr-only">
        <caption id={captionId}>{m.charging_session_chart_table_caption()}</caption>
        <thead>
          <tr>
            <th>{m.charging_session_chart_col_time()}</th>
            <th>{m.charging_session_chart_col_kwh()}</th>
            <th>{m.charging_session_chart_col_ore()}</th>
          </tr>
        </thead>
        <tbody>
          {detail.prices.map((p) => {
            const iv = detail.intervals.find((i) => i.startMs <= p.startMs && i.endMs > p.startMs)
            return (
              <tr key={p.startMs}>
                <td>{formatTime(new Date(p.startMs))}–{formatTime(new Date(p.endMs))}</td>
                <td>{iv ? formatOneDecimal((iv.kwh * (p.endMs - p.startMs)) / (iv.endMs - iv.startMs)) : '—'}</td>
                <td>{p.spotOre === null ? '—' : formatOre(p.spotOre)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

  Before writing: confirm `@visx/curve` is installed (it is a dependency of `@visx/shape`; if it isn't resolvable
  directly, `bun add @visx/curve@4.0.0` — same version family); confirm `checkbox` and `label` exist under
  `src/components/ui/` (else `bunx shadcn@latest add checkbox label`). Read `SessionTimeline.tsx` for this repo's
  visx conventions (SVG fills via `style`, tooltip usage, `useParentSize`) and follow them where they differ from
  the sketch above. The `aria-labelledby` of the `<svg>` points at the table caption; keyboard users read the
  table, so the hover targets need no focus stops.

- [ ] **Step 4: Wire into the page** — replace the C2 marker with a `Card` holding
  `<SessionPriceChart detail={detail} />`.

- [ ] **Step 5: Run — expect PASS**: `bunx vitest run --project browser src/components/evCharging && bun run typecheck && bun run check`

- [ ] **Step 6: Commit** — `feat(charging): chart a session's energy against the spot price` (with trailer).

- [ ] **Step 7: Review** — `code-reviewer` + UI reviewer.

- [ ] **Step 8: PR C** — branch review; pre-PR gate incl. live check (desktop / tablet / mobile; a session from
  `/charging` and from `/charging/economy`; an excluded session; not-found URLs); open PR C.

---

## Self-review notes (spec coverage)

- Decisions 1–13 → A1 (2–4, 12), A2 (5, 6, 7, 8), A4 (9, 12), B1 footnote (10 and the solar caveat), B1/C1 (11),
  A5 (13). The spec's `schedules` per session and generic `NOT_FOUND` changed deliberately — see Deviations 2 and 4.
- Spec "Testing" bullets → A1/A2 pure tests (incl. the seeded invariant), A3 (`EV_SESSION_NOT_FOUND` unknown +
  voided + noise), A4 (window slots, parity, filter, excluded), A5 (bounds, auth, 404), B1–C2 component tests,
  `clientSafe` (A2).
