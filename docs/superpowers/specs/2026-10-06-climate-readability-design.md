# Klimat: readable sizes, range with the charts, a clearer sensor dialog

Status: design agreed with the owner 2026-10-06 (brainstorm via `/feature-workflow`). Two PRs; the second waits for
the visx Klimat charts (#118, client-perf step 5c) to merge.

## Why

- `/sensors` (nav *Klimat*) predates the researched type scale the owner made app-wide on 2026-10-05
  ([energy period-control spec, "Sizes on this page"](./2026-10-05-energy-period-control-design.md#sizes-on-this-page-researched)):
  12 px muted detail lines, a 28 px edit button with a 14 px icon, 14 px section titles, 12 px chart ticks, a
  10 px time in the chart card.
- The range control ("24 tim … Allt") sits at the top of the page, above the sensor chips and the tiles, far from
  the two charts it drives.
- The edit dialog has no way back to the default name and doesn't say which device it is, so the admin can't match
  "Sensor a1b2" to a device in the Shelly app.

## Owner decisions (2026-10-06)

| # | Decision |
|---|---|
| 1 | The dialog shows the device's **name from the Shelly app**: the webhook sends `${config.sys.device.name}` and we store it. |
| 2 | Display name order: **own name → Shelly name → `Sensor a1b2`**. "Återställ" clears the own name, so the sensor shows its Shelly name again. |
| 3 | Layout: a **"Just nu"** card with the tiles, then one **"Historik"** card whose header holds the range control; the sensor chips and both charts sit inside it. |
| 4 | The per-chart legends go: the chips above both charts are the shared colour key (and toggle the lines). |
| 5 | Tiles show the sensor's **location** (saved today, shown nowhere). |
| 6 | Planning only in this session; the page PR builds on #118's visx `ClimateChart`, not on recharts. |

## Slicing

| PR | Concern | Depends on |
|---|---|---|
| 1 `feat(sensor): show each sensor's name from the Shelly app` | column, webhook param, service, dialog, runbook | nothing (doesn't touch the charts) |
| 2 `feat(sensor): make the Klimat page easier to read` | layout, sizes, chips, chart text, tiles, bones | #118 merged |

PR 1 may be built before #118 merges; PR 2 must start from a main that has it.

---

## PR 1 — the Shelly name and the edit dialog

### Probe (Shelly docs, 2026-10-06)

Shelly Gen2+ webhook URLs replace `${expr}` with the expression evaluated against `status`, `config`, `info`
(Webhook component docs). Interpolated values are URL-encoded. **If evaluation fails, the token is copied
verbatim.** So a device without a name may send an empty value, `null`, or the literal `${config.sys.device.name}`.
Not settled by the docs: whether a name set in the Shelly *app* is written to the device's `sys.device.name` — the
real-world check below settles it.

URL length: the template grows by 31 characters (`&name=${config.sys.device.name}`), from ≈238 to ≈269 with a
vercel.app-length domain and a 44-character token. Battery devices allow 300, so the margin is ≈31 characters; the
runbook says so.

### Data

- `sensor_device.shelly_name text` (nullable). Migration `bun run db:generate --name=sensor-shelly-name`. No index
  (read only with the whole row; ≈4 rows). Schema-design review + `migration-guard` before code builds on it.
- No backfill: devices fill it on their next reading after the webhook is updated.

### Webhook (`src/lib/sensor/shellyWebhook.ts`)

- New optional `name` query param → `ParsedShellyReading.shellyName: string | null`.
- Trimmed. Treated as absent (null): missing, blank, `null`, `undefined`, anything starting with `${`, longer than
  80 characters. **A bad name never rejects the reading** (no 400 for it).
- The runbook URL gains `&name=${config.sys.device.name}`, with the length note.

### Service (`src/lib/services/sensor/sensor.ts`)

- `recordReading`: a present `shellyName` goes into the insert values and into the conflict `updateSet`, the same
  UPDATE that already bumps `lastSeenAt` (renaming in the app shows on the next reading). An absent name is left out
  of `updateSet`, so a device still on the old URL keeps the stored name — the same rule as `batteryPct`.
- `displayNameFor(name, shellyName, mac)` = `name ?? shellyName ?? \`Sensor ${mac.slice(-4)}\``.
- `listDevices` rows gain `shellyName` (`mac` is already there).
- `renameDevice` is unchanged: a blank name already clears to null (`labelField`), which *is* the reset.

### Dialog (`src/components/sensor/EditDeviceDialog.tsx`)

Modelled on the credentials dialog (`CredentialFieldRow`): a label row with a badge saying where the value comes
from, a summary line, and a link button for the row's action. 14 px floor throughout.

1. **"Enhet" box** (read-only, bordered, on the card surface — muted text on `bg-muted` fails 4.5:1):
   - *I Shelly-appen*: the Shelly name, or "Inte skickat än" plus one line saying the sensor sends its app name once
     its webhook has the `name` parameter.
   - *MAC*: upper-case, colon-separated (`AA:BB:CC:DD:EE:FF`), as the Shelly app's device information shows it
     (format confirmed at the real-world check).
2. **Namn row**:
   - `Label` "Namn" + a **live** badge (from the form value via `useStore`) naming what the page will show:
     *Eget namn* (field has text) / *Från Shelly-appen* (empty, Shelly name known) / *Standardnamn* (empty, none).
   - The input's placeholder is the fallback name (Shelly name or `Sensor a1b2`).
   - **"Återställ"** link button at the row header's end (as "Stäng" on a credential row), shown while the field
     has text: empties the field and focuses it. Accessible name "Återställ, Namn" (WCAG 2.5.3). 44 px tall on
     touch without growing the row (`pointer-coarse:` trick from `CredentialFieldRow`).
   - Helper line (14 px muted): "Lämna tomt för att visa {fallback}." with the fallback named.
3. **Plats**: unchanged.
4. Reset is part of the form: Spara saves it, Avbryt drops it. No new procedure.

`EditableDevice` gains `mac` and `shellyName`; the route passes the roster row as today.

### Tests (PR 1)

- `shellyWebhook.test.ts`: name present, trimmed, blank, `null`, `${config.sys.device.name}`, 81 characters →
  reading still stored, name null.
- `sensor.test.ts`: first registration stores the name; a later name replaces it; a reading without a name keeps
  it; `displayName` order for all three cases.
- `EditDeviceDialog.browser.test.tsx`: the three badge states follow typing; Återställ empties + focuses and
  disappears; helper names the fallback; Enhet box shows the Shelly name / "Inte skickat än" and the formatted
  MAC; Avbryt after Återställ saves nothing.

### Real-world check (PR 1)

Owner adds the `name` param to **one** device's webhook, wakes it, and we read `shelly_name` on prod (read-only
SELECT): it must equal the name in the Shelly app. If it's null or the device ID, the app name isn't on the device
— stop and re-shape (the MAC still matches devices). Then the other three devices.

---

## PR 2 — the page (after #118)

### Layout

```
Klimat (h1, unchanged) + description
┌ Just nu ─────────────────────────────────────┐
│ tiles: 2 columns on a phone, 4 from md       │
└──────────────────────────────────────────────┘
┌ Historik ────────────── [range control] ─────┐
│ sensor chips                                 │
│ Temperatur (°C)   chart                      │
│ Luftfuktighet (%) chart                      │
└──────────────────────────────────────────────┘
```

- Both are `Card`s with a `CardHeader` holding an `h2` (18 px semibold), as on `/energy`. The `sr-only`
  "Nuvarande värden" heading becomes the visible "Just nu".
- **Range control** in the Historik header's end, `flex-wrap` like `/energy`: items 40 px tall, 14 px text. Below
  `sm` it takes the full width under the title as a 4-column grid (two rows), never a horizontal scroll.
- **Chips** (`DeviceToggles`): 40 px tall, 14 px text, 12 px swatch; first row of the Historik content.
- **Chart sub-headings**: `h3`, 16 px medium.
- Load, failure and empty states keep today's rules (ADR-0025 §3, ADR-0016): a failed series read shows its alert
  inside the Historik card; the header (title + range control) is always real text and stays live while a range
  loads; only the charts dim (`aria-busy`).

### Tiles (`CurrentReadingTiles`)

Inner tiles are bordered blocks inside the Just nu card (not nested `Card`s).

| Part | Today | New |
|---|---|---|
| Name | 14 px, truncated | 16 px medium, truncated |
| Location | — | 14 px muted; when any sensor has one, an empty location still reserves the line so figures line up across tiles; when none has one, no line |
| Temperature | 24 px | 30 px semibold |
| Humidity | 14 px muted | 16 px muted |
| Battery · last seen | 12 px muted | 14 px muted |
| Edit button | 28 px, 14 px icon, "Redigera sensor" | 40 px, 16 px icon, "Redigera {name}" |

### Charts (`ClimateChart` as merged in #118)

- Axis ticks and any in-plot labels (#118's end labels) 13 px — a local tick size passed like `EnergyMonthlyChart`'s
  `tickPx={13}`; the shared `TICK_PX` default stays for the app-wide pass.
- Hover card 14 px (no `text-xs`); a row's own time 13 px (was 10 px); 12 px swatches.
- The `ChartLegend` under each chart is removed; the chips are the key. The chart keeps its accessible name
  (`label`).

### Bones

Re-capture with `--force` for `/sensors` (the layout and CSS changed); update `test/sectionSkeletonBones.test.ts`
if a section's bones change name.

### Tests (PR 2)

- Route test: the range control is inside the Historik section; no legend under the charts; the "Just nu" heading
  is visible.
- `CurrentReadingTiles`: location shown; empty location reserves the line only when another sensor has one; edit button named per sensor.
- `ClimateChart`: no legend; card row time present at the new size (class/structure only — browser tests have no
  app.css).
- Live (Playwright, dev server): 1440, 820 and 390 px, light and dark; switch every range — nothing below the
  Historik header moves; tap targets ≥ 40 px.

---

## Out of scope

- The app-wide type-scale pass (ADR-0015 amendment, the shared `TICK_PX`, other pages).
- The bottom-sheet dialog header on phones (issue #107).
- Deleting a sensor from the UI; resetting the location.
