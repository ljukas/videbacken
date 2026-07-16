# 03 — Data Tables: full-width + hover-revealed row actions

**Status:** planned
**Depends on:** `PageContainer` from [plan 01](./01-visual-foundation.md) for the full-width feel.

Today **both** the owners table and the document table render the `⋮` actions button **always**
(`OwnersTable.tsx:324`, `DocumentTableRow.tsx:271`). Linear shows it only on the hovered row. Introduce one
shared hover-reveal host and apply it to both — keeping the control reachable by keyboard and on touch.

---

## Pattern source
The sidebar already has the recipe: `SidebarMenuAction showOnHover` (`src/components/ui/sidebar.tsx:609`) —
`md:opacity-0`, revealed by `group-hover/<scope>`, `group-focus-within/<scope>`, and `aria-expanded`. The
`md:` guard is the a11y keystone: on touch (`<md`, no hover) the control stays fully visible.

## New shared host
- **New `src/components/ui/row-actions.tsx`:**

```tsx
import type * as React from 'react'
import { cn } from '~/lib/utils'

export function RowActions({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      data-slot="row-actions"
      className={cn(
        'flex justify-end opacity-100 transition-opacity',
        // hide-until-interaction only where hover exists; revealed on row hover,
        // keyboard focus anywhere in the row, or while the menu is open.
        'md:opacity-0 group-hover/row:md:opacity-100 group-focus-within/row:md:opacity-100 has-aria-expanded:md:opacity-100',
        className,
      )}
    >
      {children}
    </div>
  )
}
```

The `group/row` scope is declared on the `<TableRow>`. `group-focus-within/row` reveals the menu when tabbing
into the row; `has-aria-expanded` keeps it visible while the Radix dropdown is open.

## Apply to both tables
- **`src/components/user/OwnersTable.tsx`:**
  1. `OwnerTableRow`'s `<TableRow>` (~line 213) → add `className="group/row"`.
  2. Actions cell (~lines 324–359) → wrap the existing `<DropdownMenu>` in `<RowActions>`; keep the trigger
     `Button` + items unchanged (the `aria-label` on the trigger is already present).
  3. Keep responsive column folding (`hidden md:/lg:table-cell`) untouched.
- **`src/components/document/table/DocumentTableRow.tsx`:**
  1. `<TableRow>` (~line 151) → add `group/row` to its existing `cn(...)`.
  2. Wrap the `⋮` `<DropdownMenu>` (~lines 272–286) in `<RowActions>`. Only the `⋮` hides-until-hover; the
     selection checkbox / drag affordances stay as-is. Keep `{...swallow}` on the trigger. The always-available
     right-click `ContextMenu` remains the discoverability path.

## Full width
- Width is delivered by `PageContainer` (plan 01): drop the per-route `p-4 md:p-8` on `owners.tsx` (and the
  document routes) in favor of the centered container. The tables are already `w-full`. **Sequence after plan
  01**; until then leave the route padding.
- **Tables are full-bleed** (2026-06-23, ADR-0015 amendment): the data-table routes use
  `<PageContainer width="full">` — `index.tsx` (Calendar disposition list) and `owners.tsx`; the document
  routes are already `full`. On a full-bleed page, cap any descriptive header paragraph at `max-w-2xl`
  (done on `owners.tsx`) so prose keeps a readable measure while the table spans the panel.

## a11y
- Visible on touch (`<md`); revealed by hover, by keyboard focus entering the row, and held open while the menu
  is open. Sorting headers and `aria-sort` unchanged.

## Critical files
- `src/components/ui/row-actions.tsx` (new), `src/components/user/OwnersTable.tsx`,
  `src/components/document/table/DocumentTableRow.tsx`. (Sequencing: `src/routes/_authenticated/owners.tsx`
  padding when plan 01 lands.)

## Verify
- Desktop: `⋮` hidden until row hover; revealed on Tab focus; stays visible while the menu is open.
- Touch/mobile (`<md`): `⋮` always visible.
- Keyboard-only: every row action reachable and operable without a mouse.
- Column folding intact at `md`/`lg`; table fills the centered container; numerals tabular (plan 01).
