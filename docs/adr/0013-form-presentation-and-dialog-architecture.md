# ADR 0013 — Form Presentation & Dialog Architecture

- **Status**: Accepted
- **Date**: 2026-06-15
- **Deciders**: Lukas
- **Decision in one line**: Small/flat CRUD forms live in a **responsive overlay** (centered `Dialog` on desktop, bottom `Sheet` on mobile, via a `ResponsiveDialog` wrapper) whose **open/close state lives in the URL** (`?dialog=…&<entityId>=…`, driven by the shared `useUrlDialog` hook) for single-entity flows; **complex / branching / large forms get a dedicated route**; confirmations stay a centered `AlertDialog`; and every mutating overlay uses the optimistic instant-close + invalidate-on-settle pattern.

---

## Context

Oceanview is an internal admin-heavy CRUD app for ~10–20 users. By June 2026 it had ~20 dialog
components (user, season, share, document/folder, passkey) built on shadcn `Dialog` / `AlertDialog`,
with forms following `useAppForm` (ADR-0005). Three things had drifted without ever being decided:

1. **Mobile.** Every dialog was a *centered modal at all breakpoints*. On phones the form is cramped
   and the on-screen keyboard covers it — directly at odds with the "every screen must be responsive"
   non-negotiable (CLAUDE.md). Only the sidebar adapted (drawer < 768px).
2. **Complexity ceiling.** The share **Assign** form (whole/split toggle + effective date + one-or-two
   user selects) already strained a centered modal, and the planned ADR-0012 places flow (map + photo
   + tags) would not fit one at all.
3. **State inconsistency.** `owners`, `/` (seasons) and `admin/shares` drove dialog open/close from
   **URL search params** (`validateSearch` + `navigate`) — deep-linkable, back-button- and
   refresh-survivable, loader-prefetched — while document dialogs used ephemeral `useState` /
   `useDialogState`.

`useAppForm` forms are **container-agnostic** (the bound `<field.*>` components render the same inside
a `Dialog`, a `Sheet`, or a full page), so the presentation choice is free to optimize for UX without
touching form logic. This ADR makes the choice explicit so future CRUD follows it by default.

## Decision (TL;DR)

- **Small / flat CRUD form → responsive overlay.** The test is *structure, not field count*: a flat
  set of fields, no conditional/branching layout, no media/map, ≤1 logical section. (AssignShare is
  ~3 fields yet is a *page* because of its whole/split branch.) Use `ResponsiveDialog`
  (`src/components/ui/responsive-dialog.tsx`): centered `Dialog` on desktop, bottom `Sheet` on mobile,
  switched by `useIsMobile()` (`src/hooks/useMobile.ts`). Call sites use **explicit `<ResponsiveDialog>`
  JSX** (no `as Dialog` aliasing — keeps it greppable); forms are unchanged (container-agnostic).
- **Single-entity overlay open/close state → the URL.** `?dialog=<name>&<entityId>=…`, parsed by the
  route's `validateSearch` and driven by the shared **`useUrlDialog` hook** (`src/hooks/useUrlDialog.ts`),
  which owns the open/close/active state machine; the route keeps its own `validateSearch`,
  loader-prefetch (`ensureQueryData(getById)`), and dialog-name→component render map. Deep-linkable and
  back-button friendly. The open dialog reads its entity from the cached list/detail query (the
  `owners.tsx` pattern).
- **Transient multi-selection (bulk) flows stay ephemeral.** Bulk move/delete act on an unbounded,
  short-lived selection `Set` that does not belong in a URL — keep `useDialogState` + the selection
  bars. This is the one deliberate exception to "state in the URL."
- **The document library stays fully ephemeral — single-item dialogs included** (a deliberate keep,
  not the unresolved drift of Context #3). `DocumentTableRow` drives single *and* bulk actions
  (move/delete) through one `useDialogState` + `DocumentRowDialogs`, branching on `isMulti`; splitting
  that to URL-drive only the single-item dialogs is a large refactor of the most complex view
  (drag-and-drop, selection, desktop/mobile, shared across two routes) for marginal benefit — document
  operations are transient and rarely worth a deep-link. Owners / seasons / shares remain the
  URL-driven canon; documents keep `useDialogState`.
- **Complex / large / growing form → dedicated route/page.** Multi-section forms, media, maps, or any
  form that outgrows a comfortable overlay get a real route (`/admin/shares/assign/$shareCode`; the
  future ADR-0012 places editor). Unlimited room, naturally responsive, best deep-linking, no overlay
  focus/z-index friction.
- **Confirmations → centered `AlertDialog`** (not responsive). Tiny "are you sure" prompts read fine
  centered on every screen; making them adaptive is churn without payoff.
- **Mutating overlays → optimistic instant-close + invalidate-on-settle.** `onMutate` paints the cache
  (helpers in `src/lib/orpc/optimistic.ts`), the form closes immediately, `onError`/`onSettled`
  reconcile; the backend stays the source of truth via the settle refetch. See CLAUDE.md "Mutation
  callback placement & optimistic close." Keep a pessimistic close only when there's a **user-fixable**
  inline error (e.g. `RenameFolderDialog`'s `NAME_TAKEN_IN_PARENT`).

### Picking a presentation — decision flow

1. A confirmation (no fields)? → centered `AlertDialog`.
2. A form acting on a **transient multi-selection**? → ephemeral overlay (`useDialogState`), bulk
   variant.
3. A **flat, single-section** single-entity form? → `ResponsiveDialog`, URL state via `useUrlDialog`.
4. **Branching / multi-section / media / map** form? → dedicated route.

## Alternatives considered

- **A. Status quo (centered modal at all sizes).** Rejected as the default — fails the responsive
  non-negotiable on mobile.
- **B. vaul `Drawer` for the mobile branch.** Nicer draggable bottom-sheet feel, but a new dependency
  and another CLI component to maintain. Rejected in favor of reusing the existing `Sheet`
  (`side="bottom"`) — zero new deps, already production-used (sidebar, history sheets). Revisit if the
  drag-to-dismiss affordance is wanted.
- **C. Always a side `Sheet` (even desktop).** More room, but heavy for a 2-field edit and covers more
  context than a centered modal. Reserved for read-only side panels (history), not forms.
- **D. Inline / in-place editing.** Great for single-field rename, but focus/validation/a11y cost is
  high and it fights the bound-form architecture for multi-field create. Not the default; allowed as a
  future nicety for rename-only.
- **E. Popover for micro-edits.** Too little space and not modal; poor on mobile. Niche only.
- **F. Everything on dedicated pages.** Loses in-context "edit this row" flow and is overkill for a
  2-field edit at this scale. Reserved for complex forms.

## Architecture

### `ResponsiveDialog` — `src/components/ui/responsive-dialog.tsx`

A thin "Credenza"-style wrapper. The root picks the primitive (`isMobile ? Sheet : Dialog`) and shares
`{ isMobile }` through a small context; the sub-components (`ResponsiveDialogContent` /
`Header` / `Title` / `Description` / `Footer`) delegate to the matching `Sheet*` or `Dialog*` element.
Mobile content is `<SheetContent side="bottom">`. Call sites keep the familiar Dialog-shaped JSX and
the same `open` / `onOpenChange` plumbing.

SSR posture: `useIsMobile()` returns `false` until hydration, so a *deep-linked-open* overlay renders
as a `Dialog` for one frame then swaps to the bottom `Sheet` on mobile. Overlays are normally closed
at first paint, so this is a non-issue in practice — no anti-flicker machinery.

### URL-driven open/close (single-entity)

The hosting route owns a `validateSearch` schema with a `dialog` enum plus the entity id(s); triggers
`navigate({ search: { dialog, <id> } })`; the loader `ensureQueryData`s the entity when the dialog
targets one; the open dialog reads the entity from cache. The open/close/active wiring is the shared
`useUrlDialog` hook; the route owns its `validateSearch`, loader prefetch, and render map. Canonical:
`owners.tsx` (+ `EditUserDialog`).

### Dedicated route for complex forms

A normal route renders the `useAppForm` form verbatim (it's container-agnostic). The trigger
`navigate`s to it; success `navigate`s back. Canonical: `/admin/shares/assign/$shareCode`
(`ShareAssignForm` rendered by the route).

## Verification

- Each responsive form opens as a centered modal ≥768px and a bottom sheet <768px; submit + optimistic
  close work in both.
- A URL-driven single-entity dialog deep-links, survives refresh, and closes on back.
- A complex-form route deep-links and returns to its origin on success.
- Confirmations remain centered `AlertDialog`s; bulk document actions remain ephemeral.

## Critical files

- `src/components/ui/responsive-dialog.tsx` — the wrapper.
- `src/components/ui/{dialog,sheet,alert-dialog}.tsx` — the underlying primitives.
- `src/hooks/useUrlDialog.ts` — shared URL dialog open/close/active state machine (owners, seasons, shares).
- `src/hooks/useMobile.ts` (`useIsMobile`), `src/hooks/useDialogState.ts` (ephemeral bulk state).
- `src/lib/orpc/optimistic.ts` — `optimisticInsert/Patch/Remove/Replace` for the mutation pattern.
- `docs/adr/0005-form-architecture.md` — `useAppForm`; `docs/adr/0012-recommended-places.md` — places
  editor should be a dedicated route per this ADR.

## Consequences

**Positive:** one responsive overlay everywhere small forms appear (mobile fixed at low cost); a clear,
repeatable rule for dialog-vs-page; URL-driven dialogs are deep-linkable and refresh-safe; forms stay
portable across containers.

**Negative:** a one-frame Dialog→Sheet swap for deep-linked-open overlays on mobile (cosmetic); two
layouts to eyeball per responsive form; complex forms cost an extra route.

## Revisit triggers

- **Drag-to-dismiss is wanted on mobile** → reconsider vaul `Drawer` (alternative B).
- **A "small" form grows past a comfortable overlay** → promote it to a dedicated route (rule above).
- **Bulk actions ever need deep-linking** → would require encoding selection in the URL; re-open the
  ephemeral-bulk exception then (don't until there's a real need).
- **Document single-item dialogs are genuinely wanted as deep-links** → split the per-row
  single/bulk `useDialogState` coupling and adopt `useUrlDialog` (deferred — see the document-library
  decision above). Only worth it if shareable document-dialog URLs become a real need.
