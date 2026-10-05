# Laddning — page-level vehicle filter + live status in the header — design

Status: agreed 2026-10-05. Builds on: [ADR-0021](../../adr/0021-charging-session-vehicle-attribution.md) (vehicle
scope: `ours` | `other` | `all`), [ADR-0015](../../adr/0015-visual-identity-and-design-language.md) (design language),
[ADR-0018](../../adr/0018-polled-sync-replaces-realtime-sse.md) (the live status stays polled).

## Intent

The charging views open on **Vår bil**, but the owner wants **Alla** by default. On the overview (`/charging`) the
Vår bil / Gäster / Alla toggle sits in the monthly chart's toolbar, next to the chart-only kWh/kr and year controls —
yet it also scopes the tiles *above* it and the session list *below* it. It reads as a chart control. The "Laddboxen
just nu" card sits among the scoped content but is not scoped, and is a near-empty full-width card most of the time.

**Success:**
- All three charging views (Översikt, Mönster, Ekonomi) open on **Alla**.
- On the overview the scope reads as a page filter: one labelled row under the heading, everything it scopes directly
  below it, nothing unscoped in between, and the chart toolbar only holds chart controls.
- The live charger state reads as "the charger right now", outside the filtered content, in one line.
- The chosen scope survives switching between the three views in the sidebar.

## Today (as read 2026-10-05, `origin/main` 07d17f3)

| Control on `/charging` | Lives in | Actually affects |
|---|---|---|
| kWh / kr (`MetricToggle`) | chart toolbar | chart |
| Year (`YearSelector`) | chart toolbar | chart (tiles are always the *current* month/year/all-time) |
| Vår bil / Gäster / Alla (`VehicleScopeToggle`) | chart toolbar | tiles, chart, cost notice, session list |

Page order today: heading → sync alerts → **Laddboxen just nu** → cost notice → tiles → chart (+ toolbar) → price
footnote → **Elavtal** (TariffCard) → **Bilens data** (VehicleLogCard, admin) → Laddsessioner → Datakällor (admin).

Mönster and Ekonomi already put the scope toggle in a page-level row (with the year, which is page-wide there), above
all content. All three routes default the URL's missing `vehicle` to `ours` (`search.vehicle ?? 'ours'`, and
`setVehicle` maps `ours` → `undefined`). The procedures already default to `all`. The sidebar
(`AppSidebar.sectionLinkProps`) already carries `year` across the three views.

## Design

### 1. Scope is a page filter, defaulting to Alla (all three views)

- **Default `all`.** A clean URL (no `?vehicle=`) means Alla on Översikt, Mönster and Ekonomi: routes read
  `search.vehicle ?? 'all'`, loader deps likewise, and `setVehicle` maps `all` → `undefined` (so `?vehicle=ours` and
  `?vehicle=other` are explicit). Old bookmarks without the param now open on Alla — intended.
- **Option order** in the toggle: **Alla | Vår bil | Gäster** (default first). This is a display order in
  `VehicleScopeToggle`; `VEHICLE_SCOPES` (zod enum / CHECK vocabulary) is unchanged.
- **Visible label.** The toggle gets a visible label "Vems laddningar" (`charging_vehicle_scope_label`, today only an
  `aria-label`) before the segments, associated with the group (`aria-labelledby`), so it reads as a filter. On narrow
  widths the label sits above or beside the toggle without horizontal overflow.
- **The heading's scope note is removed** (`scopeNote`, `charging_vehicle_note_ours`/`_other`, and `ChargingHeading`'s
  `note` prop). With a visible labelled filter directly beneath the heading it only repeats it; the toggle group
  announces its own pressed state. Unused message keys are deleted from `sv.json` and `en.json`.
- **The scope survives view switches.** `sectionLinkProps.search` keeps `vehicle` alongside `year` (both views' search
  schemas already accept it). The sidebar's own active-match logic is unchanged (`includeSearch: false`).

### 2. Overview (`/charging`) layout

New order:

1. **Heading** (title, description, *live status line* — §3, "Senast synkad"; admin "Synka nu")
2. **Sync health alerts** (unchanged, unscoped)
3. **Filter row**: "Vems laddningar" + toggle. Rendered whether or not the overview read succeeded (today's error
   branch already keeps a toggle so a failed scope can be switched away from — this replaces that special case).
4. **Scoped content**, in order: cost notice → totals tiles → monthly chart → price footnote → **Laddsessioner**
5. **Unscoped content**, after the sessions: Elavtal (TariffCard) → Bilens data (admin) → Datakällor (admin)

The **chart toolbar** keeps only kWh/kr and the year selector.

Mönster and Ekonomi keep their layout; they only get the new default, option order and visible label (their year stays
in the filter row, since it is page-wide there).

### 3. Live charger status moves into the heading (overview only)

- The "Laddboxen just nu" card (`LiveStatusTile`) is removed. The same data (`useLiveStatus`, polled every 60 s,
  client-only — unchanged) renders as **one line in the heading**, directly above "Senast synkad".
- `ChargingHeading` gains an optional `live?: ReactNode` slot; only the overview passes it. Mönster/Ekonomi are
  unchanged.
- States:

  | `live` | Line |
  |---|---|
  | `undefined` (loading; also the SSR render) | a small skeleton bar, line height reserved so nothing shifts |
  | `null` (no charger / Zaptec unavailable) | muted "Live-status är inte tillgänglig just nu." |
  | `disconnected` | muted grey dot · "Ingen bil ansluten" |
  | `connected_requesting` / `connected_finished` / `unknown` | muted dot · mode label · "{kWh} kWh denna session" when known |
  | `charging` | brand-coloured (`chart-1`) dot · **"Laddar"** · **"{kW} kW"** · "{kWh} kWh denna session" — the line is emphasised (foreground weight, not muted) |

- Parts are separated by " · " and wrap on narrow widths. `charging_live_title` ("Laddboxen just nu") stays as the
  line's accessible name (visually hidden prefix or `aria-label`), so a screen reader still hears what it is.
- The component is renamed to fit its new shape (`LiveStatusLine`, keeping `useLiveStatus` exported from it);
  its browser test is adapted to the states above.

### 4. ADR-0021 amendment

Decision 6 ("One query seam") changes from "procedures default to `all` and routes to `ours`" to "procedures and routes default to
`all`; the scope is a page-level filter carried across the charging views by the sidebar". Add a dated amendment
note giving the reason (owner request 2026-10-05: Alla is the natural starting view; guests are part of what the
charger delivered).

## Testing

Browser tests (Vitest Browser Mode; layout itself is verified live — the browser project has no app CSS):

- `-vehicleScope.browser.test.tsx` / `-vehicleScopePages.browser.test.tsx`: a clean URL reads `all` on all three views
  (loader and procedures called with `vehicle: 'all'`); choosing Vår bil writes `?vehicle=ours`; choosing Alla clears
  the param; option order is Alla, Vår bil, Gäster; the filter row stays when the overview read fails.
- `VehicleScopeToggle.browser.test.tsx`: order + visible label + accessible group name.
- `ChargingHeading.browser.test.tsx`: no note line; renders the `live` slot when given.
- `LiveStatusLine.browser.test.tsx` (renamed from `LiveStatusTile`): each state in §3's table.
- `AppSidebar.browser.test.tsx`: sub-item links keep `vehicle` (and still keep `year`).
- Live check at desktop, tablet and mobile widths: filter row placement, chart toolbar wrapping, header live line wrap.

## Scope

- **In:** the above, one PR (`feat(charging): …`). No schema, service or procedure changes.
- **Out:** a sticky filter row; the live line on Mönster/Ekonomi; showing *who* is charging right now (live
  attribution, ADR-0022); per-vehicle split in tiles/chart (considered as approach B and rejected for now — guests are
  rare, so a stacked split would mostly be a sliver, and it needs per-vehicle breakdowns server-side).

## Alternatives considered

- **B — show the split, no filter**: tiles "varav gäster", stacked chart, all sessions with Gäst badge. Most
  informative, but needs breakdowns in `overview`/`costOverview`, and the guest share is usually tiny.
- **C — filter the aggregates only; the session list always shows all**: two scoping rules on one page — a new way to
  confuse.
- Live status: a banner only while a car is connected (hides the "no car" state entirely), or keeping the card above
  the filter row (still a near-empty card). The header line was chosen as the lightest that is always present.
