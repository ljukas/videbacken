# 05 — Empty States (richer, with CTAs)

**ADR:** [0016 — Empty State & Feedback Conventions](../../adr/0016-empty-state-and-feedback-conventions.md)
**Status:** planned

Make every list empty state a consistent `<Empty>` (icon + title + description) with **at most one** role-gated
primary CTA where there's an obvious next action. Filtered/terminal empties stay CTA-less.

---

## Convention
`Empty` → `EmptyHeader` → `EmptyMedia variant="icon"` → `EmptyTitle` → `EmptyDescription`, with optional
`EmptyContent` holding one primary `Button`. Icon by default; illustration reserved for a top-level area's
primary zero-state (art direction owned by ADR-0015). CTA only when (a) one obvious next action and (b) the
viewer may take it.

| List | Media | CTA | Gating |
|---|---|---|---|
| Owners — active empty | `UsersIcon` | "Add a member" → `open('create')` | **admin only** |
| Owners — deleted filter | `UsersIcon` | none | — |
| Documents — true-root empty | `FileIcon` | "Upload" (primary) | any user |
| Documents — empty subfolder | (inline "up one level") | none | — |
| Bin empty | `Trash2Icon` | none | — |

## `OwnersTable.tsx` — migrate the plain-text cell to `<Empty>`
When `rows.length === 0`, return an `<Empty>` block **instead of** the `<Table>` (mirror `DocumentTable`). Add
an optional `onCreate?: () => void` prop, threaded from `owners.tsx`'s `open('create')`; render the CTA only
for the active (non-deleted) view when admin:

```tsx
if (rows.length === 0) {
  return (
    <Empty className="brand-wash rounded-lg border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><UsersIcon /></EmptyMedia>
        <EmptyTitle>{showDeleted ? m.owners_empty_deleted() : m.owners_empty()}</EmptyTitle>
        {showDeleted ? null : <EmptyDescription>{m.owners_empty_description()}</EmptyDescription>}
      </EmptyHeader>
      {!showDeleted && isAdmin && onCreate ? (
        <EmptyContent>
          <Button onClick={onCreate}><PlusIcon />{m.owners_create_button()}</Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
```

Thread `onCreate={() => open('create')}` from `src/routes/_authenticated/owners.tsx` through `ActiveOwners` →
`OwnersTable`. Deleted view passes no `onCreate`.

## `DocumentTable.tsx` — add an Upload CTA
Keep the existing true-root `<Empty>`; add `EmptyContent` with an "Upload" `Button` driven by a new
`onUpload?` prop threaded from the documents view's existing upload handler. If wiring that handler down is more
plumbing than it's worth this pass, leave documents icon+text-only — the convention degrades gracefully.

## `DocumentBin.tsx`
No change — the reference terminal empty (no CTA).

## i18n
- New: `owners_empty_description` (sv "Bjud in delägare så syns de här." / en "Invite owners and they'll show up
  here."); optional `document_upload_cta` ("Ladda upp" / "Upload").
- Reuse: `owners_empty`, `owners_empty_deleted`, `owners_create_button`, `document_table_empty`,
  `document_empty_description`, `bin_empty_*`. Run `pnpm i18n:compile` if editing outside `pnpm dev`.

## Critical files
- `src/components/user/OwnersTable.tsx`, `src/routes/_authenticated/owners.tsx`,
  `src/components/document/table/DocumentTable.tsx`, `messages/{sv,en}.json`.
- Reference: `src/components/ui/empty.tsx`, `src/components/document/views/DocumentBin.tsx`.

## Verify
- Owners empty as **admin**: icon + title + description + "Add a member" CTA opening create.
- Owners empty as **member**: no CTA. Deleted filter: no CTA.
- Documents root: upload CTA (or icon+text if deferred); empty subfolder keeps "up one level"; bin: no CTA.
- `.brand-wash` reads in light + dark; CTA thumb-reachable on mobile; sv + en.
