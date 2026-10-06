# Energi summary as a flow diagram (step 1c) — design

Status: agreed 2026-10-06, from the owner's live review of step 1b (checkpoint 1b). Amends the
[period control design](./2026-10-05-energy-period-control-design.md) ("Tiles") and the
[house energy pages design](./2026-10-05-house-energy-pages-design.md) (decision 4, overview figures), and
[ADR-0024](../../adr/0024-house-energy-pages.md) decision 6. Roadmap: step 1c of the
[house energy pages roadmap](../roadmaps/2026-10-05-house-energy-pages.md).
Mockup the owner approved: <https://claude.ai/artifact/EuLriFUiKZcpxnaYhXDDHB> (version 4; prod's 2026 sums).

## Intent

Step 1b's Summering card shows the chosen period as five number tiles. The owner found them "5 blobs inside a card",
and the colour swatches of the approved 1b mockup never made it into the build. They want the same figures shown so
that how they relate is visible at a glance, built with visx, and the battery's loss shown too.

**Success:**
- The five figures (Solel, Köpt el, Såld el, Förbrukning with its car part, Självförsörjning) and the battery's loss
  are readable at a glance at 1440, 820 and 390 px, in light and dark.
- Where the energy went is drawn: every flow between solar, the grid, the battery and the house is an arrow whose
  width is its kWh, coloured by where the energy came from.
- Changing the period moves nothing (step 1b's rule, measured).
- Every value matches a plain SQL sum (step 1's rule); the loss matches ADR-0024's definition.

## Research (2026-10-06)

- Most vendors (SMA, sonnen, SolarEdge, Tesla) summarise a period as part-to-whole views: where the solar went and
  what covered the load. Node-flow and Sankey diagrams are mostly used for live power. Home Assistant's period
  node-flow card draws the complaint that it looks live.
- Bars beat pies and donuts for comparing shares (Few, Datawrapper). A Sankey's small flows can't carry labels on a
  phone; label nodes directly and keep values outside thin links.
- Self-sufficiency (load covered by own generation ÷ load) and self-consumption (solar used on site ÷ solar
  produced) are separate metrics. Our self-sufficiency counts grid-charged battery energy as bought (decision 5 of
  the house energy design), so the arrows into the house add up to more than it, by design.
- Libraries: `@visx/sankey` exists, but the graph here has a fixed shape (five nodes, at most seven flows), so the
  layout is hand-placed and needs no layout library.

## Owner decisions (2026-10-06)

| # | Decision |
|---|---|
| 1 | **A flow diagram** replaces the five tiles: Solel and Köpt el in, the battery in the middle, Förbrukning and Såld el out. Chosen over figure tiles with built-in marks and two in/out bars. |
| 2 | **Exactly today's figures stay**, each on its own node. Självförsörjning opens the card with a small ring. The detail lines (solar split, "varav till batteriet") become arrow values. |
| 3 | **The battery shows its loss**: the node gives the loss and the charge level at the period's start and end, and a fading stub leaves it, as wide as the loss. |
| 4 | **One layout, in → out**: in on the left, out on the right; on a narrow card, in on top, out below. A single grid node (bought and sold together) was tried and dropped: its arrows cross. |
| 5 | **Values on the arrows by default**, with a "Visa värden" switch on the card, remembered per browser. |
| 6 | **The battery arrow is one colour** (aqua). Splitting it by charge origin was tried and dropped. |
| 7 | **Big icons** name the nodes at a glance: solar panel, utility pole, battery, house, coins. |
| 8 | **The text block is centred on its icon tile** (the owner caught a 3 px drop that read as "shifted down"). |
| 9 | **Built with visx** (installed 4.0.0 packages), no new dependency. |

## Figures

Everything comes from the chosen period's `PeriodSums` through `energyFigures` (`src/lib/houseEnergy/figures.ts`).
Two values are new there (pure, test-first):

| Field | Rule |
|---|---|
| `batteryToGrid` | max(0, `gridExportKwh` − `solarExported`): export the solar surplus can't explain |
| `batteryToHouse` | max(0, `batteryOut` − `batteryToGrid`) |

What each element shows:

| Element | Value |
|---|---|
| Solel node | `solarKwh` |
| Köpt el node | `gridImportKwh` |
| Såld el node | `gridExportKwh` |
| Förbrukning node | `loadKwh`; "varav laddning" `car` (lines hidden when `car` is 0, space kept) |
| Självförsörjning line | `selfSufficiency` (as today) |
| Battery node | `loss` and "laddnivå {firstSocPct} → {lastSocPct} %" |
| Solel → Förbrukning | `solarDirect` |
| Solel → Batteri | `solarToBattery` |
| Solel → Såld el | `solarExported` |
| Köpt el → Förbrukning | `importDirect` |
| Köpt el → Batteri | `importToBattery` |
| Batteri → Förbrukning | `batteryToHouse` |
| Batteri → Såld el | `batteryToGrid` |
| Loss stub | `loss` |

- An arrow below 0.05 kWh isn't drawn (it would read "0,0").
- **Loss display** (the house energy design's rules): |loss| < 0.5 kWh or a negative loss shows "≈ 0 kWh" and no
  stub; the table and the tooltip keep the real value. Its share = loss ÷ (`batteryIn` − `deltaStored`), shown only
  when `efficiency` isn't null. A share above 25 % adds the winter hint to the tooltip.
- The charge-level line is left out when either SoC is null.

## UI

### The card

```
Summering                                   ‹  oktober 2026 (hittills) ⌄  ›
◔ Självförsörjning  27 %  av förbrukningen var inte köpt

┌───────────┐ ─────────── 15,5 ─────────────────────────────▶ ┌───────────┐
│ ☀ Solel    │ ────── 39,6 ───────────────────┐               │ ¤ Såld el  │
│   76,9 kWh │ ── 21,8 ──┐                    │               │   15,5 kWh │
└───────────┘           ▼                    │               └───────────┘
                  ┌──────────────┐           ▼
                  │ ▭ Batteri     │ ── 49,0 ──▶ ┌───────────────┐
                  │ Förlust 0,7   │            │ ⌂ Förbrukning  │
                  │ 19 → 100 %    │            │   200,6 kWh    │
                  └──────────────┘            │ varav laddning │
┌───────────┐           ▲  ░ (loss stub)      │   28,4 kWh     │
│ ⊤ Köpt el  │ ── 34,0 ──┘                    └───────────────┘
│  145,8 kWh │ ═══════════ 111,8 ═══════════════▶
└───────────┘
Pilens bredd visar mängden energi. Färgen visar var den kom ifrån.   [●] Visa värden
Data saknas för N h
▸ Visa som tabell
```

- The period control, the period announcement, the stale dimming and the gap note stay as in step 1b.
- `EnergyReadouts` (`src/components/energy/EnergyTiles.tsx`) is replaced by `EnergyFlow`
  (`src/components/energy/EnergyFlow.tsx`), fed the same `PeriodSums | null | 'unavailable'`.

### Geometry (`src/lib/houseEnergy/flowLayout.ts`, pure, client-safe)

The diagram's width `W` is the card content's width (visx `ParentSize`). One function returns, for a width, the box
height, the nodes, the arrows (from, to, sides, offsets, curve factors, label position) and the loss stub. The
mockup's numbers are the starting point:

| | Wide (W ≥ 860) | Narrow (W < 860) |
|---|---|---|
| Height | 360 | 490 |
| Node | 236 × 80; Förbrukning 236 × 124; battery 236 × 84 | `nw` = min(220, ⌊(W − 24) ÷ 2⌋) × 82; Förbrukning × 134; battery min(190, nw + 4) × 82 |
| Positions | Solel top-left, Köpt el bottom-left, battery centre, Såld el top-right, Förbrukning bottom-right | Solel top-left, Köpt el top-right, battery centre (+14·k), Såld el bottom-left, Förbrukning bottom-right |
| Loss stub | below the battery, 44 long | right of the battery, min(30, 18·k) long |

- On the narrow layout the port offsets were tuned for a 146 px node and scale by k = nw ÷ 146, so the tablet
  layout (≈ 754 px) keeps the arrows apart.
- **Arrows**: a cubic Bézier from a port on the source's side to just outside the target's port, each end leaving
  along its side's normal; the control distance is a share of the distance along that axis (0.5 by default;
  Solel → Förbrukning on the narrow layout 0.9 / 0.25 so it passes under the battery). A 9 px triangle arrowhead
  sits on the target's edge. No arrow passes through a node, and no two arrows cross, at 324, 754 and 1006 px, with
  one exception: Batteri → Såld el crosses Solel → Förbrukning. With the in nodes on one side and the out nodes on
  the other, Solel → Förbrukning separates the battery from Såld el, so no routing inside the box avoids it. That
  arrow exists only when export exceeds the solar surplus, which is zero in every 2026 month so far.
- **Width**: linear in kWh, max(2, 20 × v ÷ the period's largest arrow) (16 on narrow). The loss stub uses the same
  scale with a 4 px minimum. Widths stay linear: in winter the bought arrow sets the scale and the battery's arrows
  are thin, which is true.
- **Value pills**: at the curve's midpoint (Köpt el → Förbrukning on narrow at t = 0.22, clear of the loss stub), 14 px
  semibold, tabular figures, card-coloured with a border. Drawn above the nodes.
- The cubic is a few lines of hand-written math (trivial; no installed library draws a curve between a horizontal
  and a vertical port).

### Nodes

- A rounded box (12 px) on a slightly raised surface, with an **icon tile**: 48 px with a 28 px icon on wide, 34 px
  with a 20 px icon on narrow. Icons from lucide-react (installed): `SolarPanel` (Solel), `UtilityPole` (Köpt el),
  `BatteryMedium` (battery), `House` (Förbrukning), `Coins` (Såld el), stroked in the foreground colour.
- The three sources' tiles are tinted with their arrow colour (`color-mix(in oklab, <colour> 24%, <node surface>)`),
  so they double as the colour key. That brings back the swatches the 1b build lost. The out nodes' tiles are
  neutral.
- **Wide**: the tile sits left of the text; the text block (label cap top to figure baseline: 14 px label, 28 px figure,
  14 px muted unit) is **centred on the tile**, not on the font's line box (cap height ≈ 0.7 em). The battery's three rows (label, "Förlust
  X kWh" with a 20 px figure, 13 px "laddnivå") are centred on its tile the same way (2 px higher than mockup version 4, which sat 2 px low by that measure). Förbrukning's car lines hang
  below the top row.
- **Narrow**: the tile and the label share the first row (label centred on the tile); the figure (24 px) runs the
  node's full width below. The battery drops the charge level (it moves to the loss tooltip).

### Självförsörjning line

A 44 px ring (6 px track, foreground arc from 12 o'clock) beside "Självförsörjning", the percentage (28 px; 24 px
narrow) and "av förbrukningen var inte köpt". "—" with an empty ring when there is no load.

### Colours

Arrows take the colour of where their energy came from: `--energy-solar`, `--energy-grid`, `--energy-battery` (the
loss stub fades from battery aqua to transparent). Checked with the data-viz `validate_palette.js --pairs all`:

| Set | Light (#ffffff) | Dark (#1c1c1f) |
|---|---|---|
| solar, grid, battery | CVD ΔE 9.1, normal 22.9: pass; contrast WARN for yellow and aqua (the value pills carry the numbers) | CVD 8.4, normal 16.2: pass |
| all six energy tokens | normal-vision FAIL (orange vs yellow 13.7; violet vs grey 13.5) | CVD FAIL (violet vs blue 1.9) |

So only the three source colours appear in the diagram; house orange, car violet and sold blue stay out of it. The
grey "chroma floor" fail on `--energy-grid` is the 1b decision (bought is a deliberate neutral).

### The "Visa värden" switch

A shadcn `Switch` (Radix; not installed yet: `bunx shadcn@latest add switch`, see the shadcn-add gotchas) with its
label, beside the hint line under the diagram. On by default. Hiding the values
removes the pills only; nothing moves. Remembered per browser in `localStorage` (`videbacken-energy-flow-values`),
read through `useSyncExternalStore` with the server snapshot "on", so a viewer who turned it off sees the pills for a
moment on load (no layout change). A cookie read during SSR was weighed and not worth the plumbing for this.

### Tooltip

Pointer hover (or a tap) on an arrow or the loss stub shows the existing `ChartPopover` (visx tooltip): the flow
("Solel → Förbrukning") with its colour swatch, the kWh, and a share: of the solar ("52 % av solelen"), of the
bought ("77 % av köpt el") or of the load ("24 % av förbrukningen"). The loss tooltip gives the loss, its share of
what went in, the charge level, and the winter hint above 25 %. The other arrows dim while one is hovered. Hit areas
are at least 22 px wide.

### Accessibility

- The diagram is an `<svg role="img">` with a description that points to the table; arrows aren't tab stops.
- "Visa som tabell" (a `<details>` under the diagram) lists every node value and every flow, the battery's in, out,
  change in stored energy and loss, and Självförsörjning. It is the keyboard and screen-reader path, and the place
  to read exact values when the pills are off.
- Colour is never the only cue: every value is written (pills or table), and the icons and labels name the nodes.

### No layout shift

- The diagram box has a fixed height per layout, reserved by a container query on the card content (360 px from
  860 px, else 490 px), so the server HTML, the first client render and every period have the same height before
  `ParentSize` measures.
- Nodes never move between periods; only arrow widths, values and the loss stub change.
- `energy-tiles` skeleton bones are re-captured (`bun run bones:capture`) for the new card.

### Empty and failed states

- No readings in the period: the reserved box shows "Ingen energidata för perioden." (`energy_period_no_data`), as today.
- Figures unavailable: the reserved box stays blank; the page's alert explains (step 1b's rule).
- A year still loading: the old diagram stays, dimmed (step 1b's rule).

## i18n

New `energy_flow_*` keys in `messages/sv.json` (source) and `en.json`: battery, loss ("Förlust"), charge level,
the hint line, the switch, the table toggle and headers, the tooltip shares, the winter hint and the diagram
description. Node labels reuse `energy_tile_solar`, `energy_tile_import`, `energy_tile_export`, `energy_tile_load`,
`energy_tile_self_sufficiency(_detail)` and `energy_tile_load_car`. Keys only the old tiles used
(`energy_tile_solar_split`, `energy_tile_import_to_battery`) are removed.

## Testing

- **`figures.ts`** (node, test-first): `batteryToGrid` (export within the solar surplus → 0; beyond it → the rest),
  `batteryToHouse` (never negative).
- **`flowLayout.ts`** (node, test-first): at 324, 754 and 1006 px every node lies inside the box and no two nodes
  overlap; every port lies on its node's edge; arrows below 0.05 kWh are dropped; the width scale is linear with
  its minimum; the loss stub appears only from 0.5 kWh.
- **`EnergyFlow`** (browser): the five figures, the loss ("≈ 0 kWh" for a small or negative loss), the car lines,
  the switch hides the pills and is remembered, the table's rows, the empty and unavailable states.
- **Live** (Playwright on the local dev server, full history): at 1440, 820 and 390 px, light and dark, stepping
  through periods (including February, August with its gap note, and October): the card's and the diagram's boxes
  don't change; each node's text block centre is within 2 px of its tile's centre; no value pill overlaps a node;
  no horizontal overflow; console clean. Screenshots go in the PR.

## Out of scope

- Animated or live flows.
- Splitting the battery arrow by charge origin (decision 6).
- The Batteri page (step 2): its per-month in / out / loss chart, efficiency and winter note stay there. Its plan is
  re-checked against this step's figures before it starts.
- The app-wide type-scale pass.
