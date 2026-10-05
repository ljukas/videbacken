# Client performance step 2 — deferred route loading on `/sensors` and `/users`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client navigation to `/sensors` or `/users` commits at once, with section skeletons filling in, instead of
holding the old page until the loader's queries land.

**Architecture:** Step 1's seams, applied unchanged:
- `loadRouteData` (`src/lib/query/routeData.ts`) awaits a page's critical queries only on the server.
- `SectionSkeleton` (`src/components/layout/SectionSkeleton.tsx`) shows the captured bones while a section's first
  load is pending.
- `LoadErrorAlert` shows a failed read in place (ADR-0016) instead of the route error boundary.

The one structural change is a preparatory refactor: the load-state helpers move out of `components/evCharging/` so
non-charging pages can use them.

**Tech Stack:** TanStack Start/Router + TanStack Query, oRPC, boneyard-js (React), Vitest browser project.

**Spec:** [ADR-0025](../../adr/0025-deferred-route-loading.md) (read it first). Roadmap:
[client performance](../roadmaps/2026-10-05-client-performance.md), step 2. Step 1's plan
([2026-10-05-client-perf-1-deferred-charging.md](./2026-10-05-client-perf-1-deferred-charging.md)) shows the same
pattern on the charging pages; `src/routes/_authenticated/charging/index.tsx` is the reference implementation.

## Global Constraints

- Client code may only `import type` from services (CLAUDE.md gotcha).
- Never `console.*` in app code (ADR-0003).
- User-facing text is Paraglide (`messages/sv.json` source of truth, `en.json` key-complete).
- Every screen responsive at 375 / 768 / 1280; bones captured at 375 / 768 / 1100 / 1280 (`boneyard.config.json`).
- No `useSuspenseQuery` for data a client navigation defers (ADR-0025 §3). It stays for `user.me`, and for
  `EditUserDialogBody`'s `user.list` read, which sits behind its own `<Suspense>` spinner inside the dialog.
- Pages never import `boneyard-js` directly; only `SectionSkeleton` does.
- Conventional Commits, one hat per commit. Reviewers must **not** run vitest (shared local DB; see memory).

## Review Focus

1. **No sensors yet vs. sensors still loading.** `listDevices` pending must show the `sensors-tiles` skeleton, never
   the "Inga sensorer ännu" empty state. Pinned in Task 3.
2. **No chart data vs. chart data still loading or failed.** `series` pending shows the chart skeletons. `series`
   failed shows the alert. Neither shows "Ingen data i vald period." Pinned in Task 3.
3. **Deep-linked dialogs survive the load.** `/sensors?dialog=edit&deviceId=…` and `/users?dialog=revoke&email=…`
   keep their params while the list is pending, and the dialog opens once it lands. Pinned in Tasks 2 and 3.
4. **A revisit with cached data shows the data, not a skeleton** (on both pages). Pinned in Tasks 2 and 3.
5. **The refactor changes nothing on the charging pages.** Same alert copy, same retry button, same focus behavior
   in the Datakällor tiles. Pinned in Task 1 (the moved tests keep passing unchanged, apart from their imports).

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/layout/LoadErrorAlert.tsx` *(moved from `evCharging/`)* | `LoadErrorQuery`, `loadFailed`, `firstLoadPending`, `LoadErrorAlert`, `LoadErrorLine` |
| `src/components/layout/LoadErrorAlert.browser.test.tsx` *(moved)* | Its tests |
| `src/components/layout/RefreshButton.tsx` *(new)* | The presentational refresh-icon button (spinner, `keepFocusWhilePending`), formerly `SyncNowButton`'s body |
| `src/components/evCharging/SyncNowButton.tsx` | `SyncNowButton` becomes `RefreshButton` with the "Synka nu" default label; `useSyncNow` is unchanged |
| `src/routes/_authenticated/users.tsx` | `loadRouteData`; `useQuery`; `users-table` skeleton; alert; no `loaderDeps` |
| `src/routes/_authenticated/-usersRoute.browser.test.tsx` *(new)* | Route-level pending / failed / cached / deep-link tests |
| `src/routes/_authenticated/sensors.tsx` | `loadRouteData`; `useQuery`; `sensors-tiles` + chart skeletons; alerts |
| `src/routes/_authenticated/-sensorsRoute.browser.test.tsx` *(new)* | Route-level pending / failed / cached / deep-link tests |
| `scripts/captureBones.ts` | `DEFAULT_PATHS` gains `/sensors`, `/users` |
| `src/bones/` *(generated)* | New `sensors-*` and `users-table` bones + registry |
| `messages/{sv,en}.json` | `common_load_error_description` (renamed), `sensors_devices_error_title`, `sensors_series_error_title`, `users_list_error_title` |
| `docs/superpowers/roadmaps/2026-10-05-client-performance.md` | Row 1 checkpoint passed, row 2 PR open, new step 7 |

---

### Task 0: Re-measure the baseline on `main`

**Files:** none (read-only). Results go into the PR description, not the repo.

- [ ] **Step 1: Check the plan's assumptions still hold**

```bash
git fetch origin && git log --oneline -1 origin/main
grep -n "ensureQueryData\|useSuspenseQuery(" src/routes/_authenticated/sensors.tsx src/routes/_authenticated/users.tsx
grep -rln "evCharging/LoadErrorAlert\|from './LoadErrorAlert'" src
grep -n "DEFAULT_PATHS" scripts/captureBones.ts
```

Expected: both routes still `ensureQueryData` + `useSuspenseQuery`. The importers are the four charging routes,
`SyncRunsDialog.tsx`, `SkodaSourceDetails.tsx` and the test. `DEFAULT_PATHS` lists the three charging pages.

- [ ] **Step 2: Prod server times**

With the Vercel MCP `get_runtime_logs` (project `prj_8MG0PGBp5OCoa09qvHSkWVt9EjEg`, team
`team_ipjl15fK8NbQoalWg86ZAb7o`, production, `since: 7d`), query `rpc timing` lines for `sensor/listDevices`,
`sensor/series` and `user/list`. Note their `totalMs` ranges. These are what a client navigation waits on today.

- [ ] **Step 3: Client navigation baseline (local prod build)**

Build and serve the prod build (`bun run build && bun run start` or the step-1 approach in memory
`live-ui-check-playwright`). Sign in as admin. Navigate `/charging` → `/sensors` → `/users` → `/sensors?range=1y`.
For each, record the gap between the click and the URL change. That gap is the loader blocking. Use Playwright
`page.evaluate(() => performance.now())` around `click` and `waitForURL`.

---

### Task 1: Refactor — move the load-state helpers to `components/layout/`

Behavior-preserving (refactor hat). Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` +
`vercel-react-best-practices`.

**Files:**
- Move: `src/components/evCharging/LoadErrorAlert.tsx` → `src/components/layout/LoadErrorAlert.tsx`
- Move: `src/components/evCharging/LoadErrorAlert.browser.test.tsx` → `src/components/layout/LoadErrorAlert.browser.test.tsx`
- Create: `src/components/layout/RefreshButton.tsx`
- Modify: `src/components/evCharging/SyncNowButton.tsx`, `SyncRunsDialog.tsx`, `SkodaSourceDetails.tsx`
- Modify: `src/routes/_authenticated/charging/{index,economy,patterns}.tsx`, `charging/sessions/$sessionId.tsx` (imports)
- Modify: `messages/sv.json`, `messages/en.json` (rename `charging_patterns_error_description` → `common_load_error_description`)

**Interfaces:**
- Produces: `~/components/layout/LoadErrorAlert` exporting `LoadErrorQuery`, `loadFailed`, `firstLoadPending`,
  `LoadErrorAlert`, `LoadErrorLine` (same signatures as today).
- Produces: `~/components/layout/RefreshButton` exporting

  ```ts
  export function RefreshButton(props: {
    onClick: () => void
    pending: boolean
    label: string
    variant?: 'outline' | 'default'
    'aria-label'?: string
    keepFocusWhilePending?: boolean
  }): JSX.Element
  ```

- [ ] **Step 1: Move the files with git**

```bash
git mv src/components/evCharging/LoadErrorAlert.tsx src/components/layout/LoadErrorAlert.tsx
git mv src/components/evCharging/LoadErrorAlert.browser.test.tsx src/components/layout/LoadErrorAlert.browser.test.tsx
```

- [ ] **Step 2: Extract `RefreshButton`**

`src/components/layout/RefreshButton.tsx` takes the body of today's `SyncNowButton`, with `onSync` renamed to
`onClick` and `label` made required:

```tsx
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

// A small button with a refresh icon that spins while `pending`: the "Synka nu"
// syncs and every failed read's "Försök igen".
export function RefreshButton({
  onClick,
  pending,
  label,
  variant = 'outline',
  'aria-label': ariaLabel,
  keepFocusWhilePending = false,
}: {
  onClick: () => void
  pending: boolean
  label: string
  variant?: 'outline' | 'default'
  /** Names the button when several sit on one screen (the visible label first, WCAG 2.5.3). */
  'aria-label'?: string
  /**
   * While pending, mark the button aria-disabled (and ignore clicks) instead of
   * `disabled`, so a keyboard user who just pressed it keeps focus there rather
   * than being dropped to <body> — for screens with several of these side by side.
   */
  keepFocusWhilePending?: boolean
}) {
  const softDisabled = keepFocusWhilePending && pending
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={softDisabled ? undefined : onClick}
      disabled={pending && !keepFocusWhilePending}
      aria-disabled={softDisabled || undefined}
      aria-label={ariaLabel}
      className={cn(softDisabled && 'cursor-not-allowed opacity-50')}
    >
      <RefreshCwIcon className={cn(pending && 'animate-spin motion-reduce:animate-none')} />
      {label}
    </Button>
  )
}
```

In `SyncNowButton.tsx`, keep `SyncNowButton`'s public props (`onSync`, optional `label` defaulting to
`m.charging_sync_now()`) so none of its callers change:

```tsx
export function SyncNowButton({
  onSync,
  label = m.charging_sync_now(),
  ...rest
}: Omit<React.ComponentProps<typeof RefreshButton>, 'onClick' | 'label'> & {
  onSync: () => void
  label?: string
}) {
  return <RefreshButton onClick={onSync} label={label} {...rest} />
}
```

Drop the now-unused `RefreshCwIcon`, `Button` and `cn` imports from `SyncNowButton.tsx` if nothing else there uses
them.

- [ ] **Step 3: Point the moved alert at `RefreshButton` and the renamed key**

In `src/components/layout/LoadErrorAlert.tsx`:
- Replace `import { SyncNowButton } from './SyncNowButton'` with
  `import { RefreshButton } from './RefreshButton'`.
- Change both `<SyncNowButton onSync={…}` to `<RefreshButton onClick={…}`, keeping every other prop.
- Change `m.charging_patterns_error_description()` to `m.common_load_error_description()`.

In both message files, rename the key in place, keeping its value:
`"common_load_error_description": "Kontrollera anslutningen och försök igen."` /
`"Check your connection and try again."`. Then `bun run i18n:compile`.

- [ ] **Step 4: Update the importers**

```bash
grep -rln "evCharging/LoadErrorAlert\|from './LoadErrorAlert'" src
```

- In each route, `~/components/evCharging/LoadErrorAlert` becomes `~/components/layout/LoadErrorAlert`.
- In `SyncRunsDialog.tsx` and `SkodaSourceDetails.tsx`, `'./LoadErrorAlert'` becomes
  `'~/components/layout/LoadErrorAlert'`.
- In the moved test, `'./LoadErrorAlert'` stays, since it moved alongside.
- Also grep for `charging_patterns_error_description` and fix any other user.

- [ ] **Step 5: Verify behavior is unchanged**

```bash
bun run typecheck
bunx vitest run --project browser src/components/layout src/components/evCharging src/routes/_authenticated/charging
bun run check
```

Expected: typecheck clean, every test passes with no assertion edits (only import paths moved), Biome clean.

- [ ] **Step 6: Commit**

```bash
git add -A src messages
git commit -m "refactor(ui): share the load-state helpers outside charging"
```

---

### Task 2: `/users` — deferred loading, skeleton, alert

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/routes/_authenticated/users.tsx`
- Create: `src/routes/_authenticated/-usersRoute.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (`users_list_error_title`)

**Interfaces:**
- Consumes: `loadRouteData(queryClient, { critical, deferred })` from `~/lib/query/routeData`;
  `SectionSkeleton({ name, loading, fallbackHeight, className, children })`;
  `LoadErrorAlert`, `loadFailed`, `firstLoadPending` from `~/components/layout/LoadErrorAlert` (Task 1).
- Produces: bones name `users-table` (captured in Task 4).

- [ ] **Step 1: Write the failing route tests**

`src/routes/_authenticated/-usersRoute.browser.test.tsx` mounts the real route under a bare root, as
`charging/-vehicleScopePages.browser.test.tsx` does:

```tsx
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc } from '~/lib/orpc/client'
import type { UserListRow } from '~/lib/services/user'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Users } from './users'

// The real page under a bare root (routeTree.gen.ts isn't loaded), with the cache
// seeded through the oRPC keys. Anything unseeded fails (no /api/rpc in the test
// server), which is how a failed read is staged. `-` keeps it out of the route tree.
const listKey = orpc.user.list.queryOptions().queryKey
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const row = (over: Partial<UserListRow> = {}): UserListRow => ({
  status: 'active',
  id: 'u2',
  email: 'anna@example.com',
  name: 'Anna Andersson',
  phone: null,
  role: 'user',
  image: null,
  imageBlurhash: null,
  createdAt: new Date('2026-09-01T08:00:00Z'),
  ...over,
})

// A query whose fetch never settles stays `pending`.
const pendingForever = (qc: QueryClient) => {
  qc.removeQueries({ queryKey: listKey, exact: true })
  void qc.prefetchQuery({ queryKey: listKey, queryFn: () => new Promise(() => {}) })
}

async function renderUsers(search: string, prepare: (qc: QueryClient) => void) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(Users as unknown as { update: (o: unknown) => void }).update({
    id: '/users',
    path: '/users',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([Users as never]),
    context: { queryClient: qc, user: { id: 'u1', role: 'admin' } },
    history: createMemoryHistory({ initialEntries: [`/users${search}`] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

test('list still loading: the heading and invite button render, the table is a skeleton', async () => {
  const { screen } = await renderUsers('', pendingForever)
  await expect.element(screen.getByRole('heading', { name: m.users_title() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.users_invite_button() })).toBeVisible()
  await expect.poll(() => skeleton('users-table')).not.toBeNull()
  expect(screen.getByText(m.users_list_error_title()).elements()).toHaveLength(0)
})

test('list failed: the alert with a retry, no skeleton', async () => {
  const { screen } = await renderUsers('', () => {})
  await expect.element(screen.getByText(m.users_list_error_title())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_try_again() })).toBeVisible()
  expect(skeleton('users-table')).toBeNull()
})

test('list cached: the table renders at once, no skeleton', async () => {
  const { screen } = await renderUsers('', (qc) => qc.setQueryData(listKey, [row()]))
  await expect.element(screen.getByText('Anna Andersson')).toBeVisible()
  expect(skeleton('users-table')).toBeNull()
})

test('a revoke deep link keeps its params while the list loads', async () => {
  const { router } = await renderUsers('?dialog=revoke&email=anna%40example.com', pendingForever)
  await expect.poll(() => skeleton('users-table')).not.toBeNull()
  expect(router.state.location.search).toMatchObject({
    dialog: 'revoke',
    email: 'anna@example.com',
  })
})

test('a revoke deep link opens once the list is in', async () => {
  const { screen } = await renderUsers('?dialog=revoke&email=anna%40example.com', (qc) =>
    qc.setQueryData(listKey, [row()]),
  )
  await expect.element(screen.getByRole('alertdialog')).toBeVisible()
})
```

Before relying on the last test, read `RevokeUserDialog.tsx` and confirm it renders `role="alertdialog"` (a
ResponsiveDialog may render `dialog` on desktop). Use whichever role it actually renders.

- [ ] **Step 2: Run them to verify they fail**

```bash
bunx vitest run --project browser src/routes/_authenticated/-usersRoute.browser.test.tsx
```

Expected: FAIL. `m.users_list_error_title` doesn't exist yet (type error), and with the key stubbed the pending test
hangs on the `useSuspenseQuery`.

- [ ] **Step 3: Add the message**

`messages/sv.json`: `"users_list_error_title": "Kunde inte hämta användarna"`.
`messages/en.json`: `"users_list_error_title": "Couldn't load the users"`.
Then `bun run i18n:compile`.

- [ ] **Step 4: Implement**

In `src/routes/_authenticated/users.tsx`:

```tsx
  validateSearch: usersSearchSchema,
  // The dialog params aren't loader deps: opening a dialog mustn't re-run the loader.
  loader: ({ context: { queryClient } }) =>
    loadRouteData(queryClient, { critical: [orpc.user.list.queryOptions()] }),
  component: Users,
```

Delete the old `loaderDeps` block. Replace the list read and derive the rows:

```tsx
  // Polled, not pushed (ADR-0018) … (keep the existing comment)
  const usersResult = useQuery({
    ...orpc.user.list.queryOptions(),
    refetchInterval: 60_000,
  })
  const users = loadFailed(usersResult) ? undefined : usersResult.data
  const revokeUserRow = revokeEmail ? users?.find((u) => u.email === revokeEmail) : undefined
```

Render the table through the seam:

```tsx
      <LoadErrorAlert title={m.users_list_error_title()} query={usersResult} />
      <SectionSkeleton
        name="users-table"
        loading={firstLoadPending(usersResult)}
        fallbackHeight="20rem"
      >
        {users ? (
          <UsersTable
            users={users}
            /* …existing props unchanged… */
          />
        ) : null}
      </SectionSkeleton>
```

Imports: `useQuery` (drop `useSuspenseQuery`), `SectionSkeleton`, `LoadErrorAlert`, `firstLoadPending`,
`loadFailed`, `loadRouteData`. The dialogs stay as they are. `EditUserDialog` reads `user.list` behind its own
`<Suspense>` spinner, so a deep-linked edit shows that spinner until the list lands.

`PageContainer` here is `width="full" fill`. Check that the table still fills the page once loaded, and that
neither the skeleton nor the alert stretches oddly (verify live in Task 4).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bunx vitest run --project browser src/routes/_authenticated/-usersRoute.browser.test.tsx
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authenticated/users.tsx src/routes/_authenticated/-usersRoute.browser.test.tsx messages src/paraglide
git commit -m "perf(users): navigate without waiting on the user list"
```

(Leave `src/paraglide` out of the `git add` if it is gitignored.)

---

### Task 3: `/sensors` — deferred loading, skeletons, alerts

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Files:**
- Modify: `src/routes/_authenticated/sensors.tsx`
- Create: `src/routes/_authenticated/-sensorsRoute.browser.test.tsx`
- Modify: `messages/sv.json`, `messages/en.json` (`sensors_devices_error_title`, `sensors_series_error_title`)

**Interfaces:**
- Consumes: as Task 2.
- Produces: bones names `sensors-tiles`, `sensors-temp-chart`, `sensors-hum-chart` (captured in Task 4).

**The page's states:**

| `listDevices` | `series` | Renders |
|---|---|---|
| pending | any | heading, range selector, `sensors-tiles` skeleton (toggles + tiles), chart skeletons |
| failed | any | heading, devices alert. Nothing else, since the toggles, tiles and chart colours all need the roster. |
| `[]` | any | heading + the existing empty state (unchanged) |
| loaded | first load pending | toggles + tiles, chart titles, chart bodies as skeletons |
| loaded | failed (incl. a new range that failed over placeholder data) | toggles + tiles, one series alert in place of both charts |
| loaded | loaded / placeholder | as today (`keepPreviousData` keeps the previous range's chart) |

- [ ] **Step 1: Write the failing route tests**

`src/routes/_authenticated/-sensorsRoute.browser.test.tsx`, with the same harness as Task 2 (route `Sensors` at
`/sensors`, context user `{ id: 'u1', role: 'admin' }`):

```tsx
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Sensors } from './sensors'

type Device = RouterOutputs['sensor']['listDevices'][number]

const devicesKey = orpc.sensor.listDevices.queryOptions().queryKey
const seriesKey = (range: '24h' | '1w' | '1m' | '1y' = '24h') =>
  orpc.sensor.series.queryOptions({ input: { range } }).queryKey
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const device: Device = {
  id: 'a',
  mac: 'a4cf12ab34cd',
  name: null,
  location: null,
  displayName: 'Sensor 34cd',
  batteryPct: 88,
  lastSeenAt: new Date(),
  latest: { temperatureC: 21.7, humidityPct: 46, recordedAt: new Date() },
}
const noSeries = { buckets: [], bucketSec: 900 } as never

const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}

async function renderSensors(search: string, prepare: (qc: QueryClient) => void) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(Sensors as unknown as { update: (o: unknown) => void }).update({
    id: '/sensors',
    path: '/sensors',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([Sensors as never]),
    context: { queryClient: qc, user: { id: 'u1', role: 'admin' } },
    history: createMemoryHistory({ initialEntries: [`/sensors${search}`] }),
  })
  await router.load()
  const screen = await render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { screen, router, qc }
}

test('devices still loading: skeletons, never the "no sensors" empty state', async () => {
  const { screen } = await renderSensors('', (qc) => {
    pendingForever(qc, devicesKey)
    pendingForever(qc, seriesKey())
  })
  await expect.element(screen.getByRole('heading', { name: m.sensors_title() })).toBeVisible()
  await expect.poll(() => skeleton('sensors-tiles')).not.toBeNull()
  expect(skeleton('sensors-temp-chart')).not.toBeNull()
  expect(skeleton('sensors-hum-chart')).not.toBeNull()
  expect(screen.getByText(m.sensors_empty_title()).elements()).toHaveLength(0)
  expect(screen.getByText(m.sensors_devices_error_title()).elements()).toHaveLength(0)
})

test('devices failed: the alert, no empty state, no skeleton', async () => {
  const { screen } = await renderSensors('', (qc) => qc.setQueryData(seriesKey(), noSeries))
  await expect.element(screen.getByText(m.sensors_devices_error_title())).toBeVisible()
  expect(screen.getByText(m.sensors_empty_title()).elements()).toHaveLength(0)
  expect(skeleton('sensors-tiles')).toBeNull()
})

test('no devices: the empty state, as before', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [])
    qc.setQueryData(seriesKey(), noSeries)
  })
  await expect.element(screen.getByText(m.sensors_empty_title())).toBeVisible()
})

test('series still loading: tiles render, the charts are skeletons, never "no data"', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    pendingForever(qc, seriesKey())
  })
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  await expect.poll(() => skeleton('sensors-temp-chart')).not.toBeNull()
  expect(skeleton('sensors-hum-chart')).not.toBeNull()
  expect(skeleton('sensors-tiles')).toBeNull()
  expect(screen.getByText(m.sensors_chart_empty()).elements()).toHaveLength(0)
})

test('series failed: one alert in place of the charts, never "no data"', async () => {
  const { screen } = await renderSensors('', (qc) => qc.setQueryData(devicesKey, [device]))
  await expect.element(screen.getByText(m.sensors_series_error_title())).toBeVisible()
  expect(screen.getByText(m.sensors_chart_empty()).elements()).toHaveLength(0)
  expect(skeleton('sensors-temp-chart')).toBeNull()
})

test('both cached: no skeleton at all', async () => {
  const { screen } = await renderSensors('', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey(), noSeries)
  })
  await expect.element(screen.getByText('21.7°C')).toBeVisible()
  // Empty buckets are "no data", the loaded state.
  await expect.element(screen.getByText(m.sensors_chart_empty()).first()).toBeVisible()
  expect(skeleton('sensors-tiles')).toBeNull()
  expect(skeleton('sensors-temp-chart')).toBeNull()
})

test('an edit deep link keeps its params while the devices load', async () => {
  const { router } = await renderSensors('?dialog=edit&deviceId=a', (qc) => {
    pendingForever(qc, devicesKey)
    qc.setQueryData(seriesKey(), noSeries)
  })
  await expect.poll(() => skeleton('sensors-tiles')).not.toBeNull()
  expect(router.state.location.search).toMatchObject({ dialog: 'edit', deviceId: 'a' })
})

test('an edit deep link opens once the devices are in', async () => {
  const { screen } = await renderSensors('?dialog=edit&deviceId=a', (qc) => {
    qc.setQueryData(devicesKey, [device])
    qc.setQueryData(seriesKey(), noSeries)
  })
  await expect.element(screen.getByRole('dialog')).toBeVisible()
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx
```

Expected: FAIL (missing message keys; pending devices suspend the route).

- [ ] **Step 3: Add the messages**

`sv.json`: `"sensors_devices_error_title": "Kunde inte hämta sensorerna"`,
`"sensors_series_error_title": "Kunde inte hämta mätvärdena"`.
`en.json`: `"sensors_devices_error_title": "Couldn't load the sensors"`,
`"sensors_series_error_title": "Couldn't load the readings"`.
Then `bun run i18n:compile`.

- [ ] **Step 4: Implement**

Loader (keep `loaderDeps` on `range`: on the server the range picks the series to render, and on the client nothing
is awaited, so a range switch still doesn't block):

```tsx
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context: { queryClient }, deps }) =>
    loadRouteData(queryClient, {
      critical: [
        orpc.sensor.listDevices.queryOptions(),
        orpc.sensor.series.queryOptions({ input: { range: deps.range } }),
      ],
    }),
```

Reads:

```tsx
  const devicesResult = useQuery({
    ...orpc.sensor.listDevices.queryOptions(),
    // The tiles show live latest/battery/last-seen, so poll on the same cadence
    // as the short-range charts (spec §7).
    refetchInterval: 60_000,
  })
  const seriesResult = useQuery({
    ...orpc.sensor.series.queryOptions({ input: { range } }),
    refetchInterval: POLLED_RANGES.includes(range) ? 60_000 : false,
    placeholderData: keepPreviousData, // keep the old chart while a new range loads
  })
  const devices = loadFailed(devicesResult) ? undefined : devicesResult.data
  const series = loadFailed(seriesResult) ? undefined : seriesResult.data
  const roster = devices ?? []
```

- Use `roster` wherever the component used `devices` as an array: the `toChartDevices` memos, `toggleDevices`
  and `editingDevice`. The hooks stay unconditional, above any early return.
- `if (devices?.length === 0)` keeps the existing empty-state return. It only fires once the list has loaded empty.
- A failed `listDevices` returns heading + `<LoadErrorAlert title={m.sensors_devices_error_title()} query={devicesResult} />`.
- `devicesPending = firstLoadPending(devicesResult)`.
- `seriesPending = firstLoadPending(seriesResult)` and `seriesFailed = loadFailed(seriesResult)`.

Body:

```tsx
      <div className="flex flex-col gap-3">
        <RangeSelector value={range} onChange={setRange} />
      </div>

      <SectionSkeleton name="sensors-tiles" loading={devicesPending} fallbackHeight="10rem">
        <div className="flex flex-col gap-3">
          <DeviceToggles devices={toggleDevices} hidden={hidden} onToggle={toggle} />
          <section className="flex flex-col gap-2">
            <h2 className="sr-only">{m.sensors_current_heading()}</h2>
            <CurrentReadingTiles
              devices={roster}
              isAdmin={isAdmin}
              onEdit={(id) => open('edit', { deviceId: id })}
            />
          </section>
        </div>
      </SectionSkeleton>

      <LoadErrorAlert title={m.sensors_series_error_title()} query={seriesResult} />
      {seriesFailed ? null : (
        <>
          <ChartSection title={m.sensors_temp_chart_title()}>
            <SectionSkeleton name="sensors-temp-chart" loading={seriesPending || devicesPending} fallbackHeight="260px">
              <ChartBody hasData={hasData}>
                <ClimateChart devices={tempDevices} unit="°C" formatTick={formatTick} />
              </ChartBody>
            </SectionSkeleton>
          </ChartSection>
          {/* same for humidity: name="sensors-hum-chart", humDevices, unit="%" */}
        </>
      )}
```

The range selector and toggles used to share one `flex-col gap-3` wrapper. Keep the visual gap between them the same
(compare against `main` live in Task 4). Split `ChartSection` into the titled `<section>` (title always shown) and a
`ChartBody` that renders `children` or the existing 260 px "Ingen data i vald period." box. That way the skeleton
covers only the chart area and the `h2` stays real text.

Imports: `useQuery` (drop `useSuspenseQuery`), `SectionSkeleton`, `LoadErrorAlert`, `firstLoadPending`,
`loadFailed`, `loadRouteData`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bunx vitest run --project browser src/routes/_authenticated/-sensorsRoute.browser.test.tsx src/components/sensor
bun run typecheck
```

Expected: PASS. The existing sensor component tests are untouched and still pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authenticated/sensors.tsx src/routes/_authenticated/-sensorsRoute.browser.test.tsx messages
git commit -m "perf(sensors): navigate without waiting on the readings"
```

---

### Task 4: Capture the bones and verify live

Reviewers: `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (they read the
screenshots, not the JSON).

**Files:**
- Modify: `scripts/captureBones.ts` (`DEFAULT_PATHS`)
- Generated: `src/bones/*.bones.json`, `src/bones/registry.js`

- [ ] **Step 1: Local sensor data to capture against**

The local DB has no sensors (checked 2026-10-05: 0 devices). Seed two devices through the real webhook, with the dev
server running and `SHELLY_WEBHOOK_TOKEN` read from `.env`:

```bash
TOKEN=$(grep '^SHELLY_WEBHOOK_TOKEN=' .env | cut -d= -f2-)
for i in 1 2 3; do
  curl -s "http://localhost:14600/api/webhooks/shelly?token=$TOKEN&mac=a4cf12ab34cd&t=21.$i&h=4$i&batt=88" >/dev/null
  curl -s "http://localhost:14600/api/webhooks/shelly?token=$TOKEN&mac=a4cf12ab9f01&t=4.$i&h=8$i&batt=61" >/dev/null
done
```

That's enough for the tiles and one chart point each. A chart's bones are one slab anyway (ADR-0025 known limits).
The local DB already has 2 users.

- [ ] **Step 2: Add the paths and capture**

`scripts/captureBones.ts`:

```ts
const DEFAULT_PATHS = ['/charging', '/charging/economy', '/charging/patterns', '/sensors', '/users']
```

```bash
bun run bones:capture /sensors /users
git status src/bones
```

Expected: new `sensors-tiles`, `sensors-temp-chart`, `sensors-hum-chart` and `users-table` files, and an updated
registry. The charging bones must be unchanged apart from `_hash`. If the CLI skips them, run `--force` only if a
skeleton is missing.

- [ ] **Step 3: Replay check (prod build)**

Serve a local prod build. Sign in as admin, then as a member. At 375 / 768 / 1100 / 1280, light and dark:
- Throttle the network (Playwright `route` delaying `/api/rpc/sensor/*` and `/api/rpc/user/list` by 1.5 s).
- Client-navigate `/charging` → `/sensors` → `/users`.
- Screenshot skeleton vs. loaded.

Check:
- every bone sits inside its real section;
- the loaded page doesn't jump by more than a few px (record any shift for step 7, don't chase it here);
- `prefers-reduced-motion` keeps the bones static;
- a full load of each page logs 0 hydration errors.

- [ ] **Step 4: Bundle check**

`bun run build` and compare the bones registry chunk with `main`'s (~27 KB gz). Record the delta for the PR. A large
delta (> 8 KB gz) is a finding to raise with the owner, not to fix silently.

- [ ] **Step 5: Commit**

```bash
git add scripts/captureBones.ts src/bones
git commit -m "perf(ui): capture the sensor and user list skeletons"
```

---

### Task 5: Roadmap

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

- [ ] **Step 1: Update the status table**

- Row 1: status `checkpoint passed`. Checkpoint result: *2026-10-05: owner confirmed the drag is gone on the phone;
  prod logs show 0 `/_serverFn` calls since the #89 deploy (230 in the 6 h before) across `/charging`, economy,
  patterns, `/sensors`, `/users`.*
- Row 2: plan link to this file, PR link, status `PR open`.
- New row 7: *Layout shifts after deferred loading (owner points out where; small shifts seen after step 1)*. Plan
  `—`, PR `—`, status `needs shaping`. Add a checkpoint 7 line: *the owner reviews the spots they reported, live on
  prod, and they no longer shift.*

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/roadmaps/2026-10-05-client-performance.md docs/superpowers/plans/2026-10-05-client-perf-2-deferred-sensors-users.md
git commit -m "docs(perf): record checkpoint 1 and add the layout-shift step"
```

---

### Task 6: Branch review, pre-PR gate, PR

- [ ] Branch review (feature-workflow Phase 5): `code-reviewer` over the whole diff, plus a general correctness pass.
  No schema, service or auth changes, so no `migration-guard`, `test-completeness` or security pass.
- [ ] Pre-PR gate (`docs/feature-workflow.md#pre-pr-gate`), the sv/en key check included.
- [ ] Re-run Task 0 Step 3's measurement on the branch's prod build and put before/after in the PR.
- [ ] PR title `perf(ui): navigate instantly on the sensor and user pages`. The body uses the template, links
  ADR-0025 and the roadmap, and lists the real-world gate: checkpoint 2, owner on the phone + prod logs.
