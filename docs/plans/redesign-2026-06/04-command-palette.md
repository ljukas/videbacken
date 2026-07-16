# 04 — Command Palette (global Cmd+K)

**ADR:** [0014 — Command Palette Architecture](../../adr/0014-command-palette-architecture.md)
**Status:** planned

Promote the existing documents-only palette (`src/components/document/shared/DocumentSearch.tsx`) into one
global Cmd+K that navigates everywhere, runs actions, and still searches documents. Exactly one `Mod+K` owner.

> Prereqs already met: shadcn `command` is installed (`src/components/ui/command.tsx`);
> `@tanstack/react-hotkeys` and `@tanstack/react-pacer` are in `package.json`. **No `shadcn add` needed.**

---

## New files
- `src/components/command/CommandPalette.tsx` — the `CommandDialog` (open state, `Mod+K`, renders groups +
  async doc search). Copy the SSR-safe kbd-label effect from `DocumentSearch`.
- `src/components/command/commands.ts` — the static typed registry.
- `src/components/command/useCommandPalette.tsx` — open-state context `{ open, setOpen }`.

## Command model (typed, no framework)

```ts
type Role = 'admin' | 'user'
type CommandCtx = {
  navigate: (opts: NavigateOptions) => void
  signOut: () => void
  setTheme: (t: Theme) => void
  setLocale: (l: Locale) => void
  close: () => void
}
type PaletteCommand = {
  id: string
  group: 'navigate' | 'actions' | 'preferences'
  label: () => string          // m.cmd_* — message FUNCTION, called at render (locale per-render)
  keywords?: () => string
  icon: LucideIcon             // direct import, no barrel
  shortcut?: string            // display-only hint
  visibleWhen?: (role: Role) => boolean
  perform: (ctx: CommandCtx) => void
}
```

Registry is a module-level array. Filter by role once per render (`useMemo` keyed on role). Admin gating is
UX-only — routes/procedures still enforce `adminProcedure`.

## Coexistence — one `<Command shouldFilter={false}>`
- Static groups (navigate / actions / preferences): self-filter with a substring match over `label()` +
  `keywords()` (~15 items).
- Async groups (documents / folders): `useDebouncedValue(q, { wait: 250 })` +
  `orpc.documentSearch.search.queryOptions`, `enabled: open && debounced.length >= 2`,
  `placeholderData: keepPreviousData`, `loading` on `CommandInput`. Control `selected`, clear on each edit
  (the proven `DocumentSearch` behavior — fixes cmdk's first-item scroll).

## Navigate targets (static registry, typed `to` literals)
`/`, `/owners`, `/documents`, `/account`; admin-only: `/admin/shares`, `/admin/documents/bin`. Icons reuse
those in `AppSidebar`.

## Actions (reuse ADR-0013 flows — never re-implement a form)
- **Invite owner** (admin): `navigate({ to: '/owners', search: { dialog: 'create' } })` → opens
  `CreateUserDialog` via `useUrlDialog`.
- **Assign share…** (admin): push a cmdk sub-page listing `SHARE_CODES` (holder from cached `share.listAll`) →
  `navigate({ to: '/admin/shares/assign/$shareCode', params: { shareCode } })`. MVP fallback: navigate to
  `/admin/shares`. Sub-page = a `pages: string[]` stack, Backspace-on-empty pops.
- **Create folder**: `navigate({ to: '/documents' })` (its create dialog is the ephemeral document-library
  exception; deep-open deferred).
- **Preferences**: theme (system/light/dark via `useTheme().setTheme`), language (sv/en via `setLocale`), sign
  out (`useSignOut()`) — the same primitives `UserMenu` uses.

## Mount + affordances
- **`src/routes/_authenticated.tsx`** — wrap children in `CommandPaletteProvider`; render
  `<CommandPalette role={user.role} />` inside `SidebarProvider`. Bind `Mod+K` here only.
- **`src/components/AppSidebar.tsx`** — add a search button in `SidebarHeader` (SearchIcon + kbd hint) calling
  `useCommandPalette().setOpen(true)`.
- **Documents views** (`DocumentsDesktop.tsx`, `DocumentsMobile.tsx`) — replace `<DocumentSearch />` with a
  button that opens the global palette.
- **Delete** `src/components/document/shared/DocumentSearch.tsx` (its `Mod+K` binding must not coexist).

## i18n
- New `cmd_*` keys in `messages/{sv,en}.json` (group headings + command labels), sv source. Reuse existing
  `search_*` keys for the document group. Run `pnpm i18n:compile` if editing outside `pnpm dev`.

## Phasing
1. **Navigate-only MVP** — registry (navigate group) + provider + `CommandPalette` + `Mod+K` + sidebar button.
2. **Actions / preferences** — actions group + the share sub-page; wire `CommandCtx`.
3. **Async doc search** — lift the `DocumentSearch` body in; swap the documents-view affordances; delete the
   old component.

## Critical files
- `src/components/command/{CommandPalette,commands,useCommandPalette}.{tsx,ts}` (new),
  `src/routes/_authenticated.tsx`, `src/components/AppSidebar.tsx`,
  `src/components/document/views/{DocumentsDesktop,DocumentsMobile}.tsx`,
  `src/components/document/shared/DocumentSearch.tsx` (delete), `messages/{sv,en}.json`.
- Reference: `src/hooks/useUrlDialog.ts`, `src/lib/orpc/procedures/documentSearch.ts`,
  `docs/adr/0013-form-presentation-and-dialog-architecture.md`.

## Verify
- `Mod+K` and the sidebar button open it from any page; Esc/back close.
- Navigate reaches every route; admin targets absent for `user`, present for `admin`.
- "Invite owner" → `/owners?dialog=create` opens `CreateUserDialog` (survives refresh); "Assign share…" →
  pick code → assign route.
- Theme/language/sign-out behave like the user menu; document search debounced with spinner.
- Keyboard-only throughout; labels in sv + en.
