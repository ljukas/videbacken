# ADR 0016 — Empty State & UX Feedback Conventions

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: Lukas
- **Decision in one line**: Every list/collection renders the shared `Empty` component with a consistent **icon (or, for a top-level area's primary zero-state, an illustration) + title + description**, plus **at most one primary CTA** that appears only when there is a single obvious next action and the viewer is permitted to take it (role-gated); filtered, sub-scope, and terminal empties (e.g. an empty sync-run history opened from a tile that already carries the action) stay CTA-less.

> **Amended 2026-09-29. Pruned to the current template.** References to features the template removed
> (owners, documents/folders, the bin) were removed or replaced with current examples (charging sessions,
> tariffs, sync runs, sensors). No decision changed.

---

## Context

Videbacken is an internal CRUD app for ~10–20 users. When this ADR was written, empty states had drifted into
two inconsistent shapes (in features since removed from the template):

1. **Composed `Empty`** — the documents table (true-root empty) and the document bin already used the shadcn
   `Empty` composition (`EmptyHeader` → `EmptyMedia variant="icon"` → `EmptyTitle` → `EmptyDescription`): an
   icon, a title, a description, no action.
2. **Plain text in a table cell** — the owners table rendered a single muted `<TableCell>` ("Inga delägare
   än"), with no icon, no description, and no way to act.

None of the empty states offer a **call to action**, even where the next step is obvious and the viewer is
allowed to take it (an admin staring at an empty list should be one click from adding the first entry). The
result is a dead-end screen instead of a guided one.

This ADR is deliberately scoped to **empty states and the feedback conventions immediately around them**
(when to show a CTA, how to role-gate it, when an illustration is warranted). It does **not** define the brand
palette, the logo mark, or illustration art direction — those belong to **ADR-0015 (visual identity)**;
this ADR only says *where* a brand illustration may appear and defers its definition there. Toasts (`sonner`)
and optimistic mutation feedback are already settled by ADR-0013 (and ADR-0005's two-channel error policy); this ADR cross-references them
rather than restating them.

## Decision (TL;DR)

- **One component for every empty state: `Empty`** (`src/components/ui/empty.tsx`). No bespoke empty-state
  markup, no plain-text table cells. A zero-row list lifts the `Empty` block **out** of the table (render
  `Empty` instead of an empty `Table`), as `SessionList` and `TariffCard` do — a header over zero rows carries
  no information.
- **The canonical shape** is `EmptyHeader` → `EmptyMedia` → `EmptyTitle` → `EmptyDescription`, with an optional
  trailing `EmptyContent` holding the CTA.
- **Icon vs illustration.** Default to `EmptyMedia variant="icon"` with a Lucide glyph that matches the domain
  (`ZapIcon` for charging sessions, `ReceiptTextIcon` for tariffs, `ThermometerIcon` for sensors). Reserve a
  richer **illustration** (and the nautical brand mark, used sparingly) for the **primary zero-state of a
  top-level area** — never for filtered or sub-scope empties. The illustration asset and brand treatment are
  owned by ADR-0015.
- **When a CTA.** Add **at most one primary CTA** (`EmptyContent` + a single primary `Button`) only when both
  hold: (a) there is **one obvious next action** for this list, and (b) the **viewer is permitted** to take it.
  A second action may appear as `variant="outline"`, but the primary stays singular. Otherwise the empty state
  is informational only.
- **Role-gating.** The CTA is gated on the viewer's capability, not just the presence of a handler:
  - Charging sessions (empty) → **admins** see "Sync now" (`SyncNowButton`; `onSync` is passed only for
    admins); users see icon + title + description only.
  - Tariffs (empty) → **admins** see "New period" (`charging_tariff_new` → `open('tariffNew')`); users never
    reach the tariff card (it lives on the admin-only `/charging/settings`); their counterpart is the
    overview's `CostNotice` ("Kostnaden visas när en administratör har lagt in avgifterna.").
- **No CTA on filtered / sub-scope / terminal empties.** The reference is a sub-scope view: `RecentRunsTable`
  (an admin's empty sync-run history, in the Datakällor overlay on `/charging/settings`) opens from a source tile
  that already carries its own sync button, so the history adds no CTA of its own — icon + title +
  description, nothing more. The
  template has no truly filtered or terminal empty today; the rule stands for when one arrives.
- **Description copy** states what lands here / what to do, in one short sentence, localized in
  `messages/{sv,en}.json`. The `EmptyMedia` icon is decorative; the title carries the meaning.

### Picking an empty state — decision flow

1. List has rows? → render the list. Otherwise continue.
2. Is this a **filtered, sub-scope, or terminal** view (e.g. a source's sync-run history, whose tile already
   carries the action)? → `Empty` with
   icon + title + description, **no CTA**.
3. Is this the **primary zero-state of a top-level area**? → `Empty`; an illustration (ADR-0015) is permitted.
4. Is there **one obvious next action** the **current viewer is allowed** to take? → add a single primary CTA in
   `EmptyContent`. Otherwise → icon + title + description only.

## Alternatives considered

- **A. Keep plain-text table-cell empties (the owners-table status quo at the time).** Rejected: inconsistent
  with the two views that already used `Empty`, no room for a CTA, reads as a bug rather than a guided state.
- **B. Always show a CTA on every empty state.** Rejected: filtered/terminal views have no sensible single
  action, and a sub-scope card (e.g. the sync-run history, under a page header that already has "Sync now")
  would only duplicate its page's action; a CTA there is noise or misleading. Capability- and context-gating keeps it
  meaningful.
- **C. Render `Empty` inside a full-span `<TableCell>` (keep the table chrome).** Rejected: `Empty`'s dashed
  border and centered padding fight the table's border; lifting the block out (as `SessionList` and
  `TariffCard` do) is cleaner and already proven.
- **D. A new `<ListEmpty>` wrapper that bakes in icon/title/description/CTA as props.** Rejected as premature:
  only ~5 empty states exist; the `Empty` composition is already expressive and this convention is enough to
  keep them consistent. Revisit if the list count or per-list variation grows.
- **E. Put empty-state CTAs only in page toolbars, never in the empty state.** Rejected: the empty state is
  exactly where a first-time user looks; duplicating the toolbar's primary action inside it removes the
  dead-end without harming the toolbar.

## Architecture

### `Empty` — `src/components/ui/empty.tsx`

The shadcn `Empty` composition is the single seam. Parts used by this convention:

- `Empty` — the dashed-border, centered container. List empties add `className="rounded-lg border"` so the
  block reads as the list's frame.
- `EmptyHeader` → `EmptyMedia variant="icon"` (Lucide glyph) → `EmptyTitle` (uses `font-heading`) →
  `EmptyDescription`.
- `EmptyContent` — optional trailing block; holds the single primary CTA `Button`, plus an optional
  `variant="outline"` secondary.

No new component is introduced. The convention lives in this ADR and in how each list calls `Empty`.

### Call sites

- `SessionList` — when `sessions.length === 0`, return `Empty` instead of the `Table`; it receives an
  `onSync?` prop (threaded from `charging.tsx`, admins only) and renders the admin-gated CTA.
- `TariffCard` — renders `Empty` instead of the `Table` when there are no tariffs; the `admin` prop's `onNew`
  (`open('tariffNew')` in `src/routes/_authenticated/charging/settings.tsx`) adds the CTA.
- `RecentRunsTable` — the reference sub-scope empty (no CTA; its Datakällor tile carries the sync).
- `src/routes/_authenticated/sensors.tsx` and `src/routes/_authenticated/index.tsx` — top-level zero-states
  (`brand-wash`), no CTA: there is no in-app next action.

### Relationship to feedback already decided

Toasts (`sonner`) and the optimistic instant-close + invalidate-on-settle mutation feedback are governed by
**ADR-0013** (and ADR-0005's two-channel error policy) and are unchanged here. Brand palette, the `--brand` token, the logo mark, and
illustration art direction are governed by **ADR-0015**; this ADR only authorizes *where* an illustration may
appear in an empty state.

## Verification

- Charging sessions, **admin**, no sessions → `Empty` with `ZapIcon`, title, description, and a "Sync now"
  CTA.
- Charging sessions, **user**, no sessions → same `Empty` **without** the CTA.
- Tariffs, **admin**, none → `Empty` with a "New period" CTA that opens the tariff dialog; **user** → no CTA.
- Sync-run history empty → `Empty`, no CTA (`HistoryIcon`).
- All titles/descriptions/CTAs render correctly in **sv** and **en**.
- Mobile and dark mode: `Empty` and the CTA `Button` use semantic tokens — verify centering, contrast, and
  thumb-reach on a phone.

## Critical files

- `src/components/ui/empty.tsx` — the shared `Empty` composition (the seam).
- `src/components/evCharging/SessionList.tsx` — `Empty` + admin CTA in place of the table.
- `src/components/evCharging/TariffCard.tsx` — `Empty` + admin CTA inside the card.
- `src/routes/_authenticated/charging.tsx` — threads `onSync` (admins only); `charging/settings.tsx` threads the tariff `admin.onNew`.
- `src/components/evCharging/RecentRunsTable.tsx` — reference sub-scope empty (no CTA).
- `messages/{sv,en}.json` — empty-state titles/descriptions and CTA labels.
- `docs/adr/0015-visual-identity-and-design-language.md` — owns the brand token, logo mark, and illustration art
  direction this ADR defers to; `docs/adr/0013-form-presentation-and-dialog-architecture.md` — owns dialogs,
  toasts, and the optimistic mutation feedback this ADR builds on.

## Consequences

**Positive:** one empty-state shape across every list; empty screens become guided (CTA where it helps)
instead of dead-ends; role-gating keeps CTAs honest; new lists have a clear rule to follow; no new component to
maintain.

**Negative:** lists must thread an action handler down to their table/empty component to offer a CTA (small
prop plumbing); the icon-vs-illustration line is a judgment call per area.

## Revisit triggers

- **Lists grow past ~6, or per-list empty variation multiplies** → reconsider a dedicated `<ListEmpty>` wrapper
  (Alternative D) to stop repeating the composition.
- **Empty states need richer guidance** (multi-step onboarding, sample data, video) → this convention only
  covers single-CTA states; design a richer onboarding pattern then.
- **A brand illustration system lands (ADR-0015)** → replace the top-level area icons with the agreed
  illustrations; this ADR's "icon by default, illustration for primary zero-states" line holds.
