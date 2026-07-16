# ADR 0014 — Command Palette Architecture

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: Lukas
- **Decision in one line**: A single global Cmd/Ctrl+K command palette, mounted once in the authenticated shell, is built on the existing cmdk `Command` component and a small **static, typed command registry** (`{ id, group, label (message fn), icon, keywords, shortcut, visibleWhen(role), perform(ctx) }`); it generalizes today's documents-only `DocumentSearch` palette into three coexisting kinds — **navigate** (static route targets), **actions** (which navigate to the ADR-0013 URL-state dialogs / dedicated routes, never re-implementing flows), and **async document search** (debounced `documentSearch.search`) — with admin-only commands hidden by role and exactly one owner of the `Mod+K` chord.

---

## Context

Oceanview is an internal CRUD app for ~10–20 users. It already ships a Cmd+K palette —
`src/components/document/shared/DocumentSearch.tsx` — but scoped to the documents views: it binds `Mod+K`
(`@tanstack/react-hotkeys`), opens a cmdk `CommandDialog`, debounces input (`@tanstack/react-pacer`), and
renders folder/document hits from the `documentSearch.search` oRPC procedure with `keepPreviousData`. It
cannot navigate the app or run actions, and it is mounted **twice** (desktop + mobile document views) — so
two instances both bind `Mod+K`.

We want a "new and improved" palette in the spirit of Linear's: open from anywhere, jump to any page, run
common actions (assign share, invite owner, create folder, switch theme/language, sign out), and still search
documents. The building blocks are all present: the cmdk `Command` UI (`src/components/ui/command.tsx`, already
installed), `@tanstack/react-hotkeys`, `@tanstack/react-pacer`, the `documentSearch` procedure, and the
ADR-0013 dialog architecture (URL-state single-entity dialogs via `useUrlDialog`; dedicated routes for complex
forms). The open questions this ADR settles: how to model commands, how navigation/actions/async-search
coexist in one palette, how actions reuse ADR-0013 flows instead of forking them, and how admin gating works —
at a scale where a hand-written registry beats any framework.

## Decision (TL;DR)

- **One palette, mounted once** in `src/routes/_authenticated.tsx` (inside `SidebarProvider`). `DocumentSearch`
  is folded into it and deleted; there is exactly one `Mod+K` owner.
- **Static typed registry** (`src/components/command/commands.ts`): a module-level array of `PaletteCommand`.
  Labels/keywords are **message functions** (called at render so the active Paraglide locale wins — the same
  discipline as `AppSidebar`'s `linkOptions`). Each command has a `perform(ctx)` and optional `visibleWhen(role)`.
- **Three kinds, cmdk groups, one input.** Navigate + Actions + Preferences are static and self-filtered
  (substring over ~15 items); Documents/Folders are async (debounced `documentSearch.search`, `enabled` at
  query ≥ 2 chars, `keepPreviousData`). The `Command` runs with `shouldFilter={false}` and we control
  `selected` — the proven `DocumentSearch` pattern — so static and server results rank under one model.
- **Actions reuse ADR-0013 flows; the palette never re-invents a form.** A URL-state dialog is opened by
  navigating to its route with the `?dialog=` search param (e.g. "Invite owner" → `navigate({ to: '/owners',
  search: { dialog: 'create' } })`, which the owners route's `validateSearch` + `useUrlDialog` turn into the
  `CreateUserDialog`). A dedicated-route flow is a plain navigate. A client effect (theme/language/sign out)
  calls the same primitives the user menu uses (`useTheme`, `setLocale`, `useSignOut`).
- **"Assign share" uses a nested palette page.** The dedicated route `/admin/shares/assign/$shareCode` needs a
  code the palette doesn't have, so selecting "Assign share…" pushes a cmdk sub-page listing `SHARE_CODES`
  (with current holder from the cached `share.listAll`); picking one navigates to the assign route. (MVP
  fallback: navigate to `/admin/shares` to pick on the grid.)
- **Admin gating is by `visibleWhen(role)`**, role read from the `_authenticated` route context. UX-only — the
  routes/procedures still enforce `adminProcedure`/`protectedProcedure`.
- **Route list is a static registry, not router introspection.** Typed `to` literals keep it compile-checked;
  the inventory is ~8 targets and rarely changes.

## Alternatives considered

- **A. Router introspection for the navigate list.** Walk TanStack Router's route tree instead of hand-listing
  targets. Rejected: routes carry no labels/icons/i18n/role, and param routes (`/documents/$`,
  `/admin/shares/assign/$shareCode`) aren't directly navigable. More code for less control at a tiny, stable
  inventory. Revisit only if route count explodes.
- **B. Build a palette from scratch.** Rejected — cmdk is already installed, themed
  (`src/components/ui/command.tsx`), and proven in `DocumentSearch` (handles fuzzy match, keyboarding, the
  first-item-scroll quirk, SSR-safe kbd label). Reusing it is strictly less risk.
- **C. Keep per-view palettes (status quo).** Rejected — two mounts both binding `Mod+K`, no global navigation,
  duplicated affordances.
- **D. A command framework / plugin abstraction (kbar, dynamic registration).** Rejected as over-engineering
  for ~15 commands and 10–20 users: a static array with `perform(ctx)` is greppable, fully typed, and has
  nothing to learn. (Deletion test: deleting the "framework" would just inline the array.)
- **E. Action commands re-implement their own forms in the palette.** Rejected — duplicates ADR-0013 flows and
  their optimistic-mutation wiring. Navigating to the existing URL-dialog or dedicated route reuses one source
  of truth.
- **F. Global custom event / Zustand for open state.** Rejected for a small React context provider
  (`useCommandPalette`) — one consumer tree (sidebar button, documents toolbar), idiomatic, typed.

## Architecture

### Mount & open state — `src/routes/_authenticated.tsx`, `useCommandPalette.tsx`
`<CommandPalette role={user.role} />` renders once inside `SidebarProvider`. A `CommandPaletteProvider`
exposes `{ open, setOpen }` so the sidebar search button and the documents toolbar button open it without
prop-drilling. `Mod+K` is bound here and **only** here.

### Registry — `src/components/command/commands.ts`
Module-level `PaletteCommand[]`. `label`/`keywords` are `m.*` functions; `icon` is a Lucide component (direct
import, no barrel); `perform(ctx)` receives `{ navigate, setTheme, setLocale, signOut, close }`;
`visibleWhen(role)` gates admin commands. Filtered once per render in a `useMemo` keyed on role.

### Coexistence — one `<Command shouldFilter={false}>`
Static groups filter themselves with a substring pass over `label()` + `keywords()` (~15 items — trivial per
keystroke); async groups gate on `open && debounced.length >= 2` and use `placeholderData: keepPreviousData`.
`selected` is controlled and cleared on each edit so cmdk re-picks the top item — lifted verbatim from
`DocumentSearch`. One ranking model across static + async.

### Actions → ADR-0013
URL-state dialog: `navigate({ to, search: { dialog: '…' } })`. Dedicated route: plain navigate. "Assign
share": nested cmdk page over `SHARE_CODES` → `/admin/shares/assign/$shareCode`. "Create folder": navigate to
`/documents` (its create-folder dialog is the ephemeral document-library exception in ADR-0013; deep-opening
it is deferred). Theme/locale/sign-out call the same primitives as `UserMenu`.

### Async document search
Reuses `orpc.documentSearch.search` (`protectedProcedure`), `useDebouncedValue(q, { wait: 250 })`,
`fileTypeAppearance`, `folderPathToSplat`. Folder hits navigate `/documents/$`; document hits open the file
download/view route.

### React-best-practices applied
`commands.ts` is module-level (no per-render recreation); the registry is filtered in a `useMemo`; `perform`
closures are stable; `useDebouncedValue` keeps input responsive; Lucide icons are imported directly (no barrel).

## Verification

- `Mod+K` (and the sidebar search button) opens the palette from any authenticated page; Esc/back closes it.
- Navigate group jumps to each route; admin targets (`/admin/shares`, `/admin/documents/bin`) are absent for a
  non-admin session and present for an admin.
- "Invite owner" lands on `/owners?dialog=create` and the existing `CreateUserDialog` opens (refresh keeps it
  open — ADR-0013 deep-link); "Assign share…" → pick a code → `/admin/shares/assign/$shareCode` renders the
  assign form.
- Theme cycles, language switches (page reload via Paraglide), sign out works — same as the user menu.
- Document search returns debounced folder/document hits with a spinner while fetching.
- Keyboard-only operation throughout (arrows/Enter/Esc, Backspace pops the share sub-page); labels render in
  both `sv` and `en`.

## Critical files

- `src/components/command/CommandPalette.tsx` — the overlay (open state, hotkey, groups).
- `src/components/command/commands.ts` — the typed command registry.
- `src/components/command/useCommandPalette.tsx` — open-state context.
- `src/components/ui/command.tsx` — cmdk primitives (already installed).
- `src/routes/_authenticated.tsx` — single mount point; `src/components/AppSidebar.tsx` — search button.
- `src/hooks/useUrlDialog.ts` + `docs/adr/0013-form-presentation-and-dialog-architecture.md` — the action
  target flows the palette reuses.
- `src/components/document/shared/DocumentSearch.tsx` — superseded; folded in and deleted (with its `Mod+K`
  binding).
- `messages/{sv,en}.json` — new `cmd_*` keys (sv source of truth).

## Consequences

**Positive:** one global palette and one `Mod+K` owner; navigate + act + search from anywhere; a tiny,
greppable, fully typed registry; actions reuse ADR-0013 flows (no duplicated forms or mutation wiring); admin
gating is one predicate; the riskiest pieces (cmdk, debounce, hotkey, SSR kbd label) are reused, not rebuilt.

**Negative:** the registry must be hand-updated when routes/actions change (mitigated by typed `to` literals
failing the build); "create folder" only lands on `/documents` until the ephemeral dialog gets a deep-open
trigger; "assign share" needs a nested page or a grid hop because the route is param-bound; a substring filter
for static commands is less clever than fuzzy ranking (fine at ~15 items).

## Revisit triggers

- **Command count grows past ~30, or third parties need to register commands** → reconsider a registration API
  (Alternative D).
- **Route inventory grows large / becomes dynamic** → reconsider router introspection for navigate targets
  (Alternative A).
- **Deep-opening the documents create-folder dialog is genuinely wanted** → add an ephemeral `?action=` trigger
  or promote that dialog to URL-state (touches ADR-0013's document-library exception).
- **Recent/frequent commands or a results-ranking model is wanted** → add a small usage store; revisit the
  self-filter.
