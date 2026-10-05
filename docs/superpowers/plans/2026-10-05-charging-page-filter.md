# Laddning page-level vehicle filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The charging views open on **Alla**, the Vår bil / Gäster / Alla control reads as a labelled page filter
placed above everything it scopes, the live charger state becomes one line in the overview's heading, and the
sidebar carries the chosen scope between the three views.

**Architecture:** UI-only. The vehicle-scope default moves from three copies of `?? 'ours'` into one client-safe
constant in `src/lib/evCharging/vehicle.ts`. `VehicleScopeToggle` gains a visible label and the Alla-first order;
the heading's scope note is removed and replaced by an optional `live` slot that the overview fills with a new
`LiveStatusLine`. The overview is re-ordered so scoped content sits directly under the filter row. No schema,
service or procedure changes (procedures already default to `all`).

**Tech Stack:** TanStack Start/Router (search params via zod `validateSearch`), TanStack Query, shadcn/Radix
`ToggleGroup`, Paraglide i18n, Vitest Browser Mode.

**Spec:** `docs/superpowers/specs/2026-10-05-charging-page-filter-design.md`

## Global Constraints

- Worktree: `/Users/lukas/prog/videbacken/.claude/worktrees/charging-page-filter`, branch `feat/charging-page-filter`. Run every command from there.
- A clean URL (no `?vehicle=`) means `all` on `/charging`, `/charging/patterns`, `/charging/economy`; `ours`/`other` are explicit params.
- Toggle option order: **Alla | Vår bil | Gäster**. `VEHICLE_SCOPES` (the zod/CHECK vocabulary) is NOT reordered.
- User-facing text via Paraglide (`messages/sv.json` source of truth, `en.json` key-complete). No new copy is needed; removed keys are removed from both files.
- Client code may only `import type` from services; `src/lib/evCharging/vehicle.ts` is client-safe (zod only) — keep it that way.
- Never `console.*`. Biome formatting (`bun run check`). Conventional Commits, one hat per commit, end each commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every screen responsive; no fixed pixel widths. Browser tests have no app CSS (layout is verified live, not in tests; `sr-only` text is in the DOM and "visible" to tests).
- Don't run two vitest processes at once (shared local DB schema names collide).

## Review Focus

1. **Old bookmarks / shared links without `?vehicle=`** — they now show Alla; `?vehicle=ours` must still show only our car (loader key and component key must agree, or the page renders from an unseeded key). Pinned in Task 1's loader test and the pages test "component reads the same query keys the loader fetched".
2. **The overview read fails** — the filter row must still render (above the error alert) so the user can switch scope away; it must not render twice. Pinned in Task 2 ("a failed overview read shows the alert and exactly one scope group").
3. **Scoped vs unscoped order on the overview** — the scope group precedes the totals; Laddsessioner precedes the tariff card. Pinned in Task 2's DOM-order test.
4. **The live line while loading/failed** — SSR always renders the loading state (client-only query); a failed poll must read "unavailable", never an endless skeleton (existing `useLiveStatus` tests move over unchanged). Pinned in Task 3.
5. **Sidebar from a session page or another section** — `prev.vehicle` may be absent; the link must produce a clean URL (no `vehicle: undefined` junk). Pinned in Task 4.

---

## File map

| File | Change | Task |
|---|---|---|
| `src/lib/evCharging/vehicle.ts` | + `DEFAULT_VEHICLE_SCOPE`, `vehicleScopeParam()` | 1 |
| `src/routes/_authenticated/charging/{index,patterns,economy}.tsx` | default `all` via the constant | 1 |
| `src/components/evCharging/EconomyGridOnlyLead.tsx` | doc comment only | 1 |
| `src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx` | default `all` | 1 |
| `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` | default `all`; later order + failed-read tests | 1, 2 |
| `docs/adr/0021-charging-session-vehicle-attribution.md` | amend decision 6 | 1 |
| `src/components/evCharging/MetricToggle.tsx` | accept `aria-labelledby` | 2 |
| `src/components/evCharging/VehicleScopeToggle.tsx` (+ test) | order, visible label, drop `scopeNote` | 2 |
| `src/components/evCharging/ChargingHeading.tsx` (+ test) | drop `note`, add `live` slot | 2 (note), 3 (live) |
| `src/routes/_authenticated/charging/index.tsx` | filter row + re-order; live line | 2, 3 |
| `src/routes/_authenticated/charging/{patterns,economy}.tsx` | filter row: scope left, year right; drop note | 2 |
| `messages/{sv,en}.json` | remove `charging_vehicle_note_ours/_other` | 2 |
| `src/components/evCharging/LiveStatusLine.tsx` (+ test) | replaces `LiveStatusTile.tsx` (+ test) | 3 |
| `src/components/AppSidebar.tsx` (+ test) | keep `vehicle` across views | 4 |

Reviewer pairing for every task (UI): **`code-reviewer`** + a reviewer loading **`web-design-guidelines`** and **`vercel-react-best-practices`**. Task 1 also touches the ADR — the `code-reviewer` checks the amendment.

---

### Task 1: Default the vehicle scope to Alla on all three views

**Files:**
- Modify: `src/lib/evCharging/vehicle.ts` (after `export const vehicleScope = z.enum(VEHICLE_SCOPES)`)
- Modify: `src/routes/_authenticated/charging/index.tsx` (loaderDeps, `vehicle` select, `setVehicle`)
- Modify: `src/routes/_authenticated/charging/patterns.tsx` (loaderDeps ~l.62, `vehicle` ~l.88, toggle onChange ~l.155)
- Modify: `src/routes/_authenticated/charging/economy.tsx` (loaderDeps ~l.46, `vehicle` ~l.74, `setVehicle` ~l.89)
- Modify: `src/components/evCharging/EconomyGridOnlyLead.tsx` (doc comment on `vehicle`)
- Modify: `docs/adr/0021-charging-session-vehicle-attribution.md` (decision 6)
- Test: `src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx`, `-vehicleScopePages.browser.test.tsx`

**Interfaces:**
- Produces (in `~/lib/evCharging/vehicle`):
  - `export const DEFAULT_VEHICLE_SCOPE: VehicleScope = 'all'`
  - `export function vehicleScopeParam(scope: VehicleScope): VehicleScope | undefined` — `undefined` for the default (a clean URL), else the scope.

- [ ] **Step 1: Update the loader test to expect `all` for a clean URL**

In `-vehicleScope.browser.test.tsx`, rename the junk test and replace the loader test:

```tsx
test.each(routes)('%s: a junk ?vehicle= falls back to the default', (_name, route) => {
  const validate = validator(route)
  expect(validate({ vehicle: 'neighbour' }).vehicle).toBeUndefined()
  expect(validate({ vehicle: 'other' }).vehicle).toBe('other')
  expect(validate({}).vehicle).toBeUndefined()
})
```

```tsx
test.each([
  ['overview', Overview, ['overview', 'sessions', 'costOverview']],
  ['patterns', Patterns, ['patterns', 'timeline']],
  ['economy', Economy, ['economy']],
] as const)('%s: a clean URL requests everything, ?vehicle=ours passes ours', async (_n, route, procs) => {
  const clean = await runLoader(route as unknown as RouteLike, {})
  const ours = await runLoader(route as unknown as RouteLike, { vehicle: 'ours' })
  for (const p of procs) {
    const c = scoped(clean, p)
    const o = scoped(ours, p)
    expect(c.length, `${p} requested`).toBeGreaterThan(0)
    expect(o.length, `${p} requested for ours`).toBeGreaterThan(0)
    for (const k of c) expect(k).toContain('"vehicle":"all"')
    for (const k of o) expect(k).toContain('"vehicle":"ours"')
  }
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx`
Expected: the loader test FAILs (clean keys contain `"vehicle":"ours"`).

- [ ] **Step 3: Add the default to the vocabulary**

In `src/lib/evCharging/vehicle.ts`, after `export const vehicleScope = z.enum(VEHICLE_SCOPES)`:

```ts
/** What a charging view shows when its URL names no scope: every counted session (ADR-0021, amended 2026-10-05). */
export const DEFAULT_VEHICLE_SCOPE: VehicleScope = 'all'

/** The `?vehicle=` value for a scope: the default is a clean URL. */
export function vehicleScopeParam(scope: VehicleScope): VehicleScope | undefined {
  return scope === DEFAULT_VEHICLE_SCOPE ? undefined : scope
}
```

- [ ] **Step 4: Use it in the three routes**

`index.tsx` — import `DEFAULT_VEHICLE_SCOPE, vehicleScopeParam` alongside `type VehicleScope, vehicleScope`; then:

```tsx
  // Whose charging: a clean URL means every counted session.
  vehicle: vehicleScope.optional().catch(undefined),
```
```tsx
  loaderDeps: ({ search }) => ({
    year: search.year,
    vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE,
  }),
```
```tsx
  const vehicle = Route.useSearch({ select: (s) => s.vehicle ?? DEFAULT_VEHICLE_SCOPE })
```
```tsx
  function setVehicle(v: VehicleScope) {
    // The default scope is a clean URL.
    navigate({
      to: '.',
      search: (s) => ({ ...s, vehicle: vehicleScopeParam(v) }),
      replace: true,
      resetScroll: false,
    })
  }
```

`economy.tsx` — same import; `loaderDeps` → `vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE`; `const vehicle: VehicleScope = search.vehicle ?? DEFAULT_VEHICLE_SCOPE`; in `setVehicle`: `search: (s) => ({ ...s, vehicle: vehicleScopeParam(v) })`.

`patterns.tsx` — same import; `vehicle: search.vehicle ?? DEFAULT_VEHICLE_SCOPE` in `loaderDeps` and in the component; toggle `onChange={(v) => set({ vehicle: vehicleScopeParam(v), month: undefined })}`.

`EconomyGridOnlyLead.tsx` — the prop doc becomes `/** The page's own search value: undefined is every session (a clean URL), as on the overview. */`.

- [ ] **Step 5: Run the loader test — expect PASS**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-vehicleScope.browser.test.tsx`
Expected: PASS.

- [ ] **Step 6: Move the pages test to the new default**

In `-vehicleScopePages.browser.test.tsx` (every clean-URL render now reads the `all` keys):

1. Import the type: `import type { VehicleScope } from '~/lib/evCharging/vehicle'`. Change `seedOverview`'s and `seedEconomy`'s `vehicle` parameter type to `VehicleScope`.
2. The patterns/economy failed-read test: rename to `'%s: a failed read keeps the scope toggle, and Alla gives a clean URL'`; click `m.charging_vehicle_scope_all()` (not ours) and assert it is `aria-checked="true"`; keep `expect(router.state.location.search).not.toHaveProperty('vehicle')`.
3. `'Översikt, our car with nothing: …'` → rename `'Översikt, everyone with nothing: the empty state still offers the admin a sync'`, seed `seedOverview(qc, 'all', [])`.
4. `'Översikt: switching scope never shows the sessions empty state mid-switch'`: replace every `'ours'` seed (and the `s-ours` session) with `'all'` (`session('s-all', 3.3)`). The `other` parts stay.
5. `'Översikt: a sessions read still pending …'` and `'Översikt: a failed sessions read …'`: every `vehicle: 'ours'` / `seedOverview(qc, 'ours', …)` → `'all'`.
6. `'Översikt: a failed overview read shows the alert and the toggle; …'`: rename the tail to `Alla gives a clean URL`, click `m.charging_vehicle_scope_all()` and assert it checked.
7. The Datakällor/car-log tests (`seedEmptyOverview`, and the three `seedOverview(qc, 'ours', [])` in the car-log tests at ~l.308–336): `'ours'` → `'all'`.
8. `'%s: switching scope keeps the chosen year'` and `'patterns: switching scope clears the month'`: click `m.charging_vehicle_scope_all()` instead of ours (assert it checked); the remaining asserts are unchanged.
9. `seedCost`: the three `vehicle: 'ours'` → `vehicle: 'all'`.
10. Ekonomi grid-only lead table becomes:

```tsx
test.each([
  ['everyone', '', 'all', '/charging?year=2026'],
  ['our car', '?vehicle=ours', 'ours', '/charging?year=2026&vehicle=ours'],
  ['guests', '?vehicle=other', 'other', '/charging?year=2026&vehicle=other'],
] as const)('Ekonomi, %s: the grid-only lead links the overview for the same year and scope', async (_n, search, vehicle, href) => {
```

11. `'Ekonomi: no lead without sessions …'`: `seedEconomy(qc, 'all', 0)`, and the failed render asserts `radio(failed.screen, m.charging_vehicle_scope_all())` is checked.

Then grep for leftovers: `grep -n "'ours'" src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` — the only remaining hits must be the `session()` fixture's row field `vehicle: 'ours'` (a session's own vehicle, not a scope) and the new `?vehicle=ours` lead row.

- [ ] **Step 7: Run both route tests — expect PASS**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/`
Expected: PASS (all files in the folder, including `sessions/`).

- [ ] **Step 8: Amend ADR-0021**

In `docs/adr/0021-charging-session-vehicle-attribution.md`, decision 6 becomes:

```markdown
6. **One query seam.** `countedSessionFilter({ vehicle })` is the single place every scoped read filters on
   vehicle; procedures and routes default to `all` (`DEFAULT_VEHICLE_SCOPE` in `src/lib/evCharging/vehicle.ts`).
   *Amended 2026-10-05:* routes defaulted to `ours` until the owner asked for Alla as the starting view — guests are
   part of what the charger delivered. The scope is a page-level filter, carried across the charging views by the
   sidebar.
```

- [ ] **Step 9: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`
Expected: no errors.

```bash
git add src/lib/evCharging/vehicle.ts src/routes/_authenticated/charging src/components/evCharging/EconomyGridOnlyLead.tsx docs/adr/0021-charging-session-vehicle-attribution.md
git commit -m "feat(charging): open the charging views on every session

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The scope as a labelled page filter, and the overview re-ordered under it

**Files:**
- Modify: `src/components/evCharging/MetricToggle.tsx`
- Modify: `src/components/evCharging/VehicleScopeToggle.tsx`
- Modify: `src/components/evCharging/ChargingHeading.tsx` (remove `note`)
- Modify: `src/routes/_authenticated/charging/index.tsx`, `patterns.tsx`, `economy.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (remove `charging_vehicle_note_ours`, `charging_vehicle_note_other`)
- Test: `src/components/evCharging/VehicleScopeToggle.browser.test.tsx`, `ChargingHeading.browser.test.tsx`, `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`

**Interfaces:**
- Consumes: `DEFAULT_VEHICLE_SCOPE`, `vehicleScopeParam` (Task 1).
- Produces: `MetricToggle` props become `{ value, options, onChange } & ({ 'aria-label': string } | { 'aria-labelledby': string })`. `VehicleScopeToggle({ value, onChange })` unchanged signature, now renders a visible label; `scopeNote` is deleted. `ChargingHeading` loses `note`.

- [ ] **Step 1: Write the failing toggle tests**

Replace `VehicleScopeToggle.browser.test.tsx` with:

```tsx
import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { VehicleScopeToggle } from './VehicleScopeToggle'

test('a visible label names the group, and Alla comes first', async () => {
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="all" onChange={vi.fn()} />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_scope_label())).toBeVisible()
  const group = screen.getByRole('group', { name: m.charging_vehicle_scope_label() })
  await expect.element(group).toBeVisible()
  const names = group
    .getByRole('radio')
    .elements()
    .map((el) => el.textContent)
  expect(names).toEqual([
    m.charging_vehicle_scope_all(),
    m.charging_vehicle_scope_ours(),
    m.charging_vehicle_scope_other(),
  ])
})

test('shows the active scope and reports a change', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="ours" onChange={onChange} />,
  )
  await expect
    .element(screen.getByRole('radio', { name: m.charging_vehicle_scope_ours() }))
    .toHaveAttribute('aria-checked', 'true')
  await screen.getByRole('radio', { name: m.charging_vehicle_scope_other() }).click()
  expect(onChange).toHaveBeenCalledWith('other')
})

test('re-pressing the active scope does not deselect it', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <VehicleScopeToggle value="all" onChange={onChange} />,
  )
  await screen.getByRole('radio', { name: m.charging_vehicle_scope_all() }).click()
  expect(onChange).not.toHaveBeenCalled()
})
```

(If Radix's single `ToggleGroup` exposes `role="radiogroup"` instead of `group`, use the role the existing DOM has — check with `screen.getByRole('radiogroup')` in the failing run and keep whichever the component renders; the assertion that matters is the *accessible name* equals the visible label.)

In `ChargingHeading.browser.test.tsx`, delete the `'renders the optional note line'` test.

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run --project browser src/components/evCharging/VehicleScopeToggle.browser.test.tsx`
Expected: FAIL (no visible label text; order is Vår bil first; `scopeNote` import gone is fine).

- [ ] **Step 3: Let `MetricToggle` take a labelling element**

```tsx
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'

export type MetricOption<T extends string> = { value: T; label: string; ariaLabel?: string }

/** The group's accessible name: a string, or the id of a visible label. */
type GroupLabel = { 'aria-label': string } | { 'aria-labelledby': string }

/** A single-choice switch between a chart's metrics (kWh ↔ kr, kWh ↔ plugged in). */
export function MetricToggle<T extends string>({
  value,
  options,
  onChange,
  ...label
}: {
  value: T
  options: MetricOption<T>[]
  onChange: (value: T) => void
} & GroupLabel) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix fires '' when the active item is re-pressed; keep one selected.
      onValueChange={(v) => {
        const picked = options.find((o) => o.value === v)
        if (picked) onChange(picked.value)
      }}
      variant="outline"
      size="sm"
      {...label}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} aria-label={o.ariaLabel}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
```

- [ ] **Step 4: Rewrite `VehicleScopeToggle`**

```tsx
import { useId } from 'react'
import type { VehicleScope } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { MetricToggle } from './MetricToggle'

// Display order: the default first. The vocabulary's own order (VEHICLE_SCOPES) is unchanged.
const OPTIONS: { value: VehicleScope; label: () => string }[] = [
  { value: 'all', label: m.charging_vehicle_scope_all },
  { value: 'ours', label: m.charging_vehicle_scope_ours },
  { value: 'other', label: m.charging_vehicle_scope_other },
]

// Whose sessions a charging view shows (ADR-0021): a page filter, labelled so it
// reads as one rather than as a control of whatever sits next to it. One option is always on.
export function VehicleScopeToggle({
  value,
  onChange,
}: {
  value: VehicleScope
  onChange: (v: VehicleScope) => void
}) {
  const labelId = useId()
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span id={labelId} className="text-muted-foreground text-sm">
        {m.charging_vehicle_scope_label()}
      </span>
      <MetricToggle
        value={value}
        options={OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
        onChange={onChange}
        aria-labelledby={labelId}
      />
    </div>
  )
}
```

- [ ] **Step 5: Remove the heading's note**

In `ChargingHeading.tsx`: delete the `note` prop (type + destructure) and the whole `{note !== undefined ? (<p aria-live …>) : null}` block with its comment. Remove `note={scopeNote(vehicle) ?? ''}` from the three routes and the `scopeNote` import (keep `VehicleScopeToggle`).

Delete `"charging_vehicle_note_ours"` and `"charging_vehicle_note_other"` from `messages/sv.json` and `messages/en.json`.

- [ ] **Step 6: Run the component tests — expect PASS**

Run: `bunx vitest run --project browser src/components/evCharging/VehicleScopeToggle.browser.test.tsx src/components/evCharging/ChargingHeading.browser.test.tsx`
Expected: PASS.

- [ ] **Step 7: Write the failing overview order tests**

Append to `-vehicleScopePages.browser.test.tsx`:

```tsx
// --- Översikt: the scope is a page filter --------------------------------------

/** a precedes b in document order */
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

test('Översikt: the scope filter sits above the totals; the sessions above the tariff card', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', seedEmptyOverview)
  const scope = screen.getByRole('group', { name: m.charging_vehicle_scope_label() })
  await expect.element(scope).toBeVisible()
  const totals = screen.getByRole('heading', { name: m.charging_totals_heading() }).element()
  const chartTitle = screen.getByRole('heading', { name: m.charging_chart_title() }).element()
  const sessions = screen.getByRole('heading', { name: m.charging_sessions_heading() }).element()
  const tariff = screen.getByRole('heading', { name: m.charging_tariff_title() }).element()
  expect(precedes(scope.element(), totals)).toBe(true)
  expect(precedes(chartTitle, sessions)).toBe(true)
  expect(precedes(sessions, tariff)).toBe(true)
  // The chart's toolbar holds only chart controls.
  const chartSection = chartTitle.closest('section')
  expect(chartSection?.contains(scope.element())).toBe(false)
})
```

Use the same role (`group`/`radiogroup`) Step 1 settled on. In `'Översikt: a failed overview read shows the alert and the toggle; …'` add, after the alert assertion:

```tsx
  expect(
    screen.getByRole('group', { name: m.charging_vehicle_scope_label() }).elements(),
  ).toHaveLength(1)
```

- [ ] **Step 8: Run — expect FAIL**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`
Expected: the new order test FAILs (scope is inside the chart section; sessions come after the tariff card).

- [ ] **Step 9: Re-order the overview**

In `index.tsx`'s JSX, after the `CredentialExpiryAlert` line and before `<LiveStatusTile live={live} />` (Task 3 removes that line; leave it where it is for now — it stays above the filter row):

1. Insert the filter row right after `<LiveStatusTile live={live} />`:

```tsx
      {/* The page filter: everything below it down to the sessions is scoped,
          and it stays when a scoped read fails, so the user can switch back. */}
      <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
```

2. In the chart toolbar, delete `<VehicleScopeToggle value={vehicle} onChange={setVehicle} />` (MetricToggle + YearSelector remain).
3. Replace the error branch

```tsx
      ) : (
        <>
          {/* The scope stays switchable when its read fails, or the user can't switch back. */}
          <div className="flex justify-end">
            <VehicleScopeToggle value={vehicle} onChange={setVehicle} />
          </div>
          <LoadErrorAlert title={m.charging_overview_error_title()} query={overviewResult} />
        </>
      )}
```

with

```tsx
      ) : (
        <LoadErrorAlert title={m.charging_overview_error_title()} query={overviewResult} />
      )}
```

4. Move the whole `<section className="flex flex-col gap-2"><h2 …>{m.charging_sessions_heading()}</h2> … </section>` block up so it directly follows the overview ternary (`{overview ? (…) : (…)}`), i.e. before `<TariffCard …/>`. The order after the ternary is then: sessions section → `TariffCard` → `VehicleLogCard` (admin) → `SyncSourcesPanel` (admin) → dialogs.

- [ ] **Step 10: Patterns and Ekonomi filter rows: scope left, year right**

In both `patterns.tsx` and `economy.tsx` change the row's classes from `flex flex-wrap items-center justify-end gap-2` to `flex flex-wrap items-center justify-between gap-2`. Nothing else moves (the toggle is already first in the row, the year second). Keep the existing "Outside the load branches …" comment.

- [ ] **Step 11: Run the charging tests — expect PASS**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/ src/components/evCharging/`
Expected: PASS.

- [ ] **Step 12: i18n keys match, typecheck, lint, commit**

Run the key check from `docs/feature-workflow.md` (Pre-PR gate) → `sv/en keys match`; then `bun run typecheck && bun run check`.

```bash
git add src/components/evCharging/MetricToggle.tsx src/components/evCharging/VehicleScopeToggle.tsx src/components/evCharging/VehicleScopeToggle.browser.test.tsx src/components/evCharging/ChargingHeading.tsx src/components/evCharging/ChargingHeading.browser.test.tsx src/routes/_authenticated/charging messages/sv.json messages/en.json
git commit -m "feat(charging): show the vehicle scope as a page filter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Live charger status as one line in the overview's heading

**Files:**
- Create: `src/components/evCharging/LiveStatusLine.tsx`
- Create: `src/components/evCharging/LiveStatusLine.browser.test.tsx`
- Delete: `src/components/evCharging/LiveStatusTile.tsx`, `src/components/evCharging/LiveStatusTile.browser.test.tsx`
- Modify: `src/components/evCharging/ChargingHeading.tsx` (+ test) — `live` slot
- Modify: `src/routes/_authenticated/charging/index.tsx`

**Interfaces:**
- Produces: `export function useLiveStatus(): LiveStatus | undefined` (moved verbatim) and `export function LiveStatusLine({ live }: { live: LiveStatus | undefined })` from `~/components/evCharging/LiveStatusLine`. `ChargingHeading` gains `live?: React.ReactNode`, rendered between the description and "Senast synkad".

- [ ] **Step 1: Move the tests to the new component and write the new expectations**

`git mv src/components/evCharging/LiveStatusTile.browser.test.tsx src/components/evCharging/LiveStatusLine.browser.test.tsx`, then in it:
- import `{ LiveStatusLine, useLiveStatus } from './LiveStatusLine'`; replace every `LiveStatusTile` with `LiveStatusLine`.
- Replace the `'undefined (loading)…'` test with:

```tsx
test('undefined (loading): names the line without a reading', async () => {
  const { screen } = await renderWithProviders(<LiveStatusLine live={undefined} />)
  // The name is screen-reader-only text (no app CSS in tests, so it is in the DOM).
  await expect.element(screen.getByText(m.charging_live_title(), { exact: false })).toBeInTheDocument()
  expect(screen.getByText(m.charging_live_unavailable()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_live_mode_disconnected()).elements()).toHaveLength(0)
})
```

- Add:

```tsx
test('every state carries the line’s name for a screen reader', async () => {
  const live: Live = { mode: 'disconnected', powerKw: 0, sessionKwh: null, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(m.charging_live_title(), { exact: false })).toBeInTheDocument()
})

test('connected, waiting: shows the session energy but no power', async () => {
  const live: Live = { mode: 'connected_requesting', powerKw: 0, sessionKwh: 3.14, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(m.charging_live_mode_connected_requesting())).toBeVisible()
  await expect.element(screen.getByText(m.charging_live_session_kwh({ kwh: '3,1' }))).toBeVisible()
  expect(screen.getByText(/kW$/).elements()).toHaveLength(0)
})

test('disconnected: never shows a leftover session energy', async () => {
  const live: Live = { mode: 'disconnected', powerKw: 0, sessionKwh: 9.9, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(m.charging_live_mode_disconnected())).toBeVisible()
  expect(screen.getByText(m.charging_live_session_kwh({ kwh: '9,9' })).elements()).toHaveLength(0)
})
```

The other tests (charging, each mode, null, failed request, retry, success) stay as they are.

In `ChargingHeading.browser.test.tsx` add:

```tsx
test('renders the live slot between the description and the sync time', async () => {
  const { screen } = await renderWithProviders(
    <ChargingHeading lastSuccessAt={null} live={<span>live-line</span>} />,
  )
  const live = screen.getByText('live-line').element()
  const synced = screen.getByText(m.charging_never_synced()).element()
  expect(live.compareDocumentPosition(synced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run --project browser src/components/evCharging/LiveStatusLine.browser.test.tsx src/components/evCharging/ChargingHeading.browser.test.tsx`
Expected: FAIL (module `./LiveStatusLine` not found; no `live` prop).

- [ ] **Step 3: Create `LiveStatusLine.tsx`; delete the tile**

`git rm src/components/evCharging/LiveStatusTile.tsx`, then create `src/components/evCharging/LiveStatusLine.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Fragment } from 'react'
import { Skeleton } from '~/components/ui/skeleton'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatOneDecimal } from './format'

type LiveStatus = RouterOutputs['evCharging']['liveStatus']
type LiveMode = NonNullable<LiveStatus>['mode']

const MODE_LABEL: Record<LiveMode, () => string> = {
  disconnected: m.charging_live_mode_disconnected,
  connected_requesting: m.charging_live_mode_connected_requesting,
  charging: m.charging_live_mode_charging,
  connected_finished: m.charging_live_mode_connected_finished,
  unknown: m.charging_live_mode_unknown,
}

// The polled live status for `LiveStatusLine`. Client-only (not in the route
// loader) so a live Zaptec call never blocks SSR. A failed request (network,
// 5xx) reads as `null` — "unavailable" — rather than leaving the line on its
// loading skeleton forever. It stays `null` while the next poll retries: with
// no data, a refetch resets the query to `pending` with `error: null`, so
// isError alone would flip the line back to the skeleton (errorUpdateCount
// survives that reset).
export function useLiveStatus(): LiveStatus | undefined {
  const query = useQuery({
    ...orpc.evCharging.liveStatus.queryOptions(),
    refetchInterval: 60_000,
  })
  const failed = query.isError || (query.data === undefined && query.errorUpdateCount > 0)
  return failed ? null : query.data
}

// The charger right now, as one line in the page heading — outside the vehicle
// filter, which it doesn't depend on. `undefined` = still loading (the query is
// client-only, so SSR always renders the skeleton); `null` = no charger or Zaptec
// unavailable — never a health problem. Emphasised only while charging.
export function LiveStatusLine({ live }: { live: LiveStatus | undefined }) {
  const charging = live?.mode === 'charging'
  const parts: string[] = []
  if (live) {
    parts.push(MODE_LABEL[live.mode]())
    if (charging && live.powerKw != null) parts.push(`${formatOneDecimal(live.powerKw)} kW`)
    if (live.sessionKwh != null && live.mode !== 'disconnected') {
      parts.push(m.charging_live_session_kwh({ kwh: formatOneDecimal(live.sessionKwh) }))
    }
  }
  return (
    <div
      className={cn(
        'flex min-h-5 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm',
        charging ? 'font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="sr-only">{m.charging_live_title()}: </span>
      {live === undefined ? (
        <Skeleton className="h-4 w-48 max-w-full" />
      ) : live === null ? (
        <span>{m.charging_live_unavailable()}</span>
      ) : (
        <>
          <span
            aria-hidden
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              charging ? 'bg-chart-1' : 'bg-muted-foreground/40',
            )}
          />
          {parts.map((part, i) => (
            <Fragment key={part}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span className="tabular-nums">{part}</span>
            </Fragment>
          ))}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Add the `live` slot to the heading**

In `ChargingHeading.tsx` add `live?: React.ReactNode` to the props (doc: `/** The charger right now (overview only), between the description and the sync time. */`), destructure it, and render `{live}` directly after the description `<p>` and before the "last synced" `<p>`. Update the header comment to mention `live`.

- [ ] **Step 5: Use it on the overview**

In `index.tsx`: change the import to `import { LiveStatusLine, useLiveStatus } from '~/components/evCharging/LiveStatusLine'`; delete the `<LiveStatusTile live={live} />` line; pass `live={<LiveStatusLine live={live} />}` to `ChargingHeading`.

- [ ] **Step 6: Run — expect PASS**

Run: `bunx vitest run --project browser src/components/evCharging/ src/routes/_authenticated/charging/`
Expected: PASS. `grep -rn LiveStatusTile src` → no hits.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`

```bash
git add -A src/components/evCharging src/routes/_authenticated/charging/index.tsx
git commit -m "feat(charging): show the charger's live state in the heading

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The sidebar carries the vehicle scope between the charging views

**Files:**
- Modify: `src/components/AppSidebar.tsx` (`sectionLinkProps`, ~l.42–51)
- Test: `src/components/AppSidebar.browser.test.tsx`

**Interfaces:**
- Consumes: `type VehicleScope` from `~/lib/evCharging/vehicle` (type-only import).

- [ ] **Step 1: Write the failing test**

In `AppSidebar.browser.test.tsx`, in the `"charging links match exactly, ignoring the views' own params, and keep the year"` test, rename it to `…, and keep the year and vehicle scope`, and after the existing `expect(search({ year: 2025, month: 3, metric: 'plugged' })).toEqual({ year: 2025 })` add:

```tsx
    expect(search({ year: 2025, vehicle: 'other', month: 3 })).toEqual({
      year: 2025,
      vehicle: 'other',
    })
    // From a page without the params (a session page, another section): a clean URL.
    expect(Object.entries(search({})).filter(([, v]) => v !== undefined)).toEqual([])
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run --project browser src/components/AppSidebar.browser.test.tsx`
Expected: FAIL (vehicle dropped).

- [ ] **Step 3: Keep `vehicle` in `sectionLinkProps`**

```tsx
// Links into a section with sub-views. Link sets aria-current itself from its
// own match, prefix by default, so it must be exact or /charging would read as
// the current page on /charging/patterns too. The views' own params (month,
// metric, dialog) mustn't count, so search is ignored for the match. The chosen
// year and vehicle scope (the page filter, ADR-0021) are kept when switching
// between the views.
const sectionLinkProps = {
  search: (prev: { year?: number; vehicle?: VehicleScope }) => ({
    year: prev.year,
    vehicle: prev.vehicle,
  }),
  activeOptions: { exact: true, includeSearch: false },
} as const
```

with `import type { VehicleScope } from '~/lib/evCharging/vehicle'` among the imports.

- [ ] **Step 4: Run — expect PASS**

Run: `bunx vitest run --project browser src/components/AppSidebar.browser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `bun run typecheck && bun run check`

```bash
git add src/components/AppSidebar.tsx src/components/AppSidebar.browser.test.tsx
git commit -m "feat(charging): keep the vehicle scope when switching views

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After the tasks (Phases 5–7 of `docs/feature-workflow.md`)

- **Branch review:** `code-reviewer` + a general correctness pass over `git diff origin/main...HEAD`. No schema/service/auth changes → no migration-guard, test-completeness or security gates.
- **Pre-PR gate:** `bun run check && bun run check:ci && bun run build && bun run db:up && bun run db:migrate && bun run test` + the sv/en key check.
- **Live check** (`bun run dev`, port 14600) at 1280, 820 and 390 px: the filter row under the heading on all three views; the overview chart toolbar holds only kWh/kr + year and wraps cleanly; the live line wraps; sessions sit above Elavtal; sidebar switching keeps `?vehicle=`.
- **PR:** title `feat(charging): make the vehicle scope a page filter, default Alla` (≤72 chars), body per `.github/PULL_REQUEST_TEMPLATE.md`, links the spec and ADR-0021's amendment.
