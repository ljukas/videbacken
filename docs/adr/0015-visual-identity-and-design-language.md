# ADR 0015 — Visual Identity & Design Language

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: Lukas
- **Decision in one line**: Adopt a "quiet nautical confidence" design language — a Linear-style **inset app-shell** with a shared centered **`PageContainer`**, a **self-hosted type pairing** of Cabinet Grotesk (headings) over Switzer (body/UI) tuned Linear-style, **one** signature nautical-blue accent (`--brand`, applied to login/empty washes, the logo mark, and form-field focus borders, never to `--primary`), and a slightly slower, `prefers-reduced-motion`-aware overlay choreography shared across dialog / alert-dialog / sheet.

---

## Context

By mid-2026 Oceanview's UI was functional but read as **bland**: a flat default sidebar, full-bleed pages
that each hand-rolled `flex flex-col gap-6 p-4 md:p-8`, a purely neutral palette whose only color
(`--selected`) appeared in selection states, plain-text "Oceanview" branding, the default `@fontsource`
Geist face, and instant 100 ms overlay fades. The brand blue `#156cdd` lived only in `public/favicon.svg`
and the web manifest. The base is shadcn `radix-nova` + Tailwind v4 with oklch tokens in
`src/styles/app.css`, dark mode via `.dark` + the `oceanview-theme` cookie.

The goal is "striking but usable" for a calm internal tool used by ~10–20 sailboat co-owners. The risk with
"make it bold" is loudness; the discipline adopted here is **three concentrated moves on a restrained
canvas** — an inset shell, a distinctive type pairing, and one signature accent — rather than pervasive
decoration. Crucially, the inset machinery already exists in `src/components/ui/sidebar.tsx`
(`variant="inset"`) but was never deployed, so most of this is configuration plus a small amount of shared
layout, not new infrastructure.

This ADR owns the design **language** — shell, type, color, motion. It is consumed by ADR-0014 (command
palette) and ADR-0016 (empty states), and by the login redesign. The implementation breakdown lives in
`docs/plans/redesign-2026-06/`.

## Decision (TL;DR)

- **Inset app-shell.** Deploy `variant="inset"` on the sidebar; the sidebar background wraps a rounded,
  shadowed `bg-background` panel. Page content is centered in a shared `PageContainer` with a small max-width
  scale, replacing per-page padding.
- **Typography.** Self-host two faces, both from **Fontshare** under the **ITF Free Font License**:
  **Cabinet Grotesk** (variable) for headings and **Switzer** (variable) for body/UI. **Geist is removed.**
  Body gets Linear-style tuning (tight negative tracking, optical sizing, tabular numerals in tables).
  Heading hierarchy uses Cabinet Grotesk's variable weight axis throughout — page titles bold, section/dialog
  titles at their own medium/semibold weight (no fall-back to the body face needed).
- **Color & signature accent.** Promote `#156cdd` to a semantic `--brand` token (≈ the existing `--selected`
  blue). Apply it in a few low-frequency/transient places: a `.brand-wash` gradient on login and empty states,
  a `LogoMark`, and the focus border on form fields (see the 2026-06-18 amendment). `--primary` stays neutral.
- **Motion & overlays.** Overlay + content of dialog / alert-dialog / sheet move from 100 ms to 200 ms
  `ease-out` with the content rising 1px after the overlay dims; a global `prefers-reduced-motion` guard
  near-instants all overlay animation.

### Layout shell

`AppSidebar` renders `<Sidebar collapsible="icon" variant="inset">`. `SidebarProvider` already paints
`has-data-[variant=inset]:bg-sidebar`; `SidebarInset` already becomes `m-2 rounded-xl shadow-sm` under that
variant. A new `src/components/layout/PageContainer.tsx` owns `mx-auto`, responsive padding
(`px-4 py-6 md:px-8 md:py-10`), `gap-6`, and a `width` prop (`default ≈ max-w-5xl`, `prose ≈ max-w-2xl`,
`full`). All ~6 routes that hand-rolled `flex flex-col gap-6 p-4 md:p-8` switch to it. Mobile (`<768px`) is
unaffected: the sidebar is already a `Sheet` drawer and the inset margins are `md:`-gated, so the panel is
full-bleed with comfortable padding.

In light mode `--sidebar` (near-white) wraps a pure-white `--background` panel — the small lightness gap plus
`shadow-sm` + `rounded-xl` makes the panel lift. In dark mode the panel is a darker recessed well than its
wrap; both read as a distinct surface (the standard inset look). Text contrast is unchanged (`foreground` on
`background`), so accessibility is preserved.

> **Amendment (2026-06-23) — data tables go full-bleed (the table/content split).** The "Pages
> routinely need full width" revisit trigger **fired**: rather than only the document grid opting into
> `width="full"`, **every primary data-table screen now uses `full`** — Calendar (disposition list,
> `index.tsx`), Owners (`owners.tsx`), and Documents (already `full`). This matches Linear's pattern
> (wide tables for column scannability; constrained reading width for prose/forms) and the readability
> consensus (~65–75 chars ≈ 600–720px for body/forms — Baymard, NN/g, WCAG 1.4.8, GitHub Primer). The
> `width` tiers settle as: **`full`** (`max-w-none`) = data tables + document grid; **`default`**
> (`max-w-5xl`) = card grids / lists / mixed content (Admin Shares grid, Bin); **`prose`** (`max-w-2xl`)
> = forms / settings / reading (unchanged — already the ideal measure, so *not* tightened). **Full-bleed
> prose rule:** on a `width="full"` page, cap any multi-word descriptive paragraph at `max-w-2xl` while
> titles, controls, and the table span the panel (applied to the Owners + Documents descriptions; Calendar
> has none). Page-title `h1`s on the table screens are unified at `text-2xl md:text-3xl` (Documents was
> `text-3xl md:text-4xl` — now matched to Calendar/Owners). Ultrawide column stretch on the now-full tables
> is accepted; a `max-w-7xl` cap is the documented fallback if it ever bothers.

> **Amendment (2026-06-28) — settings pages with an inner nav + Linear-style card rows.** The Account
> screen splits into subpages (`/account/profile`, `/account/security`) switched by an **inner
> navigation** that lives *inside* the page content, not the app sidebar: a left rail from `md:` up, a
> top segmented control below it (`src/components/account/AccountNav.tsx`, routed `Link`s with
> `activeProps`). Because the rail eats horizontal room, the account **layout** uses `width="default"`
> (max-w-5xl) with the content column itself capped at `max-w-2xl` — the prose measure is preserved for
> the form, the rail just sits beside it (a deliberate exception to "settings = `prose`"). Editable
> settings render as **Linear-style rows**: one bordered `divide-y` card whose container is
> `@container/field-group`, each field a `<Field orientation="responsive">` (stacked on a narrow card,
> label-left at the `@md` container breakpoint) with the control pinned to a fixed width on the right
> (`w-full @md/field-group:w-64`). The bound `TextField`/`PhoneField` gained optional `orientation` /
> `fieldClassName` / `controlClassName` props (default `vertical` — every existing caller unchanged) so
> they compose into these rows without bypassing ADR-0005. This is the reusable template for future
> settings screens.

> **Amendment (2026-06-29) — off-white content canvas so cards lift (light mode).** The original
> "pure-white `--background` panel lifts above the near-white `--sidebar` wrap" reads flat for
> card-based screens: in light mode `--background` and `--card` were both `oklch(1 0 0)`, so white
> cards (ProfileCard, document/folder cards, empty states, …) only separated by their border. A new
> **`--canvas` token** (light `oklch(0.98 0 0)`, dark `oklch(0.145 0 0)` = today's `--background`)
> paints the inset content panel: `SidebarInset` gets `bg-canvas` at its single call site
> (`src/routes/_authenticated.tsx`), tailwind-merge overriding the component's base `bg-background` —
> `sidebar.tsx` is untouched. Now the white `--card` is the lifted surface and the panel is the
> recessed off-white one (inverting the original panel-lifts framing, light mode only). `--background`,
> `--card`, and `--popover` are unchanged, so **dialogs, popovers, inputs, and the login wash stay
> white, and dark mode is pixel-identical** (there `--card` 0.205 already lifts on `--background`
> 0.145). Applies app-wide (every authenticated page), matching Linear's off-white canvas.

> **Amendment (2026-06-29, follow-on) — the surface tiers become a named scale, and dark mode
> gains three distinct tiers.** The off-white canvas above added a *third* surface but left it
> under-named: the page tier lived only as `bg-canvas` (one consumer), while `bg-background` — the
> obvious-sounding name — meant the pure-white *content/primitive* tier, so layout code reached for
> the wrong token (the Documents + Owners sticky table headers and the mobile selection bar painted
> `bg-background` pure white on the off-white page, reading as white blocks). Two layered changes;
> **the surface scale re-values nothing** (it only aliases existing tokens — one source of truth per
> value), while the dark-mode tier change below deliberately re-values `--sidebar`/`--canvas`/`--card`:
> - **A semantic surface scale** in `@theme inline`: `--color-surface-sidebar` → `--sidebar`,
>   `--color-surface-page` → `--canvas`, `--color-surface-raised` → `--card`, exposing
>   `bg-surface-{sidebar,page,raised}` as the canonical *app-layout* vocabulary for the three Linear
>   tiers (chrome → page → content). shadcn primitives in `src/components/ui/` keep
>   `bg-sidebar`/`bg-card`/`bg-background`; the ambiguous `bg-canvas` utility is dropped. Page-composition
>   surfaces migrate: `SidebarInset` → `bg-surface-page`; hand-rolled content panels (profile, security,
>   share cards, season table, bin, document/folder cards) → `bg-surface-raised`; the three sticky
>   headers/bar → `bg-surface-page` (the fix). Overlays/floating surfaces (upload box, selection pills,
>   drag previews, sheet items) and emails stay on `bg-card` — they aren't page tiers.
> - **Dark mode gets three distinct tiers** (this **supersedes** the prior amendment's "dark mode is
>   pixel-identical" note): dark `--sidebar` 0.205 → **0.155** (darkest), `--canvas` 0.145 → **0.185**
>   (page), and `--card` 0.205 → **0.22** (content), so `--sidebar` < `--canvas` < `--card` read as three
>   distinct surfaces in dark too (steps ~0.03), matching the Linear dark reference. `--background` stays
>   0.145 as the primitive base (inputs/outline
>   buttons read as slightly sunken). Light mode already had three tiers (`--sidebar` 0.97 < `--canvas`
>   0.99 < `--card`/`--background` 1.0) and is unchanged. (Light `--canvas` shipped as `oklch(0.99 0 0)`,
>   not the `0.98` quoted in the prior amendment.)
>
> Design doc: `docs/superpowers/specs/2026-06-29-surface-token-system-design.md`.

### Typography & type scale

Both faces are **self-hosted woff2 under `public/fonts/`** with `@font-face` declarations in `app.css`
(`font-display: swap`). There is no `@fontsource` package for either — this manual hosting is the accepted
cost of the chosen faces. (Oceanview is a non-commercial internal tool, so commercial-licensing concerns
don't apply; both faces are ITF-FFL anyway, which permits commercial + web embedding regardless — see
Alternative E for why the originally-considered dafont route was dropped.)

- **Headings — Cabinet Grotesk.** Variable woff2 from **Fontshare** (Jérémie Hornus / ITF) under the **ITF
  Free Font License** (free personal + commercial + web embedding); retain the license file in-repo. A
  vintage-warm grotesque with softened terminals — the "quiet nautical confidence" character — with a full
  Thin–Black variable axis, downloaded as woff2 directly (no manual conversion). `--font-heading:
  'Cabinet Grotesk', var(--font-sans)`.
- **Body/UI — Switzer.** Variable woff2 from Fontshare under the **ITF Free Font License** (free personal +
  commercial); retain the license file in-repo. `--font-sans: 'Switzer', system-ui, sans-serif`.
- **Linear-style body tuning** (`@layer base`): tight negative letter-spacing on body/UI (≈ `-0.011em`),
  `font-optical-sizing: auto`, and `font-variant-numeric: tabular-nums` on numeric table cells (sizes, dates,
  phone, share counts). This tuning — not an exotic typeface — is the bulk of the "Linear feel."
- **Type scale.** An `@layer base` rule applies `font-heading tracking-tight` to `h1/h2/h3`. Page titles
  become `font-bold` (was Geist `font-semibold`). Dialog/section titles use `font-medium`/`font-semibold`
  **in Cabinet Grotesk** — its variable axis covers 500/600, so there is no fall-back to the body face.
  `DialogTitle`/`SheetTitle`/`AlertDialogTitle` already consume `font-heading`, so all titles upgrade
  automatically. Watch the longest **Swedish** strings (the primary locale) under `tracking-tight`;
  `text-balance` on `h1` helps.

### Color & signature accent

New tokens in `:root` and `.dark`: `--brand` (light `oklch(0.56 0.18 256)`, dark `oklch(0.62 0.17 256)`) and
`--brand-foreground`, registered in `@theme inline` as `--color-brand` / `--color-brand-foreground`. A
`.brand-wash` component utility paints a soft radial `--brand`→transparent gradient, applied to the login
wrapper and `Empty` surfaces **only**. An optional `src/components/Logo.tsx` (`LogoMark` + `Wordmark`, sharing
its geometry with `favicon.svg`) renders the brand mark — a single off-center, wind-filled sail in `--brand`
(an original, Linear-style glyph) — in the sidebar header and login. `--primary` is deliberately left neutral.

> **Amendment (2026-06-19) — logo mark is a standalone sail.** The mark dropped the rounded `--brand` tile +
> Lucide `SailboatIcon` for a single off-center sail filled in `--brand` (`text-brand` + an inline `<svg>`;
> favicons share the path via `scripts/generateFavicons.mjs`). Browser favicons render the sail on transparent
> (floats on the tab); apple-touch + maskable Android variants sit it on an opaque white field inside the safe
> zone (transparency renders black there). An interim version used a disc with the sail knocked out via
> `fill-rule="evenodd"`; the disc was dropped so the sail reads on its own.

> **Amendment (2026-06-18) — form-field focus borders.** Form-field focus highlights move from the heavy
> 3px translucent neutral ring (`focus-visible:ring-3 ring-ring/50`) to a thin `--brand` edge —
> `focus-visible:border-brand focus-visible:ring-1 focus-visible:ring-brand` — across `input`, `textarea`,
> `select` trigger, the `input-group` wrapper, and `phone-input` (the country-select button included so the
> control reads as one). This is a **deliberate** third `--brand` placement, not drift: it's low-frequency
> and transient (one field, only while focused), reinforces the accent at the interaction moment, and leaves
> `--primary` neutral. The matching `aria-invalid` state is thinned to `ring-1 ring-destructive/50` for weight
> parity. Buttons and other non-field controls keep the neutral ring.

### Motion & overlays

In `dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx`: overlay fade `duration-100` → `duration-200 ease-out`;
dialog/alert content `duration-100` → `duration-200 ease-out` plus `data-open:slide-in-from-top-1` so it rises
after the scrim dims (perceived stagger — overlay is a pure fade, content fades+zooms+rises). Sheet keeps its
200 ms slide; only its overlay timing is aligned. A single `@media (prefers-reduced-motion: reduce)` rule in
`app.css` near-zeroes animation/transition duration for `[data-slot$="-overlay"]` and `[data-slot$="-content"]`.

## Alternatives considered

- **A. Make `--primary` the nautical blue.** Bolder, but tints every primary button and destroys the "calm"
  brief; fights the neutral-slate base. Rejected — one accent in two placements instead.
- **B. `variant="floating"` sidebar.** Rounds the *sidebar* into a card too; busier and less Linear-like than
  `inset` (which floats only the content panel). Rejected.
- **C. Keep per-page padding (no `PageContainer`).** Status quo; no centering on wide monitors and 6×
  duplication. Rejected — the container is the one place that owns page layout.
- **D. Keep Geist (or Schibsted Grotesk) for body.** Geist reads as "default Inter"; the owner explicitly
  wanted Linear's direction. Switzer is Inter-adjacent with more warmth and is free-for-commercial. **Inter
  Variable** (Linear's actual font) and **Hanken Grotesk** are documented drop-in body fallbacks (one-line
  `--font-sans` swap).
- **E. Alte Haas Grotesk (dafont) for headings — the original pick, dropped.** Alte Haas has the same
  vintage-warm grotesque character, but it's a dafont freeware face whose terms live in a bundled
  `licence.rtf`, so shipping it required *verifying web embedding + commercial use* — and it ships only fixed
  **400/700** (forcing semibold titles onto the body face) and needs manual **OTF→woff2** conversion. Since
  Oceanview is non-commercial the commercial-use half of that gate was moot, which **widened the field**: the
  free-for-personal tier opened up, and — more usefully — Fontshare's own ITF-FFL **variable** grotesques
  (Switzer's home, so commercial-safe regardless) match the brief while dissolving *both* Alte Haas costs.
  **Cabinet Grotesk** was chosen (closest to the warm-grotesque character); **Clash Display** (more striking
  than the calm brief) and **General Sans** (more neutral than wanted) were the other Fontshare candidates.
  **Schibsted Grotesk / Hanken Grotesk** remain documented further fallbacks.
- **F. Third-party font CDN.** Rejected — privacy + FOUT + offline; self-hosting is the established pattern.
- **G. Longer (300 ms+) overlay motion.** Feels laggy for this CRUD-heavy app's repeated opens. 200 ms ceiling.

## Architecture

`PageContainer` (`src/components/layout/PageContainer.tsx`) is a deep-but-tiny module: one `width` prop hides
the padding + centering + max-width decision from every route. `Logo` (`src/components/Logo.tsx`) centralizes
the wordmark/mark and is shared with the login redesign. All color/motion/font decisions stay centralized in
`src/styles/app.css` tokens and base/component layers; the overlay primitives only change class strings. The
only new runtime assets are the two self-hosted font families under `public/fonts/`; no new npm dependency
(and `@fontsource-variable/geist` is removed).

## Verification

- The project build succeeds with the new `@font-face` rules and Geist removed; no missing-font console
  warnings.
- Desktop ≥768px: inset panel floats with rounded corners + shadow; sidebar bg wraps; page content centered
  within `max-w-5xl`/`prose`. Mobile <768px: sidebar is a drawer, panel full-bleed, padding comfortable.
- Light and dark: panel separates from the wrap in both. Text contrast unchanged.
- Headings render in Cabinet Grotesk; body in Switzer; numerals in tables are tabular/aligned; hierarchy
  reads bold → semibold/medium, all in Cabinet Grotesk's variable axis.
- `.brand-wash` visible on login + empty states in both themes; `--primary` buttons remain neutral; the logo
  mark's `--brand` sail reads against the sidebar + wash backgrounds in both themes and stays legible down to
  16px (favicon).
- Overlays open with a ~200 ms dim-then-rise; sheet slides from bottom on mobile. With OS "Reduce Motion" on,
  overlays appear effectively instantly.
- Longest Swedish page titles do not crowd/clip under `tracking-tight`.

## Critical files

- `src/components/AppSidebar.tsx` — `variant="inset"`.
- `src/components/ui/sidebar.tsx` — existing inset classes (reference only).
- `src/components/layout/PageContainer.tsx` — new shared centered container.
- `src/styles/app.css` — `@font-face` (Cabinet Grotesk + Switzer), `--font-heading`/`--font-sans`, `--brand`
  tokens, `.brand-wash`, base heading + body-tuning rules, reduced-motion guard; remove Geist import.
- `public/fonts/` — self-hosted woff2 + retained license files for both faces.
- `src/components/ui/{dialog,alert-dialog,sheet}.tsx` — overlay timing + content rise.
- `src/components/Logo.tsx` (new, shared with login) and the ~6 routes migrating to `PageContainer`.

## Consequences

**Positive:** the shell reads as a deliberate, modern product at near-zero cost (machinery already existed);
one place (`PageContainer`) owns page layout, ending 6× duplication and giving readable centering on wide
screens; a distinctive heading face + a warmer Linear-tuned body + one signature blue make it "bold" without
loud; overlays feel considered and finally respect reduced-motion; all design decisions are centralized in
tokens/primitives, so the language is greppable and easy to retune.

**Negative:** the inset frame slightly reduces usable width everywhere (intended); two **manually hosted**
font families (woff2 to retain under `public/fonts/`, with license files) — more upkeep than `@fontsource`,
though both download as ready woff2 from Fontshare (no conversion, and the variable axes mean no
fixed-weight compromises); migrating ~6 routes to `PageContainer` is mechanical but touches several files;
data-table screens + the document grid opt into `width="full"` while grids/lists/forms stay `default`/`prose`
(see the 2026-06-23 amendment); the brand blue overlaps `--selected`, so the
two must be kept visually coherent.

## Revisit triggers

- **Manual font upkeep becomes a burden / FOUT is noticeable** → swap to the documented `@fontsource`
  fallbacks (Inter or Hanken body; Schibsted heading) via a one-line token change.
- **Pages routinely need full width** → actioned for data tables (2026-06-23 amendment). If the remaining
  `default` card-grid/list screens also feel cramped, reconsider whether `default` should be wider, or make
  `full` default.
- **The brand wants more color presence** → re-open Alternative A (blue `--primary`) deliberately, not by drift.
- **Overlay motion feels slow under heavy CRUD use** → step back toward 150 ms.
- **A brand illustration system is wanted** → extend this ADR; ADR-0016 already defers empty-state
  illustrations here.
