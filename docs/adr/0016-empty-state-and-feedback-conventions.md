# ADR 0016 — Empty State & UX Feedback Conventions

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: Lukas
- **Decision in one line**: Every list/collection renders the shared `Empty` component with a consistent **icon (or, for a top-level area's primary zero-state, an illustration) + title + description**, plus **at most one primary CTA** that appears only when there is a single obvious next action and the viewer is permitted to take it (role-gated); filtered, sub-scope, and terminal empties (deleted filters, empty subfolders, the bin) stay CTA-less.

---

## Context

Oceanview is an internal CRUD app for ~10–20 owners. Empty states had drifted into two inconsistent shapes:

1. **Composed `Empty`** — `DocumentTable` (true-root empty) and `DocumentBin` already use the shadcn `Empty`
   composition (`EmptyHeader` → `EmptyMedia variant="icon"` → `EmptyTitle` → `EmptyDescription`): an icon, a
   title, a description, no action.
2. **Plain text in a table cell** — `OwnersTable` renders a single muted `<TableCell>` ("Inga delägare än"),
   with no icon, no description, and no way to act.

None of the empty states offer a **call to action**, even where the next step is obvious and the viewer is
allowed to take it (an admin staring at an empty owners list should be one click from "Add a member"). The
result is a dead-end screen instead of a guided one.

This ADR is deliberately scoped to **empty states and the feedback conventions immediately around them**
(when to show a CTA, how to role-gate it, when an illustration is warranted). It does **not** define the brand
palette, the sailboat lockup, or illustration art direction — those belong to **ADR-0015 (visual identity)**;
this ADR only says *where* a brand illustration may appear and defers its definition there. Toasts (`sonner`)
and optimistic mutation feedback are already settled by ADR-0013 and CLAUDE.md; this ADR cross-references them
rather than restating them.

## Decision (TL;DR)

- **One component for every empty state: `Empty`** (`src/components/ui/empty.tsx`). No bespoke empty-state
  markup, no plain-text table cells. A zero-row list lifts the `Empty` block **out** of the table (render
  `Empty` instead of an empty `Table`), matching the existing `DocumentTable` precedent — a header over zero
  rows carries no information.
- **The canonical shape** is `EmptyHeader` → `EmptyMedia` → `EmptyTitle` → `EmptyDescription`, with an optional
  trailing `EmptyContent` holding the CTA.
- **Icon vs illustration.** Default to `EmptyMedia variant="icon"` with a Lucide glyph that matches the domain
  (`UsersIcon` for owners, `FileIcon` for documents, `Trash2Icon` for the bin). Reserve a richer
  **illustration** (and the nautical brand mark, used sparingly) for the **primary zero-state of a top-level
  area** — never for filtered or sub-scope empties. The illustration asset and brand treatment are owned by
  ADR-0015.
- **When a CTA.** Add **at most one primary CTA** (`EmptyContent` + a single primary `Button`) only when both
  hold: (a) there is **one obvious next action** for this list, and (b) the **viewer is permitted** to take it.
  A second action may appear as `variant="outline"`, but the primary stays singular. Otherwise the empty state
  is informational only.
- **Role-gating.** The CTA is gated on the viewer's capability, not just the presence of a handler:
  - Owners (active, empty) → **admins** see "Add a member" (`owners_create_button` → `open('create')`); members
    see icon + title + description only.
  - Documents (true-root empty) → any user may "Upload" (optionally an admin-only "Create folder" secondary).
- **No CTA on filtered / sub-scope / terminal empties.** The deleted-owners filter, an empty subfolder (which
  keeps its "up one level" row), and the bin are dead-ends by design — icon + title + description, nothing more.
- **Description copy** states what lands here / what to do, in one short sentence, localized in
  `messages/{sv,en}.json`. The `EmptyMedia` icon is decorative; the title carries the meaning.

### Picking an empty state — decision flow

1. List has rows? → render the list. Otherwise continue.
2. Is this a **filtered, sub-scope, or terminal** view (deleted filter, empty subfolder, bin)? → `Empty` with
   icon + title + description, **no CTA**.
3. Is this the **primary zero-state of a top-level area**? → `Empty`; an illustration (ADR-0015) is permitted.
4. Is there **one obvious next action** the **current viewer is allowed** to take? → add a single primary CTA in
   `EmptyContent`. Otherwise → icon + title + description only.

## Alternatives considered

- **A. Keep plain-text table-cell empties (status quo for owners).** Rejected: inconsistent with the two views
  that already use `Empty`, no room for a CTA, reads as a bug rather than a guided state.
- **B. Always show a CTA on every empty state.** Rejected: filtered/terminal views (deleted filter, bin) have
  no sensible single action; a CTA there is noise or misleading. Capability- and context-gating keeps it
  meaningful.
- **C. Render `Empty` inside a full-span `<TableCell>` (keep the table chrome).** Rejected: `Empty`'s dashed
  border and centered padding fight the table's border; lifting the block out (the `DocumentTable` precedent)
  is cleaner and already proven.
- **D. A new `<ListEmpty>` wrapper that bakes in icon/title/description/CTA as props.** Rejected as premature:
  only ~4 lists exist; the `Empty` composition is already expressive and this convention is enough to keep them
  consistent. Revisit if the list count or per-list variation grows.
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

- `OwnersTable` — when `rows.length === 0`, return `Empty` instead of the `Table`; the active empty receives an
  `onCreate?` prop (threaded from `owners.tsx`'s `open('create')`) and renders the admin-gated CTA. The deleted
  view passes no `onCreate`.
- `DocumentTable` — keeps its existing true-root `Empty`; an `onUpload?` prop adds the primary CTA (degrade to
  icon+text if the upload handler isn't easily in scope this pass).
- `DocumentBin` — unchanged; the reference terminal empty (no CTA).

### Relationship to feedback already decided

Toasts (`sonner`) and the optimistic instant-close + invalidate-on-settle mutation feedback are governed by
**ADR-0013** and CLAUDE.md and are unchanged here. Brand palette, the `--brand` token, the sailboat lockup, and
illustration art direction are governed by **ADR-0015**; this ADR only authorizes *where* an illustration may
appear in an empty state.

## Verification

- Owners list, **admin**, no owners → `Empty` with `UsersIcon`, title, description, and an "Add a member" CTA
  that opens the create dialog.
- Owners list, **member**, no owners → same `Empty` **without** the CTA.
- Owners **deleted** filter, empty → `Empty`, no CTA.
- Documents true-root empty → `Empty` with the upload CTA (or icon+text only if the handler isn't threaded this
  pass); empty **subfolder** keeps its inline row and "up one level".
- Bin empty → `Empty`, no CTA (`Trash2Icon`).
- All titles/descriptions/CTAs render correctly in **sv** and **en**.
- Mobile and dark mode: `Empty` and the CTA `Button` use semantic tokens — verify centering, contrast, and
  thumb-reach on a phone.

## Critical files

- `src/components/ui/empty.tsx` — the shared `Empty` composition (the seam).
- `src/components/user/OwnersTable.tsx` — migrates from a plain-text cell to `Empty` + admin CTA.
- `src/routes/_authenticated/owners.tsx` — threads `onCreate` into the table.
- `src/components/document/table/DocumentTable.tsx` — true-root `Empty` + optional upload CTA.
- `src/components/document/views/DocumentBin.tsx` — reference terminal empty (no CTA).
- `messages/{sv,en}.json` — empty-state titles/descriptions and CTA labels.
- `docs/adr/0015-visual-identity-and-design-language.md` — owns the brand token, lockup, and illustration art
  direction this ADR defers to; `docs/adr/0013-form-presentation-and-dialog-architecture.md` — owns dialogs,
  toasts, and the optimistic mutation feedback this ADR builds on.

## Consequences

**Positive:** one empty-state shape across every list; empty screens become guided (CTA where it helps)
instead of dead-ends; role-gating keeps CTAs honest; new lists have a clear rule to follow; no new component to
maintain.

**Negative:** lists must thread an action handler down to their table/empty component to offer a CTA (small
prop plumbing); the icon-vs-illustration line is a judgment call per area; the documents upload CTA depends on
the toolbar handler being in scope, so it may land after the owners CTA.

## Revisit triggers

- **Lists grow past ~6, or per-list empty variation multiplies** → reconsider a dedicated `<ListEmpty>` wrapper
  (Alternative D) to stop repeating the composition.
- **Empty states need richer guidance** (multi-step onboarding, sample data, video) → this convention only
  covers single-CTA states; design a richer onboarding pattern then.
- **A brand illustration system lands (ADR-0015)** → replace the top-level area icons with the agreed
  illustrations; this ADR's "icon by default, illustration for primary zero-states" line holds.
