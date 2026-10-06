# Energi period control (step 1b) — design

Status: agreed 2026-10-05, from the owner's review of `/energy` after step 1. Amends the
[house energy pages design](./2026-10-05-house-energy-pages-design.md) (decision 6, the tiles, the chart) and
[ADR-0024](../../adr/0024-house-energy-pages.md) decision 6. Roadmap: step 1b of the
[house energy pages roadmap](../roadmaps/2026-10-05-house-energy-pages.md).
Mockup the owner approved: <https://claude.ai/artifact/BJF8ZV8vXwH3DhsPRWVtgv> (version 5; prod's 2026 sums).

## Intent

Step 1 shows the current month, the current year and all time. The owner wants the details of **any month** (and
any year), picked from the tiles or by clicking the chart, without the segmented tabs, which took about a third of
the card. The owner's review also set four rules for this page: nothing may shift when the period changes, text
must be readable (it is too small throughout the app), the chart's colours must be told apart easily, and hovering
a month shows its values.

**Success:**
- Any month with readings, any year with readings, or all time can be chosen in at most two taps, and month to
  month in one.
- Changing the period moves no element on the page (measured, not eyeballed).
- The chart's colours pass the data-viz palette validator (CVD and normal vision, light and dark).
- Every figure still matches a plain SQL sum (step 1's rule).

## Owner decisions (2026-10-05)

| # | Decision |
|---|---|
| 1 | **Both ways to pick**: a period control on the tiles card, and clicking a month in the chart. |
| 2 | **Stepper + picker**: `‹ augusti 2026 ⌄ ›` in the tiles card header replaces the segmented tabs. ‹ › step within the kind (month → month, skipping months without readings; year → year); they are disabled for Totalt and at the ends. |
| 3 | **The picker never scrolls**: one panel with the year and ‹ › to change it, the year's twelve months in a 3 × 4 grid (months without readings disabled, the current month marked "hittills"), then *Hela {år}* and *Totalt*. |
| 4 | **The chosen period's year is the chart's year.** The chart loses its own year selector. Totalt shows the current year's chart. |
| 5 | **The chosen month is highlighted in the chart** (a tinted column and a bold month label); other months keep their full colours (no dimming). |
| 6 | **Hovering a month outlines its column** (label included) and shows a **tooltip**: each series' kWh and share (%, smaller), the view's total, and "Data saknas för N h" when it applies. Keyboard focus does the same. On touch, a tap selects the month; no tooltip. |
| 7 | **No layout shift**: the period label has the width of the widest label it can show; detail lines and the gap note always keep their space. |
| 8 | **Readable sizes** (researched, see below). The owner made them the **app-wide** scale; this page goes first, the rest of the app in its own pass. |
| 9 | **Validated colours, one meaning each** (see below), shared with `/charging` through the existing tokens. |

## Period model

```ts
type EnergyPeriod =
  | { kind: 'month'; year: number; month: number } // month 1–12
  | { kind: 'year'; year: number }
  | { kind: 'all' }
```

- **URL**: `?period=2026-08` | `?period=2026` | `?period=all`, parsed by a pure client-safe helper
  (`src/lib/houseEnergy/period.ts`: `parsePeriod`, `formatPeriod`, `stepPeriod`, `defaultPeriod`). An invalid or
  missing value means the default. The step-1 `?year=Y` still works: it reads as `?period=Y`.
- **Default**: the current Stockholm month; when it has no readings yet (the first hour of a new month), the newest
  month with readings this year; with none this year yet (a new year's first hour), Totalt. With no readings at all,
  the empty state as today.
- **A period without readings** (a hand-typed URL) falls back to the default, like step 1's year fallback.
- **The chart's year** = the period's year; for `all`, the current Stockholm year.
- **Stepping** uses `monthsWithReadings` (below): month steps skip months without readings; year steps go through
  the years that have readings.

## Read model changes

`EnergyOverview` (`src/lib/services/houseEnergy/energyOverview.ts`) changes shape:

```ts
type EnergyOverview = {
  year: number                       // the chart's year, as before
  availableYears: number[]           // as before
  firstReadingDay: string | null     // as before
  monthsWithReadings: string[]       // 'YYYY-MM', oldest first, every year (the picker and the stepper)
  yearTotal: PeriodSums | null       // the chart year's total (period bounds, as the step-1 year tile)
  allTime: PeriodSums | null         // as step 1's all-time tile
  months: (PeriodSums | null)[]      // the chart year's 12 months, as before
}
```

- `tiles.thisMonth` / `tiles.thisYear` go away. A month's figures are `months[m − 1]` of its year; a year's are
  `yearTotal`. The query input stays `{ year }`, so a month switch inside a year costs no request, and a year switch
  is one request (the old figures stay, dimmed, while it loads: step 1's `keepPreviousData` pattern).
- `yearTotal` uses step 1's tile rule: expected buckets from the year's bounds clipped to the first reading's day and
  the newest reading, so a month without readings counts as missing. Its car kWh is the sum of the charging
  overview's months for that year (`getOverview({ year, vehicle: 'all' })` already returns them), so a past year's
  total works too.
- `monthsWithReadings` comes from the same grouped scan (one row per month with readings). Still one scan per
  request (the hourly scan of #95).
- The battery page (step 2) reads the same shape; its plan is re-checked against step 1b before it starts.

## UI

### The period control (`src/components/energy/PeriodControl.tsx`)

```
Summering                                ‹   augusti 2026  ⌄   ›
                                         ┌──────────────────────┐
                                         │ ‹        2026      › │
                                         │  jan    feb    mar   │
                                         │  apr    maj    jun   │
                                         │  jul   [aug]   sep   │
                                         │  okt    nov    dec   │
                                         │       hittills       │
                                         │ ──────────────────── │
                                         │ [Hela 2026] [Totalt] │
                                         └──────────────────────┘
```

- A shadcn `Popover` (installed, Radix) holds the picker; on a phone it spans the card width. Every button ≥ 44 px
  tall; the arrows are 40 × 40 px with 20 px chevrons; the label's chevron is 18 px (lucide `ChevronDown`).
- **Fixed label width without JS**: every label the control can show (each month with readings, each year, Totalt)
  is rendered into the same grid cell, all but the current one `invisible` and `aria-hidden`, so the cell is as wide
  as the widest. SSR-safe, no measuring.
- Accessible names: "Föregående månad" / "Nästa månad" (or "år"), the label "Period: augusti 2026. Välj period".
  The picker is a dialog; Escape closes it and returns focus to the label.
- The period lives in the URL (`navigate({ search, replace: true, resetScroll: false })`), so reload and share keep it.

### Tiles

- The five readouts stay (step 1's figures and copy), fed the chosen period's `PeriodSums`.
- **Grid**: 5 columns when the card is ≥ 980 px wide, 3 from 560 px, else 2 (a container query, not the viewport).
- **No shift**: each detail line reserves two lines; the "Data saknas för N h" line is always rendered (empty when
  complete). The current month and the current year say "(hittills)" in the period label.
- `PeriodTabs` is removed; the battery tiles (step 2) use the same control and the same reserved-space readouts.

### Chart (`EnergyMonthlyChart`)

- **Click / Enter on a month** selects it (`?period=YYYY-MM`). Months without readings aren't clickable.
- **Hover / focus outline**: a rounded outline around the whole month column, label included; the cursor is a
  pointer. The selected month has a tinted column behind its bars and a bold label.
- **Tooltip** (desktop hover, keyboard focus): the month (+ "(hittills)"), one row per series with its swatch,
  kWh and share of the view's total in a smaller muted column (13 px), a total row (Producerat / Köpt totalt /
  Förbrukat), Såld as its own row in the Nät view, and the gap note. Placed beside the column, flipping left near
  the right edge.
- **Marks**: a 2 px surface gap between stacked segments, 2 px rounded ends, no dimming of other months.
- **Phone**: month labels shorten to initials when a month's column is narrower than 36 px.

### Colours (validated)

Checked with the data-viz skill's `validate_palette.js` (`--pairs all`; light on `#ffffff`, dark on `#1c1c1f`), for
every set that is shown together (the solar stack, the grid stack, the consumption stack, the tile swatches).

| Token | Meaning | Light | Dark |
|---|---|---|---|
| `--energy-solar` | solar used directly | `#eda100` | `#c98500` |
| `--energy-battery` | into / from the battery | `#1baf7a` | `#199e70` |
| `--energy-export` | sold | `#2a78d6` | `#3987e5` |
| `--energy-grid` | bought | `#475569` | `#94a3b8` |
| `--energy-house` (new) | the rest of the house | `#eb6834` | `#d95926` |
| `--energy-car` (new) | car charging | `#4a3aa7` | `#9085e9` |

- Rejected on the way (validator FAIL): violet for bought (too close to blue for protan in dark), orange for bought
  (too close to solar yellow), magenta for bought (too close to aqua for deutan in dark).
- In light mode yellow and aqua are below 3:1 against white: the legend and the tooltip carry identity, so colour is
  never the only cue.
- `--energy-solar`, `--energy-battery` and `--energy-grid` are shared with `/charging` (`EnergySourceBar`): the new
  values apply there too, on purpose (one meaning per colour). Car (`--brand`) and house (`--chart-2`) in step 1
  move to the new tokens.

### Sizes on this page (researched)

From WCAG 2.2, Apple HIG, Material 3, GOV.UK, USWDS, NN/g and chart guides (ONS, Datawrapper): no source supports
12 px muted text for labels; 14 px is the floor for labels and helper text, 12–13 px for captions and chart ticks.

| Role | Size |
|---|---|
| Readout label | 14 px, medium, foreground (not muted) |
| Readout figure | 36 px (28 px in the two-column grid); unit 16 px muted |
| Detail line, gap note | 14 px muted |
| Period label | 16 px semibold; "(hittills)" 14 px muted |
| Chart ticks | 13 px; legend 14 px; tooltip 14 px, shares 13 px |
| Card titles | 18 px |
| Icons next to text | 16–20 px; tap targets ≥ 40 px (44 px in the picker) |

Muted text stays on the card surface only (muted on `bg-muted` fails 4.5:1).

**App-wide (owner, 2026-10-05):** the whole app follows this scale. This page adopts it in step 1b; the rest of the
app gets its own pass (an ADR-0015 type-scale amendment, then the ≈48 `text-xs` + muted places and the 9–11 px
chart labels), planned separately so it doesn't tangle with the energy steps.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| `?period=` invalid, or a period without readings | The default period. |
| `?year=2026` (step-1 links) | Read as `?period=2026`. |
| Current month without readings yet | Default = the newest month with readings this year, else Totalt. |
| Year switch while loading | Old figures and chart stay, dimmed, until the new year lands. |
| Year read fails | The period control stays usable (step 1's `lastShown` rule); the alert explains. |
| Only one year with readings | The year arrows in the stepper and the picker are disabled. |

## Testing

- `period.ts` (node, test-first): parse/format round trip, the legacy `?year=`, invalid input, the default (current
  month, the first-hour fallback, no readings), stepping across a year boundary and over months without readings,
  the ends.
- `energyOverview.ts` (node): `monthsWithReadings` across two years; `yearTotal` for a past year (car kWh from that
  year's months; a month without readings counts as missing); `allTime` unchanged.
- Components (browser): the control steps and disables at the ends; the picker shows twelve months, disables those
  without readings, picks a month, a year, Totalt; the URL follows; a chart click selects a month; the tooltip lists
  rows with shares; readouts keep their reserved lines.
- **Live (Playwright, the local dev server)**: at 1440, 820 and 390 px, light and dark, switch through months with
  and without a gap note, a year and Totalt, and assert that the bounding boxes of the arrows, the label, the tiles
  card and the chart don't change. The owner reviews the page live (checkpoint 1b).

## Out of scope

- Applying the scale to the rest of the app (decided; its own plan and PR, after this step).
- Day views, kronor (unchanged from the design).
