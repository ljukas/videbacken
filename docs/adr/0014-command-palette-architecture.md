# ADR 0014 — Command Palette Architecture

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: Lukas
- **Decision in one line**: A single global Cmd/Ctrl+K command palette, mounted once in the authenticated shell, is built on the existing cmdk `Command` component and a small **static, typed command registry** (`{ to, label (message fn), keywords (message fn), icon, adminOnly }`; action commands add `perform(ctx)`); it generalizes the earlier documents-only palette into three coexisting kinds — **navigate** (static route targets), **actions** (which navigate to the ADR-0013 URL-state dialogs / dedicated routes, never re-implementing flows), and **async entity search** (debounced server search) — with admin-only commands hidden by role and exactly one owner of the `Mod+K` chord. Today only the navigate kind has commands registered.

> **Amended 2026-09-29. Pruned to the current template.** References to features the template removed
> (documents/folders and their search, shares, owners) were removed or replaced with current examples. The
> "Assign share" nested page and the "create folder" deep-open only served removed features and are marked
> as no longer governing code. The registry description now matches the shipped `NAVIGATE_COMMANDS` shape
> (`adminOnly` in place of `visibleWhen(role)`); the decision-level shape dropped `id`, `group`, `shortcut`,
> `perform` and `visibleWhen` to match the navigate-only registry (`perform(ctx)` returns with the first action
> command). No other decision changed.

---

## Context

Videbacken is an internal CRUD app for ~10–20 users. When this ADR was written it already shipped a Cmd+K
palette, but scoped to the documents views (a feature since removed from the template): it bound `Mod+K`
(`@tanstack/react-hotkeys`), opened a cmdk `CommandDialog`, debounced input, and rendered folder/document hits
from a server search procedure with `keepPreviousData`. It could not navigate the app or run actions, and it
was mounted **twice** (desktop + mobile document views) — so two instances both bound `Mod+K`.

We want a "new and improved" palette in the spirit of Linear's: open from anywhere, jump to any page, run
common actions (invite a user, switch theme/language, sign out), and search entities. The building blocks are
all present: the cmdk `Command` UI (`src/components/ui/command.tsx`, already installed),
`@tanstack/react-hotkeys`, and the ADR-0013 dialog architecture (URL-state single-entity dialogs via
`useUrlDialog`; dedicated routes for complex forms). The open questions this ADR settles: how to model
commands, how navigation/actions/async-search coexist in one palette, how actions reuse ADR-0013 flows
instead of forking them, and how admin gating works — at a scale where a hand-written registry beats any
framework.

## Decision (TL;DR)

- **One palette, mounted once** in `src/routes/_authenticated.tsx` (inside `SidebarProvider`). The earlier
  documents palette was folded into it and deleted; there is exactly one `Mod+K` owner.
- **Static typed registry** (`src/components/command/commands.ts`): `NAVIGATE_COMMANDS`, a module-level
  `linkOptions` array. Labels/keywords are **message functions** (called at render so the active Paraglide
  locale wins — the same discipline as `AppSidebar`'s `linkOptions`). Each command carries an `adminOnly` flag.
- **Three kinds, cmdk groups, one input.** Static groups (Navigate today; no Actions or Preferences commands
  are registered yet) self-filter (substring over the registry). Async entity-search groups are debounced,
  `enabled` at query ≥ 2 chars, with `keepPreviousData`; no entity source is registered today (the documents
  search that filled this slot was removed with documents). The `Command` runs with `shouldFilter={false}`
  and we control `selected`, so static and server results rank under one model.
- **Actions reuse ADR-0013 flows; the palette never re-invents a form.** A URL-state dialog is opened by
  navigating to its route with the `?dialog=` search param (e.g. "Invite user" → `navigate({ to: '/users',
  search: { dialog: 'invite' } })`, which the users route's `validateSearch` + `useUrlDialog` turn into the
  `InviteUserDialog`). A dedicated-route flow is a plain navigate. A client effect (theme/language/sign out)
  calls the same primitives the user menu uses (`useTheme`, `setLocale`, `useSignOut`). No action command is
  registered today; this governs the first one.
- **"Assign share" nested palette page** — applied to the removed shares feature (a param-bound dedicated
  route picked via a cmdk sub-page) and no longer governs code.
- **Admin gating is by `adminOnly`**, role read from the `_authenticated` route context and passed as
  `role`. UX-only — the routes/procedures still enforce `adminProcedure`/`protectedProcedure`. (No registered
  command is admin-only today.)
- **Route list is a static registry, not router introspection.** Typed `to` literals keep it compile-checked;
  the inventory is five targets and rarely changes.

## Alternatives considered

- **A. Router introspection for the navigate list.** Walk TanStack Router's route tree instead of hand-listing
  targets. Rejected: routes carry no labels/icons/i18n/role, and param routes aren't directly navigable. More
  code for less control at a tiny, stable inventory. Revisit only if route count explodes.
- **B. Build a palette from scratch.** Rejected — cmdk is already installed, themed
  (`src/components/ui/command.tsx`), and was proven in the earlier documents palette (handles fuzzy match,
  keyboarding, the first-item-scroll quirk, SSR-safe kbd label). Reusing it is strictly less risk.
- **C. Keep per-view palettes (status quo).** Rejected — two mounts both binding `Mod+K`, no global navigation,
  duplicated affordances.
- **D. A command framework / plugin abstraction (kbar, dynamic registration).** Rejected as over-engineering
  for ~15 commands and 10–20 users: a static array with `perform(ctx)` is greppable, fully typed, and has
  nothing to learn. (Deletion test: deleting the "framework" would just inline the array.)
- **E. Action commands re-implement their own forms in the palette.** Rejected — duplicates ADR-0013 flows and
  their optimistic-mutation wiring. Navigating to the existing URL-dialog or dedicated route reuses one source
  of truth.
- **F. Global custom event / Zustand for open state.** Rejected for a small React context provider
  (`useCommandPalette`) — one consumer tree (sidebar search button, mobile-header `CommandTriggerButton`),
  idiomatic, typed.

## Architecture

### Mount & open state — `src/routes/_authenticated.tsx`, `useCommandPalette.tsx`
`<CommandPalette role={user.role} />` renders once inside `SidebarProvider`. A `CommandPaletteProvider`
exposes `{ open, setOpen }` so the sidebar search button and the mobile-header `CommandTriggerButton` open it
without prop-drilling. `Mod+K` is bound in `CommandPalette` and **only** there.

### Registry — `src/components/command/commands.ts`
Module-level `NAVIGATE_COMMANDS` (`linkOptions`, so `to` is type-checked). `label`/`keywords` are `m.*`
functions; `icon` is a Lucide component (direct import, no barrel); `adminOnly` gates admin commands. Filtered
once per render in a `useMemo` keyed on role. Action commands, when added, carry a `perform(ctx)` receiving
`{ navigate, setTheme, setLocale, signOut, close }`.

### Coexistence — one `<Command shouldFilter={false}>`
Static groups filter themselves with a scored substring pass over `label()` + `keywords()` (label prefix >
label substring > keyword-word prefix > keyword substring — trivial per keystroke at this size); async groups
gate on `open && debounced.length >= 2` and use `placeholderData: keepPreviousData`. `selected` is controlled
and cleared on each edit so cmdk re-picks the top item — lifted from the earlier documents palette. One
ranking model across static + async.

### Actions → ADR-0013
URL-state dialog: `navigate({ to, search: { dialog: '…' } })`. Dedicated route: plain navigate.
Theme/locale/sign-out call the same primitives as the user menu (`src/components/user/UserMenu.tsx`). (The
"Assign share" sub-page and the "Create folder" hop served removed features and no longer govern code.)

### Async entity search
No entity source is registered today. The removed documents feature filled this slot with a
`protectedProcedure` search procedure; a new source follows the coexistence rules above.

### React-best-practices applied
`commands.ts` is module-level (no per-render recreation); the registry is filtered in a `useMemo`; Lucide
icons are imported directly (no barrel).

## Verification

- `Mod+K` (and the sidebar search button) opens the palette from any authenticated page; Esc/back closes it.
- Navigate group jumps to each route; `adminOnly` targets are absent for a non-admin session and present for
  an admin.
- Keyboard-only operation throughout (arrows/Enter/Esc); labels render in both `sv` and `en`.

## Critical files

- `src/components/command/CommandPalette.tsx` — the overlay (open state, hotkey, groups).
- `src/components/command/commands.ts` — the typed command registry.
- `src/components/command/useCommandPalette.tsx` — open-state context.
- `src/components/ui/command.tsx` — cmdk primitives (already installed).
- `src/routes/_authenticated.tsx` — single mount point; `src/components/AppSidebar.tsx` — search button.
- `src/hooks/useUrlDialog.ts` + `docs/adr/0013-form-presentation-and-dialog-architecture.md` — the action
  target flows the palette reuses.
- `messages/{sv,en}.json` — new `cmd_*` keys (sv source of truth).

## Consequences

**Positive:** one global palette and one `Mod+K` owner; navigate from anywhere, with slots for actions and
search; a tiny, greppable, fully typed registry; actions reuse ADR-0013 flows (no duplicated forms or mutation
wiring); admin gating is one predicate; the riskiest pieces (cmdk, hotkey, SSR kbd label) are reused, not
rebuilt.

**Negative:** the registry must be hand-updated when routes/actions change (mitigated by typed `to` literals
failing the build); a substring filter for static commands is less clever than fuzzy ranking (fine at this
size — five targets today).

## Revisit triggers

- **Command count grows past ~30, or third parties need to register commands** → reconsider a registration API
  (Alternative D).
- **Route inventory grows large / becomes dynamic** → reconsider router introspection for navigate targets
  (Alternative A).
- **Recent/frequent commands or a results-ranking model is wanted** → add a small usage store; revisit the
  self-filter.
