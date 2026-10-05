# ADR 0024 — Deferred Route Loading and Section Skeletons

- **Status**: Accepted (the boneyard-js spike passed on 2026-10-05, see [Decision 4](#4-boneyard-js-is-the-loading-state-primitive-spike-gated))
- **Date**: 2026-10-05
- **Deciders**: Lukas
- **Decision in one line**: A client-side navigation never waits on the network. Route loaders await their data on the
  server only (so a first load or refresh is still complete HTML) and on the client just start the fetches and return.
  Each section shows a boneyard-js skeleton while its query is pending, and the session guard reads a cached session
  instead of calling the server on every navigation.

---

## Context

Navigating between `/charging` and its sub-pages took a second or more, and nothing on screen changed while it
did. TanStack Router keeps the old page mounted until the new route's `beforeLoad` and `loader` settle, and ours
were built to wait. Measured on `main` at `99fa206` (production build + 24 h of prod `rpc timing` logs, 2026-10-05):

1. **A session round trip before anything else.** `_authenticated.tsx`'s `beforeLoad` called the `getSession()`
   server function on every navigation *and* every hover preload. No loader starts until it returns.
2. **Loaders awaited everything.** `/charging`'s loader awaited ~15 queries, including the admin-only Datakällor
   diagnostics at the bottom of the page (4× `syncStatus`, 4× `recentRuns`, coverage, `vehicleStateLatest`), and a
   two-hop chain: `sessions` (49–150 ms) and only then `sessionCosts` (193–306 ms).
3. **The fan-out slows itself down.** Alone, the user lookup every RPC does (`findActiveById`) takes 3–5 ms. Within
   one navigation's ~15 parallel requests it read 90–141 ms: they queue for the instance's 10 pooled connections.
4. **Revisits re-fetched and waited.** After the 20 s `staleTime`, `await prefetchQuery` fetches again and blocks.

TanStack's own Router + Query guidance names this pattern as the wrong one: `await prefetchQuery` in a loader
"blocks navigation, no streaming benefit". The documented pattern is to start non-critical fetches without awaiting
and let the component show a loading state.

The app is already most of the way there. `setupRouterSsrQueryIntegration` dehydrates pending queries (so a fetch
started on the server and not awaited streams to the client), and most sections already branch on "has data /
failed" rather than throwing.

---

## Decision

### 1. Loaders await on the server, not on the client

A route loader names the queries its page needs. It goes through one shared helper (in `src/lib/query/`) instead
of calling `prefetchQuery` / `ensureQueryData` directly:

- **On the server** (first load, refresh, opened link) it awaits the page's *critical* queries, as today, so the
  HTML is complete. Queries for sections below the fold (the Datakällor diagnostics, `sessionCosts`) are *deferred*:
  started without awaiting, so they stream into the client's cache instead of holding the response.
- **On the client** it starts every query and awaits none. The navigation commits at once: URL, sidebar and page
  heading change immediately, and sections fill in as their queries land.
- **Cached data renders straight away.** A query already in the cache (even stale) shows its data while TanStack
  Query refreshes it in the background, so a revisit shows no skeleton at all.
- **Failures never throw from a loader.** A failed read shows the section's own `LoadErrorAlert` with a retry
  (ADR-0016), exactly as `prefetchQuery` already guaranteed.
- **Critical means "in the first HTML", not "never late".** The sources' health statuses are critical, so a first
  load renders their alerts in place. On a client navigation nothing is awaited, so a failing source's alert can
  appear a moment after the page, pushing the content down once. We accept that: it's rare and needs attention.
- **Deferred queries must be bounded.** A deferred query started on the server keeps the SSR stream open until it
  settles (its result streams into the client's cache). Every deferred query today is a DB read; one that calls an
  external service needs a timeout first, or it holds the response open (ADR-0018).

**One exception:** a loader may await on the client when the result decides *routing*: a `redirect` or a
`notFound`. Today that is `_authenticated`'s `user.me` (the onboarding redirect) and the session page's not-found
check. Both use `ensureQueryData`, which returns cached data immediately, so they block only on a first visit.

### 2. The session guard reads a cached session

`_authenticated`'s `beforeLoad` reads the session through the query cache (`staleTime` 5 min) instead of calling
the `getSession` server function every time.

- **Only a live session is reused.** A `null` or soft-deleted result has `staleTime` 0, and the guard removes it
  from the cache before redirecting, so a user who has just signed in (or been re-invited) is never bounced back to
  `/login` by a cached miss.
- **Nearly as loose as today.** 5 min equals Better Auth's `session.cookieCache.maxAge`, but the client can hold a
  session for up to about 2x that (a fetch near the end of a cookie snapshot's life). Returning to the tab marks
  the entry stale (`focusManager`), so a sign-out in another tab is noticed on the next navigation. If the
  cookie-cache setting changes, this one changes with it.
- **The guard is UX, not security.** Every RPC still checks the session and the soft-delete flag server-side
  (`protectedProcedure` / `adminProcedure`, ADR-0017).
- **The cache never holds the session token.** The SSR query integration serializes the cache into the HTML, so the
  query function returns `{ user }` (or `null`), never Better Auth's session object.
- **On the server it's always fresh.** `getRouter()` builds a new `QueryClient` per request.
- **Sign-out already clears it.** `useSignOut` calls `queryClient.clear()`.

### 3. Sections own their loading state

There is no route-level `pendingComponent` and no full-page skeleton. Each section that renders query data (tiles,
a chart, a list, a card) shows a skeleton shaped like itself while its query is pending, so nothing jumps when the
data arrives.

- A section reads deferred data with `useQuery`, not `useSuspenseQuery`. A suspending read would hang the whole route
  on the nearest Suspense boundary and bring back the frozen page. `useSuspenseQuery` stays for data a loader
  guarantees on both server and client (Decision 1's exception: `user.me`).
- **A skeleton is not an empty state.** ADR-0016's "never flash the empty state while loading" still holds.
- **Year and scope switches** keep `keepPreviousData` and dim the previous data, as today. Skeletons are only for a
  query with nothing to show yet.

### 4. boneyard-js is the loading-state primitive (spike-gated)

Skeletons come from [boneyard-js](https://github.com/0xGF/boneyard) (`boneyard-js/react`'s `<Skeleton name loading>`).
Instead of hand-sized placeholders, it captures each named section's real rendered layout ("bones") from the running
app at fixed viewport widths and replays it while loading.

- **Capture is an explicit command, not the always-on Vite plugin.** `bun run bones:capture` signs a Playwright
  browser in through the local Mailpit magic link, then runs the boneyard CLI with that session's `better-auth.*`
  cookies (`--cookie`). The plugin's own headless browser has no session (every authed route would capture
  `/login`), and it would re-crawl on every HMR save.
- **Widths** 375 / 768 / 1280 px: our mobile / tablet / desktop rule. `select: 'viewport'`, because the sidebar makes
  the content area narrower than the window.
- **Bones are committed** (`src/bones/`). `SectionSkeleton` imports the generated registry, so the bones and the
  boneyard runtime load with the first route that shows a skeleton, not with the entry chunk. The registry is a
  side-effect-only import, so `package.json`'s `sideEffects` lists it; without that a production build drops it and
  every skeleton falls back to a plain block. **Re-capture after changing a section's layout**, or its skeleton
  stops matching.
- **Theme and motion.** Bone geometry is theme-independent. The colours are set in `boneyard.config.json` (written
  into the registry's `configureBoneyard`), and boneyard follows the `.dark` class `ThemeProvider` sets. The light
  bone colour `#ebebeb` is deliberately darker than `--muted` (`#f5f5f5`): at `--muted` the bones are invisible on
  the `#fcfcfc` page. Don't "fix" it back. boneyard doesn't honour `prefers-reduced-motion` itself, so app.css's
  reduced-motion block stops the bones' animation (ADR-0015).
- **No fade-out.** boneyard can fade the skeleton out when loading ends, but `SectionSkeleton` drops boneyard's
  wrapper as soon as a section stops loading, so that fade is bypassed by design: the content replaces the bones in
  one frame.
- **Sizing.** boneyard scales the bones to its wrapper's measured height. So while loading, `SectionSkeleton`
  renders no children (a section's no-data render is shorter than its loaded one) and shows the fallback block only
  after mounting (boneyard measures on its first render, before it picks the bones). The empty wrapper then reserves
  the captured height.
- **Missing bones degrade.** A section without captured bones renders the `fallback` prop (a plain block of the
  section's height) rather than nothing.
- **Data.** Capture shows whatever the local database holds, so it runs against realistic local data. A section that
  can't have real data at capture time gets a `fixture`.
- **One seam.** Pages never import boneyard directly. They use `SectionSkeleton`
  (`src/components/layout/SectionSkeleton.tsx`), which decides "loading" the same way everywhere (nothing to show
  yet, nothing failed, and hydrated, so the server HTML and the first client render agree). A library swap changes
  that one file.
- **Not for inline placeholders.** A placeholder *inside* an already-rendered section, such as a session row's cost
  cell while its cost loads, stays shadcn's `Skeleton`. boneyard is for whole sections.

**Spike gate.** It is a six-month-old library, so the first task of the first build step is a spike: capture the
`/charging` tiles through `bones:capture` at all three widths, then replay them in both themes. If it can't do that
cleanly, the fallback is [react-loading-skeleton](https://github.com/dvtng/react-loading-skeleton), and that
outcome is recorded as an amendment here.

**Spike (2026-10-05): go.** `bones:capture /charging` signed in on the first try and captured `charging-totals` at
375, 768 and 1280 px (13, 13 and 42 bones: one tabbed card when narrow, three cards when wide). Replayed in light and
dark, every bone sat inside its real tile and the skeleton was exactly the content's height. Under reduced motion the
bones stayed static. A second capture was byte-identical apart from `_hash`, which changes on every capture. Step 1
then captured all seven skeletons (`charging-totals`, `-chart`, `-sessions`, `-tariffs`, `-economy`, `-patterns`,
`-timeline`). Known limits, accepted for step 1:
- **Bones are sparse.** Text next to an icon gets no bone, and card outlines aren't drawn, so a tile reads as a few
  bars on the page background.
- **Graphics become slabs.** A chart, the patterns heatmap and the day-by-day calendars are each one solid block, and
  a table's middle columns read as one block.
- **Three widths, one layout per range.** The 768 capture serves viewports 768–1279. `/charging`'s totals switch to
  three cards when the content is 768 px wide (a ~1100 px viewport beside the sidebar), so from there to 1279 the
  skeleton shows the narrow layout. A fourth breakpoint would fix it.
- **Size.** The seven skeletons add ~20 KB gz to every charging page (economy and patterns are ~9 KB each).

---

## Alternatives considered

- **Keep awaiting, add a route-level `pendingComponent`** (after a short `pendingMs`). Least code, but the whole page
  becomes a skeleton until the *slowest* query lands, and the session round trip still runs first. It hides the wait
  rather than removing it.
- **Defer on the server too** (stream everything, even on first load). Marginally faster first byte, but every
  refresh or opened link would flash skeletons for content we can render in one SSR pass.
- **Other skeleton approaches.**
  - shadcn's `Skeleton` (already in `ui/`) is a plain pulsing div, and we'd size every placeholder by hand.
  - react-loading-skeleton (1.5 M/week, zero deps) inherits text size, which removes most of that work. It is the
    fallback.
  - react-content-loader means drawing every shape in a fixed SVG coordinate space, which fights layouts that change
    between mobile and desktop.
  - boneyard-js was chosen because it captures the real layout, so skeletons match without hand-tuning, at the cost of
    the capture workflow above.

---

## Consequences

- **Navigations feel instant.** A first visit shows section skeletons for the length of the slowest query (~150–400
  ms on `/charging`), and a revisit shows cached data at once.
- **Fewer requests block, and they're shorter.** On the client nothing blocks. On the server `/charging` waits on 8
  queries in one hop instead of 15 in two, which also eases the pool queueing behind the inflated `findActiveById`.
- **A new step in UI work:** re-run `bones:capture` after changing a section's layout. Stale bones look slightly wrong
  but never break anything.
- **The bones cost bytes.** All seven skeletons (~20 KB gz) load with the first charging page, whichever it is. A
  per-route registry would split them if this grows.
- **`useSuspenseQuery` is now rare.** Reviewers should flag it on data a client navigation defers.
- **Role changes reach the client guard within about 5–10 min** (§2: up to ~2× the cookie cache's 5 min), or on
  the next navigation after the tab regains focus.
- The loader helper is the one place that decides await vs defer. A page whose loader bypasses it reintroduces the
  frozen navigation.
