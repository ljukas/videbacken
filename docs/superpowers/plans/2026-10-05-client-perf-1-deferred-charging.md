# Client performance step 1 — deferred route loading on the charging pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Navigating between `/charging`, `/charging/economy` and `/charging/patterns` commits immediately, with
section skeletons filling in, instead of freezing the old page for a second or more.

**Architecture:**
- A shared loader helper, `loadRouteData`, awaits a page's critical queries only on the server and starts everything
  without awaiting on the client.
- The `_authenticated` guard reads the session from the query cache (5 min) instead of calling a server function on
  every navigation.
- Sections show boneyard-js skeletons, captured from the real UI, through one wrapper, `SectionSkeleton`.

**Tech Stack:** TanStack Start/Router 1.170 + TanStack Query 5.104, oRPC, boneyard-js 1.10 (React), Vitest
(node + browser projects), Playwright (capture script).

**Spec:** [ADR-0025](../../adr/0025-deferred-route-loading.md). Read it first. Roadmap:
[client performance](../roadmaps/2026-10-05-client-performance.md), step 1 (baseline numbers there).

## Global Constraints

- Client code may only `import type` from services (CLAUDE.md gotcha). `loadRouteData` and `SectionSkeleton` are
  client-safe modules.
- Never `console.*` in app code (ADR-0003). The capture script under `scripts/` may print to stdout, like
  `scripts/deriveEnergyMix.ts`.
- User-facing text is Paraglide (`messages/sv.json` source of truth, `en.json` key-complete).
- Every screen responsive at mobile 375 / tablet 768 / desktop 1280 (boneyard breakpoints are exactly these).
- Reduced motion: no skeleton animation under `prefers-reduced-motion: reduce` (ADR-0015).
- Session cache lifetime = Better Auth `session.cookieCache.maxAge` (5 min), via one shared constant.
- The cached session holds `{ user }` or `null`, never the session or its token.
- No `useSuspenseQuery` for data a client navigation defers (ADR-0025 §3). It stays only for `user.me`.
- Conventional Commits, one hat per commit; reviewers must **not** run vitest (shared local DB, see memory).

## Review Focus

1. **Health still loading must not claim "Aldrig synkad".** `ChargingHeading` with `lastSuccessAt === undefined`
   renders a blank line of the same height, not "never synced". Pinned in Task 5.
2. **Tariffs still loading must not act like "no tariffs".** No `noTariff` CostNotice, and a deep link
   `?dialog=tariffEdit&tariffId=…` keeps its dialog param instead of being cleared as "unavailable". Pinned in
   Task 5.
3. **A failed SSR read must not cause a hydration mismatch.** The skeleton shows only after hydration
   (`useHydrated`), the same rule `LoadErrorAlert` already follows. Pinned in Task 4.
4. **A revisit with cached data (even stale) shows the data, not a skeleton.** Pinned in Tasks 3 and 4.
5. **A scope/year switch to a never-loaded key keeps the previous data dimmed** (`keepPreviousData`), not a skeleton.
   Pinned in Task 4.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/authConfig.ts` *(new)* | `SESSION_COOKIE_CACHE_MAX_AGE_S`, shared by `auth.ts` and the client session query (client-safe) |
| `src/lib/sessionQuery.ts` *(new)* | `sessionQueryOptions`: the guard's cached `{ user } \| null` |
| `src/lib/query/routeData.ts` *(new)* | `loadRouteData(queryClient, { critical, deferred })`, the one await-vs-defer decision |
| `src/components/layout/SectionSkeleton.tsx` *(new)* | The only boneyard import in pages: hydration-gated `loading`, viewport breakpoints, fallback block |
| `src/components/evCharging/LoadErrorAlert.tsx` | + `firstLoadPending(query)` next to `loadFailed` |
| `src/lib/bones.ts` *(new)* | Imports the generated bones registry and applies reduced motion; imported once from `src/router.tsx` |
| `src/bones/` *(generated, committed)* | `*.bones.json` + `registry.js` from the boneyard CLI (Biome-ignored) |
| `boneyard.config.json` *(new)* | Breakpoints, output dir, colours, animation |
| `scripts/captureBones.ts` *(new)* | `bun run bones:capture`: Mailpit sign-in → boneyard CLI with the session cookies |
| `src/routes/_authenticated.tsx` | Guard reads `sessionQueryOptions` |
| `src/routes/_authenticated/charging/index.tsx`, `economy.tsx`, `patterns.tsx` | Loaders → `loadRouteData`; suspense reads → `useQuery`; sections wrapped |
| `src/components/evCharging/ChargingHeading.tsx` | `lastSuccessAt` may be `undefined` (unknown yet) |

The session page (`charging/sessions/$sessionId.tsx`) is **not** changed: its loader awaits on purpose (not-found
decision, ADR-0025 §1 exception), and it gains the cached guard for free.

---

### Task 0: Verify `main` still matches this plan

**Files:** none (read-only)

- [ ] **Step 1: Check the assumptions**

```bash
git fetch origin && git log --oneline -1 origin/main
grep -n "getSession()" src/routes/_authenticated.tsx            # expect line ~16 inside beforeLoad
grep -n "maxAge" src/lib/auth.ts                                 # expect cookieCache maxAge: 5 * 60
grep -c "prefetchQuery\|ensureQueryData" src/routes/_authenticated/charging/index.tsx   # expect ~16
grep -n "useSuspenseQuery(" src/routes/_authenticated/charging/*.tsx
grep -n "environmentManager" node_modules/@tanstack/query-core/src/environmentManager.ts | head -2
docker exec videbacken-db-1 psql -U videbacken -d videbacken -Atc "select count(*) from ev_charge_session"  # expect > 0
```

If a file moved or a loader changed shape, update the affected task before building. If the local DB has no
sessions, get data first: run the dev server with `ZAPTEC_ADAPTER=fake` and press "Synka nu" as admin.

---

### Task 1: Spike — can boneyard-js capture and replay a signed-in section?

This is the ADR-0025 gate. **Outcome:** `go` (keep boneyard) or `no-go` (switch `SectionSkeleton`'s internals to
react-loading-skeleton in Task 4), recorded in the ADR in Task 7.

**Files:**
- Modify: `package.json` (dependency + `bones:capture` script)
- Create: `boneyard.config.json`, `scripts/captureBones.ts`
- Modify: `biome.json` (ignore `src/bones/`)
- Temporary (not committed): a `<Skeleton name="charging-totals">` around the totals tiles in `charging/index.tsx`

**Interfaces:**
- Produces: `bun run bones:capture [paths…]` (default: the three charging pages), writes `src/bones/`.
- Produces: `boneyard.config.json` read by both the CLI and the generated registry.

- [ ] **Step 1: Install**

```bash
bun add boneyard-js@1.10.0
```

`boneyard-js` depends on `playwright`; we already have `playwright` in devDependencies, so it dedupes. Confirm
`bun pm ls | grep playwright` shows one version.

- [ ] **Step 2: Config**

`boneyard.config.json`:

```json
{
  "breakpoints": [375, 768, 1280],
  "out": "./src/bones",
  "wait": 1500,
  "animate": "pulse",
  "color": "#e9ecf1",
  "darkColor": "#1f2633"
}
```

The colours start as our slate `--muted` light/dark values in hex. boneyard's pulse lightens/darkens the colour
with `adjustColor`, which needs hex, so don't use `var(...)` here. Compare them with the real `--muted` in
`src/styles/app.css` at replay time (Step 6) and adjust.

`biome.json`: add `"!**/src/bones/**"` to `files.includes`, next to `"!**/src/paraglide/**"`. The registry and the
JSON files are generated.

- [ ] **Step 3: The capture script**

`scripts/captureBones.ts`:

```ts
// Captures boneyard skeletons ("bones") from the running dev app, signed in.
//
// boneyard's own headless browser has no session, so every authed route would
// capture /login. This signs a Playwright browser in through the local magic
// link (Mailpit), then runs the boneyard CLI with the session cookies.
//
// Usage (dev stack up, realistic local data, ADR-0025):
//   BETTER_AUTH_URL=http://localhost:14610 bunx vite dev --port 14610 --strictPort   # one terminal
//   bun run bones:capture                       # the default pages
//   bun run bones:capture /charging/economy     # just these paths
//
// Re-run after changing a skeleton-wrapped section's layout, then commit src/bones/.
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import './loadEnv'

const ORIGIN = process.env.BONES_ORIGIN ?? 'http://localhost:14610'
const MAILPIT = 'http://localhost:14602'
const DEFAULT_PATHS = ['/charging', '/charging/economy', '/charging/patterns']

const email = process.env.INITIAL_ADMIN_EMAILS?.split(',')[0]?.trim()
if (!email) {
  console.error('INITIAL_ADMIN_EMAILS is unset (.env); the first address signs in.')
  process.exit(1)
}
const paths = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PATHS

type MailpitList = { messages: { ID: string; To: { Address: string }[]; Created: string }[] }

async function latestMagicLink(since: number): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as MailpitList
    const msg = list.messages.find(
      (x) => x.To.some((t) => t.Address === email) && Date.parse(x.Created) >= since,
    )
    if (msg) {
      const body = (await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json()) as {
        HTML: string
        Text: string
      }
      const link = `${body.Text}\n${body.HTML}`.match(/https?:\/\/[^\s"<>]+magic-link\/verify[^\s"<>]+/)
      if (link) return link[0].replaceAll('&amp;', '&')
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('No magic-link email arrived in Mailpit within 30 s')
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const since = Date.now() - 1000
await page.goto(`${ORIGIN}/login`, { waitUntil: 'load' })
// Before hydration the form submits as a GET; Vite's HMR socket means
// `networkidle` never fires, so wait a fixed beat instead.
await page.waitForTimeout(4000)
await page.getByLabel('E-post').fill(email)
await page.getByRole('button', { name: 'Skicka inloggningslänk' }).click()
await page.goto(await latestMagicLink(since), { waitUntil: 'load' })
const cookies = (await context.cookies()).filter((c) => c.name.startsWith('better-auth.'))
await browser.close()
if (!cookies.some((c) => c.name.endsWith('session_token'))) {
  console.error('Signed in, but no better-auth session cookie was set.')
  process.exit(1)
}

const result = spawnSync(
  'bunx',
  [
    'boneyard-js',
    'build',
    ...paths.map((p) => `${ORIGIN}${p}`),
    '--no-scan',
    ...cookies.flatMap((c) => ['--cookie', `${c.name}=${c.value}`]),
  ],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
```

`package.json` scripts: `"bones:capture": "bun scripts/captureBones.ts"`.

`scripts/loadEnv.ts` loads `.env` and then `.env.local` on import (dotenv `config`), so the bare import is enough.
The script never reads `DATABASE_URL`.

- [ ] **Step 4: Temporary capture target**

In `charging/index.tsx`, wrap only the totals `<section>` (the one holding `<TotalsTiles>`) in boneyard directly:

```tsx
import { Skeleton } from 'boneyard-js/react'
// …
<Skeleton name="charging-totals" loading={false} select="viewport">
  <section className="flex flex-col gap-2">…unchanged…</section>
</Skeleton>
```

- [ ] **Step 5: Capture**

Start the dev server as in the script header, then run `bun run bones:capture /charging`.

Expected: the CLI logs "Applying N cookie(s)", visits `/charging` at 375/768/1280, and writes
`src/bones/charging-totals.bones.json` plus `src/bones/registry.js`. `networkidle` may hit its 15 s timeout
(the CLI still captures). Open the JSON: there are three breakpoint entries, each with a non-zero `height` and bones
that look like 3–4 tiles.

If it captured `/login` (tiny bones, or a "login" name), the cookies didn't apply. Check the cookie names and
domain, and whether the CLI wants `localhost` vs `127.0.0.1`.

- [ ] **Step 6: Replay**

Temporarily add `import '~/bones/registry'` at the top of `src/router.tsx` and set
`loading={true}` on the temporary Skeleton. Drive the page with the worktree's Playwright (signed in as in the
script):

- Screenshot the totals area at 375, 768 and 1280 px, in light, then in dark (`videbacken-theme=dark` cookie).
- Bones must sit where the tiles sit, sized like them, in a colour that reads as our muted surface in both themes.
- Under `reducedMotion: 'reduce'` (Playwright context option), with `configureBoneyard({ animate: 'solid' })` called
  after the registry import, the bones must not pulse.

**Go** if all of those hold. **No-go** if capture can't be made to work signed in within ~1 hour of fiddling, or
replayed bones are visibly misplaced at any width. Record what you saw (screenshots in the PR description, the
verdict in Task 7).

- [ ] **Step 7: Clean up and commit the keepers**

Revert the temporary Skeleton, the `loading` hack and the router import. Delete `src/bones/` (Task 6 captures for
real). Then commit:

```bash
git add package.json bun.lock boneyard.config.json biome.json scripts/captureBones.ts
git commit -m "build(perf): add boneyard-js and a signed-in bones capture script"
```

If no-go: `bun remove boneyard-js && bun add react-loading-skeleton`, drop `boneyard.config.json`, the script, the
`bones:capture` entry and the biome ignore, and commit
`build(perf): add react-loading-skeleton for section skeletons`.

**Reviewers:** `code-reviewer` + a reviewer loading `vercel-react-best-practices` (focus: the script's sign-in
robustness; nothing in it may run in the app bundle).

---

### Task 2: Cached session for the `_authenticated` guard

**Files:**
- Create: `src/lib/authConfig.ts`, `src/lib/sessionQuery.ts`, `src/lib/sessionQuery.test.ts`
- Modify: `src/lib/auth.ts` (use the constant), `src/routes/_authenticated.tsx:15-27`

**Interfaces:**
- Produces: `SESSION_COOKIE_CACHE_MAX_AGE_S: number` (= 300).
- Produces: `sessionQueryOptions`, TanStack `queryOptions` with key `['session']`, data
  `{ user: Session['user'] } | null`.

- [ ] **Step 1: Write the failing test** (`src/lib/sessionQuery.test.ts`, node project, no DB)

```ts
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const getSession = vi.fn()
vi.mock('~/lib/getSession', () => ({ getSession: () => getSession() }))

const { sessionQueryOptions } = await import('./sessionQuery')
const { SESSION_COOKIE_CACHE_MAX_AGE_S } = await import('./authConfig')

const user = { id: 'u1', email: 'a@example.se', role: 'admin', deletedAt: null }

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-05T08:00:00Z') })
  getSession.mockReset()
})
afterEach(() => vi.useRealTimers())

test('keeps only the user, never the session or its token', async () => {
  getSession.mockResolvedValue({ session: { token: 'secret-token', id: 's1' }, user })
  const data = await new QueryClient().fetchQuery(sessionQueryOptions)
  expect(data).toEqual({ user })
  expect(JSON.stringify(data)).not.toContain('secret-token')
})

test('no session is null', async () => {
  getSession.mockResolvedValue(null)
  expect(await new QueryClient().fetchQuery(sessionQueryOptions)).toBeNull()
})

test('reuses the session for the cookie-cache lifetime, then asks the server again', async () => {
  getSession.mockResolvedValue({ session: { token: 't' }, user })
  const qc = new QueryClient()
  await qc.fetchQuery(sessionQueryOptions)
  vi.advanceTimersByTime(SESSION_COOKIE_CACHE_MAX_AGE_S * 1000 - 1)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(2)
  await qc.fetchQuery(sessionQueryOptions)
  expect(getSession).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run it, expect failure**

`bunx vitest run src/lib/sessionQuery.test.ts`. Expected: FAIL, cannot resolve `./sessionQuery`.

- [ ] **Step 3: Implement**

`src/lib/authConfig.ts`:

```ts
// Better Auth's session cookie cache lifetime (auth.ts `session.cookieCache`).
// The client guard caches the session for exactly as long (ADR-0025 §2): the
// server-side getSession() could already answer from a cookie this old, so the
// guard is no staler than before. Client-safe: no auth/db imports.
export const SESSION_COOKIE_CACHE_MAX_AGE_S = 5 * 60
```

In `src/lib/auth.ts`, replace `maxAge: 5 * 60,` with `maxAge: SESSION_COOKIE_CACHE_MAX_AGE_S,` and import it from
`./authConfig`.

`src/lib/sessionQuery.ts`:

```ts
import { queryOptions } from '@tanstack/react-query'
import { SESSION_COOKIE_CACHE_MAX_AGE_S } from './authConfig'
import { getSession } from './getSession'

// The `_authenticated` guard's session, cached so a client navigation doesn't
// call the server function every time (ADR-0025 §2). Holds only the user: the
// SSR query integration serializes the cache into the HTML, and the session
// token must never be in it. Sign-out clears it (useSignOut → queryClient.clear()).
export const sessionQueryOptions = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const session = await getSession()
    return session ? { user: session.user } : null
  },
  staleTime: SESSION_COOKIE_CACHE_MAX_AGE_S * 1000,
})
```

`src/routes/_authenticated.tsx` `beforeLoad`:

```tsx
  beforeLoad: async ({ location, context: { queryClient } }) => {
    // fetchQuery: cached for the cookie-cache lifetime, re-checked after it
    // (ensureQueryData would keep returning a stale session forever).
    const session = await queryClient.fetchQuery(sessionQueryOptions)
    if (!session || session.user.deletedAt) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
```

The rest of `beforeLoad` (the server-only `rememberBrowserUser`, `return { user: session.user }`) is unchanged.
Replace the `getSession` import with `sessionQueryOptions`.

- [ ] **Step 4: Run, expect PASS; typecheck**

`bunx vitest run src/lib/sessionQuery.test.ts && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/authConfig.ts src/lib/sessionQuery.ts src/lib/sessionQuery.test.ts src/lib/auth.ts src/routes/_authenticated.tsx
git commit -m "perf(auth): serve the route guard's session from the query cache"
```

**Reviewers:** `code-reviewer` + a reviewer loading `better-auth-security-best-practices`. Ask them to confirm:
nothing beyond `user` is cached; a revoked or soft-deleted user is still refused by every RPC; sign-out clears the
cache before any further authed render; a server request never reuses another request's cache.

---

### Task 3: `loadRouteData` — the await-vs-defer helper

**Files:**
- Create: `src/lib/query/routeData.ts`, `src/lib/query/routeData.test.ts`

**Interfaces:**
- Produces:
  `loadRouteData(queryClient: QueryClient, { critical?, deferred? }: { critical?: readonly MaybeRouteQuery[]; deferred?: readonly MaybeRouteQuery[] }): Promise<void>`
  where `type RouteQuery = { queryKey: QueryKey }` (any oRPC `queryOptions(...)` result) and
  `type MaybeRouteQuery = RouteQuery | null | false` (so `isAdmin && query` reads cleanly).

- [ ] **Step 1: Write the failing test** (`src/lib/query/routeData.test.ts`, node project)

```ts
import { environmentManager, QueryClient } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { loadRouteData } from './routeData'

afterEach(() => environmentManager.setIsServer(() => typeof window === 'undefined'))

const never = () => new Promise<never>(() => {})
const q = (key: string, queryFn: () => Promise<unknown>) => ({ queryKey: [key], queryFn })

test('on the server it awaits critical queries', async () => {
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient()
  await loadRouteData(qc, { critical: [q('a', async () => 1)] })
  expect(qc.getQueryData(['a'])).toBe(1)
})

test('on the server deferred queries start but are not awaited', async () => {
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient()
  const deferredFn = vi.fn(never)
  await loadRouteData(qc, { deferred: [q('d', deferredFn)] }) // resolves despite a never-ending fetch
  expect(deferredFn).toHaveBeenCalledOnce()
})

test('on the client it awaits nothing', async () => {
  environmentManager.setIsServer(() => false)
  const qc = new QueryClient()
  const criticalFn = vi.fn(never)
  await loadRouteData(qc, { critical: [q('a', criticalFn)] })
  expect(criticalFn).toHaveBeenCalledOnce()
  expect(qc.getQueryState(['a'])?.status).toBe('pending')
})

test('on the client stale cached data stays readable while it refreshes', async () => {
  environmentManager.setIsServer(() => false)
  const qc = new QueryClient()
  qc.setQueryData(['a'], 'old', { updatedAt: Date.now() - 60_000 })
  const refresh = vi.fn(async () => 'new')
  await loadRouteData(qc, { critical: [{ ...q('a', refresh), staleTime: 20_000 }] })
  expect(qc.getQueryData(['a'])).toBe('old') // the page renders this at once
  expect(refresh).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(qc.getQueryData(['a'])).toBe('new'))
})

test('a failing query never rejects the loader', async () => {
  environmentManager.setIsServer(() => true)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await expect(
    loadRouteData(qc, { critical: [q('x', async () => Promise.reject(new Error('boom')))] }),
  ).resolves.toBeUndefined()
})

test('null and false entries are skipped', async () => {
  environmentManager.setIsServer(() => true)
  await expect(loadRouteData(new QueryClient(), { critical: [null, false] })).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run it, expect failure**

`bunx vitest run src/lib/query/routeData.test.ts`. Expected: FAIL, cannot resolve `./routeData`.

- [ ] **Step 3: Implement** (`src/lib/query/routeData.ts`)

```ts
import { environmentManager, type QueryClient, type QueryKey } from '@tanstack/react-query'

// Any oRPC `queryOptions(...)` result. Typed by its key only: each one goes to
// prefetchQuery unchanged, so its queryFn travels at runtime.
export type RouteQuery = { queryKey: QueryKey }
// `isAdmin && query` reads cleanly in a loader's list.
export type MaybeRouteQuery = RouteQuery | null | false

const present = (q: MaybeRouteQuery): q is RouteQuery => Boolean(q)

/**
 * A route loader's data (ADR-0025 §1). The one place that decides what a
 * navigation waits for:
 * - server (first load, refresh): awaits `critical` so the HTML is complete;
 *   `deferred` starts without awaiting and streams to the client.
 * - client: starts everything, awaits nothing. The navigation commits at once,
 *   cached data (even stale) renders while it refreshes, and each section shows
 *   its skeleton until its query lands.
 * Never rejects: prefetchQuery swallows errors, and each section shows its own
 * LoadErrorAlert (ADR-0016).
 */
export async function loadRouteData(
  queryClient: QueryClient,
  {
    critical = [],
    deferred = [],
  }: { critical?: readonly MaybeRouteQuery[]; deferred?: readonly MaybeRouteQuery[] },
): Promise<void> {
  for (const query of deferred.filter(present)) void queryClient.prefetchQuery(query)
  const started = critical.filter(present).map((query) => queryClient.prefetchQuery(query))
  if (environmentManager.isServer()) await Promise.all(started)
}
```

- [ ] **Step 4: Run, expect PASS**

`bunx vitest run src/lib/query/routeData.test.ts && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/query/
git commit -m "perf(router): add loadRouteData, awaiting route data on the server only"
```

**Reviewers:** `code-reviewer` + a reviewer loading `vercel-react-best-practices`. Ask them to check that
`environmentManager.isServer()` is the right server check under TanStack Start SSR, and that the deferred-on-server
queries really stream: `shouldDehydrateQuery` in `src/router.tsx` includes `pending`.

---

### Task 4: `SectionSkeleton`, `firstLoadPending`, and the bones registry wiring

**Files:**
- Create: `src/components/layout/SectionSkeleton.tsx`, `src/components/layout/SectionSkeleton.browser.test.tsx`,
  `src/lib/bones.ts`
- Modify: `src/components/evCharging/LoadErrorAlert.tsx` (add `firstLoadPending`),
  `src/components/evCharging/LoadErrorAlert.browser.test.tsx` (its tests), `src/router.tsx` (import `~/lib/bones`)

**Interfaces:**
- Consumes: `loadFailed`, `LoadErrorQuery` (existing, `LoadErrorAlert.tsx`).
- Produces: `firstLoadPending(query: LoadErrorQuery): boolean`. True when there's no data of its own and no
  placeholder, and nothing has failed.
- Produces:
  `<SectionSkeleton name: string, loading: boolean, className?: string, fallbackHeight?: string, children>`.
  It renders `children` plainly when not loading (no wrapper divs, so a failed or empty section leaves no stray
  gap). When loading and hydrated, it renders boneyard's skeleton (or the fallback block if no bones are captured).
  It always wraps while the boneyard CLI is capturing.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/evCharging/LoadErrorAlert.browser.test.tsx`:

```tsx
import { firstLoadPending } from './LoadErrorAlert'

const base = { isPlaceholderData: false, errorUpdateCount: 0, isFetching: true, refetch: () => {} }

test('firstLoadPending: nothing yet and nothing failed', () => {
  expect(firstLoadPending({ ...base, data: undefined })).toBe(true)
})
test('firstLoadPending: own data is not pending', () => {
  expect(firstLoadPending({ ...base, data: { x: 1 } })).toBe(false)
})
test("firstLoadPending: the previous key's placeholder keeps showing (dimmed), no skeleton", () => {
  expect(firstLoadPending({ ...base, data: { x: 1 }, isPlaceholderData: true })).toBe(false)
})
test('firstLoadPending: a failure shows the alert, not a skeleton', () => {
  expect(firstLoadPending({ ...base, data: undefined, errorUpdateCount: 1 })).toBe(false)
})
```

Create `src/components/layout/SectionSkeleton.browser.test.tsx`:

```tsx
import { expect, test } from 'vitest'
import { renderWithRouter } from '~test/browser/render'
import { SectionSkeleton } from './SectionSkeleton'

test('not loading: the children, with no wrapper around them', async () => {
  const { screen } = await renderWithRouter(
    <div data-testid="parent">
      <SectionSkeleton name="t" loading={false}>
        <p>content</p>
      </SectionSkeleton>
    </div>,
  )
  await expect.element(screen.getByText('content')).toBeVisible()
  const parent = screen.getByTestId('parent').element()
  expect(parent.firstElementChild?.tagName).toBe('P')
})

test('loading, no captured bones: a busy fallback block instead of the children', async () => {
  const { screen } = await renderWithRouter(
    <SectionSkeleton name="never-captured" loading>
      <p>content</p>
    </SectionSkeleton>,
  )
  await expect.element(screen.getByText('content')).not.toBeInTheDocument()
  const busy = document.querySelector('[data-boneyard="never-captured"]')
  expect(busy?.getAttribute('aria-busy')).toBe('true')
  expect(document.querySelector('[data-section-skeleton-fallback]')).not.toBeNull()
})
```

Check `test/browser/render.tsx` for the exact helper name and return shape (`renderWithRouter` / `screen`) and adapt
the calls. The hydration gate needs a router (`useHydrated`), hence the router helper.

- [ ] **Step 2: Run, expect failure**

`bunx vitest run --project browser src/components/layout/SectionSkeleton.browser.test.tsx src/components/evCharging/LoadErrorAlert.browser.test.tsx`
Expected: FAIL, `firstLoadPending` is not exported and `./SectionSkeleton` can't be resolved.

- [ ] **Step 3: Implement**

`LoadErrorAlert.tsx`, below `loadFailed`:

```tsx
// Whether a section has nothing to show yet and is still loading (ADR-0025 §3):
// no data of its own or placeholder, and no failure. A failed read shows the
// alert instead, and the previous key's placeholder data stays on screen dimmed.
export const firstLoadPending = (query: LoadErrorQuery) =>
  query.data === undefined && !loadFailed(query)
```

`src/components/layout/SectionSkeleton.tsx` (go variant):

```tsx
import { useHydrated } from '@tanstack/react-router'
import { Skeleton } from 'boneyard-js/react'
import type * as React from 'react'

// Set by the boneyard CLI while it captures; the section must be wrapped then
// so the CLI finds it by name, even though it isn't loading.
const capturing = () =>
  typeof window !== 'undefined' &&
  (window as { __BONEYARD_BUILD?: boolean }).__BONEYARD_BUILD === true

/**
 * A section's loading state (ADR-0025 §3–4), the only place pages meet boneyard.
 * Loading shows the bones captured for `name` (`bun run bones:capture`), or a
 * plain block if none are captured yet. Only after hydration: a server-rendered
 * failed read has no skeleton, so the first client render mustn't have one either.
 * Not loading renders the children as-is, with no wrapper, so a section that
 * renders nothing leaves no gap in the page's flex layout.
 */
export function SectionSkeleton({
  name,
  loading,
  className,
  fallbackHeight = '8rem',
  children,
}: {
  name: string
  loading: boolean
  className?: string
  /** The fallback block's height until bones are captured. */
  fallbackHeight?: string
  children: React.ReactNode
}) {
  const hydrated = useHydrated()
  const showLoading = loading && hydrated
  if (!showLoading && !capturing()) return children
  return (
    <Skeleton
      name={name}
      loading={showLoading}
      select="viewport"
      className={className}
      fallback={
        <div
          data-section-skeleton-fallback
          className="rounded-lg bg-muted"
          style={{ height: fallbackHeight }}
        />
      }
    >
      {children}
    </Skeleton>
  )
}
```

No-go variant (only if Task 1 said no-go). Same props and same early return, with the body below. Delete the
`capturing` check, and in the test use `[aria-busy="true"]` instead of the `data-boneyard` selector.

```tsx
import ReactLoadingSkeleton from 'react-loading-skeleton'
import 'react-loading-skeleton/dist/skeleton.css'
// …
  return (
    <div aria-busy="true" className={className}>
      <ReactLoadingSkeleton height={fallbackHeight} borderRadius="0.5rem" />
    </div>
  )
```

`src/lib/bones.ts` (go only):

```ts
// The captured skeletons (src/bones/, generated by `bun run bones:capture`) and
// the one runtime tweak boneyard lacks: honour reduced motion (ADR-0015). The
// generated registry already applied boneyard.config.json.
import { configureBoneyard } from 'boneyard-js/react'
import '~/bones/registry'

if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  configureBoneyard({ animate: 'solid' })
}
```

Until Task 6 captures, `src/bones/registry.js` doesn't exist. Create it with `bun run bones:capture` against any one
page now, or write the empty form the CLI generates (`import { registerBones } from 'boneyard-js'` +
`registerBones({})`), so the import resolves. Then add `import '~/lib/bones'` to `src/router.tsx` next to
`import '~/lib/zodLocale'`.

- [ ] **Step 4: Run, expect PASS**

Run the two browser test files from Step 2, then `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/SectionSkeleton.tsx src/components/layout/SectionSkeleton.browser.test.tsx src/components/evCharging/LoadErrorAlert.tsx src/components/evCharging/LoadErrorAlert.browser.test.tsx src/lib/bones.ts src/bones src/router.tsx
git commit -m "feat(ui): add SectionSkeleton, a hydration-safe section loading state"
```

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (focus:
hydration safety, no layout gap, `aria-busy`, reduced motion, nothing heavy in the entry chunk from the registry).

---

### Task 5: `/charging` overview — deferred loader, no suspense reads, section skeletons

**Files:**
- Modify: `src/routes/_authenticated/charging/index.tsx`, `src/components/evCharging/ChargingHeading.tsx`,
  `src/components/evCharging/ChargingHeading.browser.test.tsx`, `messages/sv.json`, `messages/en.json`
- Test: `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` (extend)

**Interfaces:**
- Consumes: `loadRouteData` (Task 3); `SectionSkeleton`, `firstLoadPending` (Task 4).
- Produces: `ChargingHeading` prop `lastSuccessAt: Date | null | undefined` (`undefined` = not known yet), used by
  Task 6 too.
- Skeleton names: `charging-totals`, `charging-chart`, `charging-sessions`, `charging-tariffs`.

- [ ] **Step 1: Write the failing tests**

`ChargingHeading.browser.test.tsx`, a new test:

```tsx
test('sync time not known yet: no "never synced" claim, the line keeps its height', async () => {
  const { screen } = await renderWithProviders(<ChargingHeading lastSuccessAt={undefined} />)
  await expect.element(screen.getByText(m.charging_never_synced())).not.toBeInTheDocument()
  expect(document.querySelector('[data-sync-line]')?.textContent).toBe(' ')
})
```

In `-vehicleScopePages.browser.test.tsx`, add tests that stage a still-loading read. Use the file's existing helpers:
- `renderPage(route, path, search, prepare, role?)` returns `{ screen, router, qc }`.
- `seedOverview(qc, vehicle, sessions)` and `seedOverviewShell(qc)` seed a loaded overview.
- `session(id, kwh)` and `radio(screen, name)`.

Add one helper at the top. A query whose fetch never settles stays `pending`. Remove any seeded copy first, because
`prefetchQuery` won't refetch fresh seeded data under the file's `staleTime: Infinity`:

```tsx
const pendingForever = (qc: QueryClient, queryKey: readonly unknown[]) => {
  qc.removeQueries({ queryKey, exact: true })
  void qc.prefetchQuery({ queryKey, queryFn: () => new Promise(() => {}) })
}
const overviewKey = orpc.evCharging.overview.queryOptions({ input: { year: undefined, vehicle: 'all' } }).queryKey
const tariffsKey = orpc.tariff.list.queryOptions().queryKey
```

```tsx
test('overview still loading: totals and chart show skeletons, the scope toggle is usable', async () => {
  const { screen } = await renderPage(Overview, '/charging', '', (qc) => {
    seedOverview(qc, 'all', [session('s1', 5)])
    seedOverviewShell(qc)
    pendingForever(qc, overviewKey)
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  expect(document.querySelector('[data-boneyard="charging-totals"]')).not.toBeNull()
  expect(document.querySelector('[data-boneyard="charging-chart"]')).not.toBeNull()
})

test('tariffs still loading: no "set up a tariff" notice, and the edit dialog stays in the URL', async () => {
  const { screen, router } = await renderPage(Overview, '/charging', '?dialog=tariffEdit&tariffId=t1', (qc) => {
    seedOverview(qc, 'all', [session('s1', 5)])
    seedOverviewShell(qc)
    pendingForever(qc, tariffsKey)
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  await expect.element(screen.getByText(m.charging_cost_notice_setup_admin())).not.toBeInTheDocument()
  expect(router.state.location.search).toMatchObject({ dialog: 'tariffEdit', tariffId: 't1' })
  expect(document.querySelector('[data-boneyard="charging-tariffs"]')).not.toBeNull()
})
```

If `seedOverview` doesn't seed `tariff.list` itself, `pendingForever` still applies (it only removes an exact
match). If the overview doesn't have energy with that seeding, the "no tariff" assertion is vacuous: use the session
kWh the file's existing CostNotice tests use, so `hasEnergy` is true.

- [ ] **Step 2: Run, expect failure**

`bunx vitest run --project browser src/components/evCharging/ChargingHeading.browser.test.tsx src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`
Expected: the new tests FAIL (no `data-sync-line`, no skeleton attributes, and the tariff dialog param cleared).

- [ ] **Step 3: `ChargingHeading` accepts "not known yet"**

```tsx
  lastSuccessAt: Date | null | undefined
// …
        <p data-sync-line className="text-muted-foreground text-xs" suppressHydrationWarning>
          {lastSuccessAt === undefined
            ? ' ' // not known yet: hold the line's height, claim nothing
            : lastSuccessAt
              ? m.charging_last_synced({ time: formatAgo(lastSuccessAt) })
              : m.charging_never_synced()}
        </p>
```

Update the doc comment: "`lastSuccessAt` is `undefined` while the sync status is still loading."

- [ ] **Step 4: The loader**

Replace the `loader` in `charging/index.tsx` with:

```tsx
  // ADR-0025: the server waits for what renders at the top; the client waits
  // for nothing (sections show skeletons). Datakällor's histories, the car's
  // latest state and the log coverage sit at the bottom, so they're deferred.
  loader: async ({ context: { queryClient, user }, deps }) => {
    const admin = user.role === 'admin'
    await loadRouteData(queryClient, {
      critical: [
        orpc.evCharging.overview.queryOptions({ input: { year: deps.year, vehicle: deps.vehicle } }),
        sessionsQuery(SESSIONS_PAGE, deps.vehicle),
        orpc.evCharging.costOverview.queryOptions({ input: { year: deps.year, vehicle: deps.vehicle } }),
        orpc.tariff.list.queryOptions(),
        orpc.evCharging.syncStatus.queryOptions(),
        // The sources' health drives the alerts at the top: awaited, so they don't jump in.
        admin && pricesHealthQuery,
        admin && skodaHealthQuery,
        admin && emaldoHealthQuery,
      ],
      deferred: [
        admin && orpc.evCharging.recentRuns.queryOptions({ input: { limit: RECENT_RUNS } }),
        admin && pricesRunsQuery,
        admin && skodaRunsQuery,
        admin && emaldoRunsQuery,
        admin && vehicleCoverageQuery,
        admin && vehicleLatestQuery,
      ],
    })
    // The costs need the sessions' ids. On the server the sessions are in by
    // now, so the costs start and stream; on the client the page's own query
    // starts them once the sessions land.
    const sessions = queryClient.getQueryData(sessionsQuery(SESSIONS_PAGE, deps.vehicle).queryKey)
    if (sessions?.sessions.length) {
      void queryClient.prefetchQuery(sessionCostsQuery(sessions.sessions.map((s) => s.id)))
    }
  },
```

- [ ] **Step 5: The component's reads**

- `const { data: tariffs } = useSuspenseQuery(orpc.tariff.list.queryOptions())` becomes
  `const tariffsResult = useQuery(orpc.tariff.list.queryOptions())` with
  `const tariffs = tariffsResult.data`.
- `selectedTariff = tariffs?.find(…)` and `latestTariff = tariffs?.at(-1)`.
- `dialogUnavailable` gets the tariffs guard: **only decide once tariffs are known**.

  ```tsx
  const dialogUnavailable =
    dialog !== undefined &&
    (!isAdmin ||
      (dialog === 'syncRuns'
        ? runsSource === undefined
        : dialog !== 'tariffNew' &&
          dialog !== 'vehicleImport' &&
          tariffs !== undefined && // still loading: not "gone" yet
          !selectedTariff))
  ```

- `showCost` starts with `tariffs !== undefined && tariffs.length > 0 && …`.
- `costNotice`: `!hasEnergy || tariffs === undefined ? null : tariffs.length === 0 ? 'noTariff' : …`.
- `const { data: health } = useSuspenseQuery({...syncStatus, refetchInterval})` becomes `useQuery` with the same
  options. Every `health.x` read becomes guarded:
  - `<ChargingHeading lastSuccessAt={health?.lastSuccessAt} …/>`
  - `{health ? <SyncHealthAlert health={health} … retrying={syncNow.isPendingFor('zaptec') || health.running} /> : null}`
  - The Datakällor entry `{ source: 'zaptec', health, runs: zaptecRuns }` already accepts `undefined` (the tile shows
    "unknown"). Check the `entries` type and widen it if it requires `Health`.
- Remove the now-unused `useSuspenseQuery` import.

- [ ] **Step 6: The sections**

```tsx
const overviewPending = firstLoadPending(overviewResult)
```

Restructure the overview block (today `overview ? <>…</> : <LoadErrorAlert …/>`) into independently skeletoned
sections. `LoadErrorAlert` gates itself, so it renders unconditionally:

```tsx
      {overview && costNotice ? (
        <CostNotice reason={costNotice} onAddTariff={isAdmin ? () => open('tariffNew') : undefined} />
      ) : null}
      <SectionSkeleton name="charging-totals" loading={overviewPending} fallbackHeight="7rem">
        {overview ? (
          <section className="flex flex-col gap-2">…TotalsTiles block, unchanged…</section>
        ) : null}
      </SectionSkeleton>
      <SectionSkeleton name="charging-chart" loading={overviewPending} fallbackHeight="20rem">
        {overview ? <section className="@container flex flex-col gap-2">…chart block, unchanged…</section> : null}
      </SectionSkeleton>
      {overview && showCost ? <PriceFootnote coverage={{ houseDataFrom: cost?.houseDataFrom ?? null }} /> : null}
      <LoadErrorAlert title={m.charging_overview_error_title()} query={overviewResult} />
```

Sessions: wrap the existing `sessions.data ? <SessionList …/> : null` branch:

```tsx
        <SectionSkeleton name="charging-sessions" loading={firstLoadPending(sessions)} fallbackHeight="24rem">
          {loadFailed(sessions) ? (
            <LoadErrorAlert title={m.charging_sessions_error_title()} query={sessions} />
          ) : sessions.data ? (
            <SessionList …unchanged… />
          ) : null}
        </SectionSkeleton>
```

Tariffs (new failure path, since `tariff.list` no longer takes the page down via `ensureQueryData`):

```tsx
      <SectionSkeleton name="charging-tariffs" loading={firstLoadPending(tariffsResult)} fallbackHeight="10rem">
        {tariffs ? <TariffCard tariffs={tariffs} admin={…unchanged…} /> : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_tariff_error_title()} query={tariffsResult} />
```

Messages:
- `sv.json`: `"charging_tariff_error_title": "Påslag, elnät och skatt kunde inte hämtas"`
- `en.json`: `"charging_tariff_error_title": "Markup, grid and tax couldn't be loaded"`

`TariffDialog`, `DeleteTariffDialog` and the `selectedTariff` reads already tolerate `undefined`. Check that
`TariffDialog`'s `mode` stays `undefined` while tariffs load.

- [ ] **Step 7: Run, expect PASS**

`bunx vitest run --project browser src/components/evCharging/ChargingHeading.browser.test.tsx src/routes/_authenticated/charging/`,
then `bun run typecheck`. Also run the vehicle-scope tests and every other existing `/charging` page test; they seed
the cache, so they must still pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/routes/_authenticated/charging/index.tsx src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx src/components/evCharging/ChargingHeading.tsx src/components/evCharging/ChargingHeading.browser.test.tsx messages/sv.json messages/en.json
git commit -m "perf(charging): defer the overview's data and show section skeletons"
```

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices` (focus:
Review Focus 1, 2 and 5; nothing reads `health`/`tariffs` unguarded; no hydration mismatch on a failed SSR read).

---

### Task 6: economy and patterns pages

**Files:**
- Modify: `src/routes/_authenticated/charging/economy.tsx`, `src/routes/_authenticated/charging/patterns.tsx`
- Test: `src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx` (extend)

**Interfaces:**
- Consumes: `loadRouteData`, `SectionSkeleton`, `firstLoadPending`, `ChargingHeading`'s optional `lastSuccessAt`.
- Skeleton names: `charging-economy` (tiles + both charts + table, one query), `charging-patterns` (heatmap + hour
  chart + calendar, one query), `charging-timeline`.

- [ ] **Step 1: Write the failing tests** (same file, same helpers as Task 5)

```tsx
test('economy still loading: one skeleton for the body, heading and scope toggle usable', async () => {
  const { screen } = await renderPage(Economy, '/charging/economy', '', (qc) => {
    pendingForever(qc, orpc.evCharging.economy.queryOptions({ input: { year: undefined, vehicle: 'all' } }).queryKey)
  })
  await expect.element(screen.getByRole('heading', { name: m.charging_economy_title() })).toBeVisible()
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  expect(document.querySelector('[data-boneyard="charging-economy"]')).not.toBeNull()
})

test('patterns loaded, timeline still loading: only the timeline is a skeleton', async () => {
  const { screen } = await renderPage(Patterns, '/charging/patterns', '', (qc) => {
    // Seed a loaded patterns read exactly as the file's existing patterns tests
    // do (search for `evCharging.patterns.queryOptions`); lift it into a
    // `seedPatterns(qc)` helper if it's inline today.
    seedPatterns(qc)
    pendingForever(
      qc,
      orpc.evCharging.timeline.queryOptions({ input: { year: undefined, month: undefined, vehicle: 'all' } }).queryKey,
    )
  })
  await expect.element(radio(screen, m.charging_vehicle_scope_all())).toBeVisible()
  expect(document.querySelector('[data-boneyard="charging-patterns"]')).toBeNull()
  expect(document.querySelector('[data-boneyard="charging-timeline"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run, expect failure**

`bunx vitest run --project browser src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx`

- [ ] **Step 3: economy.tsx**

Loader:

```tsx
  // ADR-0025: awaited on the server only; the client shows the skeleton.
  loader: ({ context: { queryClient }, deps }) =>
    loadRouteData(queryClient, {
      critical: [
        economyQuery(deps.year, deps.vehicle),
        orpc.evCharging.syncStatus.queryOptions(),
        pricesHealthQuery,
      ],
    }),
```

Component:
- Both `useSuspenseQuery` reads (`health`, `pricesHealth`) become `useQuery` (keep `refetchInterval: 60_000` on
  `health`).
- `<ChargingHeading lastSuccessAt={health?.lastSuccessAt} …/>`.
- Each `<SyncHealthAlert health={…}>` renders only when its health is defined.
- Wrap the existing `economy && !loadFailed(result) ? <>…</> : null` body (the tiles/charts/table block **and** its
  Empty branch) as follows, keeping the `LoadErrorAlert` outside:

```tsx
      <SectionSkeleton name="charging-economy" loading={firstLoadPending(result)} fallbackHeight="40rem">
        {economy && !loadFailed(result) ? <>…unchanged body + Empty…</> : null}
      </SectionSkeleton>
      <LoadErrorAlert title={m.charging_economy_error_title()} query={result} />
```

The grid-only lead and the YearSelector already render only when `economy` exists. Leave them.

- [ ] **Step 4: patterns.tsx**

Loader: the same shape, with `critical` = `patternsQuery(...)`, `timelineQuery(...)`,
`orpc.evCharging.syncStatus.queryOptions()`.

Component:
- `health`: `useSuspenseQuery` becomes `useQuery`, plus the guarded heading and alert.
- Wrap the `patterns && !loadFailed(patternsResult) ? <>…</> : null` body in
  `<SectionSkeleton name="charging-patterns" loading={firstLoadPending(patternsResult)} fallbackHeight="48rem">`,
  with `LoadErrorAlert` outside it.
- Inside the timeline card, wrap the existing `timeline && !loadFailed(timelineResult) ? <SessionTimeline …/> : <LoadErrorAlert …/>`
  in `<SectionSkeleton name="charging-timeline" loading={firstLoadPending(timelineResult)} fallbackHeight="16rem">`.

- [ ] **Step 5: Run, expect PASS; typecheck**

Same command as Step 2, then `bun run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authenticated/charging/economy.tsx src/routes/_authenticated/charging/patterns.tsx src/routes/_authenticated/charging/-vehicleScopePages.browser.test.tsx
git commit -m "perf(charging): defer the economy and patterns pages' data"
```

**Reviewers:** same pairing as Task 5.

---

### Task 7: Capture the bones and verify live

**Files:**
- Create (generated): `src/bones/*.bones.json`, `src/bones/registry.js`
- Modify: `docs/adr/0025-deferred-route-loading.md` (spike outcome), `CLAUDE.md`,
  `docs/superpowers/roadmaps/2026-10-05-client-performance.md`

- [ ] **Step 1: Capture** (go only)

Start the dev server as in `scripts/captureBones.ts`'s header, then run `bun run bones:capture`.
Expected: 7 bones files (`charging-totals`, `-chart`, `-sessions`, `-tariffs`, `-economy`, `-patterns`,
`-timeline`) and a registry naming all 7. The registry is imported through `src/lib/bones.ts`. Check its gzipped
size in the next build's entry chunk; if the bones add more than ~10 KB gz, note it in the PR.

- [ ] **Step 2: Live check against the baseline**

Drive the local app with the worktree's Playwright, signed in as admin (memory: `live-ui-check-playwright`):

- **Client navigations.** Log `/api/rpc/*` and `/_serverFn/*` requests for `/charging` → economy → patterns →
  `/charging` → economy.
  - No server-function `getSession` call after the first page.
  - The URL and heading change within ~100 ms of the click, and skeletons show where data is pending.
  - The second visit to economy shows data, no skeleton.
- **First load / refresh of each page.** The HTML already holds the tiles, chart and session list (view source or
  `curl` with the session cookie: the SSR output contains the figures). Look for no hydration warnings in the
  console.
- **Layout.** Screenshot each page mid-load (block the RPCs with `page.route` so skeletons stay) at 375, 768 and
  1280, in light and dark. Bones sit where the content sits.
- **Reduced motion.** Under `reducedMotion: 'reduce'`, the bones don't pulse.
- **Member view.** Repeat the navigation as a non-admin (`user` role): no admin queries fire.

Paste the request logs and screenshots into the PR's Verification section.

- [ ] **Step 3: Docs**

- **ADR-0025:** set the spike outcome. Change the Status line to "Accepted", and under Decision 4 add
  "**Spike (2026-10-05): go.** …what was captured, widths, themes…" (or the no-go amendment with the reason, if Task
  1 said no-go).
- **CLAUDE.md**, *Commands* table: add `| bun run bones:capture | Capture section skeletons from the signed-in dev app (ADR-0025); re-run after changing a skeleton-wrapped section's layout |`.
- **CLAUDE.md**, *Recipes*: add "**Add a route loader:** `loadRouteData(queryClient, { critical, deferred })` (never
  `await prefetchQuery` directly); read deferred data with `useQuery` and wrap the section in
  `<SectionSkeleton name loading={firstLoadPending(query)}>`, then `bun run bones:capture`. See **ADR-0025**."
- **CLAUDE.md**, *Code map*: add `src/bones/` (generated, committed) and `src/lib/query/` to the `lib/` line.
- **CLAUDE.md**, *Gotchas*: "`src/bones/` is generated by `bun run bones:capture` — re-capture, never hand-edit."
- **Roadmap:** step 1 row: PR link, status `PR open`.

- [ ] **Step 4: Commit**

```bash
git add src/bones docs CLAUDE.md
git commit -m "docs(perf): capture the charging skeletons and record the spike"
```

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` (do the screenshots show bones matching
content at all three widths and both themes?).

---

## After the tasks

Follow `docs/feature-workflow.md` Phase 5 (branch review: `code-reviewer` + a general correctness pass + a security
pass on the guard change), then the [pre-PR gate](../../feature-workflow.md#pre-pr-gate), then the PR. Title:
`perf(charging): navigate instantly with deferred loading and skeletons`.

The PR body's *Verification* section gets Task 7's request logs (before: the baseline's 19 requests + `getSession`
per navigation; after: none blocking on the client) and the screenshots. Then stop. The real-world checkpoint
(owner on their phone + prod logs) gates step 2.
