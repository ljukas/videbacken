# Klimat, PR 2: readable sizes and the range control with the charts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/sensors` (Klimat) follows the `/energy` type scale and layout: a "Just nu" card with the current-value
tiles (which now show the location), then a "Historik" card whose header holds the range control and whose body
holds the sensor chips and both charts; chart text 13–14 px; no per-chart legends.

**Architecture:** Presentation only — no data, procedure or schema change. `ClimateChart` (visx, merged in #118)
gets a local 13 px tick constant used for measuring and drawing, a 14 px card, and loses its `ChartLegend`.
`CurrentReadingTiles` becomes a list of bordered tiles (no nested `Card`s). `DeviceToggles` and `RangeSelector` get
40 px targets. The route regroups the sections into two `Card`s with `h2` headers (the `/energy` pattern) and adds a
skeleton for the chips.

**Tech Stack:** React 19, visx 4 (via `ClimateChart`), shadcn/Radix (`Card`, `Toggle`, `ToggleGroup`, `Button`),
Tailwind v4, Paraglide, boneyard skeletons (`bun run bones:capture`), Vitest browser mode, Playwright for the live
check.

**Spec:** [`docs/superpowers/specs/2026-10-06-climate-readability-design.md`](../specs/2026-10-06-climate-readability-design.md)
("PR 2 — the page"). Sizes come from the `/energy` spec's
[size table](../specs/2026-10-05-energy-period-control-design.md#sizes-on-this-page-researched). PR 1's plan:
[`2026-10-06-climate-1-shelly-name.md`](./2026-10-06-climate-1-shelly-name.md) — independent; if it merged first,
the device fixtures already carry `shellyName`.

**Execution (owner, 2026-10-06):** native (`superpowers:executing-plans`): implemented inline task by task, then one reviewer on the whole branch. Its own session.

## Global Constraints

- Sizes: card titles **18 px** semibold (`text-lg`); chart sub-headings **16 px** medium (`text-base`); labels,
  helper and detail text **≥ 14 px** (`text-sm`), no `text-xs` on the page; chart ticks **13 px**; hover card
  **14 px**, a row's own time **13 px**; tap targets **≥ 40 px** (`h-10` / `size-10`); icons next to text **16 px**.
- Muted text only on the card surface, never on `bg-muted`.
- **No layout shift** when the range changes: the Historik header (title + range control) and the chips stay put;
  the chart boxes stay `260 px`; only the charts dim (`aria-busy`, `opacity-60`).
- The shared `TICK_PX = 12` in `src/components/chart/axis.ts` is **not** changed (the app-wide pass owns it).
- Load/failure/empty rules unchanged (ADR-0025 §3, ADR-0016): skeleton while a first load is pending, the alert on a
  failed read, the empty state only for a loaded empty roster; server HTML = hydrating client's first render.
- Every screen responsive (1440 / 820 / 390 px): the range control never scrolls horizontally.
- `src/bones/` is generated: re-capture (`--force`), never hand-edit; `test/sectionSkeletonBones.test.ts` must pass.
- User-facing text via Paraglide (sv source, en key-complete).
- Conventional Commits, one hat per commit. PR title: `feat(sensor): make the Klimat page easier to read`.

## Review Focus

1. **A phone (390 px) with four sensors and long names** ("Källare nordväst under köket"): tiles truncate the name,
   the 40 px edit button stays inside the tile, the battery line may wrap but never overflows. Pinned live in Task 5
   and by the `truncate`/`min-w-0` structure test in Task 2.
2. **Some sensors with a location, some without**: figures still line up across a row of tiles; with no locations
   at all, no blank line. Pinned in Task 2.
3. **Switching range while the next range loads**: the header, range control and chips don't move or dim; the two
   charts dim. Pinned in Task 4 (the existing range-switch test gains "the range control is not inside an
   `aria-busy` element") and live in Task 5.
4. **Series read failed**: the alert shows inside the Historik card, under the still-working range control; no
   "no data", no chart headings. Pinned in Task 4 (existing test, now scoped to the Historik region).
5. **Every sensor toggled off**: no legend appears anywhere to fall back on — the chips still show every sensor, so
   they can be toggled back. Pinned in Task 1 (no legend) + Task 3 (chips render all, pressed state).

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/sensor/ClimateChart.tsx` (+ browser test) (modify) | 13 px ticks (measure + draw), 14 px card, 13 px row time, no legend |
| `src/components/sensor/CurrentReadingTiles.tsx` (+ browser test) (modify) | Bordered tiles: 16 px name, location line, 30 px temperature, 14 px detail, 40 px named edit button |
| `src/components/sensor/DeviceToggles.tsx` (+ browser test) (modify) | 40 px chips, 14 px text, 12 px swatch |
| `src/components/sensor/RangeSelector.tsx` (+ browser test) (modify) | 40 px items, 14 px text; 4-column grid below `sm` |
| `src/routes/_authenticated/sensors.tsx` (+ `-sensorsRoute.browser.test.tsx`) (modify) | "Just nu" card, "Historik" card (range in header, chips + charts in body), chips skeleton |
| `src/bones/sensors-*.bones.json` (regenerate) + `src/bones/sensors-chips.bones.json` (new) | `bun run bones:capture /sensors --force` |
| `messages/sv.json`, `messages/en.json` (modify) | `sensors_current_heading` → "Just nu"; `sensors_history_heading`; `sensors_edit_device_named` |

---

### Task 0: Verify `main` and create the worktree

**Files:** none (read-only), then the worktree.

- [ ] **Step 1: Check the seams this plan names**

```bash
cd /Users/lukas/prog/videbacken && git fetch -q && git switch main && git pull -q
grep -n "measureAt(TICK_PX)\|fontSize: TICK_PX\|w-full text-xs\|text-\[10px\]\|<ChartLegend\|const byName" src/components/sensor/ClimateChart.tsx
grep -n "export const TICK_PX = 12" src/components/chart/axis.ts
grep -n "RangeSelector value={range}\|sensorsTilesBones\|function ChartSection\|sr-only\">{m.sensors_current_heading" src/routes/_authenticated/sensors.tsx
grep -n "size=\"sm\"" src/components/sensor/DeviceToggles.tsx
grep -n "legendLabels" src/components/sensor/ClimateChart.browser.test.tsx
```

Expected: every grep prints a line. If PR 1 merged first, `CurrentReadingTiles.browser.test.tsx`'s fixture has
`shellyName: null` — keep it.

- [ ] **Step 2: Create the worktree** (no `+` in the path)

```bash
git worktree add .claude/worktrees/climate-readability -b feat/climate-readability origin/main
cd .claude/worktrees/climate-readability && cp ../../../.env .env 2>/dev/null; bun install && bun run db:up && bun run db:migrate
```

---

### Task 1: Chart text sizes and no legend

**Reviewers:** `code-reviewer` · UI reviewer (loads `web-design-guidelines` + `vercel-react-best-practices`)

**Files:**
- Modify: `src/components/sensor/ClimateChart.tsx`
- Test: `src/components/sensor/ClimateChart.browser.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClimateChart` with the same props, no legend.

- [ ] **Step 1: Change the tests first**

In `ClimateChart.browser.test.tsx`:

1. Import `legend` and `xTickTexts`/`yTickLabels` from `~test/browser/chartDom` (drop `legendLabels`).
2. Rename `'renders one line per visible device in its own colour, and a legend entry for every device'` to
   `'renders one line per visible device in its own colour, and no legend'`, and replace its last two lines with:

```ts
  // The page's sensor chips are the key; the chart draws none.
  expect(legend(root)).toBeNull()
```

3. In `'with every device hidden there is no line and no card, and the legend keeps every device'`: rename to
   `'with every device hidden there is no line and no card'`, and replace
   `await vi.waitFor(() => expect(legendLabels(root)).toEqual(['Visible one', 'a']))` with:

```ts
  // Drawn: the time axis keeps its ticks even with nothing visible.
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(0))
```

4. Add:

```ts
test('axis labels are 13 px and the hover card is 14 px with a 13 px row time', async () => {
  const root = await renderChart(
    [
      device('a', [
        { t: T0, a: 15.1 },
        { t: T0 + 20 * MIN, a: 15.3 },
      ]),
      device('b', [
        { t: T0 + 7 * MIN, b: 14.2 },
        { t: T0 + 27 * MIN, b: 14.4 },
      ]),
    ],
    { formatTick: (t) => new Date(t).toISOString().slice(11, 16) },
  )
  await vi.waitFor(() => expect(xTickTexts(root).length).toBeGreaterThan(0))
  for (const text of xTickTexts(root)) expect(text.getAttribute('font-size')).toBe('13')
  const yText = root.querySelector('[data-axis="y"] text')
  expect(yText?.getAttribute('font-size')).toBe('13')
  // The chart box carries the card's text size (browser tests have no app.css: classes, not pixels).
  const box = root.querySelector('[data-chart="line"]')
  expect(box?.className).toContain('text-sm')
  expect(box?.className).not.toContain('text-xs')
  await hoverPlot(root)
  // b's nearest reading is 7 min off a's, so its row shows its own time.
  await vi.waitFor(() => {
    const rowTime = tooltipNodes()
      .flatMap((n) => [...n.querySelectorAll('span')])
      .find((s) => s.className.includes('text-[13px]'))
    expect(rowTime).toBeDefined()
  })
})
```

(`hoverPlot`, `renderChart`, `device`, `T0`, `MIN` are the file's existing helpers.) If `hoverPlot` lands where both
rows share the header time, move the second device's readings so they don't (any offset ≥ 1 min shows the row
time).

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/sensor/ClimateChart.browser.test.tsx`
Expected: FAIL — legend present, `font-size="12"`, `text-xs`.

- [ ] **Step 3: Implement**

In `src/components/sensor/ClimateChart.tsx`:

1. Remove `TICK_PX` from the `~/components/chart/axis` import and the `ChartLegend` import; delete `byName` and its
   comment.
2. Below `const HEIGHT = 260`, add:

```ts
// The /energy scale: 13 px axis labels. Local, not the shared TICK_PX (12),
// until the app-wide pass. Measured and drawn at the same size, so the y-axis
// width and the end labels' inward shift fit the text.
const CLIMATE_TICK_PX = 13
```

3. `measureAt(TICK_PX)` → `measureAt(CLIMATE_TICK_PX)`; both `fontSize: TICK_PX` → `fontSize: CLIMATE_TICK_PX`.
4. In `CardContent`: the row's time span `text-[10px]` → `text-[13px]`; the swatch `size-2.5` → `size-3`.
5. The chart box `className="w-full text-xs"` → `className="w-full text-sm"`.
6. Delete the `<ChartLegend … />` element. The flex column keeps the plot at `flex: '1 1 0'` inside `HEIGHT`, so
   the plot takes the legend's height; nothing outside the 260 px box moves.

- [ ] **Step 4: Run the chart tests**

Run: `bunx vitest run --project browser src/components/sensor/ClimateChart.browser.test.tsx`
Expected: PASS (all, including the keyboard and hover ones).

- [ ] **Step 5: Commit**

```bash
git add src/components/sensor/ClimateChart.tsx src/components/sensor/ClimateChart.browser.test.tsx
git commit -m "feat(sensor): set the Klimat chart text at 13-14 px and drop its legend"
```

- [ ] **Step 6: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 2: The current-value tiles

**Reviewers:** `code-reviewer` · UI reviewer (loads `web-design-guidelines` + `vercel-react-best-practices`)

**Files:**
- Modify: `src/components/sensor/CurrentReadingTiles.tsx`, `src/components/sensor/CurrentReadingTiles.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: listDevices rows (`displayName`, `location`, `latest`, `batteryPct`, `lastSeenAt`).
- Produces: `CurrentReadingTiles({ devices, isAdmin, onEdit })` — same props; renders a `<ul>` of tiles (the route
  wraps it in the "Just nu" card in Task 4).

- [ ] **Step 1: Add the copy**

`messages/sv.json`: `"sensors_edit_device_named": "Redigera {name}",` · `messages/en.json`:
`"sensors_edit_device_named": "Edit {name}",` (next to `sensors_edit_device`, which stays as the dialog title).
Run: `bun run i18n:compile`.

- [ ] **Step 2: Write the failing tests**

In `CurrentReadingTiles.browser.test.tsx`, replace `m.sensors_edit_device()` in the two existing tests with
`m.sensors_edit_device_named({ name: 'Sensor 34cd' })`, then add:

```tsx
test('shows each sensor’s location under its name', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[{ ...device, displayName: 'NV', location: 'Under köket' }]}
      isAdmin={false}
      onEdit={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
})

test('a sensor without a location keeps the line when another has one, so figures line up', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles
      devices={[
        { ...device, id: 'a', displayName: 'NV', location: 'Under köket' },
        { ...device, id: 'b', displayName: 'SÖ', location: null },
      ]}
      isAdmin={false}
      onEdit={() => {}}
    />,
  )
  await expect.element(screen.getByText('Under köket')).toBeVisible()
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(2)
})

test('with no locations at all there is no location line', async () => {
  await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin={false} onEdit={() => {}} />,
  )
  expect(document.querySelectorAll('[data-slot="sensor-location"]')).toHaveLength(0)
})

test('the readable sizes: 16 px name that truncates, 14 px detail, a 40 px edit button', async () => {
  const { screen } = await renderWithProviders(
    <CurrentReadingTiles devices={[device]} isAdmin onEdit={() => {}} />,
  )
  const name = screen.getByRole('heading', { name: 'Sensor 34cd' })
  await expect.element(name).toBeVisible()
  expect(name.element().className).toContain('text-base')
  expect(name.element().className).toContain('truncate')
  const edit = screen.getByRole('button', { name: m.sensors_edit_device_named({ name: 'Sensor 34cd' }) })
  expect(edit.element().className).toContain('size-10')
  // No 12 px text left in a tile (browser tests have no app.css: classes, not pixels).
  expect(document.querySelector('li .text-xs')).toBeNull()
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/sensor/CurrentReadingTiles.browser.test.tsx`
Expected: FAIL — no location, no named button, no heading.

- [ ] **Step 4: Implement**

Replace `src/components/sensor/CurrentReadingTiles.tsx` with:

```tsx
import { PencilIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { formatDistanceShort } from '~/lib/i18n/format'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

type Device = RouterOutputs['sensor']['listDevices'][number]

// A tile per device: its name and location, latest temperature/humidity,
// battery, and how long ago it was last seen. Admins get an edit button
// (name/location). Plain bordered tiles: the route's "Just nu" card is the card.
export function CurrentReadingTiles({
  devices,
  isAdmin,
  onEdit,
}: {
  devices: Device[]
  isAdmin: boolean
  onEdit: (id: string) => void
}) {
  // Reserve the location line in every tile once any sensor has one, so the
  // figures line up across a row; with none, no blank line.
  const anyLocation = devices.some((d) => d.location)
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {devices.map((d) => (
        <li key={d.id} className="flex min-w-0 flex-col rounded-lg border p-3">
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-medium text-base">{d.displayName}</h3>
              {anyLocation ? (
                <p data-slot="sensor-location" className="truncate text-muted-foreground text-sm">
                  {d.location ?? ' '}
                </p>
              ) : null}
            </div>
            {isAdmin ? (
              <Button
                variant="ghost"
                size="icon"
                // 40 px target; the negative margin keeps it from pushing the name down.
                className="-mt-2 -mr-2 size-10 shrink-0"
                onClick={() => onEdit(d.id)}
                aria-label={m.sensors_edit_device_named({ name: d.displayName })}
              >
                <PencilIcon aria-hidden className="size-4" />
              </Button>
            ) : null}
          </div>
          <div className="mt-2 font-semibold text-3xl tabular-nums">
            {d.latest?.temperatureC != null ? `${d.latest.temperatureC.toFixed(1)}°C` : '—'}
          </div>
          <div className="text-base text-muted-foreground tabular-nums">
            {d.latest?.humidityPct != null ? `${d.latest.humidityPct.toFixed(0)}%` : '—'}
          </div>
          {/* The "last seen" distance is measured against `new Date()`, which
              differs by ~1s between SSR and hydration — an expected, benign
              mismatch, so suppress the hydration warning (React's documented
              use for timestamps). The 60s poll re-renders it with the fresh
              value. */}
          <div className="mt-2 text-muted-foreground text-sm" suppressHydrationWarning>
            {d.batteryPct != null ? m.sensors_battery({ pct: d.batteryPct }) : null}
            {d.batteryPct != null && d.lastSeenAt ? ' · ' : null}
            {d.lastSeenAt ? m.sensors_last_seen({ time: formatDistanceShort(d.lastSeenAt) }) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

(`h3`s get `font-heading tracking-tight` from `@layer base`, ADR-0015 — Cabinet Grotesk for the sensor name is
intended.)

- [ ] **Step 5: Run the tiles and route tests**

Run: `bunx vitest run --project browser src/components/sensor/CurrentReadingTiles.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: tiles PASS. The route test file: any assertion naming the edit button by `m.sensors_edit_device()` fails —
switch it to `m.sensors_edit_device_named({ name: 'Sensor 34cd' })`; then PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/sensor/CurrentReadingTiles.tsx src/components/sensor/CurrentReadingTiles.browser.test.tsx \
  src/routes/_authenticated/-sensorsRoute.browser.test.tsx messages/
git commit -m "feat(sensor): show the location on the Klimat tiles at readable sizes"
```

- [ ] **Step 7: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 3: 40 px chips and range control

**Reviewers:** `code-reviewer` · UI reviewer (loads `web-design-guidelines` + `vercel-react-best-practices`)

**Files:**
- Modify: `src/components/sensor/DeviceToggles.tsx` (+ `.browser.test.tsx`)
- Modify: `src/components/sensor/RangeSelector.tsx` (+ `.browser.test.tsx`)

**Interfaces:** props unchanged for both.

- [ ] **Step 1: Write the failing tests**

Append to `DeviceToggles.browser.test.tsx`:

```tsx
test('chips are 40 px tall with 14 px text and stay listed when hidden', async () => {
  const { screen } = await renderWithProviders(
    <DeviceToggles devices={devices} hidden={new Set(['a', 'b'])} onToggle={() => {}} />,
  )
  for (const name of ['NW corner', 'Kitchen']) {
    const chip = screen.getByRole('button', { name })
    await expect.element(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip.element().className).toContain('h-10')
    expect(chip.element().className).toContain('text-sm')
  }
})
```

Append to `RangeSelector.browser.test.tsx` (add `m` / `renderWithProviders` imports if the file lacks them):

```tsx
test('range items are 40 px tall with 14 px text, in a 4-column grid on a phone', async () => {
  const { screen } = await renderWithProviders(<RangeSelector value="24h" onChange={() => {}} />)
  const group = screen.getByRole('group', { name: m.sensors_range_label() })
  await expect.element(group).toBeVisible()
  expect(group.element().className).toContain('grid-cols-4')
  expect(group.element().className).toContain('sm:flex')
  const item = screen.getByRole('radio', { name: m.sensors_range_24h() })
  expect(item.element().className).toContain('h-10')
  expect(item.element().className).toContain('text-sm')
})
```

(Radix `ToggleGroup type="single"` renders `role="group"` with `role="radio"` items — the route test already clicks
`getByRole('radio', …)`. If the group's role differs in this Radix version, query `[data-slot="toggle-group"]`.)

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project browser src/components/sensor/DeviceToggles.browser.test.tsx src/components/sensor/RangeSelector.browser.test.tsx`
Expected: FAIL on the class assertions.

- [ ] **Step 3: Implement**

`DeviceToggles.tsx`: on the `Toggle`, drop `size="sm"` and add `className="h-10 px-3 text-sm"`; the swatch span
`size-2.5` → `size-3`.

`RangeSelector.tsx`: the `ToggleGroup` becomes

```tsx
    <ToggleGroup
      type="single"
      value={value}
      // Radix fires '' when the active item is re-pressed; ignore that so a range
      // is always selected.
      onValueChange={(v) => {
        if (v) onChange(v as SeriesRange)
      }}
      variant="outline"
      // Separate pills, not a joined bar: on a phone the seven ranges wrap into a
      // 4-column grid (never a sideways scroll); from `sm` they sit in one row.
      spacing={1}
      className="grid w-full grid-cols-4 sm:flex sm:w-auto sm:flex-wrap"
      aria-label={m.sensors_range_label()}
    >
      {ORDER.map((r) => (
        <ToggleGroupItem key={r} value={r} className="h-10 px-3 text-sm">
          {RANGE_LABEL[r]()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run --project browser src/components/sensor/DeviceToggles.browser.test.tsx src/components/sensor/RangeSelector.browser.test.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sensor/DeviceToggles.tsx src/components/sensor/DeviceToggles.browser.test.tsx \
  src/components/sensor/RangeSelector.tsx src/components/sensor/RangeSelector.browser.test.tsx
git commit -m "feat(sensor): give the Klimat chips and ranges 40 px targets"
```

- [ ] **Step 6: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 4: The two cards, and the skeletons

**Reviewers:** `code-reviewer` · UI reviewer (loads `web-design-guidelines` + `vercel-react-best-practices`)

**Files:**
- Modify: `src/routes/_authenticated/sensors.tsx`, `src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`
- Regenerate: `src/bones/sensors-tiles.bones.json`, `sensors-temp-chart.bones.json`, `sensors-hum-chart.bones.json`;
  create `src/bones/sensors-chips.bones.json`

**Interfaces:**
- Consumes: Tasks 1–3's components (same props).

- [ ] **Step 1: Copy**

`messages/sv.json`: `"sensors_current_heading": "Just nu"` (was "Nuvarande värden"), add
`"sensors_history_heading": "Historik"`. `messages/en.json`: `"sensors_current_heading": "Right now"`,
`"sensors_history_heading": "History"`. Run: `bun run i18n:compile`.

- [ ] **Step 2: Write the failing route tests**

In `-sensorsRoute.browser.test.tsx` add (near the other cached-data tests):

```tsx
test('the range control sits in the Historik card with the chips and both charts', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey, noSeries)
  })
  const history = screen.getByRole('region', { name: m.sensors_history_heading() })
  await expect.element(history).toBeVisible()
  await expect.element(history.getByRole('radio', { name: m.sensors_range_1y() })).toBeVisible()
  await expect.element(history.getByRole('button', { name: 'Sensor 34cd' })).toBeVisible()
  await expect
    .element(history.getByRole('heading', { name: m.sensors_temp_chart_title() }))
    .toBeVisible()
  await expect
    .element(history.getByRole('heading', { name: m.sensors_humidity_chart_title() }))
    .toBeVisible()
  // The tiles are in their own card, outside Historik.
  const current = screen.getByRole('region', { name: m.sensors_current_heading() })
  await expect.element(current.getByText('21.7°C')).toBeVisible()
  expect(history.getByText('21.7°C').elements()).toHaveLength(0)
  expect(document.querySelector('[data-slot="chart-legend"]')).toBeNull()
})
```

Extend `"a range switch keeps the shown range's chart, dimmed, …"` after the existing `aria-busy` poll:

```ts
  // Only the charts dim: the range control and the chips stay live and in place.
  const radio = screen.getByRole('radio', { name: m.sensors_range_1y() }).element()
  expect(radio.closest('[aria-busy="true"]')).toBeNull()
  const chip = screen.getByRole('button', { name: 'Sensor 34cd' }).element()
  expect(chip.closest('[aria-busy="true"]')).toBeNull()
```

In `'devices still loading: skeletons, …'` add `expect(skeleton('sensors-chips')).not.toBeNull()`; in
`'both cached: no skeleton at all'` add `expect(skeleton('sensors-chips')).toBeNull()`.

In `'series failed: …'` add, after the alert assertion:

```ts
  // The alert sits in the Historik card, under its still-working range control.
  const history = screen.getByRole('region', { name: m.sensors_history_heading() })
  await expect.element(history.getByText(m.sensors_series_error_title())).toBeVisible()
  await expect.element(history.getByRole('radio', { name: m.sensors_range_1y() })).toBeVisible()
```

- [ ] **Step 3: Run them to see them fail**

Run: `bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: FAIL — no Historik region.

- [ ] **Step 4: Implement the layout**

In `src/routes/_authenticated/sensors.tsx`:

1. Imports: add `useId` to the `react` import; add
   `import { Card, CardContent, CardHeader } from '~/components/ui/card'`.
2. In `SensorsPage`, near the other hooks (before any early return): 
   `const currentHeadingId = useId()` and `const historyHeadingId = useId()`.
3. Replace the main `return (…)` body between `<SensorsHeading />` and the `{isAdmin ? …}` dialog block with:

```tsx
      <SectionSkeleton bones={sensorsTilesBones} loading={devicesPending} fallbackHeight="13rem">
        {devices ? (
          <section aria-labelledby={currentHeadingId}>
            <Card>
              <CardHeader>
                <h2 id={currentHeadingId} className="font-semibold text-lg">
                  {m.sensors_current_heading()}
                </h2>
              </CardHeader>
              <CardContent>
                <CurrentReadingTiles
                  devices={roster}
                  isAdmin={isAdmin}
                  onEdit={(id) => open('edit', { deviceId: id })}
                />
              </CardContent>
            </Card>
          </section>
        ) : null}
      </SectionSkeleton>

      {/* The header (title + range control) is always real text and stays live
          while a range loads; only the charts dim (ChartBody). */}
      <section aria-labelledby={historyHeadingId}>
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={historyHeadingId} className="font-semibold text-lg">
              {m.sensors_history_heading()}
            </h2>
            <RangeSelector value={range} onChange={setRange} />
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <SectionSkeleton name="sensors-chips" loading={devicesPending} fallbackHeight="2.5rem">
              {devices ? (
                <DeviceToggles devices={toggleDevices} hidden={hidden} onToggle={toggle} />
              ) : null}
            </SectionSkeleton>
            <LoadErrorAlert title={m.sensors_series_error_title()} query={seriesResult} />
            {seriesFailed ? null : (
              <>
                {/* … the two existing <ChartSection> blocks, unchanged … */}
              </>
            )}
          </CardContent>
        </Card>
      </section>
```

   Move the two existing `<ChartSection …>…</ChartSection>` blocks (temperature, humidity — with their
   `SectionSkeleton`, `ChartBody`, `ClimateChart` exactly as they are) into the fragment.
4. `ChartSection`'s heading: `<h2 className="font-medium text-sm">` → `<h3 className="font-medium text-base">`, and
   update its comment ("The title stays real text …" stays true).
5. The old wrapper `<div className="flex flex-col gap-3">` with the range selector and the old `sr-only` "Nuvarande
   värden" `h2` are gone (the heading is now visible in the Just nu card).

- [ ] **Step 5: Run the route tests**

Run: `bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx test/sectionSkeletonBones.test.ts`
Expected: route tests PASS (`sensors-chips` is a literal-name skeleton for now, which the bones test allows).

- [ ] **Step 6: Commit the layout**

```bash
git add src/routes/_authenticated/sensors.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx messages/
git commit -m "feat(sensor): put the range control in a Historik card with the charts"
```

- [ ] **Step 7: Capture the bones**

Port 14610 is often another session's dev server; use 14611 if it's taken (`lsof -i :14610`).

```bash
# terminal 1 (dev stack up: bun run dev:up)
BETTER_AUTH_URL=http://localhost:14611 bunx vite dev --port 14611 --strictPort
# terminal 2
BONES_ORIGIN=http://localhost:14611 bun run bones:capture /sensors --force
ls src/bones | grep sensors
```

Expected: `sensors-chips`, `sensors-hum-chart`, `sensors-temp-chart`, `sensors-tiles` (≈1–2 min).

- [ ] **Step 8: Switch the chips skeleton to its bones**

In `sensors.tsx`: `import sensorsChipsBones from '~/bones/sensors-chips.bones.json'` (with the other bones
imports) and `<SectionSkeleton name="sensors-chips" …>` → `<SectionSkeleton bones={sensorsChipsBones} …>`.

Run: `bunx vitest run test/sectionSkeletonBones.test.ts && bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit the bones**

```bash
git add src/bones/ src/routes/_authenticated/sensors.tsx
git commit -m "chore(bones): recapture the Klimat skeletons"
```

- [ ] **Step 10: Dispatch both reviewers in parallel**; fix or rule on every finding.

---

### Task 5: Review the branch, verify live, open the PR

- [ ] **Step 1: Branch review**: `code-reviewer` + a general correctness pass over the whole diff (UI-only: no
  schema, service or auth gate applies). Fix every confirmed finding here.

- [ ] **Step 2: Pre-PR gate**: `bun run check`, `bun run check:ci`, `bun run build`,
  `bun run db:up && bun run db:migrate`, `bun run test` (no other vitest running: `pgrep -fl vitest`), sv/en key
  check. All green. `bun run bundle:measure`: `/sensors` must not grow beyond noise (no new dependency).

- [ ] **Step 3: Live check** (Playwright against the dev server, signed in via the Mailpit magic link — see the
  `live-ui-check` notes; wait for load + 4 s, never `networkidle`). At **1440, 820 and 390 px**, light and dark:
  - Header order: Klimat → Just nu card → Historik card (title left, range control right; under the title at 390
    px as a 4-column grid, no horizontal scroll: `document.documentElement.scrollWidth <= innerWidth`).
  - Measure: card titles 18 px, chart sub-headings 16 px, tile detail 14 px, ticks 13 px, chips/range items/edit
    button ≥ 40 px tall (`getBoundingClientRect`).
  - Switch through all seven ranges: the bounding boxes of the Historik header, the chips and both chart boxes are
    identical before and after each switch (no shift); the charts dim while loading.
  - Hover a chart: the card's text is 14 px, the row time 13 px.
  - Toggle every chip off and on: no legend appears; chips stay.

- [ ] **Step 4: Open the PR** (`.github/PULL_REQUEST_TEMPLATE.md`), title
  `feat(sensor): make the Klimat page easier to read`, with the spec link, gate output, the live measurements, and
  screenshots at the three widths. Owner reviews live before merge.
