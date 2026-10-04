# Sync sources panel ("Datakällor") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four identical "Senaste körningar – X" collapsibles at the bottom of `/charging` with one admin-only "Datakällor" panel: a status tile per integration (own icon + tone, state badge, last sync, own sync button, "Historik" opening the run table in a responsive overlay).

**Architecture:** Pure client/UI change — no schema, service or procedure changes; every health and runs query the panel needs is already fetched by the route. Source identity (icon, tone, role, cadence) lives in one exhaustive client-safe module; the tile and the run-history overlay are leaf components; the route owns the queries and the URL dialog state (ADR-0013, `?dialog=syncRuns&source=<source>`).

**Tech Stack:** React 19, TanStack Router/Query, shadcn (Radix) `Card`/`Badge`/`ResponsiveDialog`, lucide-react, Tailwind v4 (container queries), Paraglide, Vitest Browser Mode.

**Spec:** bounded design approved in chat on 2026-10-04 (no spec file). Visual reference: the mockup canvas https://claude.ai/artifact/PJhrex32gnUbMakVEVEag4 (desktop 4 columns, tablet 2, mobile 1; Historik = centred dialog on desktop, bottom sheet on mobile).

## Global Constraints

- Admin-only: the panel and the overlay render only for `user.role === 'admin'`; household members see nothing new.
- Health state comes from the server's `health.state` only — never re-derived client-side from timestamps.
- `not_configured` gets no sync button (a retry can't fix missing credentials), same as `SyncHealthAlert`.
- The Zaptec / elpris / Škoda health alerts at the top of the page stay unchanged; the Emaldo alert at the bottom is removed (its tile + overlay carry it).
- The heading "Synka nu" and the `VehicleLogCard` Škoda sync stay unchanged.
- Icons are semantic lucide icons, not company logos: Zaptec `EvChargerIcon`, elpris `ChartLineIcon`, Škoda `CarFrontIcon`, Emaldo `SunMediumIcon`.
- Per-source tones are dedicated `--source-*` tokens (light + dark), not `--chart-*` (the dark chart palette changes hue: chart-1 is orange in light, blue in dark).
- All user-facing copy in `messages/sv.json` (source of truth) + `messages/en.json`, keys match.
- Client code `import type` only from services; `~/lib/integrationHealth` is client-safe (value imports OK).
- Every screen responsive; no fixed pixel widths. Never `console.*`.

## Review Focus

1. **A source's health read failed or is still loading** (Škoda/Emaldo are `prefetchQuery`, so `health` can be `undefined`) → the tile still renders, with an "Okänd status" badge and its sync + Historik buttons, never a crash or a missing tile. Pinned in Task 2.
2. **A source's runs read failed** → the overlay shows the shared `LoadErrorAlert` with a retry, never "Inga körningar ännu" (ADR-0016). Pinned in Task 3.
3. **A bad deep link** (`?dialog=syncRuns` without `source`, an unknown `source`, or a non-admin) → the URL is cleaned with `replace`, nothing opens. Pinned in Task 4 (schema `.catch` + `dialogUnavailable`).
4. **A sync already running server-side** (`health.running`) or pending client-side → the button is disabled and reads "Synkar…", so it can't be double-fired. Pinned in Task 2.
5. **Four identical "Synka nu" buttons** → each has a source-specific accessible name that starts with its visible label ("Synka nu, Zaptec", WCAG 2.5.3), so a screen-reader user can tell them apart. Pinned in Task 2.

---

## File structure

| File | Responsibility |
|---|---|
| `src/styles/app.css` (modify) | `--source-{zaptec,elpris,skoda,emaldo}` tokens, light + dark, registered in `@theme inline` |
| `src/components/evCharging/SyncSourceMark.tsx` + `syncSourceCopy.ts` (create) | Source identity: `SyncSourceMark` (tinted icon square) / `syncSourceRole`, `syncSourceCadence` — exhaustive switches |
| `src/components/evCharging/SyncHealthAlert.tsx` (modify) | Export `syncHealthMessage(health)` (the existing per-state body copy), alert uses it |
| `src/components/evCharging/SyncNowButton.tsx` (modify) | Optional `aria-label` passthrough on `SyncNowButton` |
| `src/components/evCharging/SyncSourceTile.tsx` (create) | One tile + `SyncStateBadge` |
| `src/components/evCharging/RecentRunsTable.tsx` (create, from `RecentRunsCard.tsx`) | The run table / empty state only |
| `src/components/evCharging/SyncRunsDialog.tsx` (create) | Responsive overlay: mark + title + badge header, health message, runs table / load error |
| `src/components/evCharging/SyncSourcesPanel.tsx` (create) | Section heading + summary + tile grid + the one overlay |
| `src/components/evCharging/RecentRunsCard.tsx` (+ test) (delete) | Replaced |
| `src/routes/_authenticated/charging/index.tsx` (modify) | Search schema, query results, render the panel, drop cards + bottom Emaldo alert |
| `messages/{sv,en}.json` (modify) | New keys; drop `charging_runs_title`, `charging_runs_toggle` |
| `docs/adr/0015-visual-identity-and-design-language.md` (modify) | Amendment: categorical source tones are not accents |

---

### Task 1: Source identity (tokens, mark, role/cadence copy)

**Files:**
- Modify: `src/styles/app.css` (`@theme inline` block; `:root` after `--share-j`; `.dark` after `--share-j`)
- Create: `src/components/evCharging/SyncSourceMark.tsx` (component) + `src/components/evCharging/syncSourceCopy.ts` (role/cadence copy) — split after review: components are PascalCase
- Test: `src/components/evCharging/syncSource.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`
- Modify: `docs/adr/0015-visual-identity-and-design-language.md` (append an amendment)

**Interfaces:**
- Produces: `SyncSourceMark({ source, className? }: { source: IntegrationSource; className?: string })`, `syncSourceRole(source): string`, `syncSourceCadence(source): string`.

- [ ] **Step 1: Write the failing test** — `syncSource.browser.test.tsx`

```tsx
import { expect, test } from 'vitest'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceMark } from './SyncSourceMark'
import { syncSourceCadence, syncSourceRole } from './syncSourceCopy'

const ICON_CLASS = {
  zaptec: 'lucide-ev-charger',
  elpris: 'lucide-chart-line',
  skoda: 'lucide-car-front',
  emaldo: 'lucide-sun-medium',
} as const

test.each(INTEGRATION_SOURCES)('%s has its own decorative icon', async (source) => {
  const { container } = await renderWithProviders(<SyncSourceMark source={source} />)
  const icon = container.querySelector(`svg.${ICON_CLASS[source]}`)
  expect(icon).not.toBeNull()
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
})

test('every source has a distinct role', () => {
  const roles = INTEGRATION_SOURCES.map(syncSourceRole)
  expect(new Set(roles).size).toBe(INTEGRATION_SOURCES.length)
  expect(syncSourceRole('zaptec')).toBe(m.charging_source_role_zaptec())
})

test('every source has a cadence line', () => {
  for (const source of INTEGRATION_SOURCES) expect(syncSourceCadence(source)).not.toBe('')
  expect(syncSourceCadence('skoda')).toBe(m.charging_source_cadence_skoda())
})
```

- [ ] **Step 2: Run it to see it fail** — `bunx vitest run --project browser src/components/evCharging/syncSource.browser.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Add the copy** (sv first, then en; keep keys alphabetical within the file's existing order)

sv: `charging_source_role_zaptec` "Laddsessioner", `charging_source_role_elpris` "Spotpriser", `charging_source_role_skoda` "Bilens läge", `charging_source_role_emaldo` "Husets energi", `charging_source_cadence_zaptec` "Hämtas varje timme", `charging_source_cadence_elpris` "Hämtas två gånger om dagen", `charging_source_cadence_skoda` "Hämtas var 15:e minut", `charging_source_cadence_emaldo` "Hämtas varje timme".
en: "Charging sessions", "Spot prices", "Car state", "House energy", "Fetched hourly", "Fetched twice a day", "Fetched every 15 minutes", "Fetched hourly".

- [ ] **Step 4: Add the tokens** — `src/styles/app.css`

In `@theme inline` (after `--color-share-j`):
```css
    --color-source-zaptec: var(--source-zaptec);
    --color-source-elpris: var(--source-elpris);
    --color-source-skoda: var(--source-skoda);
    --color-source-emaldo: var(--source-emaldo);
```
In `:root` (after `--share-j`):
```css
  /* Integration source tones (Datakällor tiles): categorical identity, not
     accents — one hue per company, ink-dark enough for a 3:1 icon on its own
     12% wash. Keep the light/dark pairs in sync. */
  --source-zaptec: oklch(0.56 0.19 41);
  --source-elpris: oklch(0.5 0.1 185);
  --source-skoda: oklch(0.48 0.13 250);
  --source-emaldo: oklch(0.58 0.13 70);
```
In `.dark` (after `--share-j`):
```css
  --source-zaptec: oklch(0.75 0.15 45);
  --source-elpris: oklch(0.77 0.11 185);
  --source-skoda: oklch(0.75 0.12 250);
  --source-emaldo: oklch(0.83 0.14 85);
```

- [ ] **Step 5: Implement** — `SyncSourceMark.tsx` + `syncSourceCopy.ts` (final code: see the commits; token values amended after the colour-blindness review)

```tsx
import {
  CarFrontIcon,
  ChartLineIcon,
  EvChargerIcon,
  type LucideIcon,
  SunMediumIcon,
} from 'lucide-react'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

// Each integration's visual identity on the Datakällor panel: what the source
// gives us (an icon, not the company's logo) in its own tone. Exhaustive
// switches with no default — a new source is a compile error until it gets an
// icon, a tone and copy here. Tones are literal class strings so Tailwind sees them.
function identity(source: IntegrationSource): { Icon: LucideIcon; tone: string } {
  switch (source) {
    case 'zaptec':
      return { Icon: EvChargerIcon, tone: 'bg-source-zaptec/12 text-source-zaptec dark:bg-source-zaptec/20' }
    case 'elpris':
      return { Icon: ChartLineIcon, tone: 'bg-source-elpris/12 text-source-elpris dark:bg-source-elpris/20' }
    case 'skoda':
      return { Icon: CarFrontIcon, tone: 'bg-source-skoda/12 text-source-skoda dark:bg-source-skoda/20' }
    case 'emaldo':
      return { Icon: SunMediumIcon, tone: 'bg-source-emaldo/15 text-source-emaldo dark:bg-source-emaldo/20' }
  }
}

/** The source's tinted icon square. Decorative: the source name sits beside it. */
export function SyncSourceMark({
  source,
  className,
}: {
  source: IntegrationSource
  className?: string
}) {
  const { Icon, tone } = identity(source)
  return (
    <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tone, className)}>
      <Icon className="size-5" aria-hidden="true" />
    </div>
  )
}

/** What the source provides ("Laddsessioner"). */
export function syncSourceRole(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_role_zaptec()
    case 'elpris':
      return m.charging_source_role_elpris()
    case 'skoda':
      return m.charging_source_role_skoda()
    case 'emaldo':
      return m.charging_source_role_emaldo()
  }
}

/** How often the cron fetches it (vite.config.ts crons). */
export function syncSourceCadence(source: IntegrationSource): string {
  switch (source) {
    case 'zaptec':
      return m.charging_source_cadence_zaptec()
    case 'elpris':
      return m.charging_source_cadence_elpris()
    case 'skoda':
      return m.charging_source_cadence_skoda()
    case 'emaldo':
      return m.charging_source_cadence_emaldo()
  }
}
```

- [ ] **Step 6: ADR-0015 amendment** — append to the ADR's end:

```markdown
## Amendment (2026-10-04): categorical source tones

The Datakällor panel on `/charging` gives each integration (Zaptec, elpris, Škoda, Emaldo) its own
tone (`--source-*`, light + dark). Like the `--share-*` palette these are **categorical identity
colors, not accents**: they tint only a small icon square, never buttons, focus or surfaces, so
`--brand` stays the one accent. They are not `--chart-*`, whose dark palette changes hue.
```

- [ ] **Step 7: Run** `bun run i18n:compile && bunx vitest run --project browser src/components/evCharging/syncSource.browser.test.tsx` → PASS; `bun run typecheck` → clean.

- [ ] **Step 8: Commit** — `feat(charging): add per-source identity for the integrations`

---

### Task 2: Status tile

**Files:**
- Modify: `src/components/evCharging/SyncHealthAlert.tsx` (export `syncHealthMessage`)
- Modify: `src/components/evCharging/SyncNowButton.tsx` (`aria-label` prop)
- Create: `src/components/evCharging/SyncSourceTile.tsx`
- Test: `src/components/evCharging/SyncSourceTile.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: Task 1's `SyncSourceMark`, `syncSourceRole`, `syncSourceCadence`.
- Produces:
  - `syncHealthMessage(health: Health): string | null` — `null` for `ok`; never-synced / not-configured / stale / failing body copy otherwise (exactly what `SyncHealthAlert` shows today).
  - `SyncStateBadge({ health }: { health: Health | undefined })`
  - `SyncSourceTile({ source, health, onSync, syncing, onOpenHistory }: { source: IntegrationSource; health: Health | undefined; onSync: () => void; syncing: boolean; onOpenHistory: () => void })`
  - where `type Health = RouterOutputs['evCharging']['syncStatus']`.

- [ ] **Step 1: Copy** — sv / en:
`charging_source_state_unknown` "Okänd status" / "Status unknown";
`charging_source_never_synced` "Aldrig synkad" / "Never synced";
`charging_source_syncing` "Synkar…" / "Syncing…";
`charging_source_action_label` "{action}, {source}" (both locales; the accessible name starts with the visible label, WCAG 2.5.3);
`charging_source_history` "Historik" / "History";

- [ ] **Step 2: Write the failing test** — `SyncSourceTile.browser.test.tsx`

```tsx
import { expect, test, vi } from 'vitest'
import { integrationErrorMessage, integrationHealthTitle } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceTile } from './SyncSourceTile'

type Health = RouterOutputs['evCharging']['syncStatus']

const ok: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  lastAttemptAt: new Date('2026-10-04T08:00:00Z'),
  lastSuccessAt: new Date('2026-10-04T08:00:00Z'),
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
}

function tile(health: Health | undefined, extra: Partial<Parameters<typeof SyncSourceTile>[0]> = {}) {
  return (
    <SyncSourceTile
      source={health?.source ?? 'skoda'}
      health={health}
      onSync={() => {}}
      syncing={false}
      onOpenHistory={() => {}}
      {...extra}
    />
  )
}

test('an ok source shows its name, role, state and last sync', async () => {
  const { screen } = await renderWithProviders(tile(ok))
  await expect.element(screen.getByRole('heading', { name: 'Zaptec' })).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_role_zaptec())).toBeVisible()
  await expect.element(screen.getByText(integrationHealthTitle('ok'))).toBeVisible()
  await expect.element(screen.getByText(/^Senast synkad/)).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_sync_now(), source: 'Zaptec' }) }))
    .toHaveTextContent(m.charging_sync_now())
})

test('sync and history call their handlers', async () => {
  const onSync = vi.fn()
  const onOpenHistory = vi.fn()
  const { screen } = await renderWithProviders(tile(ok, { onSync, onOpenHistory }))
  await screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_sync_now(), source: 'Zaptec' }) }).click()
  await screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_source_history(), source: 'Zaptec' }) }).click()
  expect(onSync).toHaveBeenCalledOnce()
  expect(onOpenHistory).toHaveBeenCalledOnce()
})

test('a pending or server-side running sync disables the button', async () => {
  const { screen } = await renderWithProviders(
    <>
      {tile(ok, { syncing: true })}
      {tile({ ...ok, source: 'elpris', running: true })}
    </>,
  )
  const buttons = screen.getByRole('button', { name: /^Synka .* nu$/ })
  for (const button of buttons.elements()) {
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(m.charging_source_syncing())
  }
})

test('not configured has no sync button and says why', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'emaldo', state: 'not_configured', lastSuccessAt: null }),
  )
  await expect.element(screen.getByText(integrationHealthTitle('not_configured'))).toBeVisible()
  await expect
    .element(screen.getByText(integrationErrorMessage('not_configured', { source: 'emaldo' })))
    .toBeVisible()
  await expect.element(screen.getByText(m.charging_source_never_synced())).toBeVisible()
  expect(screen.getByRole('button', { name: /^Synka/ }).elements()).toHaveLength(0)
  await expect
    .element(screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_source_history(), source: 'Emaldo' }) }))
    .toBeVisible()
})

test('failing offers a retry and shows the error copy', async () => {
  const { screen } = await renderWithProviders(
    tile({ ...ok, source: 'skoda', state: 'failing', code: 'auth_failed', failingSince: new Date() }),
  )
  await expect.element(screen.getByText(integrationHealthTitle('failing'))).toBeVisible()
  await expect
    .element(screen.getByText(integrationErrorMessage('auth_failed', { source: 'skoda' })))
    .toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_sync_now(), source: 'Škoda' }) }))
    .toHaveTextContent(m.common_try_again())
})

test('stale shows its source-specific copy', async () => {
  const { screen } = await renderWithProviders(tile({ ...ok, source: 'elpris', state: 'stale' }))
  await expect.element(screen.getByText(m.charging_health_stale_elpris())).toBeVisible()
})

test('an unread health still renders a usable tile', async () => {
  const { screen } = await renderWithProviders(tile(undefined))
  await expect.element(screen.getByRole('heading', { name: 'Škoda' })).toBeVisible()
  await expect.element(screen.getByText(m.charging_source_state_unknown())).toBeVisible()
  await expect
    .element(screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_sync_now(), source: 'Škoda' }) }))
    .toBeEnabled()
})
```

- [ ] **Step 3: Run it to see it fail** — `bunx vitest run --project browser src/components/evCharging/SyncSourceTile.browser.test.tsx` → FAIL.

- [ ] **Step 4: `syncHealthMessage`** — in `SyncHealthAlert.tsx`, add and export:

```tsx
/** The state body the alert and the Datakällor tile share; null when there's nothing to say. */
export function syncHealthMessage(health: Health): string | null {
  switch (health.state) {
    case 'ok':
      return null
    case 'never_synced':
      return neverSyncedCopy(health.source)
    case 'not_configured':
      return integrationErrorMessage('not_configured', { source: health.source })
    case 'stale':
      return staleCopy(health.source)
    case 'failing':
      return integrationErrorMessage(health.code ?? 'internal_error', { source: health.source })
  }
}
```
and replace the four inline bodies in `SyncHealthAlert` with `syncHealthMessage(health)` (failing keeps its trailing `failingSince` sentence). `SyncHealthAlert.browser.test.tsx` must stay green unchanged.

- [ ] **Step 5: `SyncNowButton` aria-label** — add `'aria-label'?: string` to its props and pass it to `<Button aria-label={ariaLabel}>`.

- [ ] **Step 6: Implement** — `src/components/evCharging/SyncSourceTile.tsx`

```tsx
import { HistoryIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationHealthTitle, integrationSourceName } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatAgo } from './format'
import { syncHealthMessage } from './SyncHealthAlert'
import { SyncNowButton } from './SyncNowButton'
import { SyncSourceMark } from './SyncSourceMark'
import { syncSourceCadence, syncSourceRole } from './syncSourceCopy'

type Health = RouterOutputs['evCharging']['syncStatus']

// The state reads in text; the dot only reinforces it (never colour alone).
const DOT: Record<Health['state'], string> = {
  ok: 'bg-success',
  stale: 'bg-warning',
  failing: 'bg-destructive',
  not_configured: 'bg-muted-foreground',
  never_synced: 'bg-muted-foreground',
}

export function SyncStateBadge({ health }: { health: Health | undefined }) {
  const failing = health?.state === 'failing'
  return (
    <Badge variant={failing ? 'destructive' : 'outline'} className="gap-1.5">
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', health ? DOT[health.state] : 'bg-muted-foreground')}
      />
      {health ? integrationHealthTitle(health.state) : m.charging_source_state_unknown()}
    </Badge>
  )
}

// One integration on the Datakällor panel: who it is, whether it works, when
// it last synced, and its own sync + history. `health` is undefined while its
// read is pending or failed — the tile still renders (status unknown) so the
// admin can sync or open the history.
export function SyncSourceTile({
  source,
  health,
  onSync,
  syncing,
  onOpenHistory,
}: {
  source: IntegrationSource
  health: Health | undefined
  onSync: () => void
  syncing: boolean
  onOpenHistory: () => void
}) {
  const name = integrationSourceName(source)
  const headingId = `sync-source-${source}`
  const message = health ? syncHealthMessage(health) : null
  const pending = syncing || health?.running === true
  return (
    <Card aria-labelledby={headingId} role="group" className="min-w-0 gap-4 px-5 py-5">
      <div className="flex items-start gap-3">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col">
          <h3 id={headingId} className="break-words font-heading font-semibold text-base leading-snug">
            {name}
          </h3>
          <p className="text-muted-foreground text-xs">{syncSourceRole(source)}</p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SyncStateBadge health={health} />
        {/* Relative to `new Date()`: a benign SSR/hydration mismatch, as in ChargingHeading. */}
        <p className="text-muted-foreground text-xs tabular-nums" suppressHydrationWarning>
          {health?.lastSuccessAt
            ? m.charging_last_synced({ time: formatAgo(health.lastSuccessAt) })
            : health
              ? m.charging_source_never_synced()
              : null}
        </p>
        <p className="text-muted-foreground text-xs">{syncSourceCadence(source)}</p>
        {message ? (
          <p
            className={cn(
              'line-clamp-3 text-xs',
              health?.state === 'failing' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {message}
          </p>
        ) : null}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 [&>button]:max-sm:h-11 [&>button]:max-sm:flex-1">
        {/* Retrying can't fix missing credentials, so no sync while unconfigured. */}
        {health?.state !== 'not_configured' ? (
          <SyncNowButton
            onSync={onSync}
            pending={pending}
            aria-label={m.charging_source_action_label({ action: m.charging_sync_now(), source: name })}
            label={
              pending
                ? m.charging_source_syncing()
                : health?.state === 'failing'
                  ? m.common_try_again()
                  : m.charging_sync_now()
            }
          />
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenHistory}
          aria-label={m.charging_source_action_label({ action: m.charging_source_history(), source: name })}
        >
          <HistoryIcon />
          {m.charging_source_history()}
        </Button>
      </div>
    </Card>
  )
}
```
(If `Card` doesn't forward `role`/`aria-labelledby`, it does — it spreads `...props` onto its `div`.)

- [ ] **Step 7: Run** the tile test, `SyncHealthAlert.browser.test.tsx` and `SyncNowButton.browser.test.tsx` → PASS; `bun run typecheck`.

- [ ] **Step 8: Commit** — `feat(charging): add the integration status tile`

---

### Task 3: Run-history overlay

**Files:**
- Create: `src/components/evCharging/RecentRunsTable.tsx` (the `<Empty>` / `<Table>` body of `RecentRunsCard`, verbatim, as `RecentRunsTable({ runs }: { runs: Run[] })`)
- Create: `src/components/evCharging/SyncRunsDialog.tsx`
- Test: `src/components/evCharging/SyncRunsDialog.browser.test.tsx` (moves the two `RecentRunsCard` table assertions here)
- Delete: `src/components/evCharging/RecentRunsCard.tsx`, `RecentRunsCard.browser.test.tsx` — **only in Task 4**, when the route stops importing it (deleting here breaks the build).
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Consumes: Task 1 `SyncSourceMark`; Task 2 `SyncStateBadge`, `syncHealthMessage`; `LoadErrorAlert`, `loadFailed`, `LoadErrorQuery`.
- Produces:
  - `type Run = RouterOutputs['evCharging']['recentRuns'][number]` (exported from `RecentRunsTable.tsx`)
  - `type RunsQuery = LoadErrorQuery & { data: Run[] | undefined }` (exported from `SyncRunsDialog.tsx`)
  - `SyncRunsDialog({ source, health, runs, open, onOpenChange }: { source: IntegrationSource | undefined; health: Health | undefined; runs: RunsQuery | undefined; open: boolean; onOpenChange: (open: boolean) => void })`

- [ ] **Step 1: Copy** — sv / en:
`charging_source_dialog_title` "Synkhistorik – {source}" / "Sync history – {source}";
`charging_runs_error_title` "Kunde inte läsa körningarna" / "Couldn't load the runs".

- [ ] **Step 2: Write the failing test** — `SyncRunsDialog.browser.test.tsx`

```tsx
import { expect, test } from 'vitest'
import { integrationErrorMessage } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import type { Run } from './RecentRunsTable'
import { type RunsQuery, SyncRunsDialog } from './SyncRunsDialog'

type Health = RouterOutputs['evCharging']['syncStatus']

const okRun: Run = {
  id: 'r1',
  trigger: 'cron',
  startedAt: new Date('2026-09-28T08:00:00Z'), // 10:00 Stockholm (CEST)
  finishedAt: new Date('2026-09-28T08:00:01Z'),
  durationMs: 1250,
  outcome: 'ok',
  errorCode: null,
  errorMessage: null,
  upserted: 4,
  sessionsSeen: 9,
  pages: 1,
}
const failedRun: Run = { ...okRun, id: 'r2', trigger: 'admin', durationMs: 420, outcome: 'failed', errorCode: 'rate_limited', upserted: 0 }

const health: Health = {
  source: 'zaptec',
  state: 'ok',
  running: false,
  lastAttemptAt: new Date('2026-09-28T08:00:00Z'),
  lastSuccessAt: new Date('2026-09-28T08:00:00Z'),
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
}

const loaded = (data: Run[]): RunsQuery => ({
  data,
  isPlaceholderData: false,
  errorUpdateCount: 0,
  isFetching: false,
  refetch: () => {},
})

function dialog(props: Partial<Parameters<typeof SyncRunsDialog>[0]> = {}) {
  return (
    <div style={{ width: 1024 }}>
      <SyncRunsDialog source="zaptec" health={health} runs={loaded([okRun, failedRun])} open onOpenChange={() => {}} {...props} />
    </div>
  )
}

test('shows the source title and the run table', async () => {
  const { screen } = await renderWithProviders(dialog())
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_source_dialog_title({ source: 'Zaptec' }) }))
    .toBeVisible()
  await expect.element(screen.getByRole('table')).toBeVisible()
  await expect.element(screen.getByRole('cell', { name: /10:00/ }).first()).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_trigger_cron())).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_trigger_admin())).toBeVisible()
  await expect.element(screen.getByText(m.charging_runs_outcome_failed())).toBeVisible()
  await expect.element(screen.getByText('1,3 s')).toBeVisible()
  await expect.element(screen.getByText('420 ms')).toBeVisible()
  await expect.element(screen.getByRole('cell', { name: 'rate_limited' })).toBeVisible()
})

test('an empty history says so', async () => {
  const { screen } = await renderWithProviders(dialog({ runs: loaded([]) }))
  await expect.element(screen.getByText(m.charging_runs_empty())).toBeVisible()
})

test('a failed runs read is an error, never an empty history', async () => {
  const { screen } = await renderWithProviders(
    dialog({ runs: { ...loaded([]), data: undefined, errorUpdateCount: 1 } }),
  )
  await expect.element(screen.getByText(m.charging_runs_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_runs_empty()).elements()).toHaveLength(0)
})

test('a failing source explains itself with the admin detail', async () => {
  const { screen } = await renderWithProviders(
    dialog({
      health: {
        ...health,
        state: 'failing',
        code: 'auth_failed',
        failingSince: new Date('2026-09-28T06:00:00Z'),
        adminDetail: { lastErrorMessage: 'HTTP 401 from /oauth/token', credentialExpiry: null },
      },
    }),
  )
  await expect
    .element(screen.getByText(integrationErrorMessage('auth_failed', { source: 'zaptec' }), { exact: false }))
    .toBeVisible()
  await expect.element(screen.getByText('HTTP 401 from /oauth/token')).toBeVisible()
})
```

- [ ] **Step 3: Run it to see it fail.**

- [ ] **Step 4: Extract `RecentRunsTable.tsx`** — move `TRIGGER_LABEL`, `OUTCOME`, the `Run` type and the `runs.length === 0 ? <Empty …> : <Table …>` JSX out of `RecentRunsCard.tsx` unchanged, exported as `RecentRunsTable({ runs })` + `export type Run`. Make `RecentRunsCard` render `<RecentRunsTable runs={runs} />` inside its `CardContent` so it keeps compiling until Task 4 deletes it; its test stays green.

- [ ] **Step 5: Implement** — `src/components/evCharging/SyncRunsDialog.tsx`

```tsx
import { Skeleton } from '~/components/ui/skeleton'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import type { IntegrationSource } from '~/lib/integrationHealth'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import type { RouterOutputs } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { formatDateTime } from './format'
import { LoadErrorAlert, type LoadErrorQuery, loadFailed } from './LoadErrorAlert'
import { RecentRunsTable, type Run } from './RecentRunsTable'
import { syncHealthMessage } from './SyncHealthAlert'
import { SyncStateBadge } from './SyncSourceTile'
import { SyncSourceMark } from './SyncSourceMark'

type Health = RouterOutputs['evCharging']['syncStatus']
export type RunsQuery = LoadErrorQuery & { data: Run[] | undefined }

// One source's sync history (the last 20 runs) in the shared responsive
// overlay (ADR-0013): a dialog on desktop, a bottom sheet on mobile. A source
// that isn't ok says why above the table; the raw error is admin detail. A
// failed runs read is an error with a retry, never an empty history (ADR-0016).
export function SyncRunsDialog({
  source,
  health,
  runs,
  open,
  onOpenChange,
}: {
  source: IntegrationSource | undefined
  health: Health | undefined
  runs: RunsQuery | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ResponsiveDialog open={open && source !== undefined} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        {source ? <Body source={source} health={health} runs={runs} /> : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function Body({
  source,
  health,
  runs,
}: {
  source: IntegrationSource
  health: Health | undefined
  runs: RunsQuery | undefined
}) {
  const name = integrationSourceName(source)
  const message = health ? syncHealthMessage(health) : null
  const failing = health?.state === 'failing'
  const detail = health?.adminDetail?.lastErrorMessage
  return (
    <>
      <ResponsiveDialogHeader className="flex-row items-start gap-3 text-left">
        <SyncSourceMark source={source} />
        <div className="flex min-w-0 flex-col gap-1">
          <ResponsiveDialogTitle>{m.charging_source_dialog_title({ source: name })}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{m.charging_runs_description({ source: name })}</ResponsiveDialogDescription>
          <div className="pt-1">
            <SyncStateBadge health={health} />
          </div>
        </div>
      </ResponsiveDialogHeader>
      {message ? (
        <div
          className={cn(
            'flex flex-col gap-1.5 rounded-lg border px-3.5 py-3 text-sm',
            failing ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-muted/40',
          )}
        >
          <p>
            {message}
            {failing && health?.failingSince ? (
              <> {m.charging_health_failing_since({ time: formatDateTime(health.failingSince) })}</>
            ) : null}
          </p>
          {detail ? (
            <p className="text-muted-foreground">
              {m.charging_health_admin_detail()}{' '}
              <code className="break-all font-mono text-xs">{detail}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {runs && loadFailed(runs) ? (
        <LoadErrorAlert title={m.charging_runs_error_title()} query={runs} />
      ) : runs?.data ? (
        <RecentRunsTable runs={runs.data} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
    </>
  )
}
```
Check `ResponsiveDialogHeader`'s default classes before overriding (`flex-row … text-left`); keep the title/description semantics.

- [ ] **Step 6: Run** the dialog test + `RecentRunsCard.browser.test.tsx` → PASS; typecheck.

- [ ] **Step 7: Commit** — `feat(charging): show a source's sync runs in a responsive overlay`

---

### Task 4: The panel and the route

**Files:**
- Create: `src/components/evCharging/SyncSourcesPanel.tsx`
- Test: `src/components/evCharging/SyncSourcesPanel.browser.test.tsx`
- Modify: `src/routes/_authenticated/charging/index.tsx`
- Delete: `src/components/evCharging/RecentRunsCard.tsx`, `src/components/evCharging/RecentRunsCard.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (add panel keys; remove `charging_runs_title`, `charging_runs_toggle` after confirming with `grep -rn "charging_runs_title\|charging_runs_toggle" src` that nothing else uses them)

**Interfaces:**
- Consumes: Task 2 `SyncSourceTile`; Task 3 `SyncRunsDialog`, `RunsQuery`; `useSyncNow().syncSource` / `isPendingFor`.
- Produces: `SyncSourcesPanel({ entries, onSync, isPendingFor, openSource, onOpenHistory, onCloseHistory }: { entries: SourceEntry[]; onSync: (source: IntegrationSource) => void; isPendingFor: (source: IntegrationSource) => boolean; openSource: IntegrationSource | undefined; onOpenHistory: (source: IntegrationSource) => void; onCloseHistory: () => void })`, with `export type SourceEntry = { source: IntegrationSource; health: Health | undefined; runs: RunsQuery | undefined }`.

- [ ] **Step 1: Copy** — sv / en:
`charging_sources_heading` "Datakällor" / "Data sources";
`charging_sources_description` "Tjänsterna som sidans data hämtas från. Bara admins ser den här delen." / "The services this page's data comes from. Only admins see this section.";
`charging_sources_summary` "{ok} av {total} fungerar" / "{ok} of {total} working".

- [ ] **Step 2: Write the failing test** — `SyncSourcesPanel.browser.test.tsx`

```tsx
import { expect, test, vi } from 'vitest'
import type { IntegrationSource } from '~/lib/integrationHealth'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { type SourceEntry, SyncSourcesPanel } from './SyncSourcesPanel'

type Health = RouterOutputs['evCharging']['syncStatus']

const health = (source: IntegrationSource, state: Health['state']): Health => ({
  source,
  state,
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  failingSince: null,
  consecutiveFailures: 0,
  code: null,
  adminDetail: null,
})
const runs = { data: [], isPlaceholderData: false, errorUpdateCount: 0, isFetching: false, refetch: () => {} }

const entries: SourceEntry[] = [
  { source: 'zaptec', health: health('zaptec', 'ok'), runs },
  { source: 'elpris', health: health('elpris', 'ok'), runs },
  { source: 'skoda', health: health('skoda', 'stale'), runs },
  { source: 'emaldo', health: undefined, runs: undefined },
]

function panel(props: Partial<Parameters<typeof SyncSourcesPanel>[0]> = {}) {
  return (
    <SyncSourcesPanel
      entries={entries}
      onSync={() => {}}
      isPendingFor={() => false}
      openSource={undefined}
      onOpenHistory={() => {}}
      onCloseHistory={() => {}}
      {...props}
    />
  )
}

test('one tile per source under a labelled section with a summary', async () => {
  const { screen } = await renderWithProviders(panel())
  await expect.element(screen.getByRole('heading', { name: m.charging_sources_heading() })).toBeVisible()
  await expect.element(screen.getByText(m.charging_sources_summary({ ok: 2, total: 4 }))).toBeVisible()
  for (const name of ['Zaptec', 'elprisetjustnu.se', 'Škoda', 'Emaldo']) {
    await expect.element(screen.getByRole('heading', { name, level: 3 })).toBeVisible()
  }
})

test('a tile routes sync and history to its own source', async () => {
  const onSync = vi.fn()
  const onOpenHistory = vi.fn()
  const { screen } = await renderWithProviders(panel({ onSync, onOpenHistory }))
  await screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_sync_now(), source: 'Škoda' }) }).click()
  await screen.getByRole('button', { name: m.charging_source_action_label({ action: m.charging_source_history(), source: 'elprisetjustnu.se' }) }).click()
  expect(onSync).toHaveBeenCalledWith('skoda')
  expect(onOpenHistory).toHaveBeenCalledWith('elpris')
})

test('the open source shows its history overlay', async () => {
  const { screen } = await renderWithProviders(panel({ openSource: 'skoda' }))
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_source_dialog_title({ source: 'Škoda' }) }))
    .toBeVisible()
})
```

- [ ] **Step 3: Run it to see it fail.**

- [ ] **Step 4: Implement** — `src/components/evCharging/SyncSourcesPanel.tsx`

```tsx
import type { IntegrationSource } from '~/lib/integrationHealth'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { type RunsQuery, SyncRunsDialog } from './SyncRunsDialog'
import { SyncSourceTile } from './SyncSourceTile'

type Health = RouterOutputs['evCharging']['syncStatus']
export type SourceEntry = { source: IntegrationSource; health: Health | undefined; runs: RunsQuery | undefined }

// Admin-only "Datakällor": every integration the page reads, at a glance, with
// its own sync and history. Failures still interrupt at the top of the page
// (SyncHealthAlert); this is the calm overview + diagnostics. One overlay for
// the history, driven by the route's URL dialog state (ADR-0013).
export function SyncSourcesPanel({
  entries,
  onSync,
  isPendingFor,
  openSource,
  onOpenHistory,
  onCloseHistory,
}: {
  entries: SourceEntry[]
  onSync: (source: IntegrationSource) => void
  isPendingFor: (source: IntegrationSource) => boolean
  openSource: IntegrationSource | undefined
  onOpenHistory: (source: IntegrationSource) => void
  onCloseHistory: () => void
}) {
  const ok = entries.filter((e) => e.health?.state === 'ok').length
  const open = entries.find((e) => e.source === openSource)
  return (
    <section aria-labelledby="sync-sources-heading" className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="sync-sources-heading" className="font-medium text-sm">
            {m.charging_sources_heading()}
          </h2>
          <p className="text-muted-foreground text-xs">{m.charging_sources_description()}</p>
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          {m.charging_sources_summary({ ok, total: entries.length })}
        </p>
      </div>
      <div className="grid @3xl:grid-cols-4 @md:grid-cols-2 grid-cols-1 gap-4">
        {entries.map((e) => (
          <SyncSourceTile
            key={e.source}
            source={e.source}
            health={e.health}
            onSync={() => onSync(e.source)}
            syncing={isPendingFor(e.source)}
            onOpenHistory={() => onOpenHistory(e.source)}
          />
        ))}
      </div>
      <SyncRunsDialog
        source={open?.source}
        health={open?.health}
        runs={open?.runs}
        open={open !== undefined}
        onOpenChange={(o) => {
          if (!o) onCloseHistory()
        }}
      />
    </section>
  )
}
```
`@3xl` (48rem) needs four tiles of ≥ ~180px; if the live check (Phase 6) shows cramped tiles at 1280px with the sidebar open, move to `@4xl`/`@5xl`.

- [ ] **Step 5: Wire the route** — `src/routes/_authenticated/charging/index.tsx`
  1. Import `INTEGRATION_SOURCES, type IntegrationSource` from `~/lib/integrationHealth` and `SyncSourcesPanel` from the panel; drop the `RecentRunsCard` import.
  2. Search schema: `dialog` enum gains `'syncRuns'`; add `source: z.enum(INTEGRATION_SOURCES).optional().catch(undefined)` (comment: "the Datakällor overlay's source").
  3. `useUrlDialog` `clearKeys: ['tariffId', 'source']`.
  4. Read `const runsSource = Route.useSearch({ select: (s) => s.source })`.
  5. `dialogUnavailable`: also true for `dialog === 'syncRuns' && runsSource === undefined`. Rewrite as
     ```ts
     const dialogUnavailable =
       dialog !== undefined &&
       (!isAdmin ||
         (dialog === 'syncRuns'
           ? runsSource === undefined
           : dialog !== 'tariffNew' && dialog !== 'vehicleImport' && !selectedTariff))
     ```
     and the cleanup `navigate` also clears `source: undefined`.
  6. Keep the whole query results: `const zaptecRuns = useQuery({...recentRuns zaptec, enabled: isAdmin})`, `const pricesRuns = useQuery(...)`, `skodaRuns`, `emaldoRuns` (drop the `{ data: … }` destructuring for those four).
  7. Replace the four `RecentRunsCard`s **and** the bottom Emaldo `SyncHealthAlert` with:
     ```tsx
     {isAdmin ? (
       <SyncSourcesPanel
         entries={[
           { source: 'zaptec', health, runs: zaptecRuns },
           { source: 'elpris', health: pricesHealth, runs: pricesRuns },
           { source: 'skoda', health: skodaHealth, runs: skodaRuns },
           { source: 'emaldo', health: emaldoHealth, runs: emaldoRuns },
         ]}
         onSync={syncNow.syncSource}
         isPendingFor={syncNow.isPendingFor}
         openSource={isOpen('syncRuns') ? runsSource : undefined}
         onOpenHistory={(source: IntegrationSource) => open('syncRuns', { source })}
         onCloseHistory={close}
       />
     ) : null}
     ```
     (`useSyncNow`'s `SyncSource` union equals `IntegrationSource`; if TS disagrees, type `syncSource`'s param as `IntegrationSource` in `SyncNowButton.tsx`.)
  8. `emaldoHealth`'s query stays (the tile reads it).
  10. (From the Task 2 UI review) the tiles are a list: the grid is `<ul role="list">` (explicit role — Safari drops list semantics under `list-style: none`) with an `<li>` per tile, giving "list, 4 items"; the tile itself has no group role (its `h3` names it).
  9. (From the Task 2 review) the elpris / Škoda / Emaldo health queries get a `refetchInterval` like Zaptec's, faster while a run is in flight, so a `running: true` snapshot (a cron run seen mid-flight) can't keep a tile's sync button disabled until the next focus: `refetchInterval: (q) => (q.state.data?.running ? 5_000 : 60_000)`. These are admin-only reads (ADR-0018 polling, no held connections).

- [ ] **Step 6: Delete** `RecentRunsCard.tsx` + its test; remove the unused message keys (sv + en).

- [ ] **Step 7: Run** `bun run i18n:compile && bun run typecheck && bunx vitest run --project browser src/components/evCharging src/routes/_authenticated/charging` → PASS; sv/en key check from the pre-PR gate.

- [ ] **Step 8: Commit** — `feat(charging): show sync sources as a status panel`

---

## After the tasks

- Phase 5 branch review: `code-reviewer` + a UI reviewer (`web-design-guidelines` + `vercel-react-best-practices`) over the whole diff; no schema/service changes, so no `migration-guard` / `test-completeness` gate.
- Phase 6: full pre-PR gate (`docs/feature-workflow.md#pre-pr-gate`) + drive `/charging` as an admin in a real browser at 1280 / 820 / 390, light and dark: tiles, badge per state, sync spinner, Historik dialog vs. bottom sheet, deep link `?dialog=syncRuns&source=skoda`, bad deep link cleaned.
- Phase 7: one PR, `feat(charging): show sync sources as a status panel`.
