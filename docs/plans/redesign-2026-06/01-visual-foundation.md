# 01 — Visual Foundation

**ADR:** [0015 — Visual Identity & Design Language](../../adr/0015-visual-identity-and-design-language.md)
**Status:** ✅ implemented (2026-06-17)

Covers the inset app-shell, a shared centered `PageContainer`, the self-hosted type pairing, the `--brand`
accent, and the dialog-overlay motion polish.

---

## 1. Inset app-shell (the Linear "window")

The primitive already supports this — it's just not deployed.

- **`src/components/AppSidebar.tsx`** — change `<Sidebar collapsible="icon">` to
  `<Sidebar collapsible="icon" variant="inset">`.
  - `SidebarProvider` already paints `has-data-[variant=inset]:bg-sidebar` (the wrapping background).
  - `SidebarInset` already becomes `m-2 rounded-xl shadow-sm` under that variant (the floating panel).
  - No new CSS.

## 2. Shared centered `PageContainer`

Today ~6 routes hand-roll `<div className="flex flex-col gap-6 p-4 md:p-8">`. Replace with one component that
also centers + constrains width (Linear's centered reading column inside the panel).

- **New `src/components/layout/PageContainer.tsx`:**

```tsx
import type * as React from 'react'
import { cn } from '~/lib/utils'

const widths = {
  default: 'max-w-5xl', // tables, lists
  prose: 'max-w-2xl',   // forms, settings, reading
  full: 'max-w-none',   // wide data views (document grid)
} as const

export function PageContainer({
  className,
  width = 'default',
  ...props
}: React.ComponentProps<'div'> & { width?: keyof typeof widths }) {
  return (
    <div
      data-slot="page-container"
      className={cn('mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8 md:py-10', widths[width], className)}
      {...props}
    />
  )
}
```

- **Migrate** these routes to `<PageContainer>` (drop their `flex flex-col gap-6 p-4 md:p-8`):
  `src/routes/_authenticated/index.tsx`, `owners.tsx`, `account.tsx` (`width="prose"`),
  `admin/shares.index.tsx`, `admin/documents.bin.tsx`, `admin/shares.assign.$shareCode.tsx` (`width="prose"`).
- Document grid views that want full bleed use `width="full"`.
- Do **not** add `h-full` (would double-scroll inside `SidebarInset`).

## 3. Typography (self-hosted Cabinet Grotesk + Switzer)

Both faces self-hosted; **no `@fontsource` package** for either; **remove `@fontsource-variable/geist`.**

### Acquire + store
- `public/fonts/cabinet-grotesk/` — download the variable woff2 from Fontshare (mirror the Switzer step);
  keep the ITF Free Font License file. No conversion needed.
- `public/fonts/switzer/` — download the variable woff2 from Fontshare; keep the ITF Free Font License file.

### `src/styles/app.css`
- Remove the Geist `@import` (and drop `@fontsource-variable/geist` from `package.json`).
- Add `@font-face` blocks (`font-display: swap`):

```css
@font-face {
  font-family: 'Cabinet Grotesk';
  src: url('/fonts/cabinet-grotesk/CabinetGrotesk-Variable.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Switzer';
  src: url('/fonts/switzer/Switzer-Variable.woff2') format('woff2-variations');
  font-weight: 100 900; font-style: normal; font-display: swap;
}
```

- Update tokens:
  - `--font-sans: 'Switzer', system-ui, sans-serif;`
  - `--font-heading: 'Cabinet Grotesk', var(--font-sans);`
- Base layer — heading face + Linear-style body tuning:

```css
@layer base {
  html { @apply font-sans; letter-spacing: -0.011em; font-optical-sizing: auto; }
  h1, h2, h3 { @apply font-heading tracking-tight; }
}
```

- Tables: apply `font-variant-numeric: tabular-nums` (or `tabular-nums` utility) to numeric cells
  (sizes/dates/phone/share counts) in `OwnersTable`/`DocumentTable`.

### Type-scale rules
- Page `h1` titles: `font-bold` + `tracking-tight`; consider `text-balance`.
- Section/dialog titles that must be semibold/medium: keep them on `font-heading` — Cabinet Grotesk's variable
  axis covers 500/600, so no body-face fall-back is needed. `DialogTitle`/`SheetTitle`/`AlertDialogTitle`
  already use `font-heading`; all weights resolve correctly.
- **Check the longest Swedish titles** under `tracking-tight` for crowding/clipping.

## 4. `--brand` accent (one bold move)

- **`src/styles/app.css`** — add to `:root` and `.dark`, and register in `@theme inline`:

```css
:root  { --brand: oklch(0.56 0.18 256); --brand-foreground: oklch(0.985 0 0); }
.dark  { --brand: oklch(0.62 0.17 256); --brand-foreground: oklch(0.145 0 0); }
/* in @theme inline: */
--color-brand: var(--brand);
--color-brand-foreground: var(--brand-foreground);
```

- Add the wash utility:

```css
@layer components {
  .brand-wash {
    background-image: radial-gradient(120% 80% at 50% -20%,
      color-mix(in oklch, var(--brand) 14%, transparent), transparent 60%);
  }
}
```

- Apply `.brand-wash` only on the login wrapper (plan 02) and `Empty` surfaces (plan 05).
- **Optional `src/components/Logo.tsx`** (`LogoMark` inline SVG from `public/favicon.svg` + `Wordmark`):
  brand tile uses `bg-brand text-brand-foreground`. Used in the sidebar header (`AppSidebar.tsx`) and login.
  This component is shared with plan 02 — build it here or there, once.
- **Do not** touch `--primary`.

## 5. Dialog overlay motion

In **`src/components/ui/dialog.tsx`**, **`alert-dialog.tsx`**, **`sheet.tsx`**:
- Overlay: `duration-100` → `duration-200 ease-out`.
- Dialog/alert content: `duration-100` → `duration-200 ease-out`, add `data-open:slide-in-from-top-1` (rises
  after the scrim dims; keep `zoom-in-95`).
- Sheet: keep the 200 ms slide; align only its overlay timing.
- Add a global guard in `app.css` `@layer base`:

```css
@media (prefers-reduced-motion: reduce) {
  [data-slot$='-overlay'], [data-slot$='-content'] {
    animation-duration: 0.01ms !important; transition-duration: 0.01ms !important;
  }
}
```

## Critical files
- `src/components/AppSidebar.tsx`, `src/components/layout/PageContainer.tsx` (new),
  `src/components/Logo.tsx` (new, shared with 02), `src/styles/app.css`, `public/fonts/**` (new),
  `src/components/ui/{dialog,alert-dialog,sheet}.tsx`, the ~6 migrated routes, `package.json` (drop Geist).

## Verify
- Build succeeds; no missing-font warnings; Geist gone.
- Desktop: floating rounded panel, sidebar bg wraps, content centered. Mobile: drawer + full-bleed panel.
- Headings = Cabinet Grotesk, body = Switzer, table numerals aligned. Hierarchy reads bold→semibold.
- `.brand-wash` shows on login/empty; primary buttons neutral; brand-tile contrast ≥ 4.5:1 (light + dark).
- Overlays dim-then-rise ~200 ms; reduced-motion makes them instant.
- sv + en, light + dark, 375 / 768 / 1440px.
