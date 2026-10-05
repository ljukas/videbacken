# Charging settings, step 1 — move to `/charging/settings` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the tariff card and the Datakällor panel off the charging overview onto a new admin-only page,
`/charging/settings`, with links to it from the overview's alerts, the cost notice, the sidebar, Cmd+K and the
admin emails. Nothing about credentials yet.

**Architecture:** A new TanStack file route, `src/routes/_authenticated/charging/settings.tsx`, a sibling of the
overview's `index.tsx`. It takes over the overview's dialog URL state (`dialog` / `tariffId` / `source`), its
queries and its JSX for the two blocks, and gates non-admins in `beforeLoad`. The overview keeps everything its
alerts and cost display read. A small shared `SettingsLink` component gives the alerts and the notice a consistent
"go there" button.

**Tech Stack:** TanStack Start / Router (file routes, `beforeLoad` redirect), TanStack Query, oRPC query options,
Paraglide messages, shadcn `Button` + `Alert`, React Email, Vitest browser mode.

**Spec:** [`docs/superpowers/specs/2026-10-05-charging-settings-design.md`](../specs/2026-10-05-charging-settings-design.md)
(section "Step 1"). [ADR-0024](../../adr/0024-integration-credential-store.md) covers steps 2 and 3, not this
step. Roadmap: [`docs/superpowers/roadmaps/2026-10-05-charging-settings.md`](../roadmaps/2026-10-05-charging-settings.md).

**Worktree:** `.claude/worktrees/charging-settings`, branch `feat/charging-settings`, based on `origin/main` @
`e85c25a`. Its first commit (`d0a5e5f`) holds the spec, ADR and roadmap.

## Global Constraints

- **The page is admin-only.** A non-admin is redirected to `/charging` in `beforeLoad` and never sees the page.
- **Route URL paths stay English** (`/charging/settings`). User-facing text goes through Paraglide: `messages/sv.json`
  is the source of truth, and `messages/en.json` must be key-complete.
- **Every screen is responsive**, at desktop, tablet and mobile widths.
- **Dialogs use URL state** (ADR-0013): `?dialog=…` plus entity keys, cleared on close and when unavailable (with
  `replace`).
- **Client code may only `import type` from services** (no change expected here).
- **Never `console.*`.** Biome formats; `bun run check:ci` must pass.
- **Commits are Conventional Commits** (`<type>(<scope>): <subject>`, ≤ 72 chars, imperative), one task per commit,
  ending with the `Co-Authored-By` line from the session.
- **Don't run vitest while a reviewer does.** Two vitest processes clash on the shared local DB (memory:
  concurrent-vitest-shared-db). Reviewers are read-only and don't run tests.
- **`src/routeTree.gen.ts` is generated.** Regenerate it with `bun run build`; never edit it by hand.

## Review Focus

1. **A member opening `/charging/settings` directly** (typed URL, old link, palette history): redirected to
   `/charging`, with no admin UI flash and no admin queries fired. Pinned in Task 1.
2. **An old bookmark `/charging?dialog=tariffNew` or `?dialog=syncRuns&source=skoda`**: the overview loads
   normally, with no dialog and no error. Pinned in Task 3.
3. **The sidebar's "Inställningar" link, clicked from `/charging?year=2025&vehicle=other`**: lands on a clean
   `/charging/settings` with no `year`/`vehicle`. Pinned in Task 4.
4. **A stale deep link `/charging/settings?dialog=tariffEdit&tariffId=<deleted id>`**: cleaned from the URL, no
   dialog. Pinned in Task 1.
5. **The cost notice's "Lägg in avgifter" on the overview**: lands on the settings page with the new-period dialog
   open. Pinned in Task 2 (the href) and Task 1 (the deep link opens the dialog).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/routes/_authenticated/charging/settings.tsx` | create | Admin gate, dialog URL state, loader prefetches, page: heading, Datakällor, tariff card, dialogs |
| `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx` | create | Route tests for the settings page |
| `src/components/evCharging/SettingsLink.tsx` | create | "Gå till inställningar" button-link, optionally with search |
| `src/components/evCharging/SyncHealthAlert.tsx` | modify | Optional `settingsLink` for admins |
| `src/components/evCharging/CredentialExpiryAlert.tsx` | modify | Optional `settingsLink` |
| `src/components/evCharging/CostNotice.tsx` | modify | `onAddTariff` callback → `canAddTariff` link to `?dialog=tariffNew` |
| `src/components/evCharging/SyncSourcesPanel.tsx` | none | Only its description string changes, in messages |
| `src/routes/_authenticated/charging/index.tsx` | modify | Drop the moved blocks, params and queries; pass `settingsLink` |
| `src/routes/_authenticated/charging/{economy,patterns}.tsx` | modify | Pass `settingsLink={isAdmin}` to their alerts |
| `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` | modify | Remove the moved tests, fix the order test, add the old-bookmark test |
| `src/components/AppSidebar.tsx` (+ test) | modify | `role` prop, admin-only "Inställningar" sub-item with a clean search |
| `src/routes/_authenticated.tsx` | modify | Pass `role` to `AppSidebar` |
| `src/components/command/commands.ts` | modify | Admin-only `/charging/settings` command |
| `src/emails/{IntegrationSyncAlert,CredentialExpiry,GridTariffAvailable}Email.tsx` (+ tests) | modify | Link to `/charging/settings` |
| `messages/sv.json`, `messages/en.json` | modify | New keys + changed copy |
| `CLAUDE.md`, the roadmap | modify | Code map line, roadmap row |

---

### Task 1: The settings page

**Files:**
- Create: `src/routes/_authenticated/charging/settings.tsx`
- Create: `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`
- Regenerated: `src/routeTree.gen.ts`

**Interfaces:**
- Consumes the existing components `SyncSourcesPanel`, `SkodaSourceDetails`, `VehicleLogImportButton`, `TariffCard`,
  `TariffDialog`, `DeleteTariffDialog`, `VehicleImportDialog`, `SyncNowButton`, `useSyncNow`, `healthPoll`,
  `useUrlDialog`, all with unchanged props (see their current use in `charging/index.tsx:336-574`).
- Produces the route `/charging/settings`, with search `{ dialog?: 'tariffNew'|'tariffEdit'|'tariffDelete'|'vehicleImport'|'syncRuns', tariffId?: string, source?: IntegrationSource }`.
  Tasks 2–4 link to it.

- [ ] **Step 1: Check main still matches the plan**

Run:
```bash
cd /Users/lukas/prog/videbacken/.claude/worktrees/charging-settings
git log --oneline -1 origin/main
grep -n "SyncSourcesPanel\|TariffCard\|'tariffNew'" src/routes/_authenticated/charging/index.tsx
test ! -e src/routes/_authenticated/charging/settings.tsx && echo "no settings route yet"
```
Expected: the overview still renders both blocks and the `dialog` enum, and `settings.tsx` does not exist. If
`origin/main` moved past `e85c25a`, rebase first (`git rebase origin/main`) and re-read `index.tsx` before
continuing.

- [ ] **Step 2: Add the messages**

Add these keys to `messages/sv.json` (Swedish) and `messages/en.json` (English). The exact position doesn't
matter; Biome sorts nothing in JSON, so append before the closing brace.

| Key | sv | en |
|---|---|---|
| `meta_charging_settings_title` | `Laddningsinställningar` | `Charging settings` |
| `meta_charging_settings_description` | `Datakällor, synkning och avgifter för laddningen.` | `Data sources, syncing and fees for charging.` |
| `charging_settings_title` | `Inställningar` | `Settings` |
| `charging_settings_description` | `Datakällorna och avgifterna bakom laddningssidorna. Bara admins ser den här sidan.` | `The data sources and fees behind the charging pages. Only admins see this page.` |
| `charging_settings_link` | `Gå till inställningar` | `Go to settings` |

Change the existing `charging_sources_description` (the page is now admin-only, so the "only admins" sentence goes):
- sv: `Tjänsterna som laddningssidorna hämtar data från.`
- en: `The services the charging pages get their data from.`

Run: `bun run i18n:compile`
Expected: compiles, and `m.charging_settings_title` exists in `src/paraglide/messages`.

- [ ] **Step 3: Write the failing route tests**

Create `src/routes/_authenticated/charging/-settingsPage.browser.test.tsx`:

```tsx
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Settings } from './settings'

// The real settings page mounted under a bare root (routeTree.gen.ts isn't
// loaded), next to a stub overview the admin gate redirects to. The cache is
// seeded through the oRPC-generated keys; anything unseeded fails (the test
// server has no /api/rpc), which is how a failed read is staged. The `-` prefix
// keeps this file out of the route tree.

afterEach(() => {
  vi.restoreAllMocks()
})

const health = (source: string) =>
  ({ source, state: 'ok', lastSuccessAt: null, lastError: null }) as never

const TARIFF = {
  id: '00000000-0000-4000-8000-0000000000aa',
  validFrom: '2026-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}

function seed(qc: QueryClient, opts: { coverage?: boolean } = {}) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [TARIFF] as never)
  qc.setQueryData(orpc.evCharging.syncStatus.queryOptions().queryKey, health('zaptec'))
  for (const source of ['elpris', 'skoda', 'emaldo'] as const) {
    qc.setQueryData(
      orpc.evCharging.syncStatus.queryOptions({ input: { source } }).queryKey,
      health(source),
    )
    qc.setQueryData(
      orpc.evCharging.recentRuns.queryOptions({ input: { source, limit: 20 } }).queryKey,
      [],
    )
  }
  qc.setQueryData(orpc.evCharging.recentRuns.queryOptions({ input: { limit: 20 } }).queryKey, [])
  qc.setQueryData(orpc.evCharging.vehicleStateLatest.queryOptions().queryKey, null)
  if (opts.coverage !== false)
    qc.setQueryData(orpc.evCharging.vehicleRecordCoverage.queryOptions().queryKey, null)
}

async function renderSettings(
  search: string,
  opts: { role?: 'admin' | 'user'; coverage?: boolean } = {},
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  seed(qc, opts)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  const overviewStub = createRoute({
    getParentRoute: () => root,
    path: '/charging',
    component: () => <p>overview stub</p>,
  })
  ;(Settings as unknown as { update: (o: unknown) => void }).update({
    id: '/charging/settings',
    path: '/charging/settings',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([overviewStub, Settings as never]),
    context: { queryClient: qc, user: { role: opts.role ?? 'admin' } },
    history: createMemoryHistory({ initialEntries: [`/charging/settings${search}`] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

const sourcesHeading = { name: m.charging_sources_heading(), level: 2 } as const
const historyTitle = (source: string) => m.charging_source_dialog_title({ source })

test('an admin gets the heading, the Datakällor panel and the tariff card, in that order', async () => {
  const { screen } = await renderSettings('')
  await expect
    .element(screen.getByRole('heading', { name: m.charging_settings_title(), level: 1 }))
    .toBeVisible()
  const sources = screen.getByRole('heading', sourcesHeading)
  await expect.element(sources).toBeVisible()
  const tariff = screen.getByRole('heading', { name: m.charging_tariff_title() })
  await expect.element(tariff).toBeVisible()
  expect(
    sources.element().compareDocumentPosition(tariff.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0)
  // The heading's sync-all button.
  await expect
    .element(screen.getByRole('button', { name: m.charging_sync_now(), exact: true }))
    .toBeVisible()
})

test('a household member is redirected to the overview, with no settings UI', async () => {
  const { screen, router } = await renderSettings('', { role: 'user' })
  await expect.element(screen.getByText('overview stub')).toBeVisible()
  expect(router.state.location.pathname).toBe('/charging')
  expect(screen.getByRole('heading', sourcesHeading).elements()).toHaveLength(0)
})

test('the Škoda tile shows the car log, and ?dialog=vehicleImport opens the import', async () => {
  const { screen } = await renderSettings('?dialog=vehicleImport')
  await expect.element(screen.getByText(m.charging_vehicle_log_none())).toBeVisible()
  await expect.element(screen.getByText(m.charging_vehicle_import_title())).toBeVisible()
})

test('a failed coverage read shows an error on the Škoda tile, not "no log imported"', async () => {
  const { screen } = await renderSettings('', { coverage: false })
  await expect.element(screen.getByText(m.charging_vehicle_log_error_title())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_log_none()).elements()).toHaveLength(0)
})

test('Historik opens that source in the URL, and closing clears it', async () => {
  const { screen, router } = await renderSettings('')
  await screen
    .getByRole('button', {
      name: m.charging_source_action_label({
        action: m.charging_source_history(),
        source: 'elprisetjustnu.se',
      }),
    })
    .click()
  await expect
    .element(screen.getByRole('dialog', { name: historyTitle('elprisetjustnu.se') }))
    .toBeVisible()
  expect(router.state.location.search).toMatchObject({ dialog: 'syncRuns', source: 'elpris' })
  await screen.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
})

test('a deep link opens that source’s history', async () => {
  const { screen } = await renderSettings('?dialog=syncRuns&source=skoda')
  await expect.element(screen.getByRole('dialog', { name: historyTitle('Škoda') })).toBeVisible()
})

test('?dialog=tariffNew opens the new-period dialog', async () => {
  const { screen } = await renderSettings('?dialog=tariffNew')
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_tariff_dialog_new_title() }))
    .toBeVisible()
})

test('?dialog=tariffEdit with an existing tariff opens the edit dialog', async () => {
  const { screen } = await renderSettings(`?dialog=tariffEdit&tariffId=${TARIFF.id}`)
  await expect
    .element(screen.getByRole('dialog', { name: m.charging_tariff_dialog_edit_title() }))
    .toBeVisible()
})

test.each([
  ['a history link with no source', '?dialog=syncRuns'],
  ['a history link with an unknown source', '?dialog=syncRuns&source=tesla'],
  ['an edit link for a tariff that no longer exists', '?dialog=tariffEdit&tariffId=gone'],
  ['a delete link for a tariff that no longer exists', '?dialog=tariffDelete&tariffId=gone'],
])('%s is cleaned from the URL', async (_case, search) => {
  const { screen, router } = await renderSettings(search)
  await expect.poll(() => router.state.location.search).not.toHaveProperty('dialog')
  expect(router.state.location.search).not.toHaveProperty('source')
  expect(router.state.location.search).not.toHaveProperty('tariffId')
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})
```

Before relying on the `TARIFF` shape, check it against the `TARIFF_ROW` in
`-vehicleScopePages.browser.test.tsx` (around line 456) and copy any extra fields that row has.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-settingsPage.browser.test.tsx`
Expected: FAIL. The import of `./settings` can't be resolved.

- [ ] **Step 5: Create the route**

Create `src/routes/_authenticated/charging/settings.tsx`:

```tsx
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { DeleteTariffDialog } from '~/components/evCharging/DeleteTariffDialog'
import { healthPoll } from '~/components/evCharging/healthPoll'
import {
  SkodaSourceDetails,
  VehicleLogImportButton,
} from '~/components/evCharging/SkodaSourceDetails'
import { SyncNowButton, useSyncNow } from '~/components/evCharging/SyncNowButton'
import { SyncSourcesPanel } from '~/components/evCharging/SyncSourcesPanel'
import { TariffCard } from '~/components/evCharging/TariffCard'
import { TariffDialog } from '~/components/evCharging/TariffDialog'
import { VehicleImportDialog } from '~/components/evCharging/VehicleImportDialog'
import { PageContainer } from '~/components/layout/PageContainer'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

// The charging section's admin page: every data source's state, sync and
// history (Datakällor), the car's log import, and the tariff periods the cost
// is priced with. Moved off the overview, which keeps only the alerts.
const searchSchema = z.object({
  // Dialogs (ADR-0013): tariff new (pre-filled from the newest period), edit,
  // delete; the car's log import; one data source's sync history.
  dialog: z
    .enum(['tariffNew', 'tariffEdit', 'tariffDelete', 'vehicleImport', 'syncRuns'])
    .optional()
    .catch(undefined),
  tariffId: z.string().optional().catch(undefined),
  // The data source whose sync history is open (`dialog=syncRuns`).
  source: z.enum(INTEGRATION_SOURCES).optional().catch(undefined),
})
type SettingsSearch = z.infer<typeof searchSchema>
type SettingsDialog = NonNullable<SettingsSearch['dialog']>

const RECENT_RUNS = 20

// Zaptec's keep their input-less calls, so they share the overview's cache
// entries; every other source passes its own.
const healthQueries = {
  zaptec: orpc.evCharging.syncStatus.queryOptions(),
  elpris: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'elpris' } }),
  skoda: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } }),
  emaldo: orpc.evCharging.syncStatus.queryOptions({ input: { source: 'emaldo' } }),
} satisfies Record<IntegrationSource, unknown>
const runsQueries = {
  zaptec: orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
  elpris: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'elpris', limit: RECENT_RUNS },
  }),
  skoda: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'skoda', limit: RECENT_RUNS },
  }),
  emaldo: orpc.evCharging.recentRuns.queryOptions({
    input: { source: 'emaldo', limit: RECENT_RUNS },
  }),
} satisfies Record<IntegrationSource, unknown>
const vehicleCoverageQuery = orpc.evCharging.vehicleRecordCoverage.queryOptions()
const vehicleLatestQuery = orpc.evCharging.vehicleStateLatest.queryOptions()

export const Route = createFileRoute('/_authenticated/charging/settings')({
  head: () => ({
    meta: seo({
      title: m.meta_charging_settings_title(),
      description: m.meta_charging_settings_description(),
    }),
  }),
  // Admins only: a member lands on the overview instead (before the loader, so
  // no admin read is ever fired for them).
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/charging', replace: true })
  },
  validateSearch: searchSchema,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      // The tariff card reads the list with suspense.
      queryClient.ensureQueryData(orpc.tariff.list.queryOptions()),
      // Everything else is prefetched, not ensured: a failed read shows on its
      // tile (or in its history overlay, with a retry) and never takes the page down.
      ...Object.values(healthQueries).map((q) => queryClient.prefetchQuery(q)),
      ...Object.values(runsQueries).map((q) => queryClient.prefetchQuery(q)),
      queryClient.prefetchQuery(vehicleCoverageQuery),
      queryClient.prefetchQuery(vehicleLatestQuery),
    ])
  },
  component: ChargingSettingsPage,
})

function ChargingSettingsPage() {
  const navigate = Route.useNavigate()
  const syncNow = useSyncNow()
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const tariffId = Route.useSearch({ select: (s) => s.tariffId })
  const runsSource = Route.useSearch({ select: (s) => s.source })
  const { isOpen, open, close } = useUrlDialog<SettingsDialog, SettingsSearch>({
    current: dialog,
    navigate,
    clearKeys: ['tariffId', 'source'],
  })
  const { data: tariffs } = useSuspenseQuery(orpc.tariff.list.queryOptions())
  const selectedTariff = tariffs.find((t) => t.id === tariffId)
  // A dialog that can't show (a tariffId that no longer exists; a sync history
  // without a valid source) is cleared from the URL instead of lingering there.
  const dialogUnavailable =
    dialog !== undefined &&
    (dialog === 'syncRuns'
      ? runsSource === undefined
      : dialog !== 'tariffNew' && dialog !== 'vehicleImport' && !selectedTariff)
  useEffect(() => {
    // `replace`, so Back doesn't return to the bad URL (and bounce again).
    if (dialogUnavailable) {
      navigate({
        to: '.',
        replace: true,
        resetScroll: false,
        search: (prev) => ({ ...prev, dialog: undefined, tariffId: undefined, source: undefined }),
      })
    }
  }, [dialogUnavailable, navigate])
  // "Ny period" starts from the newest period's amounts (the list is oldest first).
  const latestTariff = tariffs.at(-1)

  // Polled, so a tile's "running" state (a cron run seen mid-flight) clears on
  // its own instead of waiting for a focus refetch (ADR-0018: polled).
  const { data: zaptecHealth } = useQuery({
    ...healthQueries.zaptec,
    refetchInterval: healthPoll(syncNow.isPendingFor('zaptec')),
  })
  const { data: pricesHealth } = useQuery({
    ...healthQueries.elpris,
    refetchInterval: healthPoll(syncNow.isPendingFor('elpris')),
  })
  const { data: skodaHealth } = useQuery({
    ...healthQueries.skoda,
    refetchInterval: healthPoll(syncNow.isPendingFor('skoda')),
  })
  const { data: emaldoHealth } = useQuery({
    ...healthQueries.emaldo,
    refetchInterval: healthPoll(syncNow.isPendingFor('emaldo')),
  })
  const zaptecRuns = useQuery(runsQueries.zaptec)
  const pricesRuns = useQuery(runsQueries.elpris)
  const skodaRuns = useQuery(runsQueries.skoda)
  const emaldoRuns = useQuery(runsQueries.emaldo)
  const vehicleCoverage = useQuery(vehicleCoverageQuery)
  const vehicleLatest = useQuery(vehicleLatestQuery)

  return (
    <PageContainer>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-balance font-bold text-2xl tracking-tight md:text-3xl">
            {m.charging_settings_title()}
          </h1>
          <p className="max-w-2xl text-muted-foreground text-sm">
            {m.charging_settings_description()}
          </p>
        </div>
        <div className="shrink-0">
          <SyncNowButton onSync={syncNow.syncAll} pending={syncNow.isPending} />
        </div>
      </header>

      <SyncSourcesPanel
        entries={[
          { source: 'zaptec', health: zaptecHealth, runs: zaptecRuns },
          { source: 'elpris', health: pricesHealth, runs: pricesRuns },
          {
            source: 'skoda',
            health: skodaHealth,
            runs: skodaRuns,
            // The car's log and live poll are one source to the admin: its last
            // contact, key expiry and log (+ import) live on its tile. A failed
            // read shows an error there, never "none".
            details: (
              <SkodaSourceDetails
                live={vehicleLatest.data}
                liveQuery={vehicleLatest}
                keyExpiry={skodaHealth?.adminDetail?.credentialExpiry ?? null}
                coverage={vehicleCoverage.data}
                coverageQuery={vehicleCoverage}
              />
            ),
            actions: <VehicleLogImportButton onImport={() => open('vehicleImport')} />,
          },
          { source: 'emaldo', health: emaldoHealth, runs: emaldoRuns },
        ]}
        onSync={syncNow.syncSource}
        isPendingFor={syncNow.isPendingFor}
        openSource={isOpen('syncRuns') ? runsSource : undefined}
        onOpenHistory={(source: IntegrationSource) => open('syncRuns', { source })}
        onCloseHistory={close}
      />

      <TariffCard
        tariffs={tariffs}
        admin={{
          onNew: () => open('tariffNew'),
          onEdit: (id) => open('tariffEdit', { tariffId: id }),
          onDelete: (id) => open('tariffDelete', { tariffId: id }),
        }}
      />

      <TariffDialog
        open={isOpen('tariffNew') || (isOpen('tariffEdit') && selectedTariff !== undefined)}
        mode={
          isOpen('tariffEdit') && selectedTariff
            ? { kind: 'edit', tariff: selectedTariff }
            : isOpen('tariffNew')
              ? { kind: 'new', from: latestTariff }
              : undefined
        }
        onOpenChange={(o) => {
          if (!o) close()
        }}
      />
      <VehicleImportDialog
        open={isOpen('vehicleImport')}
        onOpenChange={(o) => {
          if (!o) close()
        }}
      />
      <DeleteTariffDialog
        open={isOpen('tariffDelete') && selectedTariff !== undefined}
        tariff={selectedTariff}
        onOpenChange={(o) => {
          if (!o) close()
        }}
      />
    </PageContainer>
  )
}
```

Notes for the implementer:
- `satisfies Record<IntegrationSource, unknown>` makes a fifth source a compile error here.
- **`Object.values(...)` order isn't significant.** If TypeScript rejects mixing the `prefetchQuery` promise types
  in `Promise.all`, list the eight calls explicitly instead.
- **The `redirect` options.** If `replace` isn't accepted on `redirect` in the installed router version, drop it.
  Check against the current docs (Context7 `/tanstack/router`, "redirect in beforeLoad") before deciding.

- [ ] **Step 6: Regenerate the route tree and type-check**

Run: `bun run build`
Expected: success, and `src/routeTree.gen.ts` now contains `'/_authenticated/charging/settings'`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-settingsPage.browser.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
bun run check
git add src/routes/_authenticated/charging/settings.tsx \
  src/routes/_authenticated/charging/-settingsPage.browser.test.tsx \
  src/routeTree.gen.ts messages/sv.json messages/en.json
git commit -m "feat(charging): add the admin-only charging settings page"
```

**Reviewers (UI route):** `code-reviewer` + a reviewer loading `web-design-guidelines` and
`vercel-react-best-practices`.

---

### Task 2: Links to the settings page from the alerts and the cost notice

**Files:**
- Create: `src/components/evCharging/SettingsLink.tsx`
- Modify: `src/components/evCharging/SyncHealthAlert.tsx`
- Modify: `src/components/evCharging/CredentialExpiryAlert.tsx`
- Modify: `src/components/evCharging/CostNotice.tsx`
- Test: `src/components/evCharging/SyncHealthAlert.browser.test.tsx`, `CredentialExpiryAlert.browser.test.tsx`,
  `CostNotice.browser.test.tsx`

**Interfaces:**
- Consumes: the route `/charging/settings` with `search.dialog` (Task 1).
- Produces:
  - `SettingsLink({ search?: { dialog: 'tariffNew' } })`, a `Button`-styled router link with the label
    `m.charging_settings_link()` unless `children` is given.
  - `SyncHealthAlert` gets the prop `settingsLink?: boolean`. It is only effective with `isAdmin`; the default is
    false.
  - `CredentialExpiryAlert` gets the prop `settingsLink?: boolean` (default false).
  - `CostNotice`'s `onAddTariff?: () => void` is **replaced** by `canAddTariff?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/evCharging/SyncHealthAlert.browser.test.tsx`. Add `renderWithRouter` to its
`~test/browser/render` import, and reuse the file's existing health fixture helper (read its top ~35 lines and use
the same factory the `failing (admin)` test uses):

```tsx
test.each([
  ['failing', { state: 'failing', code: 'auth_failed' }],
  ['not configured', { state: 'not_configured' }],
  ['stale', { state: 'stale' }],
  ['never synced', { state: 'never_synced' }],
] as const)('%s (admin, settingsLink): links to the settings page', async (_n, patch) => {
  const { screen } = await renderWithRouter(
    <SyncHealthAlert
      health={{ ...skodaHealth(), ...patch } as never}
      isAdmin
      settingsLink
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect
    .element(screen.getByRole('link', { name: m.charging_settings_link() }))
    .toHaveAttribute('href', '/charging/settings')
})

test('no settings link for a member, or without the prop', async () => {
  const member = await renderWithRouter(
    <SyncHealthAlert
      health={{ ...skodaHealth(), state: 'failing', code: 'auth_failed' } as never}
      isAdmin={false}
      settingsLink
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(member.screen.getByRole('alert')).toBeVisible()
  expect(member.screen.getByRole('link').elements()).toHaveLength(0)
  member.screen.unmount()
  const noProp = await renderWithRouter(
    <SyncHealthAlert
      health={{ ...skodaHealth(), state: 'failing', code: 'auth_failed' } as never}
      isAdmin
      onRetry={() => {}}
      retrying={false}
    />,
  )
  await expect.element(noProp.screen.getByRole('alert')).toBeVisible()
  expect(noProp.screen.getByRole('link').elements()).toHaveLength(0)
})
```

`skodaHealth()` is a stand-in name. Use the file's actual fixture: a `Health` object with
`source: 'skoda', lastSuccessAt: null, failingSince: null, adminDetail: null, running: false`. If the file builds
its fixtures inline, add this helper at the top of the new tests:

```tsx
const skodaHealth = () =>
  ({
    source: 'skoda',
    state: 'ok',
    code: null,
    lastSuccessAt: null,
    failingSince: null,
    running: false,
    adminDetail: null,
  }) as const
```

Append to `src/components/evCharging/CredentialExpiryAlert.browser.test.tsx`, using its existing expiry fixture
(one with `warn: true, expired: false, daysLeft: 12`):

```tsx
test('with settingsLink, links to the settings page', async () => {
  const { screen } = await renderWithRouter(
    <CredentialExpiryAlert
      expiry={{ expiresAt: new Date('2026-10-17T00:00:00Z'), daysLeft: 12, warn: true, expired: false }}
      settingsLink
    />,
  )
  await expect
    .element(screen.getByRole('link', { name: m.charging_settings_link() }))
    .toHaveAttribute('href', '/charging/settings')
})
```

Match the expiry literal to the type the file's other tests pass; copy one of them.

In `src/components/evCharging/CostNotice.browser.test.tsx`, replace the first and third tests (the other one is
unchanged):

```tsx
test('with no tariff, an admin is asked to add the fees and gets a link to the new-period dialog', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="noTariff" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_setup_admin())).toBeVisible()
  await expect
    .element(screen.getByRole('link', { name: m.charging_cost_notice_setup_action() }))
    .toHaveAttribute('href', '/charging/settings?dialog=tariffNew')
})

test('with tariffs but nothing priced, it says prices or fees are missing (no link)', async () => {
  const { screen } = await renderWithRouter(<CostNotice reason="unpriced" canAddTariff />)
  await expect.element(screen.getByText(m.charging_cost_notice_unpriced())).toBeVisible()
  expect(screen.getByRole('link').elements()).toHaveLength(0)
})
```

Update that file's imports: `renderWithRouter` from `~test/browser/render`, and drop `vi` if it is no longer used.
The member test keeps `renderWithProviders`: it renders no link. Its `getByRole('button')` assertion still holds.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
bunx vitest run --project browser src/components/evCharging/SyncHealthAlert.browser.test.tsx \
  src/components/evCharging/CredentialExpiryAlert.browser.test.tsx \
  src/components/evCharging/CostNotice.browser.test.tsx
```
Expected: FAIL. TypeScript reports the unknown props `settingsLink` / `canAddTariff`, and the links are missing.

- [ ] **Step 3: Create `SettingsLink`**

`src/components/evCharging/SettingsLink.tsx`:

```tsx
import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

// "Go fix it there": the charging settings page (admins only) holds every data
// source, its sync and history, and the tariffs. Sized like SyncNowButton so the
// two sit side by side in an alert's action row.
export function SettingsLink({
  search,
  children,
}: {
  search?: { dialog: 'tariffNew' }
  children?: React.ReactNode
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/charging/settings" search={search}>
        {children ?? m.charging_settings_link()}
      </Link>
    </Button>
  )
}
```

- [ ] **Step 4: Wire `SyncHealthAlert`**

In `src/components/evCharging/SyncHealthAlert.tsx`:
1. Add `import { SettingsLink } from './SettingsLink'`.
2. Add `settingsLink = false` to the destructured props and `/** Admins: a link to the settings page. */
   settingsLink?: boolean` to the prop type. Compute `const link = isAdmin && settingsLink` before the `switch`.
3. Replace the four admin branches' action rows:
   - `never_synced`: `{isAdmin ? <RetryRow onRetry={onRetry} retrying={retrying} link={link} /> : null}`
   - `not_configured`: after the message div, add `{link ? <div><SettingsLink /></div> : null}`. Also update the
     branch comment to: `// Retrying can't fix missing credentials, so no retry: the settings page is where they're fixed.`
   - `stale` and `failing`: `<AdminDetail health={health} onRetry={onRetry} retrying={retrying} link={link} />`
4. Thread `link` through `AdminDetail`, then into `RetryRow`:

```tsx
function AdminDetail({
  health,
  onRetry,
  retrying,
  link,
}: {
  health: Health
  onRetry: () => void
  retrying: boolean
  link: boolean
}) {
  const message = health.adminDetail?.lastErrorMessage
  return (
    <>
      {message ? (
        <div className="text-muted-foreground">
          {m.charging_health_admin_detail()}{' '}
          <code className="break-all font-mono text-xs">{message}</code>
        </div>
      ) : null}
      <RetryRow onRetry={onRetry} retrying={retrying} link={link} />
    </>
  )
}

function RetryRow({
  onRetry,
  retrying,
  link,
}: {
  onRetry: () => void
  retrying: boolean
  link: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SyncNowButton onSync={onRetry} pending={retrying} label={m.common_try_again()} />
      {link ? <SettingsLink /> : null}
    </div>
  )
}
```

5. Delete the header comment's line `// Emaldo has no alert: its state lives only on its Datakällor tile.`. Replace it
   with `// Emaldo has no alert: its state lives only on its Datakällor tile (charging settings).`

- [ ] **Step 5: Wire `CredentialExpiryAlert`**

```tsx
import { KeyRoundIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'
import { SettingsLink } from './SettingsLink'

type Expiry = NonNullable<
  RouterOutputs['evCharging']['syncStatus']['adminDetail']
>['credentialExpiry']

// Admin-only (the caller passes adminDetail, which only admins get): the Škoda
// key expires about every six months (ADR-0022). The server decides when to
// warn; once expired the health alert (auth_failed) takes over, so nothing here.
// On the expiry day itself (0 calendar days left, not yet expired) it says today.
export function CredentialExpiryAlert({
  expiry,
  settingsLink = false,
}: {
  expiry: Expiry
  /** A link to the settings page, where the Škoda source lives. */
  settingsLink?: boolean
}) {
  if (!expiry?.warn || expiry.expired) return null
  // Same split as SyncHealthAlert: only the urgent state interrupts (role=alert).
  const urgent = expiry.daysLeft <= 7
  return (
    <Alert role={urgent ? 'alert' : 'status'} variant={urgent ? 'destructive' : 'default'}>
      <KeyRoundIcon />
      <AlertTitle>{m.charging_skoda_key_expiring_title()}</AlertTitle>
      {/* Children are divs, not <p>: AlertDescription adds a large bottom margin between paragraphs. */}
      <AlertDescription className="flex flex-col gap-2">
        <div>
          {expiry.daysLeft === 0
            ? m.charging_skoda_key_expiring_body_today({ date: formatDate(expiry.expiresAt) })
            : m.charging_skoda_key_expiring_body({
                date: formatDate(expiry.expiresAt),
                days: expiry.daysLeft,
              })}
        </div>
        {settingsLink ? (
          <div>
            <SettingsLink />
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
```

The existing tests match the body text with `getByText`. Wrapping it in a `div` keeps those matches.

- [ ] **Step 6: Wire `CostNotice`**

```tsx
import { InfoIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { m } from '~/paraglide/messages'
import { SettingsLink } from './SettingsLink'

export type CostNoticeReason = 'noTariff' | 'unpriced'

// Why the page shows no cost, said once above the tiles instead of in every
// tile: no tariff period yet (admins get a link to add one on the settings
// page), or periods exist but nothing charged so far has both a price and a tariff.
export function CostNotice({
  reason,
  canAddTariff = false,
}: {
  reason: CostNoticeReason
  /** Admins only: links to the settings page's new-period dialog. */
  canAddTariff?: boolean
}) {
  const text =
    reason === 'unpriced'
      ? m.charging_cost_notice_unpriced()
      : canAddTariff
        ? m.charging_cost_notice_setup_admin()
        : m.charging_cost_notice_setup_member()
  return (
    <Alert>
      <InfoIcon />
      <AlertDescription className="flex flex-col items-start gap-2">
        <div>{text}</div>
        {reason === 'noTariff' && canAddTariff ? (
          <SettingsLink search={{ dialog: 'tariffNew' }}>
            {m.charging_cost_notice_setup_action()}
          </SettingsLink>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
```

`index.tsx` still passes `onAddTariff` until Task 3, so `bun run typecheck` fails between the two tasks. Do Task 3
right after this one, and commit them together if your executor requires a green type-check per commit. Otherwise,
in this task only, change the one call site in `index.tsx`:
`onAddTariff={isAdmin ? () => open('tariffNew') : undefined}` → `canAddTariff={isAdmin}`.

- [ ] **Step 7: Run the tests to verify they pass**

Run the same command as Step 2.
Expected: PASS, including every pre-existing test in the three files.

- [ ] **Step 8: Commit**

```bash
bun run check && bun run typecheck
git add src/components/evCharging/SettingsLink.tsx src/components/evCharging/SyncHealthAlert.tsx \
  src/components/evCharging/CredentialExpiryAlert.tsx src/components/evCharging/CostNotice.tsx \
  src/components/evCharging/*.browser.test.tsx src/routes/_authenticated/charging/index.tsx
git commit -m "feat(charging): link alerts and the cost notice to the settings page"
```

**Reviewers (UI component):** `code-reviewer` + a reviewer loading `web-design-guidelines` and
`vercel-react-best-practices`.

---

### Task 3: Slim the overview

**Files:**
- Modify: `src/routes/_authenticated/charging/index.tsx`
- Modify: `src/routes/_authenticated/charging/economy.tsx`, `patterns.tsx` (only the alerts' `settingsLink`)
- Test: `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`

**Interfaces:**
- Consumes: `SyncHealthAlert`'s and `CredentialExpiryAlert`'s `settingsLink`, and `CostNotice`'s `canAddTariff`
  (Task 2).
- Produces: an overview whose search is `{ year?, vehicle?, page?, size? }` only.

- [ ] **Step 1: Update the route tests (failing first)**

In `-vehicleScopePages.browser.test.tsx`:
1. **Delete** these tests. They now live in `-settingsPage.browser.test.tsx`:
   - `Översikt: an admin sees the car log on the Škoda tile, and ?dialog=vehicleImport opens the import`
   - `Översikt: a failed coverage read shows an error on the Škoda tile, not "no log imported"`
   - `Översikt: a non-admin gets no car log, no import, no dialog, and the param is cleared`
   - the whole `// --- Datakällor ---` section's four tests (`admins get the Datakällor panel…`, `Historik opens…`,
     `a deep link opens…`, `a sync-history link with %s is cleaned…`), with its `sourcesHeading` and `historyTitle`
     consts.

   **Keep** `seedEmptyOverview`; move it above the order test if it was declared inside the deleted section.
2. **Trim** `seedOverviewShell` to what the overview still reads:

```tsx
function seedOverviewShell(qc: QueryClient) {
  qc.setQueryData(orpc.tariff.list.queryOptions().queryKey, [] as never)
}
```

   Then remove every `{ coverage: false }` argument; only the deleted tests used it.
3. **Rewrite** the order test: rename it and drop the tariff assertions.

```tsx
test('Översikt: the scope filter sits above the totals, the chart above the sessions; no admin blocks', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', seedEmptyOverview)
  const scope = screen.getByRole('radiogroup', { name: m.charging_vehicle_scope_label() })
  await expect.element(scope).toBeVisible()
  const scopeEl = scope.element()
  const totals = screen.getByRole('heading', { name: m.charging_totals_heading() }).element()
  const chartTitle = screen.getByRole('heading', { name: m.charging_chart_title() }).element()
  const sessions = screen.getByRole('heading', { name: m.charging_sessions_heading() }).element()
  expect(precedes(scopeEl, totals)).toBe(true)
  expect(precedes(chartTitle, sessions)).toBe(true)
  // The tariffs and the data sources moved to /charging/settings.
  expect(screen.getByRole('heading', { name: m.charging_tariff_title() }).elements()).toHaveLength(0)
  expect(screen.getByRole('heading', { name: m.charging_sources_heading() }).elements()).toHaveLength(0)
  // The chart's toolbar holds only chart controls.
  expect(chartTitle.closest('section')?.contains(scopeEl)).toBe(false)
  // The live line sits in the page heading, not in the scoped content.
  const banner = screen.getByRole('banner').element()
  const liveName = screen.getByText(m.charging_live_title(), { exact: false }).element()
  expect(banner.contains(liveName)).toBe(true)
  expect(precedes(liveName, scopeEl)).toBe(true)
})
```

4. **Add** the old-bookmark tests (Review Focus 2):

```tsx
test.each([
  '?dialog=tariffNew',
  '?dialog=vehicleImport',
  '?dialog=syncRuns&source=skoda',
])('Översikt: an old dialog link %s loads the overview with no dialog', async (search) => {
  const { screen } = await renderPage(Overview, '/charging', search, seedEmptyOverview)
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('Översikt: an admin’s failing Škoda alert links to the settings page', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedEmptyOverview(qc)
    qc.setQueryData(
      orpc.evCharging.syncStatus.queryOptions({ input: { source: 'skoda' } }).queryKey,
      {
        source: 'skoda',
        state: 'failing',
        code: 'auth_failed',
        lastSuccessAt: null,
        failingSince: null,
        running: false,
        adminDetail: null,
      } as never,
    )
  })
  await expect
    .element(screen.getByRole('link', { name: m.charging_settings_link() }))
    .toHaveAttribute('href', '/charging/settings')
})
```

Run: `bunx vitest run --project browser src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`
Expected: FAIL on the order test (the tariff and sources headings are still there), on the old-link tests for
`vehicleImport` and `syncRuns` (the dialogs still open), and on the link test (no `settingsLink` passed yet).

- [ ] **Step 2: Slim `index.tsx`**

Make these edits in `src/routes/_authenticated/charging/index.tsx`:

1. **Imports.** Remove `DeleteTariffDialog`, `SkodaSourceDetails`, `VehicleLogImportButton`, `SyncSourcesPanel`,
   `TariffCard`, `TariffDialog`, `VehicleImportDialog`, `useUrlDialog`,
   `import { INTEGRATION_SOURCES, type IntegrationSource } from '~/lib/integrationHealth'`, and `useEffect` from the
   `react` import (keep `useMemo`, `useState`).
2. **Search schema.** Delete the `dialog`, `tariffId` and `source` fields, and their comments. Delete the
   `type ChargingDialog = …` line. Keep `type ChargingSearch` (`useSessionPaging<ChargingSearch>` uses it).
3. **Query consts.** Delete `RECENT_RUNS`, `vehicleCoverageQuery`, `pricesRunsQuery`, `skodaRunsQuery`,
   `emaldoHealthQuery`, `emaldoRunsQuery` and `vehicleLatestQuery`. Keep `pricesHealthQuery` and
   `skodaHealthQuery`; they feed the alerts.
4. **Loader.** Replace the admin block after `ensureQueryData(orpc.evCharging.syncStatus.queryOptions())` with:

```tsx
      // The alerts' sources (admin-only, like their alerts). The data sources'
      // tiles and histories live on /charging/settings.
      user.role === 'admin' ? queryClient.ensureQueryData(pricesHealthQuery) : null,
      // Prefetched: a failed car-health read must not take the page down.
      user.role === 'admin' ? queryClient.prefetchQuery(skodaHealthQuery) : null,
```

5. **Component.**
   - Delete the `dialog` / `tariffId` / `runsSource` selects, the `useUrlDialog` call, `selectedTariff`,
     `dialogUnavailable` with its `useEffect`, and `latestTariff`.
   - Delete the `zaptecRuns`, `pricesRuns`, `vehicleCoverage`, `skodaRuns`, `emaldoHealth`, `emaldoRuns` and
     `vehicleLatest` queries.
   - Change the comment above `pricesHealth` to:
     `// Admin-only (see the alerts below). Polled like Zaptec's, so an alert's retry state clears on its own (ADR-0018: polled).`
   - Keep `const navigate = Route.useNavigate()` (`setYear`, `setVehicle` and `useSessionPaging` use it).
6. **JSX.**
   - Add `settingsLink={isAdmin}` to the Zaptec `SyncHealthAlert`, and `settingsLink` to the elpris and Škoda ones
     (already admin-only).
   - Add `settingsLink` to `CredentialExpiryAlert`.
   - `CostNotice` gets `canAddTariff={isAdmin}`, if Task 2 didn't already change it.
   - Delete everything after the sessions `</section>`: `<TariffCard …/>`, the Datakällor comment and
     `SyncSourcesPanel` block, and the admin dialogs fragment. `</PageContainer>` follows the sessions section
     directly.

Run: `bun run typecheck`
Expected: no errors. A leftover unused import shows up as a Biome warning in Step 5.

- [ ] **Step 3: Economy and patterns alerts**

In `src/routes/_authenticated/charging/economy.tsx` (two `SyncHealthAlert`s, around lines 126 and 134) and
`patterns.tsx` (one, around line 146), add `settingsLink={isAdmin}` to the Zaptec alert and `settingsLink` to any
alert already rendered admin-only. Read each file's alert block first and match how it computes `isAdmin`.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
bunx vitest run --project browser src/routes/_authenticated/charging/
```
Expected: PASS, both route test files.

- [ ] **Step 5: Commit**

```bash
bun run check && bun run typecheck
git add src/routes/_authenticated/charging/
git commit -m "refactor(charging): move the admin blocks off the overview"
```

(It's `refactor`, not `feat`: for the overview, this task only removes what Task 1 re-homed.)

**Reviewers (UI route):** `code-reviewer` + a reviewer loading `web-design-guidelines` and
`vercel-react-best-practices`.

---

### Task 4: Navigation (sidebar and Cmd+K)

**Files:**
- Modify: `src/components/AppSidebar.tsx`, `src/components/AppSidebar.browser.test.tsx`
- Modify: `src/routes/_authenticated.tsx`
- Modify: `src/components/command/commands.ts`
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Produces: `AppSidebar({ role }: { role?: string | null })`, the same prop shape as `CommandPalette`.

- [ ] **Step 1: Messages**

| Key | sv | en |
|---|---|---|
| `nav_charging_settings_short` | `Inställningar` | `Settings` |
| `nav_charging_settings` | `Laddningsinställningar` | `Charging settings` |
| `cmd_kw_charging_settings` | `inställningar datakällor synk historik tariff avgifter påslag elnät nyckel zaptec skoda emaldo elpris` | `settings data sources sync history tariff fees markup grid key zaptec skoda emaldo elpris` |

Run: `bun run i18n:compile`

- [ ] **Step 2: Write the failing sidebar tests**

In `src/components/AppSidebar.browser.test.tsx`, change `renderSidebar` to take a role:

```tsx
const renderSidebar = (role: string | null = 'user') =>
  renderWithProviders(
    <CommandPaletteProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar role={role} />
        </SidebarProvider>
      </TooltipProvider>
    </CommandPaletteProvider>,
  )
```

and append:

```tsx
test('admins get Inställningar under Laddning; members do not', async () => {
  const admin = await renderSidebar('admin')
  await expect
    .element(admin.screen.getByRole('link', { name: m.nav_charging_settings_short(), exact: true }))
    .toHaveAttribute('href', '/charging/settings')
  admin.screen.unmount()
  const member = await renderSidebar('user')
  await expect
    .element(member.screen.getByRole('link', { name: m.nav_charging_overview(), exact: true }))
    .toBeVisible()
  expect(
    member.screen.getByRole('link', { name: m.nav_charging_settings_short(), exact: true }).elements(),
  ).toHaveLength(0)
})

test('the settings link is exact and carries no page filter', async () => {
  current.path = '/charging'
  await renderSidebar('admin')
  const props = linkProps.get(m.nav_charging_settings_short())
  expect(props?.activeOptions).toEqual({ exact: true, includeSearch: false })
  // A clean URL: the year and vehicle scope belong to the views, not to settings.
  const search = props?.search as (prev: object) => object
  expect(search({ year: 2025, vehicle: 'other' })).toEqual({})
})

test('on /charging/settings only Inställningar (and Laddning) is active', async () => {
  current.path = '/charging/settings'
  const { screen } = await renderSidebar('admin')
  const link = (name: string) => screen.getByRole('link', { name, exact: true }).element()
  expect(active(link(m.nav_charging_settings_short()))).toBe(true)
  expect(active(link(m.nav_charging_overview()))).toBe(false)
  expect(active(link(m.nav_charging()))).toBe(true)
})
```

Run: `bunx vitest run --project browser src/components/AppSidebar.browser.test.tsx`
Expected: FAIL. `AppSidebar` takes no `role`, and the link is missing.

- [ ] **Step 3: Implement the sidebar**

In `src/components/AppSidebar.tsx`:

```tsx
// label is a message function rather than a string: module scope evaluates
// once per process, but the active locale is per request/render. `scoped`
// views share the page filter (year, vehicle); settings is admin-only and
// unscoped. Every item carries both flags, so the array keeps one shape.
const chargingSubItems = linkOptions([
  { to: '/charging', label: m.nav_charging_overview, scoped: true, adminOnly: false },
  { to: '/charging/patterns', label: m.nav_charging_patterns_short, scoped: true, adminOnly: false },
  { to: '/charging/economy', label: m.nav_charging_economy_short, scoped: true, adminOnly: false },
  { to: '/charging/settings', label: m.nav_charging_settings_short, scoped: false, adminOnly: true },
])
```

Below `sectionLinkProps`, add:

```tsx
// Settings: matched exactly like the views, but it starts from a clean URL.
const unscopedLinkProps = {
  search: () => ({}),
  activeOptions: { exact: true, includeSearch: false },
} as const
```

Change the signature to `export function AppSidebar({ role }: { role?: string | null } = {})`. Add
`const isAdmin = role === 'admin'` (the role filter is UX-only, like the palette's; the route enforces access).

In `renderItem`, map only the visible sub-items:

```tsx
        {'subItems' in item ? (
          <SidebarMenuSub>
            {item.subItems.filter((s) => isAdmin || !s.adminOnly).map(renderSubItem)}
          </SidebarMenuSub>
        ) : null}
```

In `renderSubItem`, pick the link props per item:

```tsx
          <Link
            to={item.to}
            {...(item.scoped ? sectionLinkProps : unscopedLinkProps)}
            onClick={() => setOpenMobile(false)}
          >
```

In `src/routes/_authenticated.tsx`, change `<AppSidebar />` to `<AppSidebar role={user.role} />`.

**If TypeScript rejects `search: () => ({})`** for `/charging/settings` because its search params are all optional,
use `search: {}` instead. Then the test's `search` is an object, not a function, so change its assertion to
`expect(props?.search).toEqual({})`.

- [ ] **Step 4: Command palette**

In `src/components/command/commands.ts`, add `SettingsIcon` to the `lucide-react` import. Insert after the
`/charging/economy` entry:

```ts
  {
    to: '/charging/settings',
    label: m.nav_charging_settings,
    keywords: m.cmd_kw_charging_settings,
    icon: SettingsIcon,
    adminOnly: true,
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run --project browser src/components/AppSidebar.browser.test.tsx src/components/command`
Expected: PASS. The existing "keep the year and vehicle scope" test still loops over the three scoped labels only.

- [ ] **Step 6: Commit**

```bash
bun run check && bun run typecheck
git add src/components/AppSidebar.tsx src/components/AppSidebar.browser.test.tsx \
  src/routes/_authenticated.tsx src/components/command/commands.ts messages/sv.json messages/en.json
git commit -m "feat(charging): add charging settings to the sidebar and Cmd+K"
```

**Reviewers (UI component):** `code-reviewer` + a reviewer loading `web-design-guidelines` and
`vercel-react-best-practices`.

---

### Task 5: Emails point at the settings page

**Files:**
- Modify: `src/emails/IntegrationSyncAlertEmail.tsx`, `src/emails/CredentialExpiryEmail.tsx`,
  `src/emails/GridTariffAvailableEmail.tsx`
- Test: `src/emails/IntegrationSyncAlertEmail.test.tsx`, `CredentialExpiryEmail.test.tsx`,
  `GridTariffAvailableEmail.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json`

- [ ] **Step 1: Write the failing assertions**

In each of the three test files, change every `toContain('/charging')` to `toContain('/charging/settings')`, and
rename `/charging` to `/charging/settings` in the test titles. In `CredentialExpiryEmail.test.tsx`, also add (next
to the existing `SKODA_API_KEY` assertion, which stays: env is still the only way to set the key in this step):

```ts
      expect(out).toContain(m.nav_charging_settings_short())
```

Use whichever variable that test already renders into (`out` in the current file). Add the `m` import if missing:
`import { m } from '~/paraglide/messages'`.

Run: `bunx vitest run src/emails`
Expected: FAIL. The links are still `/charging`.

- [ ] **Step 2: Change the links and comments**

In each email file, change the action URL and its comment:
- `IntegrationSyncAlertEmail.tsx:21-25`: `// The button always points at the charging settings page, where every data
  source's state, sync and history live — there's no per-source deep link.` and
  `` const actionUrl = () => `${process.env.BETTER_AUTH_URL}/charging/settings` ``. Keep the rest of the existing
  comment's reasoning if it says more.
- `CredentialExpiryEmail.tsx:21-22`: `// The button points at the charging settings page (the Škoda source's tile;
  BrandEmailLayout also takes the logo's origin from it).` and the same URL.
- `GridTariffAvailableEmail.tsx:15-17`: `// The button points at the charging settings page, where the tariff periods
  live.` and the same URL.

- [ ] **Step 3: Change the copy**

| Key | sv | en |
|---|---|---|
| `email_credential_expiry_button` | `Öppna laddningsinställningarna` | `Open charging settings` |
| `email_grid_tariff_button` | `Öppna laddningsinställningarna` | `Open charging settings` |
| `email_integration_sync_button` | `Öppna laddningsinställningarna` | `Open charging settings` |

In `email_credential_expiry_body`, replace only the last sentence:
- sv: `Verifiera med Synka nu på Škoda under Datakällor på Översikt.` →
  `Verifiera med Synka nu på Škoda under Laddning → Inställningar.`
- en: `Verify with Sync now on Škoda under Data sources on the overview page.` →
  `Verify with Sync now on Škoda under Charging → Settings.`

The sv value must keep containing `Inställningar` (= `nav_charging_settings_short`) for Step 1's assertion; the en
value contains `Settings`.

Run: `bun run i18n:compile`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/emails`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run check
git add src/emails messages/sv.json messages/en.json
git commit -m "feat(charging): point admin emails at the charging settings page"
```

**Reviewers (email template):** `code-reviewer` + a reviewer loading `react-email` and `email-best-practices`.

---

### Task 6: Docs and the pre-PR gate

**Files:**
- Modify: `CLAUDE.md` (code map)
- Modify: `docs/superpowers/roadmaps/2026-10-05-charging-settings.md` (step 1 row)
- Modify: `docs/runbooks/skoda-api-key.md` (step 4 location)

- [ ] **Step 1: Docs**
- **`CLAUDE.md` code map.** Change the `_authenticated/` line's `charging` to
  `charging/{index,patterns,economy,settings (admin-only: Datakällor + tariffs)}`.
- **Runbook, step 4.** Change `/charging → "Bilens data" → **Hämta bilens status**` to
  `Laddning → Inställningar → the Škoda tile → **Synka nu**`. Change the expected text to the tile's "Fungerar" and
  "Nyckeln går ut den …". Read the current tile copy in `SkodaSourceDetails.tsx` and quote it exactly.
- **Roadmap, row 1.** Status `PR open`; the PR link is filled in after `gh pr create`.

- [ ] **Step 2: Pre-PR gate**

Run, in order:
```bash
bun run check
bun run check:ci
bun run build
bun run db:up && bun run db:migrate
bun run test
bun -e 'const sv=Object.keys(await Bun.file("messages/sv.json").json()),en=Object.keys(await Bun.file("messages/en.json").json());const d=[...sv.filter(k=>!en.includes(k)).map(k=>"en missing "+k),...en.filter(k=>!sv.includes(k)).map(k=>"sv missing "+k)];console.log(d.join("\n")||"sv/en keys match");process.exit(d.length?1:0)'
grep -rn "charging?dialog\|'/charging'.*dialog" src --include=*.tsx --include=*.ts | grep -v test || echo "no stale overview dialog links"
```
Expected: each step passes, the key check prints `sv/en keys match`, and the grep finds nothing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs(charging): map the settings page and point the runbook at it"
```

---

## After the tasks (feature-workflow Phases 5–7)

- **Branch review** (Phase 5): `code-reviewer` and a general correctness pass over the whole diff. The
  admin-gated route is a permission boundary, so also run a security pass: does `beforeLoad` gate before the
  loader, and is no admin-only read reachable by a member?
- **Live check** (Phase 6), at desktop, tablet and mobile widths on the dev server (memory:
  live-ui-check-playwright, if the Chrome extension is down). Check:
  - As an admin, `/charging/settings` shows the four tiles, history, the import and the tariff card.
  - The sidebar shows "Inställningar" and Cmd+K finds it.
  - The overview ends with the sessions.
  - As a member, the item is hidden and the URL redirects.
- **PR** (Phase 7): title `feat(charging): move data sources and tariffs to a settings page`, with the body from
  `.github/PULL_REQUEST_TEMPLATE.md` linking the spec, ADR-0024 and the roadmap.
