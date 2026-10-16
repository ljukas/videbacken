# Heat pumps, step 4b: Energisignatur — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended by step 2b (2026-10-15).** Nothing changes in this plan's tasks: its day reads come through step 3's
> `daySums` (`heatPump.days`), which now reads the `heat_pump_day` materialized view (ADR-0027 decision 6, amended).
> Tests that store readings refresh the view (the `storeHours` fixture does).

**Goal:** An Energisignatur card on Energi › Värmepumpar that, per unit and around a logged event, fits the days
before the event (daily kWh against indoor − outdoor ΔT) and says how the days after compare at the same ΔT, or says
plainly that there isn't enough data yet.

**Architecture:** A pure, client-safe `src/lib/heatPump/signature.ts` (test-first, hand-computed expectations) holds
the rules: which days qualify, which event is shown, which days to fetch, and the fit (`simple-statistics`'
`linearRegression`, tree-shaken to under 1 KB gz) with its readout. `EnergySignatureSection` owns the state (unit,
event) and the reads: step 3's months query (units, first reading day), step 4a's event list, and the event's day
range from `heatPump.days` in parallel chunks of ≤ `HEAT_PUMP_DAYS_MAX` days. It hands a computed `SignatureResult` to
the presentational `EnergySignature` card (unit toggle, event select, readout, honesty note, table), which draws a visx
scatter (`SignatureScatter`, geometry in a pure `signatureChart.ts`). No server change.

**Tech Stack:** TypeScript, `simple-statistics` 7.12 (new), d3-array / d3-scale, visx (`@visx/axis`, `@visx/grid`,
`@visx/group`, `@visx/responsive`), TanStack Query (`useQuery`, `useQueries`) + oRPC, shadcn (Radix `Select`,
`ToggleGroup`), Paraglide, Vitest (node + browser), boneyard-js skeletons.

**Spec:** [`docs/superpowers/specs/2026-10-08-heat-pumps-design.md`](../specs/2026-10-08-heat-pumps-design.md)
("Energi › Värmepumpar" → **Energisignatur**, "Testing") · ADR: [`docs/adr/0027-heat-pump-energy-data.md`](../../adr/0027-heat-pump-energy-data.md)
(decision 9) · Roadmap: [`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`](../roadmaps/2026-10-08-heat-pumps.md)
(step 4b, checkpoint 6) · Shared contract: the six-planner brief (step 4b types, step 3's `HeatPumpDaysOutput`,
step 4a's `HeatPumpEventDto`).

## Decisions (ruled 2026-10-08; the spec carries them, this plan doesn't amend it)

1. **Library: `simple-statistics`** for the OLS fit (decision rule in Task 2). Residual SD and the margin are four
   lines on top, written here.
2. **Residual SD uses n − 2 degrees of freedom** (`s = √(Σ residual² ÷ (n − 2))`): the line spends two parameters.
3. **"All expected hours present" = every hour of the Stockholm day** (`hours === expectedHours` **and**
   `hours ===` the day's length from `stockholmDayBounds`: 23, 24 or 25). Step 3 clips `expectedHours` to the newest
   stored hour and the first reading, so today's partial day and a unit's first day would otherwise count as complete.
4. **Unit off → not a heating day** (owner): a qualifying day also needs heating kWh ≥ 50 % of the day's kWh
   (`heatKwh ÷ kwh ≥ 0,5`; a switched-off unit reports heat share 0, an idling unit in heat mode 1). `SignatureDay`
   gains `heatKwh`.
5. **Markers:** before = filled circle, after = filled square, extrapolated after-day = hollow square.
6. **Default event:** the unit's latest `service`; with no service, its latest event of any kind; with none, a
   "no event yet" line instead of the chart. Switching unit resets to that unit's default (spec); a chosen event that doesn't apply to the unit also falls back to the default
   (`energySignature` throws for a foreign event; the section never passes one).
7. **`afterFit`** = OLS over the counted (non-extrapolated) after-days, `null` when they span < 1 °C of ΔT; each line
   drawn over its own set's ΔT range only.
8. **Σ predicted ≤ 0** (degenerate data) → `not_enough_before`.
9. **Data range:** per event, from 400 days before it (not before the first reading) to the unit's next event or
   today, fetched in parallel chunks of ≤ `HEAT_PUMP_DAYS_MAX` (800) days and concatenated. The procedure's cap stays.
10. **Displayed percentages:** the change as a whole percent (rounding to 0 % reads "ingen skillnad"); the margin
    rounded **up** to a whole percent ("±1 %" at least). Raw values on the readout as `data-change` / `data-margin`.
11. **"Not enough before" copy:** fewer than 14 days → "(k av 14 dagar)"; 14 or more (too narrow a ΔT spread, or
    decision 8) → "dagarna före ger ingen användbar linje (…minst 4 °C)".
12. **Colours:** `--signature-before` blue `#2a78d6` / dark `#3987e5`, `--signature-after` orange `#eb6834` / dark
    `#d95926` (validated `--pairs all` in both themes; Task 3 re-runs it with step 2's heat-pump tokens). Units are
    ordered with step 2's `byHeatPumpName` and their toggle swatches use step 2's `heatPumpColor`.

## Global Constraints

- Only daily sums reach the browser (ADR-0027 decision 6): the section reads `heatPump.months`, `heatPump.days` and `heatPump.events.list`, nothing else; no new procedure, no schema change.
- `src/lib/heatPump/signature.ts` is pure and client-safe: no import of services, `db`, effects or `node:*`; only `import type` from `./events`; guarded by a client-safe browser test.
- Qualifying day: every hour present; cooling kWh ≤ 2 % of the day's kWh; heating kWh ≥ 50 % of the day's kWh; indoor and outdoor means present; ΔT = mean indoor − mean outdoor ≥ 3 °C; not an event day for that unit.
- Events for a unit = its own + Båda (`heatPumpId === null`). Before set: qualifying days after the previous event for the unit (or from the first reading) up to the event, the latest 90. After set: qualifying days from the day after the event up to the next event (or today).
- Fit: OLS kWh = a + b·ΔT on the before set; needs ≥ 14 days spanning ≥ 4 °C. After-days outside the before set's ΔT range are hollow and left out. ≥ 14 counted after-days: change = (Σ actual − Σ predicted) ÷ Σ predicted; margin = 1,96 × s × √n ÷ Σ predicted.
- States `not_enough_before` / `not_enough_after` / `ok` exactly as the brief's `SignatureResult`; `fit` is `{ a: intercept, b: slope }` (simple-statistics returns `{ m: slope, b: intercept }`: map it, never pass it through).
- Fetch range: max(event − 400 days, first reading day) … min(next event for the unit, today), in chunks of ≤ `HEAT_PUMP_DAYS_MAX` days (imported from step 3's `src/lib/heatPump/period.ts`, never a literal).
- Axis labels "Inne − ute (°C)" / "kWh per dygn"; copy "N % lägre/högre förbrukning vid samma temperaturskillnad", "Inte tillräckligt med data än (k av 14 dagar)", "inte tillräckligt med data före händelsen" as in the spec; Swedish copy exactly as written in this plan.
- Paraglide sv (source) + en key-complete; "Videbacken" untranslated; URL stays `/energy/heat-pumps`.
- New dependency pinned exact (`"simple-statistics": "7.12.1"`, like d3/visx); imported by name only (tree-shaken).
- Responsive at 1440, 820, 390 px; the card's box doesn't change height when switching unit or event, loading included (fixed chart height or a same-height placeholder, reserved readout line, always-present legend).
- The chart is `aria-hidden`; the readout sentence and "Visa som tabell" are the accessible path (dataviz: identity never by colour alone).
- Conventional Commits; `git add <paths>`, never `-A`. PR title `feat(heat-pumps): add the energy signature`.

## Review Focus

1. **Today's partial day and the DST days.** At 10:00 today has 10 stored hours and step 3 reports 10 expected hours;
   it must not qualify. 2026-10-25 (25 h) with 24 hours must not qualify; with 25 it must; 2026-03-29 (23 h) with 23
   must. Pinned in Task 1 (`qualifyingDays` tests, run with `TZ=UTC` too).
2. **An event logged for the other unit, or for Båda, inside the before window.** Övervåning's filter cleaning must
   neither cut Matsal's window nor drop that day; a Båda event must do both. Pinned in Task 2.
3. **Switching unit after choosing an event.** The section resets to the new unit's default event (spec), also
   when the chosen event is a Båda one that applies to both, and never passes a foreign event. Pinned in Task 1
   (`selectedEventId`) and Task 5 (two section browser tests).
4. **Two events on the same day** (Båda service + Matsal filter on 2026-01-20). Neither cuts the other's window to
   nothing: previous/next events are strictly earlier/later days. Pinned in Task 2.
5. **An event old enough that its range exceeds 800 days.** The days arrive in two chunks; the signature must see
   both (before-days in one, after-days in the other). Pinned in Task 1 (`signatureChunks`) and Task 5 (section test).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/heatPump/signature.ts` (create) | Types, constants, `qualifyingDays`, `eventsForUnit`, `defaultEventId`, `selectedEventId`, `signatureRange`, `signatureChunks`, `energySignature` |
| `src/lib/heatPump/signature.test.ts` (create) | Node tests, hand-computed |
| `src/components/heatPump/signatureChart.ts` (+ `.test.ts`) (create) | Pure scatter geometry: `fitSegment`, `signatureSegments`, `signatureDomains`, `nearestPoint` |
| `src/components/heatPump/SignatureScatter.tsx` (+ `.browser.test.tsx`) (create) | The visx scatter, legend, hover card |
| `src/components/heatPump/EnergySignature.tsx` (+ `.browser.test.tsx`) (create) | The presentational card: unit toggle, event select, readout, note, table, loading state |
| `test/fixtures/heatPumpSignature.ts` (create) | Synthetic day rows shared by the card and section tests |
| `src/components/heatPump/EnergySignatureSection.tsx` (+ `.browser.test.tsx`) (create) | State, the three reads (days in chunks), `SectionSkeleton`, `LoadErrorAlert` |
| `src/routes/_authenticated/energy/heat-pumps.tsx` (modify) | The events query deferred in the loader; mounts the section between Förbrukning and Händelser |
| `src/styles/app.css` (modify) | `--signature-before`, `--signature-after` (light + dark + `@theme inline`) |
| `src/lib/houseEnergy/clientSafe.browser.test.tsx` **or** `src/lib/heatPump/clientSafe.browser.test.tsx` (modify) | Guard for `signature.ts` (Task 0 decides which file) |
| `scripts/measureBundle.ts` (modify) | `simple-statistics` in `WATCHED` (and the page, if step 3 didn't add it) |
| `src/bones/heat-pumps-signature.bones.json` (generate) | The section's skeleton |
| `messages/sv.json`, `messages/en.json` (modify) | `heat_pump_signature_*` |
| `package.json`, `bun.lock` (modify) | `simple-statistics` |
| `docs/superpowers/roadmaps/2026-10-08-heat-pumps.md` (modify) | Row 4b → `PR open`; checkpoint 6 links this plan's reproduction section |
| `CLAUDE.md` (modify) | Code map: `src/lib/heatPump/signature.ts`; Stack: the `simple-statistics` dependency |

---

### Task 0: Check `main` still matches this plan; worktree

- [ ] **Step 1: Check what the plan builds on**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "| 4a |" docs/superpowers/roadmaps/2026-10-08-heat-pumps.md                       # checkpoint passed
grep -n "HEAT_PUMP_EVENT_KINDS\|export type HeatPumpEventKind\|export type HeatPumpEventDto" src/lib/heatPump/events.ts
grep -n "occurredOn\|heatPumpId: string | null" src/lib/heatPump/events.ts
grep -n "export const HEAT_PUMP_DAYS_MAX" src/lib/heatPump/period.ts                    # = 800, client-safe
grep -n "export function byHeatPumpName" src/lib/houseEnergy/figures.ts                 # (a, b) comparator
grep -n "export function heatPumpColor" src/lib/houseEnergy/heatPumpColors.ts           # (units, id) => string
grep -n "export const heatPumpMonthsQueryFor\|export const heatPumpDaysQuery\b\|export const HEAT_PUMP_STALE_TIME" src/components/heatPump/heatPumpQueries.ts
grep -n "firstReadingDay\|units:" src/lib/services/heatPump/heatPumpRead.ts | head
grep -n "heatKwh\|coolKwh\|insideC\|outsideC\|expectedHours" src/lib/services/heatPump/heatPumpRead.ts | head
grep -n "avg(\|inside_c\|outside_c\|heat_share" src/lib/services/heatPump/heatPump.ts | head   # daySums' definitions
grep -n "heatPump" src/lib/orpc/router.ts
ls src/routes/_authenticated/energy/ src/components/heatPump/
grep -n "loadRouteData\|critical\|deferred\|HeatPumpEvents\|heatPumpMonthsQueryFor\|SectionSkeleton" src/routes/_authenticated/energy/heat-pumps.tsx
grep -rn "events.list.queryOptions" src/components/heatPump/ src/routes/ | head
grep -n "heat_pump_event_kind\|heat_pump_events_kind" messages/sv.json | head            # step 4a's kind labels
grep -n "export function eventKindLabel" src/components/heatPump/eventCopy.ts                # step 4a
grep -n "energy-heat-pump-[123]" src/styles/app.css
ls src/lib/heatPump/ src/lib/houseEnergy/ | grep -i clientSafe
grep -n "heat-pumps" scripts/captureBones.ts scripts/measureBundle.ts
grep -n "simple-statistics" package.json || echo "not installed (expected)"
npm view simple-statistics version time.modified
```

Expected: row 4a is `checkpoint passed`; `events.ts` exports the three names with `occurredOn: string` and
`heatPumpId: string | null`; `HEAT_PUMP_DAYS_MAX = 800` in `period.ts`; `byHeatPumpName(a, b)` in `figures.ts` and
`heatPumpColor(units, id)` in `heatPumpColors.ts` (step 2); step 3's `heatPumpQueries.ts` exports
`heatPumpMonthsQueryFor(period | null)` and `heatPumpDaysQuery({ from, to })`; the months output carries
`units: { id, name }[]` and `firstReadingDay: string | null`; the days rows carry `heatKwh`; the route loads
`heatPumpMonthsQueryFor(…)` as critical and mounts Förbrukning and `HeatPumpEvents`. Record:

- **A moved helper.** If `byHeatPumpName`, `heatPumpColor` or step 3's query builders live elsewhere or have another
  shape, adapt Task 4/5's imports and calls (e.g. a `heatPumpColor(index)` form: pass the unit's index in the sorted
  list) and note it in the PR. Never redefine them.
- **Events query.** Step 4a reads `orpc.heatPump.events.list.queryOptions()`; the section uses the same call, so both
  share one cache entry (and 4a's invalidation after an edit). If 4a exported a named builder, import that instead.
- **Kind labels.** Step 4a ships `eventKindLabel(kind)` in `~/components/heatPump/eventCopy` with the
  `heat_pump_event_kind_*` messages ("Service", "Filterrengöring", "Inställning", "Annat"); Task 4 imports it. If it
  moved, import it from where it is; never re-add kind messages here.
- **Client-safe guard file.** If `src/lib/heatPump/clientSafe.browser.test.tsx` exists, Task 1 adds its test there;
  otherwise to `src/lib/houseEnergy/clientSafe.browser.test.tsx`.
- **Day definitions.** Note how step 3's `daySums` averages indoor/outdoor (`avg()` over non-null hours, or null
  when any hour is null) and computes `heatKwh` (Σ kWh × heat share, nulls as 0). The checkpoint 6 SQL at the end of
  this plan must use the same definitions: change its lines to match if step 3 differs.
- **simple-statistics.** If a version newer than 7.12.1 exists, read its changelog; take it unless `linearRegression`'s
  signature (`(data: readonly number[][]) => { m: number; b: number }`) changed, and use that version everywhere this
  plan says 7.12.1.

- [ ] **Step 2: Worktree**

```bash
git worktree add .claude/worktrees/heat-pumps-signature -b feat/heat-pumps-signature origin/main
cd .claude/worktrees/heat-pumps-signature && bun install && bun run db:up && bun run db:migrate
```

Port 14610 is often another session's dev server: run this worktree's dev server on 14611
(`BETTER_AUTH_URL=http://localhost:14611 bun run dev -- --port 14611`) and pass `BONES_ORIGIN=http://localhost:14611`
to `bones:capture`.

---

### Task 1: The inputs: qualifying days, event rules, fetch range (`signature.ts`, part 1)

**Reviewers:** `code-reviewer` + `test-completeness` (both told: assume the rules are wrong; check each against the
spec's "Qualifying day" and "Event" bullets and the rulings above, the range's clipping, the chunk boundaries, and that
`TZ=UTC` doesn't change a result).

**Files:**
- Create: `src/lib/heatPump/signature.ts`, `src/lib/heatPump/signature.test.ts`
- Modify: the client-safe guard file chosen in Task 0

**Interfaces:**
- Consumes: `type HeatPumpEventDto = { id: string; occurredOn: string; heatPumpId: string | null; kind: HeatPumpEventKind; note: string | null }`
  from `src/lib/heatPump/events.ts` (step 4a); `HEAT_PUMP_DAYS_MAX` from `src/lib/heatPump/period.ts` (step 3);
  `stockholmDayBounds`, `addDays(day, n)` from `~/lib/time/stockholm`.
- Produces (later tasks rely on these exact names):
  - `type SignatureDay = { day: string; kwh: number; heatKwh: number; coolKwh: number; insideC: number | null; outsideC: number | null; hours: number; expectedHours: number }`
  - `type SignaturePoint = { day: string; deltaT: number; kwh: number; set: 'before' | 'after'; extrapolated: boolean }`
  - `type SignatureFit = { a: number; b: number }` (a = intercept, b = slope)
  - `type SignatureResult` (the brief's union, with `fit: SignatureFit`)
  - `type QualifyingDay = SignatureDay & { deltaT: number }`
  - constants `SIGNATURE_MIN_DAYS = 14`, `SIGNATURE_MIN_SPAN_C = 4`, `SIGNATURE_MAX_BEFORE_DAYS = 90`,
    `SIGNATURE_MIN_DELTA_T_C = 3`, `SIGNATURE_MAX_COOL_SHARE = 0.02`, `SIGNATURE_MIN_HEAT_SHARE = 0.5`,
    `SIGNATURE_MIN_AFTER_LINE_SPAN_C = 1`, `SIGNATURE_LOOKBACK_DAYS = 400`
  - `qualifyingDays(days: readonly SignatureDay[], eventDays: ReadonlySet<string>): QualifyingDay[]`
  - `eventsForUnit(events: readonly HeatPumpEventDto[], heatPumpId: string): HeatPumpEventDto[]` (oldest first)
  - `defaultEventId(events: readonly HeatPumpEventDto[], heatPumpId: string): string | null`
  - `selectedEventId(events: readonly HeatPumpEventDto[], heatPumpId: string, chosenId: string | null): string | null`
  - `signatureRange(input: { events: readonly HeatPumpEventDto[]; heatPumpId: string; eventId: string; firstReadingDay: string | null; today: string }): { from: string; to: string }`
  - `signatureChunks(from: string, to: string, maxDays?: number): { from: string; to: string }[]`

- [ ] **Step 1: Write the failing tests** (`src/lib/heatPump/signature.test.ts`)

```ts
import { describe, expect, test } from 'vitest'
import type { HeatPumpEventDto } from './events'
import { HEAT_PUMP_DAYS_MAX } from './period'
import {
  defaultEventId,
  eventsForUnit,
  qualifyingDays,
  type SignatureDay,
  selectedEventId,
  signatureChunks,
  signatureRange,
} from './signature'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'

// A complete, heating-only day: 24 of 24 hours, all heat, no cooling, ΔT = 21 − 5 = 16.
const day = (d: string, over: Partial<SignatureDay> = {}): SignatureDay => ({
  day: d,
  kwh: 10,
  heatKwh: 10,
  coolKwh: 0,
  insideC: 21,
  outsideC: 5,
  hours: 24,
  expectedHours: 24,
  ...over,
})
const event = (over: Partial<HeatPumpEventDto> & { id: string; occurredOn: string }): HeatPumpEventDto => ({
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})
const none = new Set<string>()
const daysOf = (list: { day: string }[]) => list.map((d) => d.day)

describe('qualifyingDays', () => {
  test('a complete heating day qualifies, with ΔT = mean indoor − mean outdoor', () => {
    const [d] = qualifyingDays([day('2026-01-10', { insideC: 21.5, outsideC: -3.25 })], none)
    expect(d.deltaT).toBe(24.75)
    expect(d.kwh).toBe(10)
  })

  test('a missing hour fails the day', () => {
    expect(qualifyingDays([day('2026-01-10', { hours: 23 })], none)).toEqual([])
  })

  test('every hour of the Stockholm day, not just the expected ones: today and the DST days', () => {
    const days = [
      // Today at 10:00: 10 stored hours, and step 3 clips expectedHours to the newest stored hour.
      day('2026-10-08', { hours: 10, expectedHours: 10 }),
      // 2026-10-25 has 25 hours (DST ends).
      day('2026-10-25', { hours: 24, expectedHours: 24 }),
      day('2026-10-26', { hours: 24, expectedHours: 24 }),
      // 2026-03-29 has 23 hours (DST starts).
      day('2026-03-29', { hours: 23, expectedHours: 23 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-10-26', '2026-03-29'])
    expect(daysOf(qualifyingDays([day('2026-10-25', { hours: 25, expectedHours: 25 })], none))).toEqual([
      '2026-10-25',
    ])
  })

  test('cooling up to 2 % of the day is allowed, more is not', () => {
    const days = [
      day('2026-04-01', { kwh: 10, heatKwh: 9.8, coolKwh: 0.2 }),
      day('2026-04-02', { kwh: 10, heatKwh: 9.79, coolKwh: 0.21 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-04-01'])
  })

  test('a unit switched off is not a heating day; one idling in heat mode is', () => {
    const days = [
      // Off all day: standby only, heat share 0, though it is 8 °C colder outside.
      day('2026-01-10', { kwh: 0.65, heatKwh: 0, insideC: 21, outsideC: 13 }),
      // On in heat mode, barely working: heat share 1.
      day('2026-01-11', { kwh: 0.7, heatKwh: 0.7, insideC: 21, outsideC: 13 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-01-11'])
  })

  test('heating must be at least half of the day; a day with no kWh has no share', () => {
    const days = [
      day('2026-01-10', { kwh: 10, heatKwh: 5 }),
      day('2026-01-11', { kwh: 10, heatKwh: 4.9 }),
      day('2026-01-12', { kwh: 0, heatKwh: 0 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-01-10'])
  })

  test('a day without an indoor or outdoor mean does not qualify', () => {
    const days = [day('2026-01-10', { insideC: null }), day('2026-01-11', { outsideC: null })]
    expect(qualifyingDays(days, none)).toEqual([])
  })

  test('ΔT must be at least 3 °C', () => {
    const days = [
      day('2026-05-01', { insideC: 21, outsideC: 18 }),
      day('2026-05-02', { insideC: 21, outsideC: 18.25 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-05-01'])
  })

  test('an event day does not qualify; the input order is kept', () => {
    const days = [day('2026-01-12'), day('2026-01-10'), day('2026-01-11')]
    expect(daysOf(qualifyingDays(days, new Set(['2026-01-11'])))).toEqual(['2026-01-12', '2026-01-10'])
  })
})

describe('events for a unit', () => {
  const events = [
    event({ id: 'b', occurredOn: '2026-10-08' }), // Båda
    event({ id: 'o', occurredOn: '2026-09-01', heatPumpId: OVER, kind: 'filter' }),
    event({ id: 'm', occurredOn: '2026-03-15', heatPumpId: MATSAL, kind: 'filter' }),
  ]

  test('its own and Båda, oldest first; the other unit’s are left out', () => {
    expect(eventsForUnit(events, MATSAL).map((e) => e.id)).toEqual(['m', 'b'])
    expect(eventsForUnit(events, OVER).map((e) => e.id)).toEqual(['o', 'b'])
  })

  test('the default is the latest service, even with a later event of another kind', () => {
    const later = [...events, event({ id: 'f', occurredOn: '2026-10-20', heatPumpId: MATSAL, kind: 'filter' })]
    expect(defaultEventId(later, MATSAL)).toBe('b')
  })

  test('without a service, the latest event; without events, null', () => {
    const noService = events.filter((e) => e.kind !== 'service')
    expect(defaultEventId(noService, MATSAL)).toBe('m')
    expect(defaultEventId(noService, 'hp-third')).toBeNull()
  })

  test('the other unit’s service is not a default', () => {
    const own = [event({ id: 's-o', occurredOn: '2026-10-01', heatPumpId: OVER })]
    expect(defaultEventId(own, MATSAL)).toBeNull()
  })

  test('the chosen event when it applies to the unit, else the unit’s default', () => {
    expect(selectedEventId(events, MATSAL, 'm')).toBe('m')
    expect(selectedEventId(events, OVER, 'm')).toBe('b') // Matsal's filter, Övervåning shown
    expect(selectedEventId(events, MATSAL, null)).toBe('b')
    expect(selectedEventId(events, MATSAL, 'gone')).toBe('b')
    expect(selectedEventId([], MATSAL, null)).toBeNull()
  })
})

describe('the fetch range', () => {
  const service = event({ id: 'svc', occurredOn: '2026-01-20' })
  const range = (events: HeatPumpEventDto[], firstReadingDay: string | null, heatPumpId = MATSAL) =>
    signatureRange({ events, heatPumpId, eventId: 'svc', firstReadingDay, today: '2026-02-10' })

  test('400 days before the event to today', () => {
    // 2026-01-20 − 400 days = 2024-12-16.
    expect(range([service], '2024-10-31')).toEqual({ from: '2024-12-16', to: '2026-02-10' })
    expect(range([service], null)).toEqual({ from: '2024-12-16', to: '2026-02-10' })
  })

  test('not before the first reading', () => {
    expect(range([service], '2025-06-01')).toEqual({ from: '2025-06-01', to: '2026-02-10' })
  })

  test('up to the unit’s next event; the other unit’s next event is ignored', () => {
    const next = event({ id: 'set', occurredOn: '2026-01-28', kind: 'setting' })
    const theirs = event({ id: 'ov', occurredOn: '2026-01-25', heatPumpId: OVER, kind: 'filter' })
    expect(range([service, theirs, next], null).to).toBe('2026-01-28')
    expect(range([service, theirs], null).to).toBe('2026-02-10')
  })

  test('chunks of at most HEAT_PUMP_DAYS_MAX days, consecutive, covering the range', () => {
    expect(HEAT_PUMP_DAYS_MAX).toBe(800)
    expect(signatureChunks('2024-12-16', '2026-02-10')).toEqual([{ from: '2024-12-16', to: '2026-02-10' }])
    // 1 700 days: 800 + 800 + 100.
    expect(signatureChunks('2022-01-01', '2026-08-27')).toEqual([
      { from: '2022-01-01', to: '2024-03-10' },
      { from: '2024-03-11', to: '2026-05-19' },
      { from: '2026-05-20', to: '2026-08-27' },
    ])
    expect(signatureChunks('2026-01-01', '2026-01-01')).toEqual([{ from: '2026-01-01', to: '2026-01-01' }])
    expect(signatureChunks('2026-01-02', '2026-01-01')).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bunx vitest run src/lib/heatPump/signature.test.ts`
Expected: FAIL (cannot resolve `./signature`).

- [ ] **Step 3: Implement** (`src/lib/heatPump/signature.ts`)

```ts
import { addDays, stockholmDayBounds } from '~/lib/time/stockholm'
import type { HeatPumpEventDto } from './events'
import { HEAT_PUMP_DAYS_MAX } from './period'

// The energy signature (ADR-0027 decision 9, spec "Energisignatur"): per unit, each
// qualifying heating day is a point (x = the day's mean indoor − outdoor temperature,
// y = its kWh). A line fitted to the days before an event predicts the days after it.
// A relative before/after comparison on the units' own sensors, not an absolute
// efficiency. Pure and client-safe: the browser computes it from heatPump.days.

/** One unit's Stockholm day, as heatPump.days returns it (step 3). */
export type SignatureDay = {
  day: string
  kwh: number
  heatKwh: number
  coolKwh: number
  insideC: number | null
  outsideC: number | null
  hours: number
  expectedHours: number
}
export type SignaturePoint = {
  day: string
  deltaT: number
  kwh: number
  set: 'before' | 'after'
  /** An after-day outside the before set's ΔT range: drawn hollow, not counted. */
  extrapolated: boolean
}
/** kWh = a + b·ΔT (a: intercept, b: slope). */
export type SignatureFit = { a: number; b: number }
export type SignatureResult =
  | { state: 'not_enough_before'; before: number; points: SignaturePoint[] }
  | { state: 'not_enough_after'; after: number; needed: 14; points: SignaturePoint[]; fit: SignatureFit }
  | {
      state: 'ok'
      points: SignaturePoint[]
      fit: SignatureFit
      afterFit: SignatureFit | null
      /** (Σ actual − Σ predicted) ÷ Σ predicted: negative = lower consumption after. */
      change: number
      /** ≈ 95 % margin of `change`: 1,96 × s × √n ÷ Σ predicted (parameter uncertainty ignored). */
      margin: number
      beforeDays: number
      afterDays: number
    }
export type QualifyingDay = SignatureDay & { deltaT: number }

/** Days needed on each side of the event. */
export const SIGNATURE_MIN_DAYS = 14
/** The before set's ΔT must span this much for a slope to mean anything. */
export const SIGNATURE_MIN_SPAN_C = 4
/** The before set: the latest this many qualifying days. */
export const SIGNATURE_MAX_BEFORE_DAYS = 90
/** A heating day: indoor − outdoor at least this much. */
export const SIGNATURE_MIN_DELTA_T_C = 3
/** A heating day: cooling at most this share of the day's kWh. */
export const SIGNATURE_MAX_COOL_SHARE = 0.02
/** A heating day: heating at least this share (a switched-off unit reports 0, one on in heat mode 1). */
export const SIGNATURE_MIN_HEAT_SHARE = 0.5
/** The after line needs this much ΔT spread; narrower, its slope says nothing. */
export const SIGNATURE_MIN_AFTER_LINE_SPAN_C = 1
/** Days fetched before an event: room for the latest 90 qualifying days of a heating season. */
export const SIGNATURE_LOOKBACK_DAYS = 400

const HOUR_MS = 3_600_000

/** The Stockholm day's length in hours: 23, 24 or 25. */
const fullDayHours = (day: string) => {
  const { startMs, endMs } = stockholmDayBounds(day)
  return Math.round((endMs - startMs) / HOUR_MS)
}

/**
 * The days that can be points: every hour present, the unit on and heating (≥ 50 % of
 * the day's kWh), (almost) no cooling, both means present, ΔT ≥ 3 °C, not an event day
 * for the unit. Input order is kept.
 */
export function qualifyingDays(
  days: readonly SignatureDay[],
  eventDays: ReadonlySet<string>,
): QualifyingDay[] {
  const out: QualifyingDay[] = []
  for (const d of days) {
    if (eventDays.has(d.day)) continue
    if (d.insideC === null || d.outsideC === null) continue
    // Every hour of the Stockholm day, not only the expected ones: step 3 clips
    // expectedHours to the newest stored hour (and the unit's first reading), so
    // today's partial day would otherwise pass as complete.
    if (d.hours < d.expectedHours || d.hours !== fullDayHours(d.day)) continue
    // A day with no kWh has no heat share; a switched-off unit (standby only) reports 0.
    if (!(d.kwh > 0) || d.heatKwh < SIGNATURE_MIN_HEAT_SHARE * d.kwh) continue
    if (d.coolKwh > SIGNATURE_MAX_COOL_SHARE * d.kwh) continue
    const deltaT = d.insideC - d.outsideC
    if (deltaT < SIGNATURE_MIN_DELTA_T_C) continue
    out.push({ ...d, deltaT })
  }
  return out
}

/** The events that apply to a unit (its own and Båda), oldest first; same day: input order. */
export function eventsForUnit(
  events: readonly HeatPumpEventDto[],
  heatPumpId: string,
): HeatPumpEventDto[] {
  return events
    .filter((e) => e.heatPumpId === null || e.heatPumpId === heatPumpId)
    .sort((p, q) => p.occurredOn.localeCompare(q.occurredOn))
}

/** The event the card opens on: the unit's latest service, else its latest event, else null. */
export function defaultEventId(events: readonly HeatPumpEventDto[], heatPumpId: string): string | null {
  const own = eventsForUnit(events, heatPumpId)
  return own.filter((e) => e.kind === 'service').at(-1)?.id ?? own.at(-1)?.id ?? null
}

/**
 * The event shown: the chosen one while it applies to the unit, else the unit's default.
 * A choice made on the other unit (an event only it has) never reaches energySignature.
 */
export function selectedEventId(
  events: readonly HeatPumpEventDto[],
  heatPumpId: string,
  chosenId: string | null,
): string | null {
  const applies = chosenId !== null && eventsForUnit(events, heatPumpId).some((e) => e.id === chosenId)
  return applies ? chosenId : defaultEventId(events, heatPumpId)
}

/**
 * The days an event's signature needs: from 400 days before it (not before the unit's
 * first reading) to the unit's next event, or today. Callers pass an event that applies
 * to the unit (selectedEventId); an unknown one throws.
 */
export function signatureRange({
  events,
  heatPumpId,
  eventId,
  firstReadingDay,
  today,
}: {
  events: readonly HeatPumpEventDto[]
  heatPumpId: string
  eventId: string
  firstReadingDay: string | null
  today: string
}): { from: string; to: string } {
  const own = eventsForUnit(events, heatPumpId)
  const event = own.find((e) => e.id === eventId)
  if (!event) throw new RangeError(`Event ${eventId} does not apply to heat pump ${heatPumpId}`)
  const back = addDays(event.occurredOn, -SIGNATURE_LOOKBACK_DAYS)
  const from = firstReadingDay !== null && firstReadingDay > back ? firstReadingDay : back
  const next = own.find((e) => e.occurredOn > event.occurredOn)?.occurredOn ?? null
  const to = next !== null && next < today ? next : today
  return { from, to }
}

/** `from … to` (inclusive) as consecutive ranges of at most `maxDays` days: heatPump.days' cap. */
export function signatureChunks(
  from: string,
  to: string,
  maxDays = HEAT_PUMP_DAYS_MAX,
): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = []
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1)
    chunks.push({ from: start, to: end < to ? end : to })
  }
  return chunks
}
```

(`.filter()` returns a new array, so `.sort()` never touches the caller's list; `Array.prototype.sort` is stable.
`YYYY-MM-DD` strings compare correctly as text.)

- [ ] **Step 4: Add the client-safe guard** (append to the file Task 0 chose)

```ts
test('the energy signature is importable client-side', async () => {
  const mod = await import('~/lib/heatPump/signature')
  expect(typeof mod.qualifyingDays).toBe('function')
})
```

- [ ] **Step 5: Run the tests, also in UTC**

Run: `bunx vitest run src/lib/heatPump/signature.test.ts && TZ=UTC bunx vitest run src/lib/heatPump/signature.test.ts`
Expected: PASS both (18 tests).
Run: `bunx vitest run --project browser <the guard file>` → PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/lib/heatPump/signature.ts src/lib/heatPump/signature.test.ts <the guard file>
git commit -m "feat(heat-pumps): add the signature's day, event and range rules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The fit and the readout (`energySignature`, `simple-statistics`)

**Reviewers:** `code-reviewer` + `test-completeness` (both told: recompute every expected number by hand; check the
`{ m, b }` → `{ a, b }` mapping, the n − 2, the windows' strict/inclusive bounds and the extrapolation boundary).

**Library decision (CLAUDE.md "Reuse before you hand-roll").** Checked 2026-10-08:

| Option | Fit | Maintenance | Client cost |
|---|---|---|---|
| Installed: d3-array 3.2.4 | no regression function | — | — |
| **`simple-statistics` 7.12.1** (ISC) | `linearRegression(data) → { m, b }`, centred sums (numerically stable), typed | release 2026-09-27; ≈ 1,7 M downloads/week; no dependencies | `linearRegression` alone tree-shakes to ≈ 0,75 KB gz (measured with `bun build --minify`); the full bundle is 45 KB gz, so named imports only |
| `d3-regression` 2.2.0 (BSD-3) | `regressionLinear()` → `a`, `b`, `predict`, `rSquared` | single maintainer, release 2026-07-07; ≈ 0,66 M/week | ≈ 0,57 KB gz |
| `ml-regression-simple-linear` 3.0.1 | yes | last release 2024-05, two dependencies | — |
| Hand-roll | 10 lines | ours | 0 |

**Rule:** take the most used, actively maintained package whose fit function is typed and whose tree-shaken cost
is under 2 KB gz; hand-roll only if none qualifies. → `simple-statistics`. Neither library has a regression
standard error with n − 2, so the residual SD and the margin are written here (four lines). Task 5 checks the page
cost with `bun run bundle:measure` (the package appears under the page with < 1 KB; if it shows ≈ 45 KB the import
isn't tree-shaken: stop and fix the import).

**Files:**
- Modify: `src/lib/heatPump/signature.ts`, `src/lib/heatPump/signature.test.ts`, `package.json`, `bun.lock`

**Interfaces:**
- Consumes: Task 1's types, constants, `qualifyingDays`, `eventsForUnit`.
- Produces: `energySignature(input: { days: readonly SignatureDay[]; events: readonly HeatPumpEventDto[]; heatPumpId: string; eventId: string }): SignatureResult`
  — throws `RangeError` when `eventId` doesn't exist or doesn't apply to the unit. `points`: the used before days
  (oldest first), then every qualifying after-day (oldest first).

- [ ] **Step 1: Add the dependency**

```bash
bun add --exact simple-statistics@7.12.1
grep -n '"simple-statistics"' package.json     # "simple-statistics": "7.12.1"
```

- [ ] **Step 2: Write the failing tests** (append to `signature.test.ts`; add `energySignature` to the import from
  `./signature`, and `import { addDays } from '~/lib/time/stockholm'`)

```ts
// A complete heating day (all heat) with ΔT exactly `deltaT` (21 − (21 − ΔT), exact for integers and halves).
const at = (d: string, deltaT: number, kwh: number): SignatureDay =>
  day(d, { insideC: 21, outsideC: 21 - deltaT, kwh, heatKwh: kwh })
const run = (start: string, values: [number, number][]) =>
  values.map(([deltaT, kwh], i) => at(addDays(start, i), deltaT, kwh))

// The before set: 16 days (2026-01-04 … 01-19), ΔT 4 … 19, kWh = 2 + 0,5·ΔT + e with
// e = +0,1, −0,1, −0,1, +0,1 repeating. Each block of four has Σe = 0 and Σ ΔT·e = 0,
// so the OLS line is exactly a = 2, b = 0,5 and every residual is ±0,1:
// Σ residual² = 16 × 0,01 = 0,16, s = √(0,16 ÷ (16 − 2)).
const NOISE = [0.1, -0.1, -0.1, 0.1]
const BEFORE = run(
  '2026-01-04',
  Array.from({ length: 16 }, (_, i): [number, number] => [4 + i, 2 + 0.5 * (4 + i) + NOISE[i % 4]]),
)
// The after set: 14 days (2026-01-21 … 02-03), ΔT 5 … 18, each exactly 90 % of the
// prediction. Σ predicted = 14 × 2 + 0,5 × Σ(5…18) = 28 + 0,5 × 161 = 108,5; Σ actual = 97,65.
const AFTER = run(
  '2026-01-21',
  Array.from({ length: 14 }, (_, i): [number, number] => [5 + i, 0.9 * (2 + 0.5 * (5 + i))]),
)
const SERVICE = event({ id: 'svc', occurredOn: '2026-01-20' }) // Båda
const sig = (days: SignatureDay[], events: HeatPumpEventDto[] = [SERVICE], eventId = 'svc') =>
  energySignature({ days, events, heatPumpId: MATSAL, eventId })
const pointDays = (r: { points: { day: string; set: string }[] }, set: 'before' | 'after') =>
  r.points.filter((p) => p.set === set).map((p) => p.day)

describe('energySignature', () => {
  test('the fit, the change and the margin on known data', () => {
    const r = sig([...BEFORE, ...AFTER])
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.fit.a).toBeCloseTo(2, 10)
    expect(r.fit.b).toBeCloseTo(0.5, 10)
    expect(r.change).toBeCloseTo(-0.1, 10)
    // s·√n = √(0,16 ÷ 14) × √14 = √0,16 = 0,4.
    expect(r.margin).toBeCloseTo((1.96 * 0.4) / 108.5, 10)
    // n − 2, not n − 1: the n − 1 margin would be 1,96 × √(0,16 ÷ 15) × √14 ÷ 108,5.
    expect(r.margin).not.toBeCloseTo((1.96 * Math.sqrt(0.16 / 15) * Math.sqrt(14)) / 108.5, 6)
    expect(r.beforeDays).toBe(16)
    expect(r.afterDays).toBe(14)
    // The after-days are 1,8 + 0,45·ΔT exactly.
    expect(r.afterFit?.a).toBeCloseTo(1.8, 10)
    expect(r.afterFit?.b).toBeCloseTo(0.45, 10)
    expect(pointDays(r, 'before')).toEqual(BEFORE.map((d) => d.day))
    expect(pointDays(r, 'after')).toEqual(AFTER.map((d) => d.day))
    expect(r.points.every((p) => !p.extrapolated)).toBe(true)
  })

  test('after-days outside the before ΔT range are flagged and left out; its edges count', () => {
    const extra = [
      at('2026-02-04', 20, 9), // above 19
      at('2026-02-05', 3.5, 3), // below 4
      at('2026-02-06', 19, 0.9 * (2 + 0.5 * 19)), // on the edge: counted
    ]
    const r = sig([...BEFORE, ...AFTER, ...extra])
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.afterDays).toBe(15)
    expect(r.change).toBeCloseTo(-0.1, 10) // every counted day is still 90 % of its prediction
    const flagged = r.points.filter((p) => p.extrapolated).map((p) => p.day)
    expect(flagged).toEqual(['2026-02-04', '2026-02-05'])
  })

  test('an off day after the event is no point at all', () => {
    const off = day('2026-02-04', { kwh: 0.65, heatKwh: 0, insideC: 21, outsideC: 13 })
    const r = sig([...BEFORE, ...AFTER, off])
    expect(r).toMatchObject({ state: 'ok', afterDays: 14 })
    expect(r.points.some((p) => p.day === '2026-02-04')).toBe(false)
  })

  test('fewer than 14 counted after-days: not_enough_after with the count', () => {
    const r = sig([...BEFORE, ...AFTER.slice(0, 13), at('2026-02-04', 25, 9)])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 13, needed: 14 })
    if (r.state !== 'not_enough_after') return
    expect(r.fit.a).toBeCloseTo(2, 10)
    expect(r.points.filter((p) => p.extrapolated)).toHaveLength(1)
  })

  test('a summer after a winter event: every after-day outside the range counts 0', () => {
    const summer = run('2026-01-21', Array.from({ length: 14 }, (): [number, number] => [25, 12]))
    const r = sig([...BEFORE, ...summer])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 0 })
    expect(r.points.filter((p) => p.set === 'after' && p.extrapolated)).toHaveLength(14)
  })

  test('fewer than 14 before-days: not_enough_before with the count, points still drawn', () => {
    const r = sig([...BEFORE.slice(-13), ...AFTER])
    expect(r).toMatchObject({ state: 'not_enough_before', before: 13 })
    expect(r.points).toHaveLength(27)
    // The 13 before-days span ΔT 7 … 19: the after-days at ΔT 5 and 6 lie outside.
    expect(r.points.filter((p) => p.extrapolated).map((p) => p.deltaT)).toEqual([5, 6])
  })

  test('before-days spanning less than 4 °C: not_enough_before', () => {
    // 19 days (2026-01-01 … 01-19), ΔT 10 … 13,5.
    const narrow = run(
      '2026-01-01',
      Array.from({ length: 19 }, (_, i): [number, number] => [10 + (i % 8) * 0.5, 7]),
    )
    expect(sig([...narrow, ...AFTER])).toMatchObject({ state: 'not_enough_before', before: 19 })
  })

  test('the before set starts after the previous event for the unit', () => {
    const filter = event({ id: 'flt', occurredOn: '2026-01-10', heatPumpId: MATSAL, kind: 'filter' })
    const r = sig([...BEFORE, ...AFTER], [filter, SERVICE])
    // 01-11 … 01-19: the filter day itself is an event day.
    expect(r).toMatchObject({ state: 'not_enough_before', before: 9 })
    expect(pointDays(r, 'before')).toEqual(BEFORE.slice(7).map((d) => d.day))
  })

  test('the other unit’s event neither cuts the window nor drops its day; a Båda event does both', () => {
    const theirs = event({ id: 'ov', occurredOn: '2026-01-10', heatPumpId: OVER, kind: 'filter' })
    const r = sig([...BEFORE, ...AFTER], [theirs, SERVICE])
    expect(r.state).toBe('ok')
    if (r.state === 'ok') expect(r.beforeDays).toBe(16)
    const both = event({ id: 'both', occurredOn: '2026-01-10', kind: 'setting' })
    expect(sig([...BEFORE, ...AFTER], [both, SERVICE])).toMatchObject({
      state: 'not_enough_before',
      before: 9,
    })
  })

  test('the after set ends before the next event; the next event’s day is out', () => {
    const next = event({ id: 'set', occurredOn: '2026-01-28', kind: 'setting' })
    const r = sig([...BEFORE, ...AFTER], [SERVICE, next])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 7 })
    expect(pointDays(r, 'after')).toEqual(AFTER.slice(0, 7).map((d) => d.day))
  })

  test('two events on the same day: neither cuts the other’s window', () => {
    const sameDay = event({ id: 'flt-same', occurredOn: '2026-01-20', heatPumpId: MATSAL, kind: 'filter' })
    for (const id of ['svc', 'flt-same']) {
      const r = sig([...BEFORE, ...AFTER], [SERVICE, sameDay], id)
      expect(r).toMatchObject({ state: 'ok', beforeDays: 16, afterDays: 14 })
    }
  })

  test('only the latest 90 qualifying before-days', () => {
    // 100 days, 2025-11-21 … 2026-02-28, before an event on 2026-03-01.
    const long = run(
      '2025-11-21',
      Array.from({ length: 100 }, (_, i): [number, number] => [4 + (i % 16), 2 + 0.5 * (4 + (i % 16))]),
    )
    const march = event({ id: 'mar', occurredOn: '2026-03-01' })
    const r = sig(long, [march], 'mar')
    expect(r.state).toBe('not_enough_after')
    const before = pointDays(r, 'before')
    expect(before).toHaveLength(90)
    expect(before[0]).toBe('2025-12-01')
    expect(before.at(-1)).toBe('2026-02-28')
  })

  test('a before line that predicts no consumption over the after-days gives no ratio', () => {
    // 14 days, ΔT 4 … 17, 0,1 kWh each but 50 at ΔT 17: a ≈ −11,31, b ≈ 1,43; at ΔT 4 the line is ≈ −5,6.
    const skewed = run(
      '2026-01-06',
      Array.from({ length: 14 }, (_, i): [number, number] => [4 + i, i === 13 ? 50 : 0.1]),
    )
    const low = run('2026-01-21', Array.from({ length: 14 }, (): [number, number] => [4, 1]))
    expect(sig([...skewed, ...low])).toMatchObject({ state: 'not_enough_before', before: 14 })
  })

  test('an event that does not exist or belongs to the other unit throws', () => {
    const theirs = event({ id: 'ov', occurredOn: '2026-01-20', heatPumpId: OVER })
    expect(() => sig(BEFORE, [SERVICE], 'nope')).toThrow(RangeError)
    expect(() => sig(BEFORE, [theirs], 'ov')).toThrow(RangeError)
  })
})
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `bunx vitest run src/lib/heatPump/signature.test.ts`
Expected: FAIL (`energySignature` is not exported).

- [ ] **Step 4: Implement** (add to `signature.ts`; add `import { extent, sum } from 'd3-array'` and
  `import { linearRegression } from 'simple-statistics'` at the top)

```ts
type Xy = { deltaT: number; kwh: number }

/** OLS kWh = a + b·ΔT. simple-statistics returns { m: slope, b: intercept }: mapped, never passed through. */
function fitOf(days: readonly Xy[]): SignatureFit {
  const { m, b } = linearRegression(days.map((d) => [d.deltaT, d.kwh]))
  return { a: b, b: m }
}

const predict = (fit: SignatureFit, deltaT: number) => fit.a + fit.b * deltaT

/** [min, max] ΔT of a non-empty set; null for an empty one. */
function rangeOf(days: readonly Xy[]): [number, number] | null {
  const [lo, hi] = extent(days, (d) => d.deltaT)
  return lo === undefined || hi === undefined ? null : [lo, hi]
}

/**
 * The before fit's residual standard deviation, √(Σ residual² ÷ (n − 2)): the line
 * spent two degrees of freedom (the OLS standard error of the regression).
 */
function residualSd(days: readonly Xy[], fit: SignatureFit): number {
  return Math.sqrt(sum(days, (d) => (d.kwh - predict(fit, d.deltaT)) ** 2) / (days.length - 2))
}

/**
 * The signature around one event for one unit (spec "Energisignatur"). Before set:
 * qualifying days after the unit's previous event (or from the first reading) and
 * before this one, the latest 90. After set: qualifying days after this event and
 * before the unit's next one. Previous / next are strictly earlier / later days, so
 * a second event on the same day cuts neither window (its day is an event day anyway).
 */
export function energySignature({
  days,
  events,
  heatPumpId,
  eventId,
}: {
  days: readonly SignatureDay[]
  events: readonly HeatPumpEventDto[]
  heatPumpId: string
  eventId: string
}): SignatureResult {
  const own = eventsForUnit(events, heatPumpId)
  const event = own.find((e) => e.id === eventId)
  if (!event) throw new RangeError(`Event ${eventId} does not apply to heat pump ${heatPumpId}`)
  const on = event.occurredOn
  const previous = own.filter((e) => e.occurredOn < on).at(-1)?.occurredOn ?? null
  const next = own.find((e) => e.occurredOn > on)?.occurredOn ?? null

  const qualifying = qualifyingDays(days, new Set(own.map((e) => e.occurredOn))).sort((p, q) =>
    p.day.localeCompare(q.day),
  )
  const before = qualifying
    .filter((d) => d.day < on && (previous === null || d.day > previous))
    .slice(-SIGNATURE_MAX_BEFORE_DAYS)
  const after = qualifying.filter((d) => d.day > on && (next === null || d.day < next))

  const range = rangeOf(before)
  // No extrapolation: an after-day outside the before set's ΔT range isn't predicted.
  const outside = (d: Xy) => range !== null && (d.deltaT < range[0] || d.deltaT > range[1])
  const points: SignaturePoint[] = [
    ...before.map((d) => ({ day: d.day, deltaT: d.deltaT, kwh: d.kwh, set: 'before' as const, extrapolated: false })),
    ...after.map((d) => ({ day: d.day, deltaT: d.deltaT, kwh: d.kwh, set: 'after' as const, extrapolated: outside(d) })),
  ]

  if (range === null || before.length < SIGNATURE_MIN_DAYS || range[1] - range[0] < SIGNATURE_MIN_SPAN_C)
    return { state: 'not_enough_before', before: before.length, points }
  const fit = fitOf(before)
  const counted = after.filter((d) => !outside(d))
  if (counted.length < SIGNATURE_MIN_DAYS)
    return { state: 'not_enough_after', after: counted.length, needed: SIGNATURE_MIN_DAYS, points, fit }

  const predicted = sum(counted, (d) => predict(fit, d.deltaT))
  // A before line that predicts no consumption over these ΔT doesn't describe heating: no ratio.
  if (!(predicted > 0)) return { state: 'not_enough_before', before: before.length, points }
  const actual = sum(counted, (d) => d.kwh)
  const afterRange = rangeOf(counted)
  return {
    state: 'ok',
    points,
    fit,
    afterFit:
      afterRange !== null && afterRange[1] - afterRange[0] >= SIGNATURE_MIN_AFTER_LINE_SPAN_C
        ? fitOf(counted)
        : null,
    change: (actual - predicted) / predicted,
    margin: (1.96 * residualSd(before, fit) * Math.sqrt(counted.length)) / predicted,
    beforeDays: before.length,
    afterDays: counted.length,
  }
}
```

- [ ] **Step 5: Run the tests (and in UTC) and the types**

Run: `bunx vitest run src/lib/heatPump/signature.test.ts && TZ=UTC bunx vitest run src/lib/heatPump/signature.test.ts && bunx tsc --noEmit`
Expected: PASS (32 tests), no type errors. (`needed: SIGNATURE_MIN_DAYS` has the literal type `14`.)

- [ ] **Step 6: Commit**

```bash
bun run check
git add package.json bun.lock src/lib/heatPump/signature.ts src/lib/heatPump/signature.test.ts
git commit -m "feat(heat-pumps): fit the energy signature before and after an event" -m "Uses simple-statistics' linearRegression (tree-shaken, ~0.75 KB gz); the residual SD uses n − 2." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Colours and the scatter (`signatureChart.ts`, `SignatureScatter`)

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines`, `vercel-react-best-practices` and the
`dataviz` skill (re-runs the validator; checks markers ≥ 8 px, 2 px lines, the surface ring, recessive axes, text in
text tokens).

**Files:**
- Modify: `src/styles/app.css`, `messages/sv.json`, `messages/en.json`
- Create: `src/components/heatPump/signatureChart.ts`, `src/components/heatPump/signatureChart.test.ts`,
  `src/components/heatPump/SignatureScatter.tsx`, `src/components/heatPump/SignatureScatter.browser.test.tsx`

**Interfaces:**
- Consumes: `SignatureResult`, `SignatureFit`, `SignaturePoint` (Task 1); `ChartPopover`, `useChartPopover`
  (`~/components/evCharging/ChartPopover`); `TooltipRow` (`~/components/chart/ChartParts`); the axis constants in
  `~/components/chart/axis`; `formatDay`, `formatOneDecimal`, `formatDecimal` (`~/components/evCharging/format`).
- Produces:
  - `type Segment = { x1: number; y1: number; x2: number; y2: number }`
  - `fitSegment(fit: SignatureFit, deltaTs: readonly number[]): Segment | null`
  - `signatureSegments(result: SignatureResult): { before: Segment | null; after: Segment | null }`
  - `signatureDomains(points: readonly SignaturePoint[], segments: readonly Segment[]): { x: [number, number]; y: [number, number] }`
  - `nearestPoint(pixels: readonly { x: number; y: number }[], px: number, py: number, maxPx?: number): number | null`
  - `SignatureScatter({ result }: { result: SignatureResult })`, `SIGNATURE_CHART_HEIGHT = 300`,
    `SIGNATURE_COLORS = { before: 'var(--signature-before)', after: 'var(--signature-after)' }`
  - CSS tokens `--signature-before`, `--signature-after` (+ `--color-signature-*`)

- [ ] **Step 1: Validate the colours** (the `dataviz` skill's validator; load the skill to get its base dir)

```bash
V=<dataviz skill base dir>
node $V/scripts/validate_palette.js "#2a78d6,#eb6834" --mode light --surface "#ffffff" --pairs all
node $V/scripts/validate_palette.js "#3987e5,#d95926" --mode dark --surface "#1c1c1f" --pairs all
# Against step 2's unit colours on the same page (values from Task 0's grep of --energy-heat-pump-1..3):
node $V/scripts/validate_palette.js "<hp1>,<hp2>,<hp3>,#2a78d6,#eb6834" --mode light --surface "#ffffff" --pairs all
node $V/scripts/validate_palette.js "<hp1 dark>,<hp2 dark>,<hp3 dark>,#3987e5,#d95926" --mode dark --surface "#1c1c1f" --pairs all
```

Expected (run 2026-10-08): both two-colour runs `ALL CHECKS PASS` (light: CVD ΔE 24,7, normal 33,6, contrast ≥ 3:1;
dark: CVD 26,8, normal 31,8). **Rule for the five-colour runs:** a `[FAIL]` on the normal-vision floor whose worst
pair is a signature colour against a heat-pump colour means they look alike on one page: switch both signature
colours to violet `#4a3aa7` / dark `#9085e9` (before) and aqua `#1baf7a` / dark `#199e70` (after), validated
2026-10-08 as a pair (`ALL CHECKS PASS`; light aqua 2,82:1 is a contrast WARN, relieved by the legend and the table),
re-run both five-colour checks, and note the switch in the PR. Other `[FAIL]`s among the heat-pump colours alone are
step 2's, not this step's.

- [ ] **Step 2: The tokens** (`src/styles/app.css`)
  - `@theme inline`, after `--color-energy-loss: var(--energy-loss);`:
    `--color-signature-before: var(--signature-before);` and `--color-signature-after: var(--signature-after);`
  - `:root`, after `--energy-loss: #b91c1c;`:

```css
  /* Energisignatur (heat pumps step 4b): before / after an event; the reference palette's slots 1–2,
     validated --pairs all (light on #fff / dark on #1c1c1f). Shape is the second cue (circle / square). */
  --signature-before: #2a78d6;
  --signature-after: #eb6834;
```

  - `.dark`, after `--energy-loss: #dc3c3c;`: `--signature-before: #3987e5;` and `--signature-after: #d95926;`

- [ ] **Step 3: The chart's messages** (`messages/sv.json` / `messages/en.json`, alphabetical position among the
  `heat_pump_*` keys)

| key | sv | en |
|---|---|---|
| `heat_pump_signature_axis_x` | `Inne − ute (°C)` | `Indoor − outdoor (°C)` |
| `heat_pump_signature_axis_y` | `kWh per dygn` | `kWh per day` |
| `heat_pump_signature_before` | `Före händelsen` | `Before the event` |
| `heat_pump_signature_after` | `Efter händelsen` | `After the event` |
| `heat_pump_signature_extrapolated` | `Utanför temperaturskillnaderna före (räknas inte)` | `Outside the temperature differences before (not counted)` |
| `heat_pump_signature_tooltip_delta` | `Inne − ute` | `Indoor − outdoor` |
| `heat_pump_signature_tooltip_kwh` | `Förbrukning` | `Consumption` |

Run: `bun run i18n:compile`.

- [ ] **Step 4: Write the failing geometry tests** (`src/components/heatPump/signatureChart.test.ts`)

```ts
import { expect, test } from 'vitest'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { fitSegment, nearestPoint, signatureDomains, signatureSegments } from './signatureChart'

const p = (deltaT: number, kwh: number, set: 'before' | 'after' = 'before', extrapolated = false): SignaturePoint => ({
  day: `d${deltaT}-${set}`,
  deltaT,
  kwh,
  set,
  extrapolated,
})
const fit = { a: 2, b: 0.5 }

test('a fitted line spans its own set’s ΔT range only', () => {
  expect(fitSegment(fit, [8, 4, 19])).toEqual({ x1: 4, y1: 4, x2: 19, y2: 11.5 })
  expect(fitSegment(fit, [])).toBeNull()
})

test('segments: before over the before points, after over the counted after points', () => {
  const points = [p(4, 4), p(19, 11.5), p(5, 4, 'after'), p(18, 10, 'after'), p(25, 12, 'after', true)]
  const ok: SignatureResult = {
    state: 'ok', points, fit, afterFit: { a: 1.8, b: 0.45 }, change: -0.1, margin: 0.01, beforeDays: 2, afterDays: 2,
  }
  expect(signatureSegments(ok)).toEqual({
    before: { x1: 4, y1: 4, x2: 19, y2: 11.5 },
    after: { x1: 5, y1: 4.05, x2: 18, y2: 9.9 },
  })
  expect(signatureSegments({ ...ok, afterFit: null }).after).toBeNull()
  expect(signatureSegments({ state: 'not_enough_after', after: 2, needed: 14, points, fit }).after).toBeNull()
  expect(signatureSegments({ state: 'not_enough_before', before: 2, points })).toEqual({ before: null, after: null })
})

test('domains: ΔT over every point, kWh from 0, both nice', () => {
  const points = [p(4, 4), p(19, 11.6), p(25, 3, 'after', true)]
  expect(signatureDomains(points, [])).toEqual({ x: [4, 26], y: [0, 12] })
  expect(signatureDomains([p(4, 4), p(19, 11.6)], [{ x1: 4, y1: 4, x2: 19, y2: 13.2 }]).y).toEqual([0, 14])
})

test('domains without points or with one ΔT stay drawable', () => {
  expect(signatureDomains([], [])).toEqual({ x: [0, 20], y: [0, 1] })
  expect(signatureDomains([p(10, 5)], []).x).toEqual([9, 11])
})

test('the nearest point within 24 px, the first on a tie, none farther away', () => {
  const pixels = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 100, y: 100 }]
  expect(nearestPoint(pixels, 12, 11)).toBe(0)
  expect(nearestPoint(pixels, 20, 10)).toBe(0)
  expect(nearestPoint(pixels, 29, 14)).toBe(1)
  expect(nearestPoint(pixels, 60, 60)).toBeNull()
  expect(nearestPoint([], 0, 0)).toBeNull()
})
```

(19 × 0,5 + 2 = 11,5; 1,8 + 0,45 × 5 = 4,05; 1,8 + 0,45 × 18 = 9,9, all exact in floating point. `[4, 25]` nices to
`[4, 26]`, `[0, 11.6]` to `[0, 12]`, `[0, 13.2]` to `[0, 14]`: d3's `nice()` with its default ten ticks, checked
2026-10-08.)

Run: `bunx vitest run src/components/heatPump/signatureChart.test.ts` → FAIL (no module).

- [ ] **Step 5: Implement the geometry** (`src/components/heatPump/signatureChart.ts`)

```ts
import { extent, max } from 'd3-array'
import { scaleLinear } from 'd3-scale'
import type { SignatureFit, SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'

// The Energisignatur scatter's geometry (step 4b), pure so it is tested in node.

export type Segment = { x1: number; y1: number; x2: number; y2: number }

/** A fitted line over its own set's ΔT range: never drawn past its data. Null for an empty set. */
export function fitSegment(fit: SignatureFit, deltaTs: readonly number[]): Segment | null {
  const [lo, hi] = extent(deltaTs)
  if (lo === undefined || hi === undefined) return null
  return { x1: lo, y1: fit.a + fit.b * lo, x2: hi, y2: fit.a + fit.b * hi }
}

/** The before line (with a fit) over the before points; the after line (ok + afterFit) over the counted after points. */
export function signatureSegments(result: SignatureResult): { before: Segment | null; after: Segment | null } {
  if (result.state === 'not_enough_before') return { before: null, after: null }
  const deltaTs = (keep: (p: SignaturePoint) => boolean) => result.points.filter(keep).map((p) => p.deltaT)
  return {
    before: fitSegment(result.fit, deltaTs((p) => p.set === 'before')),
    after:
      result.state === 'ok' && result.afterFit
        ? fitSegment(result.afterFit, deltaTs((p) => p.set === 'after' && !p.extrapolated))
        : null,
  }
}

/** ΔT over every point (± 1 around a single value), kWh from 0 to the highest point or line end; both nice. */
export function signatureDomains(
  points: readonly SignaturePoint[],
  segments: readonly Segment[],
): { x: [number, number]; y: [number, number] } {
  const [lo, hi] = extent(points, (pt) => pt.deltaT)
  const x =
    lo === undefined || hi === undefined
      ? [0, 20]
      : scaleLinear()
          .domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi])
          .nice()
          .domain()
  const top = max([...points.map((pt) => pt.kwh), ...segments.flatMap((s) => [s.y1, s.y2])]) ?? 0
  const y = scaleLinear()
    .domain([0, top > 0 ? top : 1])
    .nice()
    .domain()
  return { x: [x[0], x[1]], y: [y[0], y[1]] }
}

/** The index of the point nearest (px, py) within `maxPx` (the dataviz hit target), first on a tie; else null. */
export function nearestPoint(
  pixels: readonly { x: number; y: number }[],
  px: number,
  py: number,
  maxPx = 24,
): number | null {
  let best: number | null = null
  let bestD = maxPx * maxPx
  for (let i = 0; i < pixels.length; i++) {
    const d = (pixels[i].x - px) ** 2 + (pixels[i].y - py) ** 2
    // Within reach, and strictly nearer than the best so far (the first wins a tie).
    if (d <= bestD && (best === null || d < bestD)) {
      best = i
      bestD = d
    }
  }
  return best
}
```

Run: `bunx vitest run src/components/heatPump/signatureChart.test.ts` → PASS.

- [ ] **Step 6: Write the failing scatter tests** (`src/components/heatPump/SignatureScatter.browser.test.tsx`)

```tsx
import { beforeEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { m } from '~/paraglide/messages'
import { centre, moveAt, settle, tooltipText } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { SignatureScatter } from './SignatureScatter'

const pt = (day: string, deltaT: number, kwh: number, set: 'before' | 'after', extrapolated = false): SignaturePoint => ({
  day, deltaT, kwh, set, extrapolated,
})
const points = [
  pt('2026-01-04', 4, 4.1, 'before'),
  pt('2026-01-12', 12, 8, 'before'),
  pt('2026-01-19', 19, 11.6, 'before'),
  pt('2026-01-21', 5, 4.05, 'after'),
  pt('2026-02-03', 18, 9.9, 'after'),
  pt('2026-02-04', 25, 12, 'after', true),
]
const ok: SignatureResult = {
  state: 'ok', points, fit: { a: 2, b: 0.5 }, afterFit: { a: 1.8, b: 0.45 }, change: -0.1, margin: 0.007, beforeDays: 3, afterDays: 2,
}
const q = (sel: string) => [...document.querySelectorAll(sel)]
const draw = async (result: SignatureResult, width = 900) => {
  const r = await renderWithProviders(
    <div style={{ width }}>
      <SignatureScatter result={result} />
    </div>,
  )
  await vi.waitFor(() => expect(q('[data-point]')).toHaveLength(result.points.length))
  return r
}

beforeEach(async () => {
  await page.viewport(1440, 900)
})

test('a filled circle per before-day, a filled square per after-day, a hollow square when extrapolated', async () => {
  await draw(ok)
  expect(q('circle[data-set="before"]')).toHaveLength(3)
  expect(q('rect[data-set="after"]')).toHaveLength(3)
  const hollow = q('[data-extrapolated]')
  expect(hollow.map((e) => e.getAttribute('data-point'))).toEqual(['2026-02-04'])
  expect(hollow[0].getAttribute('fill')).toBe('var(--card)')
  expect(hollow[0].getAttribute('stroke')).toBe('var(--signature-after)')
  expect(q('rect[data-set="after"]:not([data-extrapolated])')[0].getAttribute('fill')).toBe('var(--signature-after)')
})

test('ok draws both lines; not_enough_after the before line only; not_enough_before none', async () => {
  const { screen } = await draw(ok)
  expect(q('[data-fit]').map((e) => e.getAttribute('data-fit'))).toEqual(['before', 'after'])
  screen.unmount()
  const r2 = await draw({ state: 'not_enough_after', after: 2, needed: 14, points, fit: ok.fit })
  expect(q('[data-fit]').map((e) => e.getAttribute('data-fit'))).toEqual(['before'])
  r2.screen.unmount()
  await draw({ state: 'not_enough_before', before: 3, points })
  expect(q('[data-fit]')).toHaveLength(0)
})

test('axis titles and a three-item legend', async () => {
  await draw(ok)
  expect(document.querySelector('[data-axis-label="x"]')?.textContent).toBe(m.heat_pump_signature_axis_x())
  expect(document.querySelector('[data-axis-label="y"]')?.textContent).toBe(m.heat_pump_signature_axis_y())
  expect(q('[data-slot="signature-legend"] [data-legend-item]').map((e) => e.textContent)).toEqual([
    m.heat_pump_signature_before(),
    m.heat_pump_signature_after(),
    m.heat_pump_signature_extrapolated(),
  ])
})

test('hovering near a point shows its day, ΔT and kWh', async () => {
  const { screen } = await draw(ok)
  const target = document.querySelector('[data-point="2026-01-12"]') as Element
  const c = centre(target)
  moveAt(screen.container, c.x + 5, c.y + 5)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.heat_pump_signature_tooltip_delta()))
  expect(tooltipText()).toMatch(/12[,.]0\s°C/)
  expect(tooltipText()).toMatch(/8[,.]0\skWh/)
  expect(tooltipText()).toContain(m.heat_pump_signature_before())
})

test('every point stays inside the plot on a phone', async () => {
  await page.viewport(390, 844)
  await draw(ok, 340)
  await settle()
  const plot = document.querySelector('[data-hover-overlay]')?.getBoundingClientRect()
  for (const e of q('[data-point]')) {
    const b = e.getBoundingClientRect()
    expect(b.left + b.width / 2).toBeGreaterThanOrEqual((plot?.left ?? 0) - 0.5)
    expect(b.left + b.width / 2).toBeLessThanOrEqual((plot?.right ?? 0) + 0.5)
  }
})
```

(`centre` returns `{ x, y }` in client coordinates; `moveAt` dispatches on `[data-hover-overlay]`.)

Run: `bunx vitest run --project browser src/components/heatPump/SignatureScatter.browser.test.tsx` → FAIL.

- [ ] **Step 7: Implement the scatter** (`src/components/heatPump/SignatureScatter.tsx`)

```tsx
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { Group } from '@visx/group'
import { useParentSize } from '@visx/responsive'
import { scaleLinear } from 'd3-scale'
import type * as React from 'react'
import { useMemo, useRef } from 'react'
import {
  AXIS_COLOR,
  CHART_MARGIN,
  measureAt,
  TICK_PX,
  TICK_SIZE,
  X_AXIS_H,
  X_TICK_MARGIN,
  Y_TICK_MARGIN,
  yAxisWidth,
} from '~/components/chart/axis'
import { TooltipRow } from '~/components/chart/ChartParts'
import { ChartPopover, useChartPopover } from '~/components/evCharging/ChartPopover'
import { formatDay, formatDecimal, formatOneDecimal } from '~/components/evCharging/format'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { m } from '~/paraglide/messages'
import { nearestPoint, type Segment, signatureDomains, signatureSegments } from './signatureChart'

/** The whole chart's height, legend included (fixed: switching unit or event moves nothing). */
export const SIGNATURE_CHART_HEIGHT = 300
export const SIGNATURE_COLORS = {
  before: 'var(--signature-before)',
  after: 'var(--signature-after)',
} as const
/** Room for an axis title beside its axis. */
const TITLE_GAP = 18
/** Marker radius: 8 px marks (dataviz). */
const R = 4

const setLabel = (p: SignaturePoint) =>
  p.set === 'before' ? m.heat_pump_signature_before() : m.heat_pump_signature_after()

// The Energisignatur scatter (step 4b): x = the day's indoor − outdoor ΔT, y = its kWh;
// before-days filled circles, after-days filled squares, extrapolated after-days hollow
// squares; each set's fitted line over its own ΔT range. Visual only (aria-hidden): the
// card's readout and its "Visa som tabell" carry everything. Hover snaps to the nearest
// point within 24 px and shows it in the shared chart card.
export function SignatureScatter({ result }: { result: SignatureResult }) {
  // No debounce: a resize re-lays the plot at once (BarChart's rule).
  const { parentRef, width, height: plotBoxH } = useParentSize({ debounceTime: 0 })
  const popover = useChartPopover<number>({ followScroll: true })
  const cursor = useRef<number | null>(null)
  const { points } = result
  const segments = useMemo(() => signatureSegments(result), [result])

  const geometry = useMemo(() => {
    if (width <= 0 || plotBoxH <= 0) return null
    const lines = [segments.before, segments.after].filter((s): s is Segment => s !== null)
    const domains = signatureDomains(points, lines)
    const plotH = Math.max(0, plotBoxH - CHART_MARGIN.top - X_AXIS_H - TITLE_GAP)
    const y = scaleLinear().domain(domains.y).range([plotH, 0])
    const yTicks = y.ticks(5)
    const left =
      CHART_MARGIN.left + TITLE_GAP + yAxisWidth(yTicks.map(formatDecimal), measureAt(TICK_PX))
    const plotW = Math.max(0, width - left - CHART_MARGIN.right)
    const x = scaleLinear().domain(domains.x).range([0, plotW])
    const xTicks = x.ticks(plotW < 360 ? 4 : 8)
    const pixels = points.map((p) => ({ x: x(p.deltaT), y: y(p.kwh) }))
    return { x, y, xTicks, yTicks, left, plotW, plotH, pixels }
  }, [width, plotBoxH, points, segments])

  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry) return
    const box = e.currentTarget.getBoundingClientRect()
    const i = nearestPoint(geometry.pixels, e.clientX - box.left, e.clientY - box.top)
    // Same point (or still none): no re-render per pixel.
    if (i === cursor.current && (i === null || popover.open)) return
    cursor.current = i
    if (i === null) return popover.hide()
    popover.show(i, geometry.left + geometry.pixels[i].x, CHART_MARGIN.top + geometry.pixels[i].y - R)
  }
  const active =
    popover.open && popover.data !== undefined && popover.data < points.length ? popover.data : null

  const line = (s: Segment | null, key: 'before' | 'after') =>
    s && geometry ? (
      <line
        data-fit={key}
        x1={geometry.x(s.x1)}
        y1={geometry.y(s.y1)}
        x2={geometry.x(s.x2)}
        y2={geometry.y(s.y2)}
        stroke={SIGNATURE_COLORS[key]}
        strokeWidth={2}
        strokeLinecap="round"
        pointerEvents="none"
      />
    ) : null

  const svg = geometry ? (
    // biome-ignore lint/a11y/noSvgWithoutTitle: visual; the card's readout and table are the accessible path
    <svg data-chart-svg width={width} height={plotBoxH} aria-hidden className="block overflow-visible">
      <Group left={geometry.left} top={CHART_MARGIN.top}>
        <g data-grid>
          <GridRows
            scale={geometry.y}
            tickValues={geometry.yTicks}
            width={geometry.plotW}
            stroke="var(--border)"
            strokeOpacity={0.5}
          />
        </g>
        {line(segments.before, 'before')}
        {line(segments.after, 'after')}
        {points.map((p, i) => {
          const { x, y } = geometry.pixels[i]
          const color = SIGNATURE_COLORS[p.set]
          // A 1,5 px card-coloured ring keeps overlapping marks apart (dataviz).
          return p.set === 'before' ? (
            <circle
              key={p.day}
              data-point={p.day}
              data-set="before"
              cx={x}
              cy={y}
              r={R}
              fill={color}
              stroke="var(--card)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          ) : (
            <rect
              key={p.day}
              data-point={p.day}
              data-set="after"
              data-extrapolated={p.extrapolated || undefined}
              x={x - R}
              y={y - R}
              width={2 * R}
              height={2 * R}
              rx={1}
              fill={p.extrapolated ? 'var(--card)' : color}
              stroke={p.extrapolated ? color : 'var(--card)'}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )
        })}
        <g data-axis="y">
          <AxisLeft
            scale={geometry.y}
            tickValues={geometry.yTicks}
            tickFormat={(v) => formatDecimal(Number(v))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dx: -Y_TICK_MARGIN,
              dy: '0.32em',
              textAnchor: 'end' as const,
            })}
          />
        </g>
        <g data-axis="x">
          <AxisBottom
            top={geometry.plotH}
            scale={geometry.x}
            tickValues={geometry.xTicks}
            tickFormat={(v) => formatDecimal(Number(v))}
            hideTicks
            tickLength={TICK_SIZE}
            stroke={AXIS_COLOR}
            tickLabelProps={() => ({
              fill: 'var(--muted-foreground)',
              fontSize: TICK_PX,
              dy: X_TICK_MARGIN,
              textAnchor: 'middle' as const,
            })}
          />
        </g>
        <text
          data-axis-label="x"
          x={geometry.plotW / 2}
          y={geometry.plotH + X_AXIS_H + TITLE_GAP - 4}
          textAnchor="middle"
          fontSize={TICK_PX}
          fill="var(--muted-foreground)"
        >
          {m.heat_pump_signature_axis_x()}
        </text>
        <text
          data-axis-label="y"
          transform="rotate(-90)"
          x={-geometry.plotH / 2}
          y={-geometry.left + CHART_MARGIN.left + TICK_PX}
          textAnchor="middle"
          fontSize={TICK_PX}
          fill="var(--muted-foreground)"
        >
          {m.heat_pump_signature_axis_y()}
        </text>
        {/* A pointer surface in the aria-hidden svg; the card's table is the keyboard path. */}
        <rect
          data-hover-overlay
          width={geometry.plotW}
          height={geometry.plotH}
          fill="transparent"
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={(e) => {
            if (e.pointerType === 'touch') return
            cursor.current = null
            popover.hide()
          }}
        />
      </Group>
    </svg>
  ) : null

  return (
    <div
      data-chart="scatter"
      {...popover.containerProps}
      aria-hidden
      // Inline box: the plot must measure before CSS loads and in the CSS-less browser tests.
      className="w-full text-xs"
      style={{ height: SIGNATURE_CHART_HEIGHT, display: 'flex', flexDirection: 'column' }}
    >
      <div ref={parentRef} style={{ flex: '1 1 0', minHeight: 0 }}>
        {svg}
      </div>
      {/* Always all three items, so the legend's height never changes with the data. */}
      <div
        data-slot="signature-legend"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3"
      >
        <LegendItem shape="circle" label={m.heat_pump_signature_before()} />
        <LegendItem shape="square" label={m.heat_pump_signature_after()} />
        <LegendItem shape="hollow" label={m.heat_pump_signature_extrapolated()} />
      </div>
      <ChartPopover
        state={
          active === null || !geometry
            ? popover
            : {
                ...popover,
                left: geometry.left + geometry.pixels[active].x,
                top: CHART_MARGIN.top + geometry.pixels[active].y - R,
              }
        }
        variant="card"
        dataKey={active === null ? undefined : points[active].day}
      >
        {active === null ? null : (
          <>
            <div className="font-medium">{formatDay(points[active].day)}</div>
            <div className="grid gap-1.5">
              <TooltipRow label={m.heat_pump_signature_tooltip_delta()}>
                {`${formatOneDecimal(points[active].deltaT)} °C`}
              </TooltipRow>
              <TooltipRow
                label={m.heat_pump_signature_tooltip_kwh()}
                color={SIGNATURE_COLORS[points[active].set]}
              >
                {`${formatOneDecimal(points[active].kwh)} kWh`}
              </TooltipRow>
              <div className="text-muted-foreground">
                {points[active].extrapolated
                  ? m.heat_pump_signature_extrapolated()
                  : setLabel(points[active])}
              </div>
            </div>
          </>
        )}
      </ChartPopover>
    </div>
  )
}

function LegendItem({ shape, label }: { shape: 'circle' | 'square' | 'hollow'; label: string }) {
  return (
    <div data-legend-item className="flex items-center gap-1.5">
      <svg width={10} height={10} aria-hidden className="shrink-0">
        {shape === 'circle' ? (
          <circle cx={5} cy={5} r={4} fill={SIGNATURE_COLORS.before} />
        ) : (
          <rect
            x={1}
            y={1}
            width={8}
            height={8}
            rx={1}
            fill={shape === 'hollow' ? 'none' : SIGNATURE_COLORS.after}
            stroke={SIGNATURE_COLORS.after}
            strokeWidth={1.5}
          />
        )}
      </svg>
      {label}
    </div>
  )
}
```

- [ ] **Step 8: Run**

Run: `bunx vitest run src/components/heatPump/signatureChart.test.ts && bunx vitest run --project browser src/components/heatPump/SignatureScatter.browser.test.tsx`
Expected: PASS (5 + 5).

- [ ] **Step 9: Commit**

```bash
bun run check
git add src/styles/app.css messages/sv.json messages/en.json src/components/heatPump/signatureChart.ts src/components/heatPump/signatureChart.test.ts src/components/heatPump/SignatureScatter.tsx src/components/heatPump/SignatureScatter.browser.test.tsx
git commit -m "feat(heat-pumps): draw the energy signature scatter" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The card (`EnergySignature`): controls, readout, note, table

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told:
check the readout copy against the spec, the table and readout as the accessible path, the unit swatches against
step 2's colours, and no layout shift between the loading, no-event and result states).

**Files:**
- Create: `src/components/heatPump/EnergySignature.tsx`, `src/components/heatPump/EnergySignature.browser.test.tsx`,
  `test/fixtures/heatPumpSignature.ts`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: `eventKindLabel(kind: HeatPumpEventKind): string` (step 4a, `~/components/heatPump/eventCopy`); Task 1–2 (`energySignature`, `eventsForUnit`, `SIGNATURE_MIN_DAYS`, `SIGNATURE_MIN_SPAN_C`, types),
  Task 3 (`SignatureScatter`, `SIGNATURE_CHART_HEIGHT`), `heatPumpColor(units, id)` (step 2,
  `~/lib/houseEnergy/heatPumpColors`), shadcn `ToggleGroup`, `Select`, `Card`, `formatDay`, `formatOneDecimal`,
  `getIntlLocale` (`~/lib/i18n/format`), `HeatPumpEventDto`, `HeatPumpEventKind` (`~/lib/heatPump/events`).
- Produces:
  - `type SignatureDayRow = SignatureDay & { heatPumpId: string }` (a `heatPump.days` row is assignable)
  - `EnergySignature(props: { units: readonly { id: string; name: string }[]; unitId: string; onUnitChange: (id: string) => void; unitEvents: readonly HeatPumpEventDto[]; eventId: string | null; onEventChange: (id: string) => void; result: SignatureResult | null })`
    — `units` already in `byHeatPumpName` order; `unitEvents` = `eventsForUnit(…)` (oldest first); `result` null
    with an `eventId` = the days are loading.
  - `signatureReadout(result: SignatureResult, kind: HeatPumpEventKind): string`
  - readout element `[data-slot="signature-readout"]` with `data-state` (`ok` | `not_enough_after` |
    `not_enough_before` | `loading` | `no_event`), and for `ok` `data-change` / `data-margin` (raw, for checkpoint 6)
  - fixtures `signatureRow(heatPumpId, day, deltaT, kwh)`, `signatureUnitDays(heatPumpId, afterShare?)`

- [ ] **Step 1: Messages** (sv / en; the event kinds' names come from step 4a's `eventKindLabel`)

| key | sv | en |
|---|---|---|
| `heat_pump_signature_title` | `Energisignatur` | `Energy signature` |
| `heat_pump_signature_description` | `Förbrukning per dygn mot skillnaden mellan inne- och utetemperatur, före och efter en händelse.` | `Daily consumption against the indoor − outdoor temperature difference, before and after an event.` |
| `heat_pump_signature_unit_label` | `Värmepump` | `Heat pump` |
| `heat_pump_signature_event_label` | `Händelse` | `Event` |
| `heat_pump_signature_event_option` | `{kind} {date}` | `{kind} {date}` |
| `heat_pump_signature_after_service` | `Efter service` | `After the service` |
| `heat_pump_signature_after_filter` | `Efter filterrengöringen` | `After the filter cleaning` |
| `heat_pump_signature_after_setting` | `Efter inställningsändringen` | `After the settings change` |
| `heat_pump_signature_after_other` | `Efter händelsen` | `After the event` |
| `heat_pump_signature_lower` | `{event}: {percent} lägre förbrukning vid samma temperaturskillnad (±{margin}, {after} dagar efter, {before} före)` | `{event}: {percent} lower consumption at the same temperature difference (±{margin}, {after} days after, {before} before)` |
| `heat_pump_signature_higher` | `{event}: {percent} högre förbrukning vid samma temperaturskillnad (±{margin}, {after} dagar efter, {before} före)` | `{event}: {percent} higher consumption at the same temperature difference (±{margin}, {after} days after, {before} before)` |
| `heat_pump_signature_same` | `{event}: ingen skillnad i förbrukning vid samma temperaturskillnad (±{margin}, {after} dagar efter, {before} före)` | `{event}: no difference in consumption at the same temperature difference (±{margin}, {after} days after, {before} before)` |
| `heat_pump_signature_not_enough_after` | `Inte tillräckligt med data än ({count} av {needed} dagar)` | `Not enough data yet ({count} of {needed} days)` |
| `heat_pump_signature_not_enough_before` | `Inte tillräckligt med data före händelsen ({count} av {needed} dagar)` | `Not enough data before the event ({count} of {needed} days)` |
| `heat_pump_signature_not_enough_before_spread` | `Inte tillräckligt med data före händelsen: dagarna före ger ingen användbar linje (temperaturskillnaden behöver variera minst {span} °C)` | `Not enough data before the event: the days before give no usable line (the temperature difference must vary by at least {span} °C)` |
| `heat_pump_signature_no_event` | `Ingen händelse loggad för {unit} än. Energisignaturen jämför dagarna före och efter en händelse.` | `No event logged for {unit} yet. The energy signature compares the days before and after an event.` |
| `heat_pump_signature_loading` | `Hämtar dagarna…` | `Fetching the days…` |
| `heat_pump_signature_note` | `Bygger på värmepumpens egna givare inne och ute, så siffran jämför bara dagarna före och efter händelsen; den mäter inte verklig verkningsgrad. Felmarginalen är ungefärlig: den räknar med dagarnas spridning kring linjen men inte med osäkerheten i själva linjen. Bara hela uppvärmningsdagar räknas (värmepumpen på och värmer, minst 3 °C skillnad, nästan ingen kyla), och efter händelsen bara dagar inom temperaturskillnaderna före; jämförelsen behöver 14 dagar på var sida.` | `Based on the heat pump's own indoor and outdoor sensors, so the figure only compares the days before and after the event; it doesn't measure true efficiency. The margin is approximate: it counts the days' spread around the line but not the uncertainty in the line itself. Only whole heating days count (the heat pump on and heating, at least 3 °C difference, almost no cooling), and after the event only days within the temperature differences before it; the comparison needs 14 days on each side.` |
| `heat_pump_signature_table_label` | `Dagarna i energisignaturen` | `The days in the energy signature` |
| `heat_pump_signature_table_day` | `Dag` | `Day` |
| `heat_pump_signature_table_delta` | `Inne − ute (°C)` | `Indoor − outdoor (°C)` |
| `heat_pump_signature_table_kwh` | `kWh` | `kWh` |
| `heat_pump_signature_table_set` | `Period` | `Period` |
| `heat_pump_signature_table_not_counted` | `{set}, räknas inte` | `{set}, not counted` |

Run: `bun run i18n:compile`.

- [ ] **Step 2: The shared fixtures** (`test/fixtures/heatPumpSignature.ts`, synthetic numbers only)

```ts
import type { SignatureDayRow } from '~/components/heatPump/EnergySignature'
import { addDays } from '~/lib/time/stockholm'

// Synthetic heat pump days for the signature's browser tests (step 4b), never real consumption.
// signatureUnitDays: Task 2's known data. 16 before-days (2026-01-04 … 01-19) on the line
// 2 + 0,5·ΔT ± 0,1, then 14 after-days (2026-01-21 … 02-03) at `afterShare` of the line:
// around a service on 2026-01-20, 0,9 gives change −0,1 and margin 0,784 ÷ 108,5.

export const signatureRow = (heatPumpId: string, day: string, deltaT: number, kwh: number): SignatureDayRow => ({
  heatPumpId,
  day,
  kwh,
  heatKwh: kwh,
  coolKwh: 0,
  insideC: 21,
  outsideC: 21 - deltaT,
  hours: 24,
  expectedHours: 24,
})

const NOISE = [0.1, -0.1, -0.1, 0.1]

export const signatureUnitDays = (heatPumpId: string, afterShare = 0.9, start = '2026-01-04'): SignatureDayRow[] => [
  ...Array.from({ length: 16 }, (_, i) =>
    signatureRow(heatPumpId, addDays(start, i), 4 + i, 2 + 0.5 * (4 + i) + NOISE[i % 4]),
  ),
  ...Array.from({ length: 14 }, (_, i) =>
    signatureRow(heatPumpId, addDays(start, 17 + i), 5 + i, afterShare * (2 + 0.5 * (5 + i))),
  ),
]
```

(With the default `start`, day 16 is 2026-01-20, the event day, left empty; the after-days start on 2026-01-21.)

- [ ] **Step 3: Write the failing tests** (`src/components/heatPump/EnergySignature.browser.test.tsx`)

```tsx
import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { energySignature, eventsForUnit, type SignatureResult } from '~/lib/heatPump/signature'
import { getIntlLocale } from '~/lib/i18n/format'
import { addDays } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { signatureRow, signatureUnitDays } from '~test/fixtures/heatPumpSignature'
import { renderWithProviders } from '~test/browser/render'
import { EnergySignature } from './EnergySignature'
import { eventKindLabel } from './eventCopy'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'
const units = [
  { id: MATSAL, name: 'Matsal' },
  { id: OVER, name: 'Övervåning' },
]
const ev = (over: Partial<HeatPumpEventDto> & { id: string; occurredOn: string }): HeatPumpEventDto => ({
  heatPumpId: null, kind: 'service', note: null, ...over,
})
const service = ev({ id: 'svc', occurredOn: '2026-01-20' })
const pct = (v: number) => new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)
const readout = () => document.querySelector('[data-slot="signature-readout"]') as HTMLElement
const resultOf = (days = signatureUnitDays(MATSAL), events = [service], eventId = 'svc'): SignatureResult =>
  energySignature({ days, events, heatPumpId: MATSAL, eventId })

const show = (props: Partial<Parameters<typeof EnergySignature>[0]> = {}) => {
  const onUnitChange = vi.fn()
  const onEventChange = vi.fn()
  const r = renderWithProviders(
    <div style={{ width: 1000 }}>
      <EnergySignature
        units={units}
        unitId={MATSAL}
        onUnitChange={onUnitChange}
        unitEvents={eventsForUnit([service], MATSAL)}
        eventId="svc"
        onEventChange={onEventChange}
        result={resultOf()}
        {...props}
      />
    </div>,
  )
  return { r, onUnitChange, onEventChange }
}

test('the readout: lower consumption, margin rounded up, day counts, raw values on the element', async () => {
  await page.viewport(1440, 900)
  await show().r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(readout().textContent).toBe(
    m.heat_pump_signature_lower({
      event: m.heat_pump_signature_after_service(),
      percent: pct(0.1),
      margin: pct(0.01), // 0,72 % rounds up to 1 %
      after: '14',
      before: '16',
    }),
  )
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
  expect(Number(readout().dataset.margin)).toBeCloseTo(0.784 / 108.5, 10)
})

test('higher consumption reads “högre”', async () => {
  await show({ result: resultOf(signatureUnitDays(MATSAL, 1.1)) }).r
  await vi.waitFor(() =>
    expect(readout().textContent).toBe(
      m.heat_pump_signature_higher({
        event: m.heat_pump_signature_after_service(),
        percent: pct(0.1),
        margin: pct(0.01),
        after: '14',
        before: '16',
      }),
    ),
  )
})

test('the unit toggle names each unit with its colour swatch and reports a switch', async () => {
  const { r, onUnitChange } = show()
  const { screen } = await r
  await expect.element(screen.getByRole('radio', { name: 'Matsal' })).toHaveAttribute('aria-checked', 'true')
  const swatches = [...document.querySelectorAll('[data-unit-swatch]')].map((s) => (s as HTMLElement).style.background)
  expect(swatches).toEqual(['var(--energy-heat-pump-1)', 'var(--energy-heat-pump-2)'])
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  expect(onUnitChange).toHaveBeenCalledWith(OVER)
})

test('the event select lists the unit’s events newest first and reports a choice', async () => {
  const older = ev({ id: 'old', occurredOn: '2025-10-01' })
  const later = ev({ id: 'set', occurredOn: '2026-03-01', heatPumpId: MATSAL, kind: 'setting' })
  const unitEvents = eventsForUnit([older, service, later], MATSAL)
  const { r, onEventChange } = show({ unitEvents })
  const { screen } = await r
  const trigger = screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() })
  await expect.element(trigger).toHaveTextContent(eventKindLabel('service'))
  await userEvent.click(trigger)
  const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')
  expect(options).toHaveLength(3)
  expect(options[0]).toContain(eventKindLabel('setting'))
  expect(options[2]).toContain('2025')
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('setting')) }))
  expect(onEventChange).toHaveBeenCalledWith('set')
})

test('loading: the loading line and a chart-sized placeholder, no chart', async () => {
  await show({ result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
  expect(readout().textContent).toBe(m.heat_pump_signature_loading())
  expect(document.querySelector('[data-chart="scatter"]')).toBeNull()
  const placeholder = document.querySelector<HTMLElement>('[data-slot="signature-chart-placeholder"]')
  expect(placeholder?.style.height).toBe('300px')
})

test('no event for the unit: the no-event line and no chart', async () => {
  await show({ unitEvents: [], eventId: null, result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('no_event'))
  expect(readout().textContent).toBe(m.heat_pump_signature_no_event({ unit: 'Matsal' }))
  expect(document.querySelector('[data-chart="scatter"]')).toBeNull()
})

test('a summer after the event: 0 of 14 days, hollow after-days, the before line only', async () => {
  const summer = [
    ...signatureUnitDays(MATSAL).slice(0, 16),
    ...Array.from({ length: 14 }, (_, i) => signatureRow(MATSAL, addDays('2026-01-21', i), 25, 12)),
  ]
  await show({ result: resultOf(summer) }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('not_enough_after'))
  expect(readout().textContent).toBe(m.heat_pump_signature_not_enough_after({ count: '0', needed: '14' }))
  await vi.waitFor(() => expect(document.querySelectorAll('[data-extrapolated]')).toHaveLength(14))
  expect([...document.querySelectorAll('[data-fit]')].map((e) => e.getAttribute('data-fit'))).toEqual(['before'])
})

test('too few before-days says so with the count', async () => {
  await show({ result: resultOf(signatureUnitDays(MATSAL).slice(5)) }).r
  await vi.waitFor(() =>
    expect(readout().textContent).toBe(m.heat_pump_signature_not_enough_before({ count: '11', needed: '14' })),
  )
})

test('one unit: no toggle; the table lists every point with its period', async () => {
  const days = [...signatureUnitDays(MATSAL), signatureRow(MATSAL, '2026-02-04', 25, 12)]
  const { screen } = await show({ units: [units[0]], result: resultOf(days) }).r
  expect(screen.container.querySelector('[role="radiogroup"]')).toBeNull()
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  const rows = [...document.querySelectorAll('tbody tr')]
  expect(rows).toHaveLength(31)
  expect(rows[0].textContent).toContain(m.heat_pump_signature_before())
  expect(rows.at(-1)?.textContent).toContain(
    m.heat_pump_signature_table_not_counted({ set: m.heat_pump_signature_after() }),
  )
})
```

(Radix's single-mode `ToggleGroup` renders `role="radiogroup"` with `role="radio"` items, checked in
`node_modules/@radix-ui/react-toggle-group` on 2026-10-08. The swatch test assumes step 2's `heatPumpColor` maps the
first two units to `--energy-heat-pump-1/2`; adapt to its real output if Task 0 found another form.)

Run: `bunx vitest run --project browser src/components/heatPump/EnergySignature.browser.test.tsx` → FAIL.

- [ ] **Step 4: Implement** (`src/components/heatPump/EnergySignature.tsx`)

```tsx
import { useId } from 'react'
import { formatDay, formatOneDecimal } from '~/components/evCharging/format'
import { Card, CardContent, CardHeader } from '~/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import type { HeatPumpEventDto, HeatPumpEventKind } from '~/lib/heatPump/events'
import {
  SIGNATURE_MIN_DAYS,
  SIGNATURE_MIN_SPAN_C,
  type SignatureDay,
  type SignaturePoint,
  type SignatureResult,
} from '~/lib/heatPump/signature'
import { heatPumpColor } from '~/lib/houseEnergy/heatPumpColors'
import { getIntlLocale } from '~/lib/i18n/format'
import { m } from '~/paraglide/messages'
import { eventKindLabel } from './eventCopy'
import { SIGNATURE_CHART_HEIGHT, SignatureScatter } from './SignatureScatter'

/** A heatPump.days row (step 3) is one of these. */
export type SignatureDayRow = SignatureDay & { heatPumpId: string }

// Called at render (the locale is per request), never at module load.
const AFTER_KIND: Record<HeatPumpEventKind, () => string> = {
  service: m.heat_pump_signature_after_service,
  filter: m.heat_pump_signature_after_filter,
  setting: m.heat_pump_signature_after_setting,
  other: m.heat_pump_signature_after_other,
}

const percent = (v: number) =>
  new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)
/** The margin rounded up to a whole percent: never understated, "±1 %" at the least. */
const marginPercent = (v: number) => percent(Math.max(1, Math.ceil(v * 100 - 1e-9)) / 100)

const eventLabel = (e: HeatPumpEventDto) =>
  m.heat_pump_signature_event_option({ kind: eventKindLabel(e.kind), date: formatDay(e.occurredOn) })

/** The card's one sentence for a result (spec "Readout"). */
export function signatureReadout(result: SignatureResult, kind: HeatPumpEventKind): string {
  switch (result.state) {
    case 'not_enough_before':
      return result.before < SIGNATURE_MIN_DAYS
        ? m.heat_pump_signature_not_enough_before({
            count: String(result.before),
            needed: String(SIGNATURE_MIN_DAYS),
          })
        : m.heat_pump_signature_not_enough_before_spread({ span: String(SIGNATURE_MIN_SPAN_C) })
    case 'not_enough_after':
      return m.heat_pump_signature_not_enough_after({
        count: String(result.after),
        needed: String(result.needed),
      })
    case 'ok': {
      const whole = Math.round(Math.abs(result.change) * 100)
      const params = {
        event: AFTER_KIND[kind](),
        percent: percent(whole / 100),
        margin: marginPercent(result.margin),
        after: String(result.afterDays),
        before: String(result.beforeDays),
      }
      if (whole === 0) return m.heat_pump_signature_same(params)
      return result.change < 0 ? m.heat_pump_signature_lower(params) : m.heat_pump_signature_higher(params)
    }
  }
}

const READOUT = 'min-h-[3em] text-pretty'

// The Energisignatur card (step 4b, spec "Energisignatur"). Presentational: the section
// owns the unit and event state and the reads, and passes the computed result (null while
// the event's days load). The chart is aria-hidden; the readout and the table are the
// accessible path. Every state keeps the same box: a reserved readout line, the chart or a
// same-height placeholder, the note, the table toggle.
export function EnergySignature({
  units,
  unitId,
  onUnitChange,
  unitEvents,
  eventId,
  onEventChange,
  result,
}: {
  units: readonly { id: string; name: string }[]
  unitId: string
  onUnitChange: (id: string) => void
  unitEvents: readonly HeatPumpEventDto[]
  eventId: string | null
  onEventChange: (id: string) => void
  result: SignatureResult | null
}) {
  const headingId = useId()
  const unit = units.find((u) => u.id === unitId)
  const event = unitEvents.find((e) => e.id === eventId) ?? null
  if (!unit) return null

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={headingId} className="font-semibold text-lg">
              {m.heat_pump_signature_title()}
            </h2>
            <p className="text-pretty text-muted-foreground text-sm">{m.heat_pump_signature_description()}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {units.length > 1 ? (
              <ToggleGroup
                type="single"
                value={unit.id}
                // Radix fires '' when the active item is re-pressed; keep one selected.
                onValueChange={(v) => {
                  if (v) onUnitChange(v)
                }}
                variant="outline"
                size="sm"
                aria-label={m.heat_pump_signature_unit_label()}
              >
                {units.map((u) => (
                  <ToggleGroupItem key={u.id} value={u.id}>
                    <span
                      aria-hidden
                      data-unit-swatch
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: heatPumpColor(units, u.id) }}
                    />
                    {u.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {event ? (
              <Select value={event.id} onValueChange={onEventChange}>
                <SelectTrigger
                  size="sm"
                  className="w-auto max-w-full"
                  aria-label={m.heat_pump_signature_event_label()}
                >
                  {/* Explicit, so SSR shows the label and the trigger keeps its width (YearSelector's rule). */}
                  <SelectValue>{eventLabel(event)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {[...unitEvents].reverse().map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {eventLabel(e)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!event ? (
            <p data-slot="signature-readout" data-state="no_event" className={READOUT}>
              {m.heat_pump_signature_no_event({ unit: unit.name })}
            </p>
          ) : (
            <>
              {result ? (
                <p
                  data-slot="signature-readout"
                  data-state={result.state}
                  data-change={result.state === 'ok' ? String(result.change) : undefined}
                  data-margin={result.state === 'ok' ? String(result.margin) : undefined}
                  aria-live="polite"
                  className={`${READOUT} font-medium`}
                >
                  {signatureReadout(result, event.kind)}
                </p>
              ) : (
                <p data-slot="signature-readout" data-state="loading" className={`${READOUT} text-muted-foreground`}>
                  {m.heat_pump_signature_loading()}
                </p>
              )}
              {result ? (
                <SignatureScatter result={result} />
              ) : (
                <div
                  data-slot="signature-chart-placeholder"
                  aria-hidden
                  className="rounded-lg bg-foreground/8 motion-safe:animate-pulse"
                  style={{ height: SIGNATURE_CHART_HEIGHT }}
                />
              )}
              <p className="max-w-[70ch] text-pretty text-muted-foreground text-sm">{m.heat_pump_signature_note()}</p>
              <details className="text-sm">
                <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {m.energy_flow_table_toggle()}
                </summary>
                {result ? <SignatureTable points={result.points} /> : null}
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function SignatureTable({ points }: { points: readonly SignaturePoint[] }) {
  const rows = [...points].sort((p, q) => p.day.localeCompare(q.day))
  const setLabel = (p: SignaturePoint) => {
    const set = p.set === 'before' ? m.heat_pump_signature_before() : m.heat_pump_signature_after()
    return p.extrapolated ? m.heat_pump_signature_table_not_counted({ set }) : set
  }
  return (
    // A scrolling region is a Tab stop with a name, so keyboard users can scroll it.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
    <div
      role="region"
      aria-label={m.heat_pump_signature_table_label()}
      tabIndex={0}
      className="mt-2 max-h-80 overflow-auto rounded-sm focus-visible:outline-1 focus-visible:outline-ring"
    >
      <table className="min-w-full border-collapse tabular-nums">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              {m.heat_pump_signature_table_day()}
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium">
              {m.heat_pump_signature_table_delta()}
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium">
              {m.heat_pump_signature_table_kwh()}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {m.heat_pump_signature_table_set()}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.day} className="border-b">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                {formatDay(p.day)}
              </th>
              <td className="py-1.5 pr-4 text-right">{formatOneDecimal(p.deltaT)}</td>
              <td className="py-1.5 pr-4 text-right">{formatOneDecimal(p.kwh)}</td>
              <td className="py-1.5">{setLabel(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 5: Run**

Run: `bunx vitest run --project browser src/components/heatPump/EnergySignature.browser.test.tsx && TZ=UTC bunx vitest run --project browser src/components/heatPump/EnergySignature.browser.test.tsx`
Expected: PASS (9) both.

- [ ] **Step 6: Commit**

```bash
bun run check
git add messages/sv.json messages/en.json test/fixtures/heatPumpSignature.ts src/components/heatPump/EnergySignature.tsx src/components/heatPump/EnergySignature.browser.test.tsx
git commit -m "feat(heat-pumps): add the energy signature card" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: On the page: state, reads in chunks, route, skeleton, bundle

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (told:
ADR-0025 loader rules (the events query deferred, nothing awaited on the client), cache keys shared with steps 3 and
4a, the chunked reads and their concatenation, the unit/event fallback, the skeleton capture, the page's cost in
`bundle:measure`).

**Files:**
- Create: `src/components/heatPump/EnergySignatureSection.tsx`,
  `src/components/heatPump/EnergySignatureSection.browser.test.tsx`, `src/bones/heat-pumps-signature.bones.json`
  (generated)
- Modify: `src/routes/_authenticated/energy/heat-pumps.tsx`, `scripts/measureBundle.ts`, `messages/sv.json`,
  `messages/en.json`

**Interfaces:**
- Consumes: step 3's `heatPumpMonthsQueryFor(period: EnergyPeriod | null)` (→ `{ units: { id, name }[]; firstReadingDay: string | null; … }`)
  and `heatPumpDaysQuery(range: { from: string; to: string })` (→ `HeatPumpDaysOutput`) from
  `~/components/heatPump/heatPumpQueries`; `orpc.heatPump.events.list.queryOptions()` (step 4a's key); step 2's
  `byHeatPumpName(a, b)` from `~/lib/houseEnergy/figures`; Task 1–2 (`eventsForUnit`, `selectedEventId`,
  `signatureRange`, `signatureChunks`, `energySignature`); Task 4 (`EnergySignature`, `SignatureDayRow`);
  `loadRouteData`, `SectionSkeleton`, `LoadErrorAlert`, `firstLoadPending`, `loadFailed`, `LoadErrorQuery`.
- Produces: `EnergySignatureSection({ today }: { today?: string })`, `signatureEventsQuery`.

- [ ] **Step 1: The error message** (`heat_pump_signature_error_title`: sv `Energisignaturen kunde inte laddas`,
  en `The energy signature couldn't be loaded`); `bun run i18n:compile`.

- [ ] **Step 2: Write the failing section tests** (`src/components/heatPump/EnergySignatureSection.browser.test.tsx`)

```tsx
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { signatureUnitDays } from '~test/fixtures/heatPumpSignature'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { EnergySignatureSection, signatureEventsQuery } from './EnergySignatureSection'
import { eventKindLabel } from './eventCopy'
import { heatPumpDaysQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'
const TODAY = '2026-02-10'
const service: HeatPumpEventDto = { id: 'svc', occurredOn: '2026-01-20', heatPumpId: null, kind: 'service', note: null }
// Units deliberately out of name order: the section sorts with byHeatPumpName.
const months = (firstReadingDay = '2024-10-31') =>
  ({ units: [{ id: OVER, name: 'Övervåning' }, { id: MATSAL, name: 'Matsal' }], firstReadingDay }) as never
const readout = () => document.querySelector('[data-slot="signature-readout"]') as HTMLElement

const seeded = (events: HeatPumpEventDto[]) => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  qc.setQueryData(signatureEventsQuery.queryKey, events as never)
  // 2026-01-20 − 400 days = 2024-12-16 (after the first reading) … today: one chunk.
  qc.setQueryData(heatPumpDaysQuery({ from: '2024-12-16', to: TODAY }).queryKey, {
    units: [],
    days: [...signatureUnitDays(MATSAL, 0.9), ...signatureUnitDays(OVER, 1.1)],
  } as never)
  return qc
}

test('Matsal first, its default event, the signature computed from the event’s range', async () => {
  const qc = seeded([service])
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  await expect.element(screen.getByRole('radio', { name: 'Matsal' })).toHaveAttribute('aria-checked', 'true')
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
})

test('an event only Matsal has falls back to Övervåning’s default when switching unit', async () => {
  const filter: HeatPumpEventDto = { id: 'flt', occurredOn: '2026-01-20', heatPumpId: MATSAL, kind: 'filter', note: null }
  const qc = seeded([service, filter])
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  await userEvent.click(screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() }))
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('filter')) }))
  await vi.waitFor(() => expect(readout().textContent).toContain(m.heat_pump_signature_after_filter()))
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  await vi.waitFor(() => expect(readout().textContent).toContain(m.heat_pump_signature_after_service()))
  expect(Number(readout().dataset.change)).toBeCloseTo(0.1, 10)
})

test('switching unit resets to that unit’s default, even when the chosen Båda event applies to both', async () => {
  // A Båda event older than the service: it applies to Övervåning too, so only the reset can drop it.
  const older: HeatPumpEventDto = { id: 'old', occurredOn: '2025-12-01', heatPumpId: null, kind: 'other', note: null }
  const qc = seeded([older, service])
  // 2025-12-01 − 400 days = 2024-10-27, clipped to the first reading 2024-10-31; up to the next event, 2026-01-20.
  qc.setQueryData(heatPumpDaysQuery({ from: '2024-10-31', to: '2026-01-20' }).queryKey, {
    units: [],
    days: [],
  } as never)
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  const trigger = screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() })
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('other')) }))
  await expect.element(trigger).toHaveTextContent(eventKindLabel('other'))
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  await expect.element(trigger).toHaveTextContent(eventKindLabel('service'))
  await vi.waitFor(() => expect(readout().textContent).toContain(m.heat_pump_signature_after_service()))
})

test('a range over 800 days arrives in two chunks and the signature sees both', async () => {
  // A service on 2024-01-10, today 2026-06-01: 2022-12-06 … 2026-06-01 = 1 274 days,
  // fetched as 2022-12-06 … 2025-02-12 and 2025-02-13 … 2026-06-01.
  const old: HeatPumpEventDto = { id: 'old', occurredOn: '2024-01-10', heatPumpId: null, kind: 'service', note: null }
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months('2022-10-01'))
  qc.setQueryData(signatureEventsQuery.queryKey, [old] as never)
  // The before-days (2023-12-25 … 2024-01-09) in the first chunk; the after-days moved into the second.
  const all = signatureUnitDays(MATSAL, 0.9, '2023-12-25')
  const after = all.slice(16).map((d, i) => ({ ...d, day: `2025-03-${String(i + 1).padStart(2, '0')}` }))
  qc.setQueryData(heatPumpDaysQuery({ from: '2022-12-06', to: '2025-02-12' }).queryKey, {
    units: [], days: all.slice(0, 16),
  } as never)
  qc.setQueryData(heatPumpDaysQuery({ from: '2025-02-13', to: '2026-06-01' }).queryKey, {
    units: [], days: after,
  } as never)
  await renderWithProviders(<EnergySignatureSection today="2026-06-01" />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
})

test('while the days load, the card shows its loading state', async () => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  qc.setQueryData(signatureEventsQuery.queryKey, [service] as never)
  void qc.prefetchQuery({
    queryKey: heatPumpDaysQuery({ from: '2024-12-16', to: TODAY }).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
})

test('while the events load, the section shows its skeleton and no card', async () => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  void qc.prefetchQuery({ queryKey: signatureEventsQuery.queryKey, queryFn: () => new Promise(() => {}) })
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  // Before the capture (Step 6) the section has a name only: boneyard's wrapper or the plain fallback block.
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-boneyard="heat-pumps-signature"], [data-section-skeleton-fallback]'),
    ).not.toBeNull(),
  )
  expect(readout()).toBeNull()
})
```

(The 1 274-day count, `addDays('2022-12-06', 799) = '2025-02-12'`, `addDays('2026-01-20', −400) = '2024-12-16'` and
`addDays('2025-12-01', −400) = '2024-10-27'`
were checked with `bun -e` on 2026-10-08. The two-chunk test moves the after-days to 2025-03-01 … 03-14, a winter
month inside the second chunk, keeping their ΔT and kWh.)

Run: `bunx vitest run --project browser src/components/heatPump/EnergySignatureSection.browser.test.tsx` → FAIL.

- [ ] **Step 3: Implement the section** (`src/components/heatPump/EnergySignatureSection.tsx`; first version with
  `name="heat-pumps-signature"`, switched to captured bones in Step 6)

```tsx
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  firstLoadPending,
  LoadErrorAlert,
  type LoadErrorQuery,
  loadFailed,
} from '~/components/layout/LoadErrorAlert'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import {
  energySignature,
  eventsForUnit,
  selectedEventId,
  signatureChunks,
  signatureRange,
} from '~/lib/heatPump/signature'
import { byHeatPumpName } from '~/lib/houseEnergy/figures'
import { orpc } from '~/lib/orpc/client'
import { stockholmDayOf } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { EnergySignature, type SignatureDayRow } from './EnergySignature'
import { heatPumpDaysQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'

/** Step 4a's event list: the same cache entry as the Händelser card, so an edit there redraws the signature. */
export const signatureEventsQuery = orpc.heatPump.events.list.queryOptions()

const NO_EVENTS: HeatPumpEventDto[] = []

type DaysChunk = LoadErrorQuery & { data: { days: readonly SignatureDayRow[] } | undefined }

// Module-level, so TanStack keeps the combined result while no chunk changes (a stable
// combine is memoised): the days array, and with it the signature, keeps its identity.
function concatChunks(chunks: readonly DaysChunk[]) {
  return {
    days:
      chunks.length > 0 && chunks.every((c) => c.data !== undefined)
        ? chunks.flatMap((c) => c.data?.days ?? [])
        : null,
    failed: chunks.find(loadFailed) ?? null,
  }
}

// The Energisignatur section (step 4b): the unit and event state, and three reads.
// Units and the first reading day come from step 3's months query (the page's default
// cache entry), the events from step 4a's list (deferred in the loader), and the chosen
// event's days (400 days before it, not before the first reading, to the unit's next
// event or today) from heatPump.days in parallel chunks of ≤ HEAT_PUMP_DAYS_MAX days.
export function EnergySignatureSection({ today: given }: { today?: string } = {}) {
  // Fixed for the page's life: a range that moved at midnight would refetch mid-view.
  const [today] = useState(() => given ?? stockholmDayOf(Date.now()))
  const months = useQuery(heatPumpMonthsQueryFor(null))
  const events = useQuery(signatureEventsQuery)
  const [unitId, setUnitId] = useState<string | null>(null)
  const [chosenEventId, setChosenEventId] = useState<string | null>(null)

  const units = useMemo(
    () => (months.data?.units ?? []).map(({ id, name }) => ({ id, name })).sort(byHeatPumpName),
    [months.data],
  )
  const unit = units.find((u) => u.id === unitId) ?? units[0] ?? null
  const eventList = events.data ?? NO_EVENTS
  const unitEvents = useMemo(() => (unit ? eventsForUnit(eventList, unit.id) : []), [eventList, unit])
  const eventId = unit ? selectedEventId(eventList, unit.id, chosenEventId) : null
  const range =
    unit && eventId
      ? signatureRange({
          events: eventList,
          heatPumpId: unit.id,
          eventId,
          firstReadingDay: months.data?.firstReadingDay ?? null,
          today,
        })
      : null
  const from = range?.from
  const to = range?.to
  const ranges = useMemo(() => (from && to ? signatureChunks(from, to) : []), [from, to])
  const chunks = useQueries({ queries: ranges.map((r) => heatPumpDaysQuery(r)), combine: concatChunks })
  const result = useMemo(
    () =>
      unit && eventId && chunks.days
        ? energySignature({
            days: chunks.days.filter((d) => d.heatPumpId === unit.id),
            events: eventList,
            heatPumpId: unit.id,
            eventId,
          })
        : null,
    [unit, eventId, chunks.days, eventList],
  )

  // Months failing is step 3's alert (its critical read); this section then renders nothing.
  const failed = loadFailed(months) || loadFailed(events)
  return (
    <>
      <SectionSkeleton
        name="heat-pumps-signature"
        loading={!failed && (firstLoadPending(months) || firstLoadPending(events))}
        fallbackHeight="36rem"
      >
        {unit && !failed ? (
          <EnergySignature
            units={units}
            unitId={unit.id}
            // Switching unit resets to that unit's default event (spec).
            onUnitChange={(id) => {
              setUnitId(id)
              setChosenEventId(null)
            }}
            unitEvents={unitEvents}
            eventId={eventId}
            onEventChange={setChosenEventId}
            result={result}
          />
        ) : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.heat_pump_signature_error_title()} query={events} />
      {chunks.failed ? <LoadErrorAlert title={m.heat_pump_signature_error_title()} query={chunks.failed} /> : null}
    </>
  )
}
```

Notes for the implementer:
- `combine: concatChunks` must stay a module-level function (an inline arrow re-runs on every render and gives a new
  days array each time). If TypeScript rejects its parameter type against oRPC's query results, widen `DaysChunk`'s
  `data` to `unknown` and narrow inside with a type guard; don't inline it.
- `events` failing also fails step 4a's Händelser card, which shows its own alert: if two alerts for one failure read
  badly in the live check, drop this section's events alert and note it in the PR.

Run: `bunx vitest run --project browser src/components/heatPump/EnergySignatureSection.browser.test.tsx` → PASS (6).

- [ ] **Step 4: Mount it in the route** (`src/routes/_authenticated/energy/heat-pumps.tsx`)
  - Imports: `import { EnergySignatureSection, signatureEventsQuery } from '~/components/heatPump/EnergySignatureSection'`.
  - Loader: add `signatureEventsQuery` to `loadRouteData`'s `deferred` list (create the key if absent; skip if step
    4a already lists `orpc.heatPump.events.list.queryOptions()` there or in `critical`, since the keys are equal).
    The months query is already step 3's critical read; the days depend on the chosen event, so the section starts
    them itself once the events land. Comment:
    `// The signature sits below the fold: its events are deferred (ADR-0025); its days follow the chosen event.`
  - JSX: `<EnergySignatureSection />` between the Förbrukning section and step 4a's `HeatPumpEvents` section (the
    spec's order: Förbrukning, Energisignatur, Händelser), inside the same `flex flex-col gap-4` column, and only
    where the page renders its sections (not inside step 3's no-data `Empty` branch).

Run: `bunx vitest run --project browser src/routes/_authenticated/energy/ src/components/heatPump/` → PASS (step 3/4a's
page tests unchanged; if a page test asserts that no fetch starts, seed the events query there too).

- [ ] **Step 5: Bundle check** (`scripts/measureBundle.ts`): add `'simple-statistics'` to `WATCHED`; if `PAGES` has
  no `/energy/heat-pumps` entry, add `'/energy/heat-pumps': 'heat-pumps'`. Then:

```bash
bun run bundle:measure 2>&1 | grep -A3 "heat-pumps"
```

Expected: the page line lists `simple-statistics` and the page grew ≤ 6 KB gz over `main` (scatter + card + a
sub-kilobyte fit; record both numbers in the PR). `simple-statistics` near 45 KB means the import isn't tree-shaken:
stop and fix. The `entry:` line is unchanged (nothing here reaches the entry).

- [ ] **Step 6: Capture the skeleton** (dev server on 14611 with local heat pump data, see Task 6 Step 1)

```bash
BONES_ORIGIN=http://localhost:14611 bun run bones:capture /energy/heat-pumps
ls src/bones/ | grep heat-pumps-signature
```

Then in `EnergySignatureSection.tsx`: `import signatureBones from '~/bones/heat-pumps-signature.bones.json'` and
`<SectionSkeleton bones={signatureBones} …>` in place of `name="heat-pumps-signature"`. Run
`bunx vitest run test/sectionSkeletonBones.test.ts` → PASS, and the section tests (the capture's name is still
`heat-pumps-signature`).

- [ ] **Step 7: Commit**

```bash
bun run check
git add messages/sv.json messages/en.json src/components/heatPump/EnergySignatureSection.tsx src/components/heatPump/EnergySignatureSection.browser.test.tsx src/routes/_authenticated/energy/heat-pumps.tsx scripts/measureBundle.ts src/bones/heat-pumps-signature.bones.json
git commit -m "feat(heat-pumps): show the energy signature on Värmepumpar" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Verify live, review the branch, record the step, open the PR

- [ ] **Step 1: Live (Phase 6).** Local data first: the worktree's dev server on 14611 with the `.env.local`
  Comfort Cloud credentials (step 1b's sync). Backfill until both units have `history_complete_at` (each run stores
  ≤ 60 days per unit):

```bash
CRON_SECRET=$(grep -h '^CRON_SECRET=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)
for i in $(seq 1 15); do curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:14611/api/cron/comfort-cloud-sync >/dev/null; done
psql postgres://videbacken:videbacken@localhost:14620/videbacken -c "select name, registered_on, history_complete_at, (select min(hour_start) from heat_pump_reading r where r.heat_pump_id = p.id) from heat_pump p order by name"
```

  Signed in as an admin through Mailpit (memory: live UI check via Playwright; wait for load + 4 s, never
  `networkidle`). `/energy/heat-pumps` at 1440, 820 and 390 px, light and dark:
  - With the real 2026-10-08 service (Båda) logged: each unit reads "Inte tillräckligt med data än (k av 14 dagar)"
    with k small, the before points and line drawn, after points (if any) as squares. The network log shows one
    `heatPump/days` request for 2025-09-03 … today (2026-10-08 − 400 days; later if the first reading is later).
  - Log a **local-only** test event through the Händelser dialog (e.g. Filterrengöring, Matsal, 2026-01-15) and pick
    it: the readout shows a percentage and margin; the before and after lines each stay within their points; hollow
    squares appear only outside the before ΔT range; days the unit was off are not points. Delete the test event
    afterwards.
  - Switch Matsal ↔ Övervåning with the Matsal-only event selected: the select falls back to the service.
  - The card's rect stays the same height (± 0,5 px) when switching unit and event, loading included, at every width;
    the header's toggle and select wrap under the title at 390 px with no horizontal overflow; the hover card shows on
    a point and closes off the plot; "Visa som tabell" opens a scrollable table; console clean. Screenshots for the PR.
  - Spot-check one before-day against SQL (local DB): the table's ΔT and kWh for that day equal the checkpoint 6
    query's row (below) for the same unit and day.

- [ ] **Step 2: Branch review (Phase 5).** In parallel: `code-reviewer` (ADR-0027/0025 adherence over the whole
  diff, aggregates only, client-safe imports, the shared cache keys), `test-completeness` (every rule in
  `signature.ts` has a test), and a general correctness pass (`/code-review high`-style subagent told to recompute
  Task 2's expectations, to check the range and chunk bounds, and to look for a foreign event id reaching
  `energySignature` or `signatureRange`). Fix or rule on every finding.

- [ ] **Step 3: Pre-PR gate** (`docs/feature-workflow.md#pre-pr-gate`, verbatim):

```bash
bun run check                    # Biome writes fixes; commit anything it changed
bun run check:ci                 # = CI's Check (lint): must pass with no writes
bun run build                    # = Check (build); includes tsc --noEmit (= Check (types))
bun run db:up && bun run db:migrate   # tests need the local Postgres container
bun run test                     # = Test: node (per-test schema) + browser projects
# sv/en message keys match (CI doesn't check this):
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
```

  Plus `TZ=UTC bunx vitest run src/lib/heatPump/ && TZ=UTC bunx vitest run --project browser src/components/heatPump/`
  (CI runs in UTC). Browser files that fail only after a merge (Vite re-optimising deps after the new package) are
  re-run alone before calling them failures.

- [ ] **Step 4: Roadmap** (`docs/superpowers/roadmaps/2026-10-08-heat-pumps.md`): row 4b → PR link, `PR open`; in
  checkpoint 6, after "(SQL for the daily sums + a separate least-squares fit)", add
  `— the queries and script are in [step 4b's plan](../plans/2026-10-08-heat-pumps-4b-signature.md#checkpoint-6-independent-reproduction)`;
  a Log line with the live result. (The spec already carries this plan's decisions; if the build changes one, say so
  in the Log line and the PR.)

- [ ] **Step 5: CLAUDE.md** (the router file; one line each, in the house style):
  - Code map, under `src/lib/` (beside the other `heatPump/` entries steps 1b–4a added, or as a new line after
    `time/stockholm.ts` if none): `    heatPump/signature.ts       client-safe energy signature (qualifying days, event windows, fetch range + chunks, OLS fit via simple-statistics; ADR-0027)`
  - Stack, the **Data layer** line (or a new **Statistics** bullet if that reads better):
    `` `simple-statistics` (`linearRegression`, named imports only: the full bundle is 45 KB gz) for the heat pump energy signature``.

- [ ] **Step 6: Commit and PR**

```bash
git add docs/superpowers/roadmaps/2026-10-08-heat-pumps.md CLAUDE.md
git commit -m "docs(heat-pumps): track step 4b and map the signature" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/heat-pumps-signature
gh pr create --title "feat(heat-pumps): add the energy signature" --body-file <(…)
```

  The body follows `.github/PULL_REQUEST_TEMPLATE.md`: why (ADR-0027 decision 9, spec link), the library decision
  table, "Notes for the reviewer" = the decisions above (and any adaptation from Task 0), the bundle numbers, the
  pre-PR gate output, screenshots at three widths in both themes, and the PR description's last line
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Checkpoint 6 runs after merge, in a new session,
  once ≥ 14 qualifying after-days exist (expected November 2026).

---

## Checkpoint 6: independent reproduction

Runs on prod after merge, when the card first shows a percentage for the 2026-10-08 service. Read-only SELECTs only
(owner-approved for verification). It must not reuse the app's code: SQL straight from `heat_pump_reading`, and a
Python fit (`statistics.linear_regression`, a different implementation from simple-statistics).

**1. Daily inputs per unit** (run with the Supabase MCP `execute_sql`, read-only; save the JSON rows to
`$SCRATCH/days.json`):

```sql
-- One row per unit per Stockholm day: the signature's inputs, computed independently of daySums.
with h as (
  select p.name,
         (r.hour_start at time zone 'Europe/Stockholm')::date as day,
         r.energy_kwh,
         r.energy_kwh * r.heat_share as heat_kwh,
         r.energy_kwh * r.cool_share as cool_kwh,
         r.inside_c,
         r.outside_c
  from heat_pump_reading r
  join heat_pump p on p.id = r.heat_pump_id
)
select name,
       day::text as day,
       sum(energy_kwh)::float8 as kwh,
       coalesce(sum(heat_kwh), 0)::float8 as heat_kwh,   -- Σ kWh × heat share, nulls as 0 (match step 3, Task 0)
       coalesce(sum(cool_kwh), 0)::float8 as cool_kwh,
       avg(inside_c)::float8 as inside_c,                -- hour-weighted mean over hours with a value (match step 3)
       avg(outside_c)::float8 as outside_c,
       count(*)::int as hours,
       (extract(epoch from ((day + 1)::timestamp at time zone 'Europe/Stockholm')
                         - (day::timestamp at time zone 'Europe/Stockholm')) / 3600)::int as day_hours
from h
group by name, day
order by name, day;
```

**2. Events** (save to `$SCRATCH/events.json`):

```sql
select e.id::text, e.occurred_on::text as occurred_on, coalesce(p.name, 'Båda') as unit, e.kind
from heat_pump_event e
left join heat_pump p on p.id = e.heat_pump_id
order by e.occurred_on, e.created_at;
```

**3. The fit** (Python ≥ 3.10 for `statistics.linear_regression`; the system `python3` is 3.9, so use `python3.14`: `python3.14 -I $SCRATCH/signature_check.py $SCRATCH/days.json $SCRATCH/events.json`; the script lives in
the scratchpad, never committed):

```python
import json, math, statistics, sys

days = json.load(open(sys.argv[1]))
events = json.load(open(sys.argv[2]))

for unit in sorted({d["name"] for d in days}):
    own = sorted((e for e in events if e["unit"] in (unit, "Båda")), key=lambda e: e["occurred_on"])
    services = [e for e in own if e["kind"] == "service"]
    if not own:
        print(unit, "no event"); continue
    on = (services or own)[-1]["occurred_on"]
    prev = max((e["occurred_on"] for e in own if e["occurred_on"] < on), default=None)
    nxt = min((e["occurred_on"] for e in own if e["occurred_on"] > on), default=None)
    event_days = {e["occurred_on"] for e in own}

    q = []
    for d in sorted((d for d in days if d["name"] == unit), key=lambda d: d["day"]):
        if d["day"] in event_days or d["inside_c"] is None or d["outside_c"] is None:
            continue
        if d["hours"] != d["day_hours"] or d["kwh"] <= 0:
            continue
        if d["heat_kwh"] < 0.5 * d["kwh"] or d["cool_kwh"] > 0.02 * d["kwh"]:
            continue
        dt = d["inside_c"] - d["outside_c"]
        if dt >= 3:
            q.append((d["day"], dt, d["kwh"]))

    before = [x for x in q if x[0] < on and (prev is None or x[0] > prev)][-90:]
    after = [x for x in q if x[0] > on and (nxt is None or x[0] < nxt)]
    xs = [x[1] for x in before]
    if len(before) < 14 or max(xs) - min(xs) < 4:
        print(unit, "not enough before:", len(before)); continue
    fit = statistics.linear_regression(xs, [x[2] for x in before])
    lo, hi = min(xs), max(xs)
    used = [x for x in after if lo <= x[1] <= hi]
    if len(used) < 14:
        print(unit, f"not enough after: {len(used)} of 14"); continue
    pred = sum(fit.intercept + fit.slope * x[1] for x in used)
    act = sum(x[2] for x in used)
    s = math.sqrt(sum((x[2] - (fit.intercept + fit.slope * x[1])) ** 2 for x in before) / (len(before) - 2))
    print(unit, f"event {on}: change {100 * (act - pred) / pred:+.2f} %, margin ±{100 * 1.96 * s * math.sqrt(len(used)) / pred:.2f} %,"
          f" {len(used)} after, {len(before)} before, a={fit.intercept:.4f} b={fit.slope:.4f}")
```

(The script reads every stored day, not the app's 400-day window: the latest 90 qualifying before-days of a heating
season lie well inside 400 days, so both see the same before set. If the counts differ, check that first.)

**4. Compare.** On prod `/energy/heat-pumps`, for each unit read
`document.querySelector('[data-slot="signature-readout"]').dataset.change` (DevTools console) and the readout's day
counts. Pass: |page change − script change| ≤ 0,5 percentage points per unit, and the day counts equal. A mismatch
in the counts points at a definition (temperature means, heat share, completeness), not at the fit: compare the
script's qualifying days with the card's table before anything else. Record both numbers per unit in the roadmap's
checkpoint 6 cell, then the owner judges plausibility and wording.
