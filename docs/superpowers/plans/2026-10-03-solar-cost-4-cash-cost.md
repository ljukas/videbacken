# Solar-aware cost, step 4 — Cash cost uses the mix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price every counted charging session with its stored grid / solar / battery mix, so `/charging` shows
what charging really cost in cash (tiles, monthly chart, session list, session hero) with a "N % från sol och
batteri" subline and a grid / solar / battery bar, while the economy views stay grid-only and say so.

**Architecture:** Pricing stays on read (ADR-0020). The pure math in `src/lib/evCharging/cost/priceIntervals.ts`
gains an optional per-piece `mix` (`PieceMix`) and new `CostTotals` fields. `costInputs.toIntervals(session, mix?)`
turns a session's stored mix (step 3's `energyMix.listForSessions`) into 15-min pieces behind a read-time Σ kWh
guard; without a usable mix the session stays all-grid, labelled "no house data". `costing.ts` loads the mix (and the
first house-data instant) beside the slots; `chargingEconomy.getSessionEconomy` adds the session's cash `cost`
while its `economy` stays grid-only. No schema change.

**Tech Stack:** TanStack Start, oRPC, Drizzle (pg) through services, React 19 + shadcn/Radix + Tailwind v4,
Paraglide, Vitest (node + browser), Biome.

**Spec:** `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md` ("Cost and display", step 4)
· **ADR:** `docs/adr/0023-solar-aware-charging-cost.md` · **Roadmap:** step 4 of
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`
· **Contract:** step 4 + Amendment A (`solarPricedKwh` / `solarUnpricedKwh`).

**Branch:** `feat/charging-solar-cash-cost` · **PR title:** `feat(charging): price charging with solar and battery`

## Decisions this plan makes (record them in the spec in Task 9)

1. **All-grid fallback is labelled.** A session without a usable mix is priced exactly as before (all bought, at
   the slot spot + fees) but its pieces carry `mix = { noHouseDataKwh: kwh, … 0 }`, so `noHouseDataKwh` counts it and
   the UI can say "no house data" instead of silently showing an upper bound (spec Success bullet 3). The guard
   warns only when a mix exists but no longer matches; a missing mix is normal (not derived yet, Emaldo down).
2. **`avgOre` becomes the cash öre per charged kWh**: `totalSek / (fullKwh + (kwh − gridKwh))` — own solar is in
   the denominator at 0 kr. Still `null` when `fullKwh` is 0. Identical to today for all-grid energy.
3. **`gridKwh` keeps its name but means "bought kWh"**: grid + no-house-data + battery-from-grid +
   battery-of-unknown-price. `isComplete` is unchanged (`|gridKwh − fullKwh| ≤ 1e-6`), so battery-of-unknown-price
   makes a total "minst …" (tiles) / "—" (a session), per spec.
4. **Month bucketing of mix pieces follows the piece's own Zaptec interval** (the interval it starts in, or the
   first one), so cost months keep matching the kWh overview's months (an interval-less session stays whole in its
   start month).
5. **"The cost notice says what's included" = the cost note under the figures** (`PriceFootnote`, which today says
   "All laddning räknas som köpt från elnätet"), made dynamic on the overview: "Sol och batteri räknas från
   {date}. Laddning utan husdata räknas som köpt från elnätet." The `CostNotice` alert keeps its job (why no cost is
   shown at all). `{date}` = `houseEnergy.firstReadingAt()` exposed as `CostOverview.houseDataFrom`.
6. **The session hero is `detail.cost`** (a new `CostSummary` on the `session` procedure's output); the verdict,
   range bar and what-if tiles move under an `<h2>` "Pristajming som om all el köptes från elnätet" in the same card
   and keep using the grid-only `economy.actual`.

## Contract deviations

- `CostTotals` also gets `solarPricedKwh` / `solarUnpricedKwh` (Amendment A — not a deviation, listed for clarity).
- `CostTimings` gains `houseFromMs` (→ `costHouseFromMs`) beside `mixMs`; `EconomyTimings` gains `mixMs`
  (→ `economyMixMs` on the `session` procedure). The procedure needs no forwarding code: `recordPrefixedTimings`
  already prefixes every key.
- `CostOverview` gains `houseDataFrom: Date | null`; `SessionEconomyDetail` gains `cost: CostSummary`.

## Global Constraints

- Pricing on read only; nothing kronor-shaped is stored (ADR-0020/0023). Spot and stored battery spots are SEK/kWh
  **ex VAT**; cash = (spot + fees) × (1 + VAT); solar value = kWh × spot, **ex VAT, no fees**.
- Battery-from-grid takes the **fees of the day it is used** (`tariffAt(stockholmDayOf(piece.startMs))`).
- Missing data is never 0 kr: no slot spot → `noPriceKwh` (bought) / `solarUnpricedKwh` (solar); battery of unknown
  price → `noPriceKwh`; no tariff → `noTariffKwh`.
- Read-time guard: |Σ mix `kwh` − Σ session stretch kWh| > **1e-6 kWh** → ignore the mix, all-grid + one
  `logger.warn('cost: energy mix ignored, kWh differs from the session', { sessionId, mixKwh, energyKwh })`.
- Mix slots are UTC quarter-hours, **15 min** long.
- Economy (`src/lib/evCharging/economy/`) keeps `gridShare: 1`; only comments change.
- All DB access through services (`~/lib/services/energyMix`, `~/lib/services/houseEnergy`); client code imports
  only types from services and only `type MixSlot` from `~/lib/houseEnergy/mix/carMix` in the cost math.
- New RPC work is timed: `mixMs`, `houseFromMs` (CostTimings), `mixMs` (EconomyTimings).
- Never `console.*`; server logging via `logger` from `~/lib/logger/server`.
- All copy in `messages/sv.json` (source of truth) and `messages/en.json` (key-complete); run
  `bun run i18n:compile` after editing them.
- **Never commit real household readings or real cost figures from them.** Tests and PR screenshots use synthetic
  data only (the repo is public).
- Responsive at 360 / 820 / 1600 px; no fixed pixel widths.
- Conventional Commits ≤ 72 chars, one hat per commit; end every commit message with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests need the local DB: `bun run db:up && bun run db:migrate`.

## Review Focus

1. **A stale mix** (Σ kWh ≠ the session's interval energy after a Zaptec change) must fall back to all-grid with
   one warning — never price energy twice or drop it — Task 2 ("a mix that no longer matches…") + Task 3.
2. **Missing prices inside a mix**: no slot spot leaves grid unpriced and solar unvalued (`solarUnpricedKwh`) while
   battery-from-grid still prices at its stored spot; battery of unknown price or a null stored spot is never 0 kr
   — Task 1 ("a missing slot price…", "a battery part with kWh but no stored spot…").
3. **Month boundaries**: mix pieces of an overnight session land in the same month as the kWh overview, including
   an interval-less session — Task 3 ("mix pieces count in the month of their own interval…").
4. **All-solar periods**: a tile or month whose energy is all own solar is a true 0 kr, never "Pris saknas" / "—"
   (the "unpriced" checks must use `gridKwh`, not `kwh`) — Task 1 (avgOre) + Task 6.
5. **Economy stays grid-only while the hero is cash**: the session page's range bar / what-ifs use
   `economy.actual` (all-grid), the hero uses `cost` (mix) — Task 4 ("…the economy stays grid-only") + Task 7.

---

### Task 0: Verify main matches this plan

**Files:** none (read-only). **Reviewers:** none.

- [ ] **Step 1: Isolate.** From the main checkout:

```bash
git fetch origin
git worktree add ../videbacken-solar-cost-4 -b feat/charging-solar-cash-cost origin/main
cd ../videbacken-solar-cost-4 && bun install
```

- [ ] **Step 2: Previous steps merged and checked.** In `docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md`
  rows 1–3 must read `checkpoint passed` (checkpoint 3: η set, derived mix plausible, owner agreed). If row 3 is only
  `merged`, STOP and run checkpoint 3 instead (roadmap "How a session runs a step", 1).

- [ ] **Step 3: Consumed seams exist as the contract says.** Run each; every line must match:

```bash
grep -n "export type MixSlot" -A6 src/lib/houseEnergy/mix/carMix.ts
#   fields: slotStart: Date; kwh; gridKwh; solarKwh; batteryGridKwh; batteryGridSpotSek: number | null;
#           batterySolarKwh; batterySolarSpotSek: number | null; batteryUnpricedKwh; noHouseDataKwh
grep -rn "export async function listForSessions\|export async function replaceForSessions" src/lib/services/energyMix/
#   listForSessions(sessionIds: readonly string[]): Promise<Map<string, MixSlot[]>>
#   replaceForSessions(sessionIds: string[], rows: (MixSlot & { sessionId: string })[]): Promise<void>
grep -n "export \* from\|export {" src/lib/services/energyMix/index.ts src/lib/services/houseEnergy/index.ts
grep -n "export async function firstReadingAt\|export async function replaceDay\|export type HouseReading" src/lib/services/houseEnergy/houseEnergy.ts
grep -n "ev_charge_energy_mix\|battery_grid_spot_sek\|check(" src/lib/db/schema/houseEnergy.ts
grep -rn "gridShare\|toIntervals" src/lib/evCharging --include='*.ts' | grep -v test
#   expect exactly: costInputs.ts (toIntervals), costing.ts (2 calls), economy/sessionEconomy.ts:64-66,
#   economy/schedule.ts:88,116,120, cost/priceIntervals.ts
grep -rln "noTariffKwh" src
#   expect: MonthlyChart(.browser.test).tsx, SessionList.browser.test.tsx, TotalsTiles(.browser.test).tsx,
#           cost/priceIntervals(.test).ts, costing.test.ts
grep -n "recordPrefixedTimings" src/lib/orpc/procedures/evCharging.ts   # prefixes every CostTimings key
```

  Also read the `ev_charge_energy_mix` CHECKs: if a CHECK requires a battery spot to be non-null whenever its kWh
  is > 0, the test fixture `mixSlot` (Task 2) already satisfies it as long as tests set the spot with the kWh (they
  do). If `listForSessions` returns extra keys per slot (e.g. `sessionId`), nothing changes: `toIntervals` copies
  fields explicitly. If any name or signature differs, fix this plan first (and tell the coordinator).

- [ ] **Step 4: Baseline green.** `bun run db:up && bun run db:migrate && bunx vitest run src/lib/evCharging src/lib/orpc/procedures`
  → PASS. Mark the roadmap row 4 `in progress` (committed with Task 9).

---

### Task 1: Cost math prices a mix (pure)

**Files:**
- Modify: `src/lib/evCharging/cost/priceIntervals.ts` (whole file below), `src/lib/evCharging/cost/index.ts`
- Test: `src/lib/evCharging/cost/priceIntervals.test.ts`
- Modify (type completeness only): `src/components/evCharging/TotalsTiles.browser.test.tsx` (`priced`, ~line 54),
  `src/components/evCharging/SessionList.browser.test.tsx` (`priced`, ~line 117),
  `src/components/evCharging/MonthlyChart.browser.test.tsx` (`costMonths`, ~line 42)

**Interfaces:**
- Consumes: `type MixSlot` from `~/lib/houseEnergy/mix/carMix` (step 3).
- Produces:
  ```ts
  export type PieceMix = Omit<MixSlot, 'slotStart' | 'kwh'>
  export type EnergyInterval = { startMs: number; endMs: number; kwh: number; gridShare: number; mix?: PieceMix }
  export type CostTotals = { kwh; gridKwh; fullKwh; noPriceKwh; noTariffKwh; spotSek; feesSek; totalSek;
    solarKwh; batteryKwh; noHouseDataKwh; solarValueSek; solarPricedKwh; solarUnpricedKwh }  // all number
  export function ownSupplyShare(t: Pick<CostTotals, 'kwh' | 'solarKwh' | 'batteryKwh'>): number | null
  export function supplySplit(t: Pick<CostTotals, 'kwh' | 'solarKwh' | 'batteryKwh'>):
    { gridKwh: number; solarKwh: number; batteryKwh: number }
  ```
  `emptyTotals`, `mergeTotals`, `isComplete`, `tariffAt`, `unitPrice`, `priceIntervals` keep their signatures;
  `avgOre` keeps its signature with the new denominator (Decision 2).

**Reviewers:** A = `code-reviewer`, B = `test-completeness` (pure domain math, service-like).

- [ ] **Step 1: Write the failing tests.** In `priceIntervals.test.ts`: add `type PieceMix, ownSupplyShare,
  supplySplit` to the `./index` import; replace the `mergeTotals` describe; append the rest.

```ts
const FEES_SEK = (FEES_ORE / 100) * 1.25 // per kWh incl VAT
const QUARTER = 15 * MIN
const NO_MIX: PieceMix = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

/** A 15-min piece with a mix; its kWh is the sum of the parts (synthetic, never real readings). */
function piece(startIso: string, parts: Partial<PieceMix>): EnergyInterval {
  const mix = { ...NO_MIX, ...parts }
  const kwh =
    mix.gridKwh +
    mix.solarKwh +
    mix.batteryGridKwh +
    mix.batterySolarKwh +
    mix.batteryUnpricedKwh +
    mix.noHouseDataKwh
  const startMs = utc(startIso)
  return { startMs, endMs: startMs + QUARTER, kwh, gridShare: 1, mix }
}

// mulberry32: exact 32-bit integer steps, so the sequence is stable.
function mulberry32(start: number) {
  let seed = start
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32
  }
}

describe('priceIntervals with an energy mix (ADR-0023)', () => {
  // 2026-09-28 CEST: 08:00Z = local 10:00 = slot 40, 4.0 SEK/kWh ex VAT.
  const day = new SlotIndex(daySlots('2026-09-28', 15, (i) => i / 10))
  const AT = '2026-09-28T08:00Z'

  test('grid and no-house-data energy are priced at the slot exactly like all-grid energy', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, noHouseDataKwh: 0.5 })], day, [TARIFF])
    const plain = priceIntervals([iv(AT, '2026-09-28T08:15Z', 1.5)], day, [TARIFF])
    expect(t).toMatchObject({ kwh: 1.5, gridKwh: 1.5, noHouseDataKwh: 0.5, solarKwh: 0, batteryKwh: 0 })
    expect(t.spotSek).toBeCloseTo(1.5 * 4.0 * 1.25)
    expect(t.feesSek).toBeCloseTo(1.5 * FEES_SEK)
    expect(t.totalSek).toBeCloseTo(plain.totalSek, 9)
    expect(isComplete(t)).toBe(true)
  })

  test('own solar costs 0 kr and is valued at the slot spot, ex VAT and fees', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, solarKwh: 3 })], day, [TARIFF])
    expect(t).toMatchObject({ kwh: 4, gridKwh: 1, solarKwh: 3, solarPricedKwh: 3, solarUnpricedKwh: 0 })
    expect(t.fullKwh).toBeCloseTo(1)
    expect(t.totalSek).toBeCloseTo(4.0 * 1.25 + FEES_SEK)
    expect(t.solarValueSek).toBeCloseTo(3 * 4.0)
    expect(isComplete(t)).toBe(true)
    // The average is the cash cost per charged kWh, own solar included at 0 kr.
    expect(avgOre(t)).toBeCloseTo((t.totalSek / 4) * 100)
  })

  test('battery energy from the grid is priced at its stored spot plus the fees of the day it is used', () => {
    const newer: TariffPeriod = { ...TARIFF, validFrom: '2026-09-28', gridTransferOre: 135.6 }
    const t = priceIntervals(
      [piece(AT, { batteryGridKwh: 2, batteryGridSpotSek: 0.3 })],
      day,
      [TARIFF, newer],
    )
    expect(t).toMatchObject({ kwh: 2, gridKwh: 2, batteryKwh: 2, solarKwh: 0 })
    expect(t.spotSek).toBeCloseTo(2 * 0.3 * 1.25) // the stored spot, not the slot's 4.0
    expect(t.feesSek).toBeCloseTo(2 * ((FEES_ORE + 100) / 100) * 1.25) // the use day's fees
    expect(isComplete(t)).toBe(true)
  })

  test('battery energy from solar costs 0 kr and is valued at its stored spot', () => {
    const t = priceIntervals(
      [piece(AT, { batterySolarKwh: 1, batterySolarSpotSek: 0.7 })],
      day,
      [TARIFF],
    )
    expect(t).toMatchObject({
      kwh: 1,
      gridKwh: 0,
      batteryKwh: 1,
      solarKwh: 0,
      totalSek: 0,
      solarPricedKwh: 1,
      solarUnpricedKwh: 0,
    })
    expect(t.solarValueSek).toBeCloseTo(0.7)
    expect(isComplete(t)).toBe(true)
    expect(avgOre(t)).toBeNull()
  })

  test('battery energy of unknown price is no-price energy, so the total is a minimum', () => {
    const t = priceIntervals([piece(AT, { gridKwh: 1, batteryUnpricedKwh: 0.5 })], day, [TARIFF])
    expect(t).toMatchObject({ gridKwh: 1.5, batteryKwh: 0.5, noPriceKwh: 0.5 })
    expect(isComplete(t)).toBe(false)
  })

  test('a missing slot price leaves grid unpriced and solar unvalued; stored battery spots still apply', () => {
    const t = priceIntervals(
      [
        piece(AT, {
          gridKwh: 1,
          solarKwh: 1,
          batteryGridKwh: 1,
          batteryGridSpotSek: 0.5,
          batterySolarKwh: 1,
          batterySolarSpotSek: 0.2,
        }),
      ],
      new SlotIndex([]),
      [TARIFF],
    )
    expect(t.noPriceKwh).toBeCloseTo(1)
    expect(t.fullKwh).toBeCloseTo(1)
    expect(t.spotSek).toBeCloseTo(0.5 * 1.25)
    expect(t.solarUnpricedKwh).toBeCloseTo(1)
    expect(t.solarPricedKwh).toBeCloseTo(1)
    expect(t.solarValueSek).toBeCloseTo(0.2)
    expect(isComplete(t)).toBe(false)
  })

  test('a battery part with kWh but no stored spot is never priced or valued at 0', () => {
    const t = priceIntervals([piece(AT, { batteryGridKwh: 1, batterySolarKwh: 1 })], day, [TARIFF])
    expect(t).toMatchObject({ noPriceKwh: 1, solarUnpricedKwh: 1, solarPricedKwh: 0, totalSek: 0 })
    expect(isComplete(t)).toBe(false)
  })

  test('no tariff on the day of use leaves battery-from-grid as no-tariff', () => {
    const t = priceIntervals(
      [piece(AT, { batteryGridKwh: 1, batteryGridSpotSek: 0.3 })],
      day,
      [{ ...TARIFF, validFrom: '2026-10-01' }],
    )
    expect(t).toMatchObject({ noTariffKwh: 1, fullKwh: 0, totalSek: 0 })
  })

  test('a negative slot spot makes own solar worth less than nothing (export would have cost)', () => {
    const negative = new SlotIndex(daySlots('2026-09-28', 15, () => -0.2))
    const t = priceIntervals([piece(AT, { solarKwh: 2 })], negative, [TARIFF])
    expect(t.solarValueSek).toBeCloseTo(-0.4)
    expect(t.totalSek).toBe(0)
  })

  test('conserves kWh: priced + missing = bought, and bought + own solar = all', () => {
    const rand = mulberry32(7)
    const slots = new SlotIndex([
      ...daySlots('2026-09-28', 15, (i) => i / 20).filter((_, i) => i < 50 || i > 60),
      ...daySlots('2026-09-29', 15, () => 0.8),
    ])
    const base = utc('2026-09-27T22:00Z')
    let batterySolar = 0
    let solarOrigin = 0
    const pieces = Array.from({ length: 150 }, () => {
      const parts = {
        gridKwh: rand(),
        solarKwh: rand(),
        batteryGridKwh: rand(),
        batteryGridSpotSek: rand(),
        batterySolarKwh: rand(),
        batterySolarSpotSek: rand() < 0.1 ? null : rand(),
        batteryUnpricedKwh: rand() / 10,
        noHouseDataKwh: rand() / 5,
      }
      batterySolar += parts.batterySolarKwh
      solarOrigin += parts.solarKwh + parts.batterySolarKwh
      const p = piece(new Date(base).toISOString(), parts)
      const offset = Math.floor(rand() * 46 * 4) * QUARTER
      return { ...p, startMs: p.startMs + offset, endMs: p.endMs + offset }
    })
    const t = priceIntervals(pieces, slots, [{ ...TARIFF, validFrom: '2026-09-29' }])
    expect(t.fullKwh + t.noPriceKwh + t.noTariffKwh).toBeCloseTo(t.gridKwh, 9)
    expect(t.gridKwh + t.solarKwh + batterySolar).toBeCloseTo(t.kwh, 9)
    expect(t.solarPricedKwh + t.solarUnpricedKwh).toBeCloseTo(solarOrigin, 9)
  })

  test.each([
    ['a mix with gridShare below 1', { ...piece(AT, { gridKwh: 1 }), gridShare: 0.5 }],
    ['a negative mix part', piece(AT, { gridKwh: 2, solarKwh: -1 })],
    ['parts that do not sum to the kWh', { ...piece(AT, { gridKwh: 1 }), kwh: 1.1 }],
    ['a NaN stored spot', piece(AT, { batteryGridKwh: 1, batteryGridSpotSek: Number.NaN })],
    ['an infinite part', piece(AT, { solarKwh: Number.POSITIVE_INFINITY })],
  ])('rejects %s', (_, bad) => {
    expect(() => priceIntervals([bad], day, [TARIFF])).toThrow(RangeError)
  })
})

describe('emptyTotals and mergeTotals', () => {
  test('empty totals are all zero', () => {
    expect(emptyTotals()).toEqual({
      kwh: 0,
      gridKwh: 0,
      fullKwh: 0,
      noPriceKwh: 0,
      noTariffKwh: 0,
      spotSek: 0,
      feesSek: 0,
      totalSek: 0,
      solarKwh: 0,
      batteryKwh: 0,
      noHouseDataKwh: 0,
      solarValueSek: 0,
      solarPricedKwh: 0,
      solarUnpricedKwh: 0,
    })
  })

  test('sums every field', () => {
    const a = {
      ...emptyTotals(),
      kwh: 1,
      gridKwh: 1,
      fullKwh: 1,
      spotSek: 2,
      totalSek: 3,
      solarKwh: 1,
      solarValueSek: 0.5,
      solarPricedKwh: 1,
    }
    const b = {
      ...emptyTotals(),
      kwh: 2,
      gridKwh: 2,
      noPriceKwh: 2,
      feesSek: 1,
      totalSek: 1,
      batteryKwh: 2,
      noHouseDataKwh: 1,
      solarValueSek: 0.25,
      solarUnpricedKwh: 2,
    }
    expect(mergeTotals(a, b)).toEqual({
      kwh: 3,
      gridKwh: 3,
      fullKwh: 1,
      noPriceKwh: 2,
      noTariffKwh: 0,
      spotSek: 2,
      feesSek: 1,
      totalSek: 4,
      solarKwh: 1,
      batteryKwh: 2,
      noHouseDataKwh: 1,
      solarValueSek: 0.75,
      solarPricedKwh: 1,
      solarUnpricedKwh: 2,
    })
  })
})

describe('own supply', () => {
  test('the share from own solar and the battery, null without energy', () => {
    expect(ownSupplyShare({ kwh: 10, solarKwh: 3, batteryKwh: 1.4 })).toBeCloseTo(0.44)
    expect(ownSupplyShare({ kwh: 0, solarKwh: 0, batteryKwh: 0 })).toBeNull()
  })

  test('the bar split: grid is the rest (incl. energy without house data), never negative', () => {
    expect(supplySplit({ kwh: 10, solarKwh: 3, batteryKwh: 1 })).toEqual({
      gridKwh: 6,
      solarKwh: 3,
      batteryKwh: 1,
    })
    expect(supplySplit({ kwh: 1, solarKwh: 0.7, batteryKwh: 0.3000000001 }).gridKwh).toBe(0)
  })
})
```

  Delete the old `describe('mergeTotals', …)` block (lines 221–236); its case lives in the new describe.

- [ ] **Step 2: Run, expect FAIL.** `bunx vitest run src/lib/evCharging/cost/priceIntervals.test.ts` → FAIL (no
  `PieceMix`, `ownSupplyShare`, `supplySplit`; unknown fields).

- [ ] **Step 3: Implement.** Replace `src/lib/evCharging/cost/priceIntervals.ts` with:

```ts
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import type { PriceSlot } from '~/lib/spotPrice/slots'
import { stockholmDayOf } from '~/lib/time/stockholm'
import type { SlotIndex } from './slotIndex'

/**
 * How one piece of charging energy was supplied (ADR-0023), in kWh that sum
 * to the piece's `kwh`: grid, own solar, battery energy that came from the
 * grid (with the average spot it was bought at, SEK/kWh ex VAT), from solar
 * (with its average spot when stored), of unknown price, and energy without
 * house data (counted as bought from the grid). A spot is null when its kWh is 0.
 */
export type PieceMix = Omit<MixSlot, 'slotStart' | 'kwh'>

/**
 * One stretch of charging energy. Power is assumed uniform within it (Zaptec
 * intervals are ~hourly, price slots 15 min), so its kWh splits across price
 * slots in proportion to overlap. Without `mix`, `gridShare` is the fraction
 * bought from the grid and only that share is priced (the economy
 * counterfactuals use 1: price timing as if all were bought). With `mix` (a
 * 15-min slot of the stored mix, or a session's labelled all-grid fallback)
 * the piece is priced per source and `gridShare` must be 1.
 */
export type EnergyInterval = {
  startMs: number
  endMs: number
  kwh: number
  gridShare: number
  mix?: PieceMix
}

/** A tariff period as the cost math needs it; amounts in öre/kWh ex VAT. */
export type TariffPeriod = {
  /** Stockholm calendar day ('YYYY-MM-DD') the period applies from. */
  validFrom: string
  retailMarkupOre: number
  gridTransferOre: number
  energyTaxOre: number
  vatPercent: number
}

/**
 * Cost of a set of intervals. Money is SEK incl VAT; `feesSek` is markup +
 * grid transfer + energy tax, so `totalSek = spotSek + feesSek`. Only bought
 * kWh with both a price and a tariff (`fullKwh`) are priced — the rest is
 * counted as missing, never as 0 kr. Own solar (straight or via the battery)
 * costs 0 kr; what it would have earned exported is kept apart, ex VAT and
 * fees (ADR-0023).
 */
export type CostTotals = {
  /** All charged energy. */
  kwh: number
  /**
   * The bought share of `kwh` — what the money must cover: grid, energy
   * without house data, and battery energy from the grid or of unknown price.
   */
  gridKwh: number
  /** Bought kWh with a price and a tariff — what the money covers. */
  fullKwh: number
  /** Bought kWh with no spot price for its time, or battery energy of unknown price. */
  noPriceKwh: number
  /** Bought kWh with a price but no tariff in force on its day. */
  noTariffKwh: number
  spotSek: number
  feesSek: number
  totalSek: number
  /** Own solar straight to the car (not via the battery). */
  solarKwh: number
  /** From the home battery, whatever charged it (grid, solar or unknown). */
  batteryKwh: number
  /** Without house data for its time, so counted as bought from the grid (part of `gridKwh`). */
  noHouseDataKwh: number
  /** What the own solar used (straight and via the battery) would have earned exported: kWh × spot, ex VAT, no fees. */
  solarValueSek: number
  /** Solar-origin kWh (straight + via the battery) whose value is in `solarValueSek`. */
  solarPricedKwh: number
  /** Solar-origin kWh with no spot to value it — left out of `solarValueSek`, never valued at 0. */
  solarUnpricedKwh: number
}

export function emptyTotals(): CostTotals {
  return {
    kwh: 0,
    gridKwh: 0,
    fullKwh: 0,
    noPriceKwh: 0,
    noTariffKwh: 0,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    solarKwh: 0,
    batteryKwh: 0,
    noHouseDataKwh: 0,
    solarValueSek: 0,
    solarPricedKwh: 0,
    solarUnpricedKwh: 0,
  }
}

export function mergeTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    kwh: a.kwh + b.kwh,
    gridKwh: a.gridKwh + b.gridKwh,
    fullKwh: a.fullKwh + b.fullKwh,
    noPriceKwh: a.noPriceKwh + b.noPriceKwh,
    noTariffKwh: a.noTariffKwh + b.noTariffKwh,
    spotSek: a.spotSek + b.spotSek,
    feesSek: a.feesSek + b.feesSek,
    totalSek: a.totalSek + b.totalSek,
    solarKwh: a.solarKwh + b.solarKwh,
    batteryKwh: a.batteryKwh + b.batteryKwh,
    noHouseDataKwh: a.noHouseDataKwh + b.noHouseDataKwh,
    solarValueSek: a.solarValueSek + b.solarValueSek,
    solarPricedKwh: a.solarPricedKwh + b.solarPricedKwh,
    solarUnpricedKwh: a.solarUnpricedKwh + b.solarUnpricedKwh,
  }
}

/** Float tolerance for "no bought kWh is missing a price or tariff". */
const COMPLETE_EPSILON_KWH = 1e-6

/** Float tolerance for a mix's parts summing to its piece's kWh (the DB CHECK is tighter). */
const MIX_SUM_EPSILON_KWH = 1e-6

/**
 * Every bought kWh is priced — exactly once. A priced total above the bought
 * total means overlapping slots double-counted energy, which is not complete either.
 */
export function isComplete(t: CostTotals): boolean {
  return Math.abs(t.gridKwh - t.fullKwh) <= COMPLETE_EPSILON_KWH
}

/**
 * Average cash öre/kWh incl VAT per charged kWh whose cost is known: the priced
 * energy plus the cash-free own solar (`kwh − gridKwh`). Null when nothing is priced.
 */
export function avgOre(t: CostTotals): number | null {
  return t.fullKwh > 0 ? (t.totalSek / (t.fullKwh + Math.max(0, t.kwh - t.gridKwh))) * 100 : null
}

type Supply = Pick<CostTotals, 'kwh' | 'solarKwh' | 'batteryKwh'>

/** The share of the charged energy from own solar or the home battery; null without energy. */
export function ownSupplyShare(t: Supply): number | null {
  return t.kwh > 0 ? Math.min(1, (t.solarKwh + t.batteryKwh) / t.kwh) : null
}

/** kWh per source for the grid / solar / battery bar; grid includes energy without house data. */
export function supplySplit(t: Supply): { gridKwh: number; solarKwh: number; batteryKwh: number } {
  return {
    gridKwh: Math.max(0, t.kwh - t.solarKwh - t.batteryKwh),
    solarKwh: t.solarKwh,
    batteryKwh: t.batteryKwh,
  }
}

/**
 * The tariff in force on Stockholm `day`: the latest period whose `validFrom`
 * is on or before it. `tariffsAsc` must be sorted by `validFrom` ascending
 * ('YYYY-MM-DD' strings compare correctly as text).
 */
export function tariffAt(tariffsAsc: readonly TariffPeriod[], day: string): TariffPeriod | null {
  for (let i = tariffsAsc.length - 1; i >= 0; i--) {
    if (tariffsAsc[i].validFrom <= day) return tariffsAsc[i]
  }
  return null
}

/**
 * SEK per kWh incl VAT of a slot's spot price and of a tariff's per-kWh fees
 * (markup + grid transfer + energy tax). The one formula every kronor figure
 * uses — priced energy here, and slot ranking in the Phase 4 counterfactuals.
 */
export function unitPrice(
  sekPerKwh: number,
  tariff: TariffPeriod,
): { spotSek: number; feesSek: number } {
  const vat = 1 + tariff.vatPercent / 100
  const feesOre = tariff.retailMarkupOre + tariff.gridTransferOre + tariff.energyTaxOre
  return { spotSek: sekPerKwh * vat, feesSek: (feesOre / 100) * vat }
}

/**
 * Prices intervals against spot slots and tariffs. Each interval's bought kWh
 * is split into pieces by the slots it overlaps (kWh × overlap / duration); an
 * uncovered stretch is a no-price piece. A priced piece takes the tariff of its
 * slot's Stockholm day (slots never straddle local midnight). A mixed interval
 * is priced per source (ADR-0023): see `priceMixed`.
 */
export function priceIntervals(
  intervals: readonly EnergyInterval[],
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): CostTotals {
  const t = emptyTotals()
  for (const iv of intervals) {
    assertValidInterval(iv)
    t.kwh += iv.kwh
    if (iv.mix) priceMixed(t, iv, iv.mix, slots, tariffsAsc)
    else priceBought(t, iv, iv.kwh * iv.gridShare, slots, tariffsAsc)
  }
  return t
}

// `boughtKwh` spread evenly over `iv`, priced at each overlapping slot's spot
// + its day's fees; the share no slot covers is no-price.
function priceBought(
  t: CostTotals,
  iv: EnergyInterval,
  boughtKwh: number,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): void {
  t.gridKwh += boughtKwh
  const uncovered = eachSlotShare(iv, slots, (slot, share) =>
    addPriced(t, boughtKwh * share, slot.sekPerKwh, tariffAt(tariffsAsc, stockholmDayOf(slot.startMs))),
  )
  t.noPriceKwh += boughtKwh * uncovered
}

// A piece with a known mix (ADR-0023): grid and no-house-data energy at the
// slot's spot + fees; battery-from-grid at the spot it was bought at + the
// fees of the day it is used; own solar 0 kr, valued at its spot (ex VAT, no
// fees); battery energy of unknown price is no-price.
function priceMixed(
  t: CostTotals,
  iv: EnergyInterval,
  mix: PieceMix,
  slots: SlotIndex,
  tariffsAsc: readonly TariffPeriod[],
): void {
  priceBought(t, iv, mix.gridKwh + mix.noHouseDataKwh, slots, tariffsAsc)
  t.noHouseDataKwh += mix.noHouseDataKwh
  t.solarKwh += mix.solarKwh
  t.batteryKwh += mix.batteryGridKwh + mix.batterySolarKwh + mix.batteryUnpricedKwh

  if (mix.solarKwh > 0) {
    const unvalued = eachSlotShare(iv, slots, (slot, share) => {
      t.solarValueSek += mix.solarKwh * share * slot.sekPerKwh
      t.solarPricedKwh += mix.solarKwh * share
    })
    t.solarUnpricedKwh += mix.solarKwh * unvalued
  }

  t.gridKwh += mix.batteryGridKwh + mix.batteryUnpricedKwh
  t.noPriceKwh += mix.batteryUnpricedKwh
  if (mix.batteryGridKwh > 0) {
    if (mix.batteryGridSpotSek === null) t.noPriceKwh += mix.batteryGridKwh
    else {
      const useDay = tariffAt(tariffsAsc, stockholmDayOf(iv.startMs))
      addPriced(t, mix.batteryGridKwh, mix.batteryGridSpotSek, useDay)
    }
  }
  if (mix.batterySolarKwh > 0) {
    if (mix.batterySolarSpotSek === null) t.solarUnpricedKwh += mix.batterySolarKwh
    else {
      t.solarValueSek += mix.batterySolarKwh * mix.batterySolarSpotSek
      t.solarPricedKwh += mix.batterySolarKwh
    }
  }
}

// Calls `each` for every slot overlapping `iv` with the share of `iv` it
// covers (overlap ÷ duration); returns the share no slot covers — all of a
// zero-length interval, which has no duration to spread over.
function eachSlotShare(
  iv: EnergyInterval,
  slots: SlotIndex,
  each: (slot: PriceSlot, share: number) => void,
): number {
  const durationMs = iv.endMs - iv.startMs
  if (durationMs <= 0) return 1
  let coveredMs = 0
  for (const slot of slots.between(iv.startMs, iv.endMs)) {
    const overlapMs = Math.min(slot.endMs, iv.endMs) - Math.max(slot.startMs, iv.startMs)
    if (overlapMs <= 0) continue
    coveredMs += overlapMs
    each(slot, overlapMs / durationMs)
  }
  return (durationMs - Math.min(coveredMs, durationMs)) / durationMs
}

function addPriced(
  t: CostTotals,
  kwh: number,
  sekPerKwh: number,
  tariff: TariffPeriod | null,
): void {
  if (!tariff) {
    t.noTariffKwh += kwh
    return
  }
  const unit = unitPrice(sekPerKwh, tariff)
  const spotSek = kwh * unit.spotSek
  const feesSek = kwh * unit.feesSek
  t.fullKwh += kwh
  t.spotSek += spotSek
  t.feesSek += feesSek
  t.totalSek += spotSek + feesSek
}

// Stored energy is CHECK-constrained non-negative and finite, so a bad value
// here is a caller bug: fail loudly rather than let one NaN poison every sum.
function assertValidInterval(iv: EnergyInterval): void {
  if (
    !Number.isFinite(iv.startMs) ||
    !Number.isFinite(iv.endMs) ||
    !Number.isFinite(iv.kwh) ||
    iv.kwh < 0 ||
    !(iv.gridShare >= 0 && iv.gridShare <= 1)
  ) {
    throw new RangeError('Invalid energy interval')
  }
  if (iv.mix) assertValidMix(iv.mix, iv.kwh, iv.gridShare)
}

function assertValidMix(mix: PieceMix, kwh: number, gridShare: number): void {
  const parts = [
    mix.gridKwh,
    mix.solarKwh,
    mix.batteryGridKwh,
    mix.batterySolarKwh,
    mix.batteryUnpricedKwh,
    mix.noHouseDataKwh,
  ]
  const spots = [mix.batteryGridSpotSek, mix.batterySolarSpotSek]
  if (
    gridShare !== 1 ||
    parts.some((p) => !Number.isFinite(p) || p < 0) ||
    spots.some((s) => s !== null && !Number.isFinite(s)) ||
    Math.abs(parts.reduce((a, b) => a + b, 0) - kwh) > MIX_SUM_EPSILON_KWH
  ) {
    throw new RangeError('Invalid energy mix')
  }
}
```

  In `src/lib/evCharging/cost/index.ts` extend the export list: add `ownSupplyShare`, `type PieceMix`,
  `supplySplit` (alphabetical, as Biome's organize-imports keeps it).

  Type-complete the three UI fixtures (no behaviour change): add
  `solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 0, solarValueSek: 0, solarPricedKwh: 0, solarUnpricedKwh: 0,` to
  `priced` in `TotalsTiles.browser.test.tsx` and in `SessionList.browser.test.tsx`, and to each element of
  `costMonths` in `MonthlyChart.browser.test.tsx`.

- [ ] **Step 4: Run, expect PASS.** `bunx vitest run src/lib/evCharging/cost && bun run typecheck` → PASS (the
  existing economy tests too: `bunx vitest run src/lib/evCharging/economy`).

- [ ] **Step 5: Commit** `feat(charging): price a solar and battery energy mix`

---

### Task 2: `toIntervals` uses the stored mix behind the read-time guard

**Files:**
- Modify: `src/lib/evCharging/costInputs.ts`
- Create: `test/fixtures/energyMix.ts`
- Test: create `src/lib/evCharging/costInputs.test.ts`

**Interfaces:**
- Consumes: `listForSessions` from `~/lib/services/energyMix`; `type MixSlot`; `PieceMix`, `EnergyInterval`.
- Produces:
  ```ts
  export const MIX_GUARD_KWH = 1e-6
  export function toIntervals(session: SessionEnergy, mix?: readonly MixSlot[]): EnergyInterval[]
  export async function loadMix(sessions: readonly SessionEnergy[], timings?: { mixMs?: number }):
    Promise<Map<string, MixSlot[]>>
  // test/fixtures/energyMix.ts
  export function mixSlot(slotStartIso: string, parts: Partial<PieceMix>): MixSlot
  ```

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the fixture and the failing tests.**

```ts
// test/fixtures/energyMix.ts
import type { PieceMix } from '~/lib/evCharging/cost'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'

const ZERO: PieceMix = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

/**
 * A synthetic stored mix slot (never real readings — the repo is public).
 * `kwh` is the sum of the parts, as the table's CHECK requires.
 */
export function mixSlot(slotStartIso: string, parts: Partial<PieceMix>): MixSlot {
  const p = { ...ZERO, ...parts }
  return {
    slotStart: new Date(slotStartIso),
    kwh:
      p.gridKwh +
      p.solarKwh +
      p.batteryGridKwh +
      p.batterySolarKwh +
      p.batteryUnpricedKwh +
      p.noHouseDataKwh,
    ...p,
  }
}
```

```ts
// src/lib/evCharging/costInputs.test.ts
import { afterEach, expect, test, vi } from 'vitest'
import { logger } from '~/lib/logger/server'
import type { SessionEnergy } from '~/lib/services/evCharging'
import { mixSlot } from '~test/fixtures/energyMix'
import { MIX_GUARD_KWH, toIntervals } from './costInputs'

afterEach(() => {
  vi.restoreAllMocks()
})

const at = (iso: string) => Date.parse(iso)
const ZERO_MIX = {
  gridKwh: 0,
  solarKwh: 0,
  batteryGridKwh: 0,
  batteryGridSpotSek: null,
  batterySolarKwh: 0,
  batterySolarSpotSek: null,
  batteryUnpricedKwh: 0,
  noHouseDataKwh: 0,
}

function sessionOf(stretches: [string, string, number][]): SessionEnergy {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    startAt: new Date(stretches[0][0]),
    endAt: new Date(stretches[stretches.length - 1][1]),
    energyKwh: stretches.reduce((sum, [, , kwh]) => sum + kwh, 0),
    stretches: stretches.map(([s, e, kwh]) => ({ startMs: at(s), endMs: at(e), kwh })),
    estimated: false,
    vehicle: 'ours',
    vehicleSource: 'default',
  }
}

const S = sessionOf([['2026-09-28T08:00:00Z', '2026-09-28T08:30:00Z', 3]])
const MIX = [
  mixSlot('2026-09-28T08:00:00Z', { gridKwh: 1, solarKwh: 0.5 }),
  mixSlot('2026-09-28T08:15:00Z', { gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.4 }),
]

test('a matching mix becomes one 15-min piece per slot, priced per source', () => {
  expect(toIntervals(S, MIX)).toEqual([
    {
      startMs: at('2026-09-28T08:00:00Z'),
      endMs: at('2026-09-28T08:15:00Z'),
      kwh: 1.5,
      gridShare: 1,
      mix: { ...ZERO_MIX, gridKwh: 1, solarKwh: 0.5 },
    },
    {
      startMs: at('2026-09-28T08:15:00Z'),
      endMs: at('2026-09-28T08:30:00Z'),
      kwh: 1.5,
      gridShare: 1,
      mix: { ...ZERO_MIX, gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.4 },
    },
  ])
})

test('extra keys on a stored slot never reach the piece', () => {
  const withId = MIX.map((slot) => ({ ...slot, sessionId: S.sessionId }))
  expect(toIntervals(S, withId)[0].mix).toEqual({ ...ZERO_MIX, gridKwh: 1, solarKwh: 0.5 })
})

test('without a mix every stretch is bought from the grid, labelled as without house data', () => {
  const warn = vi.spyOn(logger, 'warn')
  const allGrid = [
    {
      startMs: at('2026-09-28T08:00:00Z'),
      endMs: at('2026-09-28T08:30:00Z'),
      kwh: 3,
      gridShare: 1,
      mix: { ...ZERO_MIX, noHouseDataKwh: 3 },
    },
  ]
  expect(toIntervals(S)).toEqual(allGrid)
  expect(toIntervals(S, [])).toEqual(allGrid)
  expect(warn).not.toHaveBeenCalled()
})

test('a mix that no longer matches the session is ignored with one warning', () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const stale = [...MIX, mixSlot('2026-09-28T08:30:00Z', { gridKwh: 0.25 })]
  const pieces = toIntervals(S, stale)
  expect(pieces).toHaveLength(1)
  expect(pieces[0].mix).toEqual({ ...ZERO_MIX, noHouseDataKwh: 3 })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('cost: energy mix ignored, kWh differs from the session', {
    sessionId: S.sessionId,
    mixKwh: 3.25,
    energyKwh: 3,
  })
})

test('a drift within the guard keeps the mix; just past it does not', () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const nudge = (d: number) => [MIX[0], { ...MIX[1], kwh: MIX[1].kwh + d, gridKwh: MIX[1].gridKwh + d }]
  expect(toIntervals(S, nudge(MIX_GUARD_KWH / 2))).toHaveLength(2)
  expect(toIntervals(S, nudge(MIX_GUARD_KWH * 2))).toHaveLength(1)
})

test('the guard compares against the interval energy, not the session total', () => {
  // Zaptec's session total can differ slightly from its intervals; the mix is derived from the intervals.
  const s = { ...S, energyKwh: 3.4 }
  expect(toIntervals(s, MIX)).toHaveLength(2)
})
```

- [ ] **Step 2: Run, expect FAIL.** `bunx vitest run src/lib/evCharging/costInputs.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Replace the header comment and `toIntervals` in `src/lib/evCharging/costInputs.ts`
  (keep `timed` and `loadTariffs` unchanged):

```ts
import type { EnergyInterval, PieceMix, TariffPeriod } from '~/lib/evCharging/cost'
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { logger } from '~/lib/logger/server'
import type { SessionEnergy } from '~/lib/services/evCharging'
import { listForSessions } from '~/lib/services/energyMix'
import * as tariffService from '~/lib/services/tariff'

// Server-only. Inputs shared by the cost read models: `costing.ts` uses all of
// them; `chargingEconomy.ts` uses `timed` and `loadTariffs` for its grid-only
// counterfactuals, and `loadMix` + `toIntervals` for a session's cash cost.

/** A stored mix slot's length: one UTC quarter-hour (ADR-0023). */
const MIX_SLOT_MS = 15 * 60_000

/** How far a session's stored mix may drift from its interval energy before it is ignored (spec "Read-time guard"). */
export const MIX_GUARD_KWH = 1e-6
```

  (`timed` and `loadTariffs` stay here, unchanged.) Then:

```ts
/** The stored energy mix of these sessions, by session id; sessions without one are absent. */
export async function loadMix(
  sessions: readonly SessionEnergy[],
  timings?: { mixMs?: number },
): Promise<Map<string, MixSlot[]>> {
  return timed(timings, 'mixMs', async () =>
    sessions.length === 0 ? new Map() : listForSessions(sessions.map((s) => s.sessionId)),
  )
}

/**
 * A session's priced pieces (ADR-0023). With a stored mix whose kWh matches
 * the session's interval energy: one 15-min piece per mix slot, priced per
 * source. Otherwise every stretch is bought from the grid and labelled as
 * without house data — normal while there's no mix (Emaldo down, not derived
 * yet, before the first reading); a mix that no longer matches (a Zaptec
 * change the re-derive hasn't reached) is ignored with a warning, so energy is
 * never priced twice or lost. The economy counterfactuals don't use this:
 * they stay grid-only (spec "Cost and display").
 */
export function toIntervals(session: SessionEnergy, mix?: readonly MixSlot[]): EnergyInterval[] {
  if (mix && mix.length > 0) {
    const energyKwh = sum(session.stretches.map((s) => s.kwh))
    const mixKwh = sum(mix.map((slot) => slot.kwh))
    if (Math.abs(mixKwh - energyKwh) <= MIX_GUARD_KWH) {
      return mix.map((slot) => ({
        startMs: slot.slotStart.getTime(),
        endMs: slot.slotStart.getTime() + MIX_SLOT_MS,
        kwh: slot.kwh,
        gridShare: 1,
        mix: pieceMix(slot),
      }))
    }
    logger.warn('cost: energy mix ignored, kWh differs from the session', {
      sessionId: session.sessionId,
      mixKwh,
      energyKwh,
    })
  }
  return session.stretches.map((s) => ({ ...s, gridShare: 1, mix: withoutHouseData(s.kwh) }))
}

// Copied field by field: a stored row may carry more (e.g. its session id).
function pieceMix(slot: MixSlot): PieceMix {
  return {
    gridKwh: slot.gridKwh,
    solarKwh: slot.solarKwh,
    batteryGridKwh: slot.batteryGridKwh,
    batteryGridSpotSek: slot.batteryGridSpotSek,
    batterySolarKwh: slot.batterySolarKwh,
    batterySolarSpotSek: slot.batterySolarSpotSek,
    batteryUnpricedKwh: slot.batteryUnpricedKwh,
    noHouseDataKwh: slot.noHouseDataKwh,
  }
}

function withoutHouseData(kwh: number): PieceMix {
  return {
    gridKwh: 0,
    solarKwh: 0,
    batteryGridKwh: 0,
    batteryGridSpotSek: null,
    batterySolarKwh: 0,
    batterySolarSpotSek: null,
    batteryUnpricedKwh: 0,
    noHouseDataKwh: kwh,
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
```

  `costing.ts` still calls `sessions.flatMap(toIntervals)` — that now passes the array index as `mix` and fails
  `tsc`. Make it compile for this commit with `sessions.flatMap((s) => toIntervals(s))` and
  `toIntervals(s)` in `getSessionCosts`; Task 3 wires the mix in.

- [ ] **Step 4: Run, expect PASS.** `bunx vitest run src/lib/evCharging/costInputs.test.ts src/lib/evCharging/costing.test.ts && bun run typecheck`.
  `costing.test.ts` still passes: all-grid labelled pieces price identically.

- [ ] **Step 5: Commit** `feat(charging): build cost pieces from the stored energy mix`

---

### Task 3: The cost read model loads the mix and the first house-data day

**Files:**
- Modify: `src/lib/evCharging/costing.ts`
- Test: `src/lib/evCharging/costing.test.ts`

**Interfaces:**
- Consumes: `loadMix`, `toIntervals` (Task 2); `firstReadingAt` from `~/lib/services/houseEnergy` (step 2);
  `replaceForSessions` (tests), `replaceDay` from houseEnergy (tests).
- Produces:
  ```ts
  export type CostOverview = { year; tiles; months; houseDataFrom: Date | null }
  export type CostTimings = { energyMs?; slotsMs?; tariffMs?; mixMs?; houseFromMs?; computeMs? }
  export function summarize(t: CostTotals): CostSummary   // now exported (Task 4 uses it)
  ```

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing tests** (append to `costing.test.ts`; add the imports):

```ts
import type { MixSlot } from '~/lib/houseEnergy/mix/carMix'
import { logger } from '~/lib/logger/server'
import { replaceForSessions } from '~/lib/services/energyMix'
import { replaceDay as replaceHouseDay } from '~/lib/services/houseEnergy'
import { mixSlot } from '~test/fixtures/energyMix'
import { vi } from 'vitest' // merge into the existing vitest import

const storeMix = (sessionId: string, slots: MixSlot[]) =>
  replaceForSessions(
    [sessionId],
    slots.map((s) => ({ ...s, sessionId })),
  )

test('a session with a stored mix costs its cash: own solar 0 kr, battery at its stored spot', async () => {
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15, () => 0.5))
  await tariffService.create(TARIFF)
  const id = await session('2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3, [
    ['2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3],
  ])
  await storeMix(id, [
    mixSlot('2026-09-20T18:00:00Z', { gridKwh: 1, solarKwh: 0.5 }),
    mixSlot('2026-09-20T18:15:00Z', { gridKwh: 0.5, batteryGridKwh: 1, batteryGridSpotSek: 0.2 }),
  ])

  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({ kwh: 3, solarKwh: 0.5, batteryKwh: 1, noHouseDataKwh: 0, complete: true })
  expect(sep.gridKwh).toBeCloseTo(2.5)
  expect(sep.spotSek).toBeCloseTo((1.5 * 0.5 + 1 * 0.2) * 1.25)
  expect(sep.feesSek).toBeCloseTo(((2.5 * FEES_ORE) / 100) * 1.25)
  expect(sep.solarValueSek).toBeCloseTo(0.5 * 0.5)
  expect(sep.avgOre).toBeCloseTo((sep.totalSek / 3) * 100)

  const [cost] = await getSessionCosts({ sessionIds: [id] })
  expect(cost.totalSek).toBeCloseTo(sep.totalSek, 9)
  expect(cost.solarKwh).toBeCloseTo(0.5)
})

test('a session without a mix is all grid, labelled as without house data', async () => {
  await replaceDay('SE3', '2026-09-20', daySlots('2026-09-20', 15, () => 0.5))
  await tariffService.create(TARIFF)
  await session('2026-09-20T18:00:00Z', '2026-09-20T19:00:00Z', 4, [
    ['2026-09-20T18:00:00Z', '2026-09-20T19:00:00Z', 4],
  ])
  const sep = (await getCostOverview({ now: NOW })).months[8]
  expect(sep).toMatchObject({ kwh: 4, noHouseDataKwh: 4, solarKwh: 0, batteryKwh: 0, complete: true })
  expect(sep.spotSek).toBeCloseTo(4 * 0.5 * 1.25)
})

test('a mix that no longer matches the session falls back to all grid', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const id = await session('2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3, [
    ['2026-09-20T18:00:00Z', '2026-09-20T18:30:00Z', 3],
  ])
  await storeMix(id, [mixSlot('2026-09-20T18:00:00Z', { solarKwh: 2 })])
  const [cost] = await getSessionCosts({ sessionIds: [id] })
  expect(cost).toMatchObject({ kwh: 3, solarKwh: 0, noHouseDataKwh: 3 })
  expect(warn).toHaveBeenCalledWith(
    'cost: energy mix ignored, kWh differs from the session',
    expect.objectContaining({ sessionId: id }),
  )
  vi.restoreAllMocks()
})

test('mix pieces count in the month of their own interval, like the kWh overview', async () => {
  // Local 23:00 Aug 31 → 01:00 Sep 1 (CEST), hour-aligned intervals.
  const id = await session('2026-08-31T21:00:00Z', '2026-08-31T23:00:00Z', 10, [
    ['2026-08-31T21:00:00Z', '2026-08-31T22:00:00Z', 4],
    ['2026-08-31T22:00:00Z', '2026-08-31T23:00:00Z', 6],
  ])
  await storeMix(id, [
    ...['21:00', '21:15', '21:30', '21:45'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { gridKwh: 1 }),
    ),
    ...['22:00', '22:15', '22:30', '22:45'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { solarKwh: 1.5 }),
    ),
  ])
  const [kwh, cost] = await Promise.all([
    getOverview({ year: 2026, now: NOW }),
    getCostOverview({ year: 2026, now: NOW }),
  ])
  expect(cost.months[7].kwh).toBeCloseTo(kwh.months[7].kwh, 9) // August: 4
  expect(cost.months[8].kwh).toBeCloseTo(kwh.months[8].kwh, 9) // September: 6
  expect(cost.months[8].solarKwh).toBeCloseTo(6)
})

test('an interval-less session with a mix stays whole in its start month', async () => {
  // Local 23:30 Aug 31 → 00:30 Sep 1, no intervals: one estimated stretch.
  const id = await session('2026-08-31T21:30:00Z', '2026-08-31T22:30:00Z', 2)
  await storeMix(
    id,
    ['21:30', '21:45', '22:00', '22:15'].map((hm) =>
      mixSlot(`2026-08-31T${hm}:00Z`, { gridKwh: 0.25, solarKwh: 0.25 }),
    ),
  )
  const cost = await getCostOverview({ year: 2026, now: NOW })
  expect(cost.months[7]).toMatchObject({ kwh: 2, solarKwh: 1 })
  expect(cost.months[8].kwh).toBe(0)
})

test('reports when house data starts (null before any reading)', async () => {
  expect((await getCostOverview({ now: NOW })).houseDataFrom).toBeNull()
  const bucketStart = new Date('2026-09-01T06:00:00Z')
  await replaceHouseDay(
    { dayStart: new Date('2026-08-31T22:00:00Z'), dayEnd: new Date('2026-09-01T22:00:00Z') },
    [
      {
        bucketStart,
        gridImportKwh: 0.1,
        gridExportKwh: 0,
        solarKwh: 0,
        loadKwh: 0.1,
        batteryDischargeKwh: 0,
        batteryChargeSolarKwh: 0,
        batteryChargeGridKwh: 0,
        batteryChargeAcKwh: 0,
      },
    ],
  )
  expect((await getCostOverview({ now: NOW })).houseDataFrom).toEqual(bucketStart)
})
```

  Update the existing `'records sub-timings when asked'` expectation to:

```ts
  expect(timings).toEqual({
    energyMs: expect.any(Number),
    slotsMs: expect.any(Number),
    tariffMs: expect.any(Number),
    mixMs: expect.any(Number),
    houseFromMs: expect.any(Number),
    computeMs: expect.any(Number),
  })
```

- [ ] **Step 2: Run, expect FAIL.** `bunx vitest run src/lib/evCharging/costing.test.ts` → FAIL (no mix pricing,
  no `houseDataFrom`, missing timings).

- [ ] **Step 3: Implement** in `src/lib/evCharging/costing.ts`:
  - Imports: add `type EnergyInterval` to the `~/lib/evCharging/cost` import; `import { firstReadingAt } from
    '~/lib/services/houseEnergy'`; change the costInputs import to `{ loadMix, loadTariffs, timed, toIntervals }`.
  - Header comment: append "Since ADR-0023 it prices each session's stored solar/battery mix (cash cost); a
    session without one stays all-grid, labelled as without house data."
  - Types:

```ts
export type CostOverview = {
  year: number
  tiles: { thisMonth: CostSummary; thisYear: CostSummary; allTime: CostSummary }
  /** The selected year's 12 Stockholm months, zero-filled. */
  months: (CostSummary & { month: number })[]
  /**
   * The first 5-minute bucket of house data (Emaldo); solar and battery count
   * from here, earlier energy is all-grid (ADR-0023). Null before any reading.
   */
  houseDataFrom: Date | null
}

/** Optional sub-timings sink (the procedure forwards it to `context.timings`). */
export type CostTimings = {
  energyMs?: number
  slotsMs?: number
  tariffMs?: number
  mixMs?: number
  houseFromMs?: number
  computeMs?: number
}

export function summarize(t: CostTotals): CostSummary {
  return { ...t, avgOre: avgOre(t), complete: isComplete(t) }
}
```

  - `loadSlots` stays as is: every mix slot is a quarter-hour inside `[floor15(first stretch start),
    ceil15(last stretch end))`, and each such quarter overlaps the stretches' span, so the slots it loads already
    cover every mix piece. Add that sentence to its comment.
  - Add the bucketing helper:

```ts
// The kWh overview buckets energy by each Zaptec interval's own start. A mix
// piece (one 15-min slot) follows the interval it starts in — or the first
// one, for the slot a session starts inside — so cost months match kWh months;
// an interval-less session's one stretch keeps it whole in its start month.
// `stretches` are ascending (listSessionEnergy orders them).
function bucketStartMs(pieceStartMs: number, stretches: readonly { startMs: number }[]): number {
  let owner = stretches[0]?.startMs ?? pieceStartMs
  for (const s of stretches) {
    if (s.startMs > pieceStartMs) break
    owner = s.startMs
  }
  return owner
}
```

  - `getCostOverview` body from the session load to the bucketing:

```ts
  // Tariffs and the house-data start don't depend on the sessions, so they load alongside them.
  const [sessions, tariffsAsc, houseDataFrom] = await Promise.all([
    timed(input.timings, 'energyMs', () =>
      listSessionEnergy({ all: true, vehicle: input.vehicle }),
    ),
    timed(input.timings, 'tariffMs', loadTariffs),
    timed(input.timings, 'houseFromMs', firstReadingAt),
  ])
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, input.timings),
    loadMix(sessions, input.timings),
  ])

  const costStart = performance.now()
  // year*100+month → that month's pieces (see `bucketStartMs`).
  const buckets = new Map<number, EnergyInterval[]>()
  for (const s of sessions) {
    for (const iv of toIntervals(s, mixes.get(s.sessionId))) {
      const { year: y, month } = stockholmYearMonth(bucketStartMs(iv.startMs, s.stretches))
      const key = y * 100 + month
      const list = buckets.get(key)
      if (list) list.push(iv)
      else buckets.set(key, [iv])
    }
  }
```

  (the `priced` map, `monthTotals`, `yearTotals`, `allTime` stay); add `houseDataFrom` to the returned `overview`.
  - `getSessionCosts`:

```ts
  const [index, mixes] = await Promise.all([
    loadSlots(sessions, input.timings),
    loadMix(sessions, input.timings),
  ])
  const costStart = performance.now()
  const costs = sessions.map((s) => ({
    sessionId: s.sessionId,
    estimated: s.estimated,
    ...summarize(priceIntervals(toIntervals(s, mixes.get(s.sessionId)), index, tariffsAsc)),
  }))
```

- [ ] **Step 4: Run, expect PASS.** `bunx vitest run src/lib/evCharging/costing.test.ts && bun run typecheck`.

- [ ] **Step 5: Commit** `feat(charging): load the energy mix into the cost read model`

---

### Task 4: The session detail carries its cash cost; economy stays grid-only

**Files:**
- Modify: `src/lib/evCharging/chargingEconomy.ts`, `src/lib/evCharging/economy/sessionEconomy.ts` (comment,
  line 64), `src/lib/evCharging/economy/schedule.ts` (doc comment, lines 85–89)
- Test: `src/lib/evCharging/chargingEconomy.test.ts`

**Interfaces:**
- Consumes: `loadMix`, `toIntervals`, `summarize`, `CostSummary`.
- Produces: `SessionEconomyDetail.cost: CostSummary`; `EconomyTimings.mixMs?: number`.

**Reviewers:** A = `code-reviewer`, B = `test-completeness`.

- [ ] **Step 1: Write the failing tests** (in `chargingEconomy.test.ts`; import `replaceForSessions` from
  `~/lib/services/energyMix` and `mixSlot` from `~test/fixtures/energyMix`):

```ts
test('getSessionEconomy carries the cash cost with the mix; the economy stays grid-only', async () => {
  await seedPrices() // local 10:xx (08:00Z–09:00Z) at 3 SEK
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 4, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 4],
  ])
  await replaceForSessions(
    [id],
    ['08:00', '08:15', '08:30', '08:45'].map((hm) => ({
      ...mixSlot(`2026-09-28T${hm}:00Z`, { gridKwh: 0.5, solarKwh: 0.5 }),
      sessionId: id,
    })),
  )
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.cost).toMatchObject({ kwh: 4, solarKwh: 2, complete: true })
  expect(d.cost.totalSek).toBeCloseTo(2 * unit(3))
  expect(d.cost.solarValueSek).toBeCloseTo(2 * 3)
  // Price timing still treats every kWh as bought.
  expect(d.economy.actual.totalSek).toBeCloseTo(4 * unit(3))
  expect(d.economy.actual.solarKwh).toBe(0)
  // The hero and the session list agree.
  const [listed] = await getSessionCosts({ sessionIds: [id] })
  expect(listed.totalSek).toBeCloseTo(d.cost.totalSek, 9)
})

test('without a mix the cash cost equals the grid-only actual', async () => {
  await seedPrices()
  const id = await session('2026-09-28T08:00:00Z', '2026-09-28T10:00:00Z', 4, [
    ['2026-09-28T08:00:00Z', '2026-09-28T09:00:00Z', 4],
  ])
  const d = await getSessionEconomy({ sessionId: id })
  expect(d.cost.totalSek).toBeCloseTo(d.economy.actual.totalSek, 9)
  expect(d.cost.noHouseDataKwh).toBeCloseTo(4)
})
```

  In `'getSessionEconomy fills its timings sink'` add `mixMs: expect.any(Number)`.

- [ ] **Step 2: Run, expect FAIL.** `bunx vitest run src/lib/evCharging/chargingEconomy.test.ts`.

- [ ] **Step 3: Implement.**
  - `chargingEconomy.ts` imports: `import { type CostSummary, summarize } from './costing'`; costInputs import
    becomes `{ loadMix, loadTariffs, timed, toIntervals }`; add `priceIntervals` to the `~/lib/evCharging/cost`
    import. Header comment: replace "Spot timing only: every kWh is treated as grid-bought." with "Spot timing only:
    the counterfactuals treat every kWh as grid-bought (ADR-0023 decision 8). A session's detail also carries its
    cash cost (the stored solar/battery mix), the page's hero."
  - `EconomyTimings` gains `mixMs?: number`.
  - `SessionEconomyDetail` gains, after `rateKw`:

```ts
  /** What the session cost in cash, solar and battery included (ADR-0023) — the hero. `economy` stays grid-only. */
  cost: CostSummary
```

  - In `getSessionEconomy` load slots and mix together, then price the cash cost in the compute block:

```ts
  const [slots, mixes] = await Promise.all([
    timed(t, 'slotsMs', () =>
      listSlotsOverlapping(SPOT_ZONE, [
        { startMs: window.startMs - CONTEXT_MS, endMs: window.endMs + CONTEXT_MS },
      ]),
    ),
    loadMix([energy], t),
  ])

  const computeStart = performance.now()
  const index = new SlotIndex(slots)
  const { economy, optimalSchedule, rateKw } = analyzeSession(session, index, tariffsAsc)
  const cost = summarize(
    priceIntervals(toIntervals(energy, mixes.get(energy.sessionId)), index, tariffsAsc),
  )
```

  and add `cost,` to `detail` (after `rateKw`). (The window ± 1 h covers every mix slot: they start at most 15 min
  before the first stretch.)
  - `economy/sessionEconomy.ts` line 64: replace the comment with

```ts
  // Grid-only on purpose (ADR-0023 decision 8, spec "Cost and display"): price
  // timing as if every kWh were bought. The cash cost with the solar/battery mix
  // is costInputs.toIntervals → costing; a solar-aware economy is a later phase.
```

  - `economy/schedule.ts` doc (line 86–88): "Returned in time order, all grid-bought (`gridShare` 1): the
    counterfactuals compare spot timing as if every kWh were bought (ADR-0023 decision 8)."

- [ ] **Step 4: Run, expect PASS.** `bunx vitest run src/lib/evCharging && bun run typecheck`.

- [ ] **Step 5: Commit** `feat(charging): add the cash cost to the session detail`

---

### Task 5: Procedures expose the new fields and timings

**Files:**
- Modify: `src/lib/orpc/procedures/evCharging.ts` (comments on `costOverview`, `sessionCosts`, `session` only)
- Test: `src/lib/orpc/procedures/tariff.test.ts` (~line 141), `src/lib/orpc/procedures/evCharging.test.ts`
  (~line 555)

**Interfaces:** Consumes Tasks 3–4. Produces nothing new in code: `recordPrefixedTimings` turns `mixMs` →
`costMixMs` / `economyMixMs` and `houseFromMs` → `costHouseFromMs`.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `better-auth-security-best-practices` (focus: these are
`protectedProcedure` reads open to non-admin members — they must expose only per-session/per-month aggregates and one
date, never house readings; no new input; no timing key leaks values).

- [ ] **Step 1: Write the failing tests.**
  `tariff.test.ts`, in `'costOverview and sessionCosts are readable by users and record cost sub-timings'`:

```ts
  expect(overview.houseDataFrom).toBeNull()
  expect(timings).toMatchObject({
    costEnergyMs: expect.any(Number),
    costSlotsMs: expect.any(Number),
    costTariffMs: expect.any(Number),
    costMixMs: expect.any(Number),
    costHouseFromMs: expect.any(Number),
    costComputeMs: expect.any(Number),
  })
```

  `evCharging.test.ts`, in `'session returns one counted session with its economy for a signed-in user'`: call
  with `{ context: { ...baseContext(), timings } }` (declare `const timings: Record<string, number> = {}`) and add

```ts
  expect(result.cost).toMatchObject({ kwh: 10, complete: true, noHouseDataKwh: 10 })
  expect(result.cost.totalSek).toBeCloseTo(result.economy.actual.totalSek, 9)
  expect(timings).toMatchObject({ economyMixMs: expect.any(Number) })
  // Aggregates only: no raw house readings ride along.
  expect(Object.keys(result).sort()).toEqual(
    ['cost', 'economy', 'intervals', 'optimalSchedule', 'prices', 'rateKw', 'session', 'window'].sort(),
  )
```

- [ ] **Step 2: Run** `bunx vitest run src/lib/orpc/procedures/tariff.test.ts src/lib/orpc/procedures/evCharging.test.ts`.
  These pass already if Tasks 3–4 are in (the procedure needs no code); if any fails, the forwarding is broken —
  fix it, don't weaken the test.

- [ ] **Step 3: Implement** (comments only): `costOverview` comment gains "Prices each session's stored
  solar/battery mix (ADR-0023): `costMixMs`, `costHouseFromMs`." `session` comment gains "Carries the cash `cost`
  (the hero) beside the grid-only `economy`; `economyMixMs`."

- [ ] **Step 4: Run, expect PASS** (same command).

- [ ] **Step 5: Commit** `test(charging): pin the cost timings and session cash cost`

---

### Task 6: Overview shows the cash cost with the own-supply share

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`, `src/components/evCharging/TotalsTiles.tsx`,
  `src/components/evCharging/MonthlyChart.tsx` (lines 110, 133), `src/components/evCharging/PriceFootnote.tsx`,
  `src/routes/_authenticated/charging/index.tsx` (lines 322, 360)
- Test: `TotalsTiles.browser.test.tsx`, `MonthlyChart.browser.test.tsx`, `SessionList.browser.test.tsx`; create
  `src/components/evCharging/PriceFootnote.browser.test.tsx`

**Interfaces:** `TotalsTiles({ tiles, cost?, houseData? })`; `PriceFootnote({ coverage? }: { coverage?: {
houseDataFrom: Date | null } })`.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Messages** (then `bun run i18n:compile`). New keys after `charging_cost_unknown_hint`; one changed.

| key | sv | en |
|---|---|---|
| `charging_cost_note` (changed) | Uppskattning inkl. moms. Fasta månadsavgifter ingår inte. | An estimate incl. VAT. Fixed monthly fees aren't included. |
| `charging_cost_note_mix` | Sol och batteri räknas från {date}. Laddning utan husdata räknas som köpt från elnätet. | Solar and battery are counted from {date}. Charging without house data counts as bought from the grid. |
| `charging_cost_note_all_grid` | All laddning räknas som köpt från elnätet: husets energidata (sol och batteri) saknas. | All charging counts as bought from the grid: the house's energy data (solar and battery) is missing. |
| `charging_cost_own_share` | {share} från sol och batteri | {share} from solar and battery |
| `charging_cost_no_house_data_hint` | Husdata saknas för {share} av laddningen, räknat som köpt från elnätet. | No house data for {share} of the charging, counted as bought from the grid. |

- [ ] **Step 2: Write the failing browser tests.**
  `TotalsTiles.browser.test.tsx` (import `formatShare` from `./format`):

```tsx
const mixed: Cost = {
  ...priced,
  kwh: 100,
  gridKwh: 66,
  fullKwh: 66,
  solarKwh: 22,
  batteryKwh: 12,
  spotSek: 41.5,
  feesSek: 63.5,
  totalSek: 105,
  avgOre: 105,
}

test('a tile with own solar and battery says the share under the cash cost', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(mixed)} houseData />,
  )
  expect(screen.getByText(/^105 kr$/).elements()).toHaveLength(3)
  expect(
    screen.getByText(m.charging_cost_own_share({ share: formatShare(0.34) })).elements(),
  ).toHaveLength(3)
})

test('no share line without own solar or battery', async () => {
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(priced)} houseData />,
  )
  expect(screen.getByText(/från sol och batteri/).elements()).toHaveLength(0)
})

test('energy without house data is said in the footer, once house data exists at all', async () => {
  const cost = { ...priced, noHouseDataKwh: 25 }
  const hint = m.charging_cost_no_house_data_hint({ share: formatShare(0.25) })
  const withData = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(cost)} houseData />,
  )
  expect(withData.screen.getByText(hint).elements()).toHaveLength(3)
  await withData.screen.unmount()
  const without = await renderWithProviders(<TotalsTiles tiles={zeroTiles} cost={allTiles(cost)} />)
  expect(without.screen.getByText(hint).elements()).toHaveLength(0)
})

test('an all-solar tile is a true 0 kr, never "price missing"', async () => {
  const solar: Cost = {
    ...priced,
    kwh: 10,
    gridKwh: 0,
    fullKwh: 0,
    solarKwh: 10,
    spotSek: 0,
    feesSek: 0,
    totalSek: 0,
    avgOre: null,
    complete: true,
  }
  const { screen } = await renderWithProviders(
    <TotalsTiles tiles={zeroTiles} cost={allTiles(solar)} houseData />,
  )
  expect(screen.getByText(/^0 kr$/).elements()).toHaveLength(3)
  expect(screen.getByText(m.charging_cost_unknown()).elements()).toHaveLength(0)
})
```

  `MonthlyChart.browser.test.tsx`:

```tsx
test('a month charged only from own solar is 0 kr, not "Pris saknas"', async () => {
  const solarJune = costMonths.map((c) =>
    c.month === 6 ? { ...c, gridKwh: 0, fullKwh: 0, solarKwh: c.kwh, spotSek: 0, feesSek: 0, totalSek: 0, avgOre: null } : c,
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 300 }}>
      <MonthlyChart months={months} cost={{ year: 2026, months: solarJune }} metric="sek" />
    </div>,
  )
  await expect.element(screen.getByText(m.charging_chart_series_spot())).toBeVisible()
  expect(screen.getByText(m.charging_chart_no_price()).elements()).toHaveLength(0)
})
```

  `SessionList.browser.test.tsx` (the list already renders `sessionCosts`, which is cash after Task 3 — pin it):

```tsx
test('a session partly charged from own solar shows its cash cost', async () => {
  const { screen } = await renderWithCost({
    ...priced,
    gridKwh: 10.26,
    fullKwh: 10.26,
    solarKwh: 4,
    totalSek: 16.3,
  })
  await expect.element(screen.getByText(/^16,30\s?kr$/)).toBeVisible()
})
```

  `PriceFootnote.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { formatDate } from './format'
import { PriceFootnote } from './PriceFootnote'

test('the overview says from when solar and battery count', async () => {
  const from = new Date('2026-01-20T06:00:00Z')
  const { screen } = await renderWithProviders(<PriceFootnote coverage={{ houseDataFrom: from }} />)
  await expect.element(screen.getByText(m.charging_cost_note())).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_cost_note_mix({ date: formatDate(from) })))
    .toBeVisible()
  await expect.element(screen.getByRole('link', { name: 'Elpriset just nu.se' })).toBeVisible()
})

test('without house data the overview says all charging counts as bought', async () => {
  const { screen } = await renderWithProviders(<PriceFootnote coverage={{ houseDataFrom: null }} />)
  await expect.element(screen.getByText(m.charging_cost_note_all_grid())).toBeVisible()
})

test('the economy views carry no coverage line', async () => {
  const { screen } = await renderWithProviders(<PriceFootnote />)
  expect(screen.getByText(/Sol och batteri räknas|All laddning räknas/).elements()).toHaveLength(0)
})
```

- [ ] **Step 3: Run, expect FAIL.** `bunx vitest run --project browser src/components/evCharging/TotalsTiles.browser.test.tsx src/components/evCharging/MonthlyChart.browser.test.tsx src/components/evCharging/PriceFootnote.browser.test.tsx src/components/evCharging/SessionList.browser.test.tsx`
  (the SessionList test passes already — it's a pin).

- [ ] **Step 4: Implement.**
  `TotalsTiles.tsx` — import `ownSupplyShare` from `~/lib/evCharging/cost` (pure, client-safe); props and
  `TileReadouts`:

```tsx
export function TotalsTiles({
  tiles,
  cost,
  houseData = false,
}: {
  tiles: Tiles
  cost?: CostTiles
  /** House data (Emaldo) exists at all, so energy without it is worth saying (ADR-0023). */
  houseData?: boolean
}) {
```

  pass `houseData` to `<TileReadouts totals={totals} cost={cost?.[key]} houseData={houseData} />`, then:

```tsx
// Cash cost (ADR-0023): own solar costs 0 kr, so a tile whose energy was all
// own solar is a true 0 kr — "no price" is judged on the bought energy only.
function TileReadouts({
  totals,
  cost,
  houseData,
}: {
  totals: Totals
  cost: Cost | undefined
  houseData: boolean
}) {
  const energy = (/* unchanged */)
  if (!cost) return energy

  const unpriced = cost.gridKwh > 0 && cost.fullKwh === 0
  // Energy counted as missing a price or tariff. Zero here with an incomplete
  // total means an over-count (overlapping slots), so "minst" would be wrong.
  const missingKwh = cost.noPriceKwh + cost.noTariffKwh
  const short = !unpriced && !cost.complete && missingKwh > 0
  const ownShare = ownSupplyShare(cost)
  const footer = tileFooter(cost, { unpriced, short, missingKwh, houseData })

  return (
    <div className="@container/tile flex flex-col gap-3">
      <div className="grid @[16rem]/tile:grid-cols-2 gap-3 @[16rem]/tile:gap-0">
        <div className="@[16rem]/tile:pr-4">{energy}</div>
        <div className="@[16rem]/tile:border-l @[16rem]/tile:pl-4">
          {unpriced ? (
            <Readout label={m.charging_tile_cost()} value="—" muted detail={m.charging_cost_unknown()} />
          ) : (
            <Readout
              label={m.charging_tile_cost()}
              qualifier={short ? m.charging_cost_min_prefix() : undefined}
              value={formatKronor(cost.totalSek)}
              unit="kr"
              detail={
                cost.kwh === 0 ? undefined : (
                  <>
                    <span>{m.charging_cost_spot_share({ spot: formatSek(cost.spotSek) })}</span>
                    {ownShare ? (
                      <span>{m.charging_cost_own_share({ share: formatShare(ownShare) })}</span>
                    ) : null}
                  </>
                )
              }
            />
          )}
        </div>
      </div>
      {footer.length > 0 ? (
        <div className="flex flex-col gap-1 border-t pt-3 text-muted-foreground text-xs">
          {footer.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function tileFooter(
  cost: Cost,
  {
    unpriced,
    short,
    missingKwh,
    houseData,
  }: { unpriced: boolean; short: boolean; missingKwh: number; houseData: boolean },
): string[] {
  const lines: string[] = []
  if (unpriced) lines.push(m.charging_cost_unknown_hint())
  else if (cost.kwh > 0) {
    if (short) lines.push(m.charging_cost_partial_hint({ share: formatShare(missingKwh / cost.kwh) }))
    else if (!cost.complete) lines.push(m.charging_cost_partial_hint_generic())
    // The average (cash per charged kWh) is shown beside a complete total only.
    else if (cost.avgOre !== null) lines.push(m.charging_cost_avg({ avg: formatOrePrecise(cost.avgOre) }))
  }
  if (houseData && cost.kwh > 0 && cost.noHouseDataKwh > 0) {
    lines.push(
      m.charging_cost_no_house_data_hint({ share: formatShare(cost.noHouseDataKwh / cost.kwh) }),
    )
  }
  return lines
}
```

  In `Readout`, the detail wrapper becomes
  `{detail ? <span className="flex flex-col text-muted-foreground text-sm">{detail}</span> : null}` (a two-line
  detail stacks; a one-line one looks as before). Update the comment above `TileReadouts` ("The footer carries what
  qualifies both: …") to mention the house-data line.

  `MonthlyChart.tsx`: line 110 → `const unpriced = (c: CostMonth) => c.gridKwh > 0 && c.fullKwh === 0` (comment:
  "bought energy with no price; all-own-solar is a true 0 kr"); line 133 denominator `c.kwh` instead of
  `c.gridKwh` ("of the charging", as the tiles say it).

  `PriceFootnote.tsx`:

```tsx
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

// How the cost is estimated, plus the attribution elprisetjustnu.se asks for
// in return for its free API. On the overview (`coverage` given) it also says
// what the cash cost counts: solar and battery from the first house data on
// (ADR-0023). The economy views omit it — they price everything as bought.
export function PriceFootnote({
  coverage,
}: {
  coverage?: { houseDataFrom: Date | null }
}) {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <p>{m.charging_cost_note()}</p>
      {coverage ? (
        <p>
          {coverage.houseDataFrom
            ? m.charging_cost_note_mix({ date: formatDate(coverage.houseDataFrom) })
            : m.charging_cost_note_all_grid()}
        </p>
      ) : null}
      <p>{/* attribution, unchanged */}</p>
    </div>
  )
}
```

  `index.tsx`: line 322 →
  `<TotalsTiles tiles={overview.tiles} cost={showCost ? cost?.tiles : undefined} houseData={cost?.houseDataFrom != null} />`;
  line 360 → `{showCost ? <PriceFootnote coverage={{ houseDataFrom: cost?.houseDataFrom ?? null }} /> : null}`.
  `showCost` stays `allTime.avgOre != null` (non-null iff something bought is priced; an all-solar history is not a
  realistic state).

- [ ] **Step 5: Run, expect PASS.** Same command as Step 3, plus
  `bunx vitest run --project browser src/routes/_authenticated/charging` and `bun run typecheck`.

- [ ] **Step 6: Commit** `feat(charging): show the cash cost and own-supply share on the overview`

---

### Task 7: Session page hero is the cash cost, with a grid / solar / battery bar

**Files:**
- Create: `src/components/evCharging/EnergySourceBar.tsx`, `src/components/evCharging/EnergySourceBar.browser.test.tsx`
- Modify: `src/components/evCharging/SessionSummary.tsx`, `SessionSummary.browser.test.tsx`,
  `src/routes/_authenticated/charging/sessions/-sessionRoute.browser.test.tsx` (`foundDetail`, ~line 147),
  `messages/{sv,en}.json`

**Interfaces:** `EnergySourceBar({ supply }: { supply: { kwh: number; solarKwh: number; batteryKwh: number;
noHouseDataKwh: number } })`; `SessionSummary({ detail: Pick<Detail, 'session' | 'economy' | 'optimalSchedule' |
'rateKw' | 'cost'> })`.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Messages** (then `bun run i18n:compile`):

| key | sv | en |
|---|---|---|
| `charging_source_grid` | Elnät | Grid |
| `charging_source_solar` | Sol | Solar |
| `charging_source_battery` | Batteri | Battery |
| `charging_session_sources_title` | Varifrån elen kom | Where the energy came from |
| `charging_session_sources_label` | Varifrån elen kom: elnät {grid} kWh, sol {solar} kWh, batteri {battery} kWh | Where the energy came from: grid {grid} kWh, solar {solar} kWh, battery {battery} kWh |
| `charging_session_no_house_data` | varav {kwh} kWh utan husdata, räknat som köpt från elnätet | of which {kwh} kWh without house data, counted as bought from the grid |
| `charging_session_no_house_data_all` | Husdata saknas för laddningen, så all el räknas som köpt från elnätet. | There's no house data for this session, so all energy counts as bought from the grid. |
| `charging_economy_grid_only_heading` | Pristajming som om all el köptes från elnätet | Price timing as if all energy were bought from the grid |

- [ ] **Step 2: Write the failing browser tests.**

```tsx
// src/components/evCharging/EnergySourceBar.browser.test.tsx
import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergySourceBar } from './EnergySourceBar'

const supply = { kwh: 56, solarKwh: 20, batteryKwh: 8, noHouseDataKwh: 0 }

test('one image summarised in its label, with every figure in the legend', async () => {
  const { screen } = await renderWithProviders(<EnergySourceBar supply={supply} />)
  const bar = screen.getByRole('img', {
    name: m.charging_session_sources_label({ grid: '28,0', solar: '20,0', battery: '8,0' }),
  })
  await expect.element(bar).toBeVisible()
  const segments = [...bar.element().querySelectorAll<HTMLElement>('[data-source]')]
  expect(segments.map((el) => el.dataset.source)).toEqual(['grid', 'solar', 'battery'])
  const widths = segments.map((el) => Number.parseFloat(el.style.width))
  expect(widths[0]).toBeCloseTo(50, 3)
  expect(widths[1]).toBeCloseTo((20 / 56) * 100, 3)
  expect(widths[2]).toBeCloseTo((8 / 56) * 100, 3)
  await expect.element(screen.getByText(m.charging_source_solar())).toBeVisible()
  await expect.element(screen.getByText('20,0 kWh')).toBeVisible()
})

test('a source without energy is left out', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ ...supply, batteryKwh: 0 }} />,
  )
  expect(screen.getByText(m.charging_source_battery()).elements()).toHaveLength(0)
})

test('no house data at all: a sentence instead of a 100 % grid bar', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ kwh: 56, solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 56 }} />,
  )
  await expect.element(screen.getByText(m.charging_session_no_house_data_all())).toBeVisible()
  expect(screen.getByRole('img').elements()).toHaveLength(0)
})

test('partly without house data says how much', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ ...supply, noHouseDataKwh: 6 }} />,
  )
  await expect
    .element(screen.getByText(m.charging_session_no_house_data({ kwh: '6,0' })))
    .toBeVisible()
})

test('no energy renders nothing', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ kwh: 0, solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 0 }} />,
  )
  expect(screen.container.textContent).toBe('')
})
```

  `SessionSummary.browser.test.tsx` — the default cash cost mirrors the grid-only actual and has **no house data**
  (so the existing tests, which query `getByRole('img')` unnamed, keep seeing only the range bar):

```tsx
type Cash = Detail['cost']
const cash = (totalSek: number, over: Partial<Cash> = {}): Cash => ({
  ...cost(totalSek),
  noHouseDataKwh: 56,
  avgOre: (totalSek / 56) * 100,
  complete: true,
  ...over,
})
```

  `detail()` gains an option `cost?: Cash` and returns `cost: over.cost ?? cash(95.13)`. Update
  `'a partial actual shows "—"…'` to also pass `cost: { ...cash(17.5), complete: false, avgOre: null }` via a new
  second argument of `excluded(reason, economy, cost?)`. Add:

```tsx
const mixedCash = cash(61.2, {
  noHouseDataKwh: 0,
  solarKwh: 20,
  batteryKwh: 8,
  gridKwh: 36,
  fullKwh: 36,
  avgOre: (61.2 / 56) * 100,
})

test('the hero is the cash cost; the timing below is headed as all-grid', async () => {
  const { screen } = await render(detail({ cost: mixedCash }))
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card).toHaveTextContent(/61,20\s?kr/)
  await expect.element(card.getByText('1,09 kr/kWh i snitt')).toBeVisible()
  const timing = screen.getByRole('region', { name: m.charging_economy_grid_only_heading() })
  await expect.element(timing.getByText(m.charging_session_verdict_ok())).toBeVisible()
  // The range bar still compares the grid-only actual.
  await expect.element(timing).toHaveTextContent(/95,13\s?kr/)
  await expect
    .element(
      screen.getByRole('img', {
        name: m.charging_session_sources_label({ grid: '28,0', solar: '20,0', battery: '8,0' }),
      }),
    )
    .toBeVisible()
})

test('an excluded session has the cash hero and no timing section', async () => {
  const d = excluded('no_hourly')
  const { screen } = await render({ ...d, cost: mixedCash })
  await expect.element(screen.getByText(/61,20/)).toBeVisible()
  expect(
    screen.getByRole('region', { name: m.charging_economy_grid_only_heading() }).elements(),
  ).toHaveLength(0)
})
```

  (`grid: '28,0'` = 56 − 20 − 8.) In `-sessionRoute.browser.test.tsx` `foundDetail`, add to `detail`:
  `cost: { ...cost(20), avgOre: 200, complete: true, noHouseDataKwh: 10 },`.

- [ ] **Step 3: Run, expect FAIL.** `bunx vitest run --project browser src/components/evCharging/EnergySourceBar.browser.test.tsx src/components/evCharging/SessionSummary.browser.test.tsx`.

- [ ] **Step 4: Implement.**

```tsx
// src/components/evCharging/EnergySourceBar.tsx
import { supplySplit } from '~/lib/evCharging/cost'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

type Supply = { kwh: number; solarKwh: number; batteryKwh: number; noHouseDataKwh: number }
type Source = 'grid' | 'solar' | 'battery'

const SOURCES: { key: Source; label: () => string; swatch: string }[] = [
  { key: 'grid', label: m.charging_source_grid, swatch: 'bg-muted-foreground' },
  { key: 'solar', label: m.charging_source_solar, swatch: 'bg-warning' },
  { key: 'battery', label: m.charging_source_battery, swatch: 'bg-success' },
]

/** Float slack for "every kWh lacks house data". */
const ALL_EPSILON_KWH = 1e-6

// Where a session's energy came from (ADR-0023): grid (incl. energy without
// house data, counted as bought), own solar, the home battery. One image
// summarised in its label; the legend carries every figure in text, so the
// colours only echo it (they needn't clear 3:1 on their own). A session with
// no house data at all gets a sentence instead of a 100 % grid bar.
export function EnergySourceBar({ supply }: { supply: Supply }) {
  if (supply.kwh <= 0) return null
  if (supply.noHouseDataKwh >= supply.kwh - ALL_EPSILON_KWH) {
    return <p className="text-muted-foreground text-sm">{m.charging_session_no_house_data_all()}</p>
  }
  const split = supplySplit(supply)
  const kwh: Record<Source, number> = {
    grid: split.gridKwh,
    solar: split.solarKwh,
    battery: split.batteryKwh,
  }
  const shown = SOURCES.filter((s) => kwh[s.key] > 0)
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-muted-foreground text-sm">
        {m.charging_session_sources_title()}
      </span>
      <div
        role="img"
        aria-label={m.charging_session_sources_label({
          grid: formatOneDecimal(kwh.grid),
          solar: formatOneDecimal(kwh.solar),
          battery: formatOneDecimal(kwh.battery),
        })}
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        {shown.map((s) => (
          <span
            key={s.key}
            data-source={s.key}
            className={cn('h-full not-last:border-r not-last:border-background', s.swatch)}
            style={{ width: `${(kwh[s.key] / supply.kwh) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', s.swatch)} />
            <span className="text-muted-foreground">{s.label()}</span>
            <span className="font-medium tabular-nums">{formatOneDecimal(kwh[s.key])} kWh</span>
          </li>
        ))}
      </ul>
      {supply.noHouseDataKwh > 0 ? (
        <p className="text-muted-foreground text-xs">
          {m.charging_session_no_house_data({ kwh: formatOneDecimal(supply.noHouseDataKwh) })}
        </p>
      ) : null}
    </div>
  )
}
```

  `SessionSummary.tsx`: `import { useId } from 'react'` (keep the type import), import `EnergySourceBar`; the
  props type adds `'cost'`. Replace the component body's card content and `Hero`:

```tsx
export function SessionSummary({
  detail,
}: {
  detail: Pick<Detail, 'session' | 'economy' | 'optimalSchedule' | 'rateKw' | 'cost'>
}) {
  const { session, economy, cost } = detail
  const cf = economy.counterfactual
  const timingHeadingId = useId()
  return (
    <div className="flex flex-col gap-3">
      <Card
        role="group"
        aria-label={m.charging_session_fig_actual()}
        className="@container gap-0 py-0"
      >
        <div className="flex flex-col gap-6 p-4 md:p-6">
          <Hero session={session} economy={economy} cost={cost} />
          <EnergySourceBar supply={cost} />
          {cf ? (
            // Price timing stays grid-only (ADR-0023 decision 8): headed so its
            // "Faktiskt" isn't read as the cash cost above.
            <section aria-labelledby={timingHeadingId} className="flex flex-col gap-6 border-t pt-5">
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <h2 id={timingHeadingId} className="max-w-prose text-pretty font-medium text-sm">
                  {m.charging_economy_grid_only_heading()}
                </h2>
                <VerdictPill verdict={timingVerdict(cf.score)} />
              </div>
              <p className="max-w-prose text-pretty text-base">
                <Sentence cf={cf} />
              </p>
              {cf.score === null ? null : <RangeBar cf={cf} actualSek={economy.actual.totalSek} />}
              <div className="grid @lg:grid-cols-2 gap-x-8 gap-y-5 border-t pt-5">
                {/* SavedTile + LeftTile, unchanged */}
              </div>
            </section>
          ) : null}
        </div>
      </Card>
      {/* the excluded Alert, unchanged */}
    </div>
  )
}

// The page's one hero figure: what the session cost in cash, own solar and
// the battery included (ADR-0023). A partial cost is "—", never the partial
// kronor; a cost priced from the total alone is "≈". The cash per charged kWh
// shows beside a complete cost of a non-excluded session only (an estimated
// session is always excluded, so the line never shows an unmarked estimate).
function Hero({
  session,
  economy,
  cost,
}: Pick<Detail, 'session' | 'economy' | 'cost'>) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium text-muted-foreground text-sm">
        {m.charging_session_fig_actual()}
      </span>
      {/* The heading face (ADR-0015), with proportional figures: tabular digits look loose at display size. */}
      <span className="font-heading font-semibold text-4xl leading-tight tracking-tight md:text-5xl">
        {cost.complete ? (
          <Estimated estimated={session.estimated}>{formatSek(cost.totalSek, 2)}</Estimated>
        ) : (
          <Unknown label={m.charging_sessions_cost_unknown()} />
        )}
      </span>
      {economy.excluded === null && cost.complete && cost.avgOre !== null ? (
        <span className="text-muted-foreground text-sm">
          {m.charging_session_kwh_unit_price({ price: formatKronor(cost.avgOre / 100, 2) })}
        </span>
      ) : null}
    </div>
  )
}
```

  Update the component doc comment: "A session's summary: what it cost in cash (with where the energy came from),
  then — grid-only — how good its timing was and what charging at other times would have cost." Re-run Biome on
  the file (`bun run check`) — the `useId` import merges with the type import.

- [ ] **Step 5: Run, expect PASS.**
  `bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging && bun run typecheck`.

- [ ] **Step 6: Commit** `feat(charging): show the cash cost and energy sources per session`

---

### Task 8: Economy page and footnotes say "as if bought from the grid"

**Files:**
- Create: `src/components/evCharging/EconomyGridOnlyLead.tsx`, `EconomyGridOnlyLead.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/economy.tsx` (before `<EconomyTiles …>`, ~line 133),
  `messages/{sv,en}.json`

**Interfaces:** `EconomyGridOnlyLead(): JSX.Element`.

**Reviewers:** A = `code-reviewer`, B = reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

- [ ] **Step 1: Messages** (then `bun run i18n:compile`):

| key | sv | en |
|---|---|---|
| `charging_economy_grid_only_lead` | Sol och batteri ingår inte här – vad laddningen faktiskt kostade visas på översikten. | Solar and battery aren't included here — what charging actually cost is on the overview. |
| `charging_economy_caveat` (changed) | Pristajmingen räknar all el som köpt från elnätet, så sol och batteri ingår inte i den. Den fördelar varje timmes energi jämnt över timmens prisperioder, och laddtakten är en timmedel, så ”Kvar att hämta” kan vara något över- eller underskattat. | Price timing counts all energy as bought from the grid, so solar and battery aren't part of it. It spreads each hour's energy evenly over the hour's price periods, and the charge rate is an hourly average, so “Left on the table” may be somewhat over- or understated. |

- [ ] **Step 2: Failing test.**

```tsx
// src/components/evCharging/EconomyGridOnlyLead.browser.test.tsx
import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EconomyGridOnlyLead } from './EconomyGridOnlyLead'

test('says the economy counts all energy as bought, and where the cash cost is', async () => {
  const { screen } = await renderWithProviders(<EconomyGridOnlyLead />)
  await expect
    .element(screen.getByText(m.charging_economy_grid_only_heading(), { exact: false }))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_economy_grid_only_lead(), { exact: false })).toBeVisible()
})
```

  Run `bunx vitest run --project browser src/components/evCharging/EconomyGridOnlyLead.browser.test.tsx` → FAIL.

- [ ] **Step 3: Implement.**

```tsx
// src/components/evCharging/EconomyGridOnlyLead.tsx
import { m } from '~/paraglide/messages'

// The economy view measures price timing as if every kWh were bought from the
// grid (ADR-0023 decision 8). Said up front, so its kronor aren't read as what
// charging cost — that's the overview's cash cost.
export function EconomyGridOnlyLead() {
  return (
    <p className="max-w-prose text-pretty text-muted-foreground text-sm">
      <span className="font-medium text-foreground">{m.charging_economy_grid_only_heading()}.</span>{' '}
      {m.charging_economy_grid_only_lead()}
    </p>
  )
}
```

  In `economy.tsx`, first child of the `sessions > 0` wrapper: `<EconomyGridOnlyLead />` (import it). The session
  page's footnote (`EconomyFootnote` → `PriceFootnote` without `coverage`) now reads the neutral
  `charging_cost_note` plus the reworded caveat — no code change.

- [ ] **Step 4: Run, expect PASS.** `bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging`.

- [ ] **Step 5: Commit** `feat(charging): label the economy views as grid-only`

---

### Task 9: Docs — ADR-0020 amendment, spec as-built notes, code map

**Files:** `docs/adr/0020-spot-prices-and-cost-model.md`, `docs/superpowers/specs/2026-10-03-ev-charging-solar-cost-design.md`,
`docs/superpowers/roadmaps/2026-10-03-ev-charging-solar-cost.md` (row 4 `in progress`), `CLAUDE.md`.
**Reviewers:** A = `code-reviewer` (docs match the code); B = none (docs only).

- [ ] **Step 1: ADR-0020.** Replace the Consequences bullet "Cost is an **upper bound** today: …" with:

```markdown
- Cost was an **upper bound** until ADR-0023 (2026-10): all charging counted as grid-bought. Since then the cash
  cost prices each session's stored solar/battery mix on read; a session without house data is still priced as
  grid-bought, and the page says how much ("utan husdata"). Zaptec's hourly intervals still can't resolve cheaper
  quarters inside an hour, though the mix's load-shaped spread narrows it. The economy counterfactuals remain
  grid-only (spot timing), labelled so.
```

  and append to the `gridShare` bullet (line 53): "Since ADR-0023 a piece may instead carry a `mix` (grid / solar /
  battery parts); `gridShare` is then 1 and ignored. The economy keeps `gridShare` 1."

- [ ] **Step 2: Spec.** Under "Cost and display", after "Step 4: cash cost on screen.", add "**As built (step 4,
  2026-10):**" with one bullet per item of this plan's "Decisions this plan makes" (1–6) and "`CostTotals` also
  carries `solarPricedKwh` / `solarUnpricedKwh` (contract Amendment A)."

- [ ] **Step 3: CLAUDE.md** code map, `evCharging/` line: "cost read model (costing.ts) over the pure cost/ math"
  → "cost read model (costing.ts: prices each session's stored solar/battery mix, ADR-0023) over the pure cost/
  math". Roadmap row 4 → `in progress`.

- [ ] **Step 4: Commit** `docs(charging): record the cash cost in ADR-0020 and the spec`

---

### Task 10: Branch review (feature-workflow Phase 5)

- [ ] **Gates that apply:**
  - Schema / `drizzle/`: none expected — confirm `git diff --stat origin/main -- drizzle src/lib/db/schema` is
    empty (if not, migration-guard + schema-design review become mandatory).
  - Service-like / pure modules changed (`cost/`, `costInputs.ts`, `costing.ts`, `chargingEconomy.ts`) →
    `test-completeness` (agent) over the branch diff.
  - Always → `code-reviewer` (agent) + `/code-review high` on the branch.
  - Permission boundary: the `protectedProcedure` reads now return more fields to non-admin members → a security
    pass (`/security-review`), focused on "no raw house readings, only aggregates and one date".
  - UI → one reviewer loading `web-design-guidelines` + `vercel-react-best-practices` over `TotalsTiles`,
    `EnergySourceBar`, `SessionSummary`, `PriceFootnote`, `EconomyGridOnlyLead`, `MonthlyChart`.
- [ ] Tell every reviewer to assume the branch is wrong; point them at "Review Focus". Fix or explicitly rule on
  every finding in this PR (one hat per commit, e.g. `fix(charging): …`).

---

### Task 11: Pre-PR gate + live verification

- [ ] **Gate** (from `docs/feature-workflow.md`):

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

- [ ] **Local data with a mix.** First `grep -n DATABASE_URL .env.local` must show nothing (else delete those
  lines — CLAUDE.md gotcha). `bun run dev:up`, `bun run dev:worker` (separate shell), `bun run dev`; sign in at
  http://localhost:14600 with an `INITIAL_ADMIN_EMAILS` address (magic link in Mailpit, http://localhost:14602).
  Sessions: set `ZAPTEC_ADAPTER=fake` in `.env.local` (or real Zaptec creds), then **Synka nu** (also pulls elpris).
  Add a tariff period from 2025-01-01 if none. Then pick one:
  - **A — real house data (preferred for the owner's eye, never for the PR):** put the four `EMALDO_*` values in
    `.env.local`, press **Synka nu**; the Emaldo sync (step 2) triggers the derive (step 3). Note: a login ends the
    Emaldo account's other sessions, so prod's next cron run re-logs in (expected, one extra login). Real readings
    stay in the local DB: no screenshots of these figures in the PR.
  - **B — synthetic (for screenshots and the PR):** save as `$SCRATCH/seed-mix.sql` (your scratchpad, never the
    repo) and run `docker compose exec -T db psql -U videbacken -d videbacken -v ON_ERROR_STOP=1 < $SCRATCH/seed-mix.sql`.
    Check the column names against `src/lib/db/schema/houseEnergy.ts` first (Task 0).

```sql
-- Synthetic mix for every local session with intervals: midday 35 % solar, 5 % battery-grid,
-- 10 % battery-solar; otherwise 10 % battery-grid. Never real readings.
BEGIN;
DELETE FROM ev_charge_energy_mix;
WITH pieces AS (
  SELECT i.session_id, q.slot_start,
         i.energy_kwh
           * EXTRACT(EPOCH FROM LEAST(i.end_at, q.slot_start + interval '15 minutes') - GREATEST(i.start_at, q.slot_start))
           / EXTRACT(EPOCH FROM i.end_at - i.start_at) AS kwh
  FROM ev_charge_interval i
  CROSS JOIN LATERAL generate_series(
    date_bin('15 minutes', i.start_at, timestamptz '2000-01-01 00:00Z'),
    i.end_at - interval '1 microsecond',
    interval '15 minutes') AS q(slot_start)
  WHERE i.end_at > i.start_at
), slots AS (
  SELECT session_id, slot_start, sum(kwh) AS kwh,
         extract(hour FROM slot_start AT TIME ZONE 'Europe/Stockholm') AS h
  FROM pieces GROUP BY session_id, slot_start
), parts AS (
  SELECT session_id, slot_start, kwh,
    CASE WHEN h BETWEEN 10 AND 15 THEN kwh * 0.35 ELSE 0 END AS solar,
    CASE WHEN h BETWEEN 10 AND 15 THEN kwh * 0.05 ELSE kwh * 0.10 END AS battery_grid,
    CASE WHEN h BETWEEN 10 AND 15 THEN kwh * 0.10 ELSE 0 END AS battery_solar
  FROM slots
)
INSERT INTO ev_charge_energy_mix (session_id, slot_start, kwh, grid_kwh, solar_kwh, battery_grid_kwh,
  battery_grid_spot_sek, battery_solar_kwh, battery_solar_spot_sek, battery_unpriced_kwh, no_house_data_kwh)
SELECT session_id, slot_start, kwh, kwh - solar - battery_grid - battery_solar, solar, battery_grid,
       CASE WHEN battery_grid > 0 THEN 0.40 END, battery_solar,
       CASE WHEN battery_solar > 0 THEN 0.30 END, 0, 0
FROM parts;
-- First house data: one empty bucket a week before the first session.
INSERT INTO house_energy_reading (bucket_start, grid_import_kwh, grid_export_kwh, solar_kwh, load_kwh,
  battery_discharge_kwh, battery_charge_solar_kwh, battery_charge_grid_kwh, battery_charge_ac_kwh)
SELECT date_bin('5 minutes', min(start_at) - interval '7 days', timestamptz '2000-01-01 00:00Z'), 0, 0, 0, 0, 0, 0, 0, 0
FROM ev_charge_session ON CONFLICT DO NOTHING;
-- The newest session has no mix ("utan husdata"); the second newest gets a stale mix (guard → all grid + warning).
DELETE FROM ev_charge_energy_mix
 WHERE session_id = (SELECT id FROM ev_charge_session ORDER BY start_at DESC LIMIT 1);
UPDATE ev_charge_energy_mix m SET kwh = m.kwh + 0.5, grid_kwh = m.grid_kwh + 0.5
  FROM (SELECT session_id, min(slot_start) AS slot_start FROM ev_charge_energy_mix
         WHERE session_id = (SELECT id FROM ev_charge_session ORDER BY start_at DESC OFFSET 1 LIMIT 1)
         GROUP BY session_id) t
 WHERE m.session_id = t.session_id AND m.slot_start = t.slot_start;
COMMIT;
```

- [ ] **Look (claude-in-chrome or the playwright plugin), at 360, 820 and 1600 px wide, light and dark:**
  - `/charging`: tiles show the cash cost, "N % från sol och batteri" on tiles with a mix, the "Husdata saknas för
    …" footer line where the newest/stale sessions fall, the footnote "Sol och batteri räknas från {date}"; the kr
    chart has no "Pris saknas" stub for priced months; the session list costs are lower for midday sessions.
  - `/charging/sessions/<midday id>`: hero = cash, bar with three segments + legend, the grid-only timing section
    under its heading; `<newest id>`: the "Husdata saknas för laddningen…" sentence; `<stale id>`: same (fallback)
    and one `cost: energy mix ignored` line in the dev server log.
  - `/charging/economy`: the lead line above the tiles; figures unchanged from `main` (spot timing).
  - No horizontal scroll at 360 px; the legend wraps; the bar is full width.
- [ ] Clean up: `DELETE FROM ev_charge_energy_mix; DELETE FROM house_energy_reading;` (B only).

---

### Task 12: Roadmap row and PR

- [ ] Roadmap row 4: PR link + status `PR open`; add a Log line "2026-10-xx: step 4 PR opened (cash cost)". Commit
  `docs(charging): mark solar cost step 4 as PR open`.
- [ ] `git push -u origin feat/charging-solar-cash-cost` and open the PR with `.github/PULL_REQUEST_TEMPLATE.md`:
  - **Title:** `feat(charging): price charging with solar and battery`
  - **Why:** charging was priced as all-grid (an upper bound); ADR-0023 step 4 prices the stored mix on read so
    `/charging` shows the cash cost. Link ADR-0023 + the roadmap.
  - **What changed:** cost math (mix pieces, new totals, cash avg), mix + house-data start in the read models,
    session hero + source bar, own-supply subline, grid-only economy labels, ADR-0020 amendment.
  - **Verification:** paste the gate output; describe the live check (synthetic data, three widths, both themes);
    screenshots only from synthetic data.
  - **Risks / follow-ups:** cost months use the piece's own interval (rare split if a Zaptec interval isn't
    hour-aligned at a month boundary); step 5 shows `solarValueSek`; solar-aware economy is a later phase.
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 13: STOP — checkpoint 4

Do not start step 5. After the owner merges, set row 4 to `merged`. The checkpoint (roadmap) is the owner's, on
prod, live: they review `/charging` —
- a sunny midday session is clearly cheaper than before; a winter night session is roughly unchanged;
- the notice ("Sol och batteri räknas från …") and the grid-only economy label read right;
- responsive at mobile, tablet and desktop.

Record the result in the roadmap's table (row 4 → `checkpoint passed` with a one-line result), in a small
`docs(charging): …` PR or in step 5's PR if the owner says so.
