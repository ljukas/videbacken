# ADR 0025 — Deferred Route Loading and Section Skeletons

- **Status**: Accepted (the boneyard-js spike passed on 2026-10-05, see [Decision 4](#4-boneyard-js-is-the-loading-state-primitive-spike-gated))
- **Date**: 2026-10-05
- **Deciders**: Lukas
- **Decision in one line**: A client-side navigation never waits on the network. Route loaders await their data on the
  server only (so a first load or refresh is still complete HTML for the critical sections; deferred ones load after
  hydration) and on the client just start the fetches and return.
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

The app is already most of the way there: most sections already branch on "has data / failed" rather than
throwing.

---

## Decision

### 1. Loaders await on the server, not on the client

A route loader names the queries its page needs. It goes through one shared helper (in `src/lib/query/`) instead
of calling `prefetchQuery` / `ensureQueryData` directly:

- **On the server** (first load, refresh, opened link) it awaits the page's *critical* queries, as today, so the
  HTML is complete. Queries for sections below the fold (the Datakällor diagnostics; `sessionCosts` until §5 merged it
  into `sessions`) are *deferred*:
  the server doesn't start them at all. The HTML renders those sections pending, and each section's own `useQuery`
  fetches its data after hydration.
- **On the client** it starts every query and awaits none. The navigation commits at once: URL, sidebar and page
  heading change immediately, and sections fill in as their queries land.
- **Cached data renders straight away.** A query already in the cache (even stale) shows its data while TanStack
  Query refreshes it in the background, so a revisit shows no skeleton at all.
- **Failures never throw from a loader.** A failed read shows the section's own `LoadErrorAlert` with a retry
  (ADR-0016), exactly as `prefetchQuery` already guaranteed.
- **Critical means "in the first HTML", not "never late".** The sources' health statuses are critical, so a first
  load renders their alerts in place. On a client navigation nothing is awaited, so a failing source's alert can
  appear a moment after the page, pushing the content down once. We accept that: it's rare and needs attention.
- **Why deferred queries don't stream.** `setupRouterSsrQueryIntegration` can stream a query started on the server
  into the client's cache. But our sections read with a plain `useQuery` (§3), and a streamed result that lands before
  hydration makes the hydrating render show data where the server rendered "pending": a hydration mismatch, and React
  re-renders the page from scratch. That happened on every `/charging` load with `sessionCosts` (2026-10-05).
  Starting deferred queries on the client only means both sides render them pending. The cost is that a first load
  fetches them after the JS runs instead of in parallel with the HTML.

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
- **Sign-out clears it.** `useSignOut` removes the cached session before navigating to `/login`, and clears the whole
  cache afterwards.

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
  `/login`), and it would re-crawl on every HMR save. The CLI skips a skeleton whose DOM is unchanged, even when the
  breakpoints or the CSS changed, so after changing either run `bun run bones:capture --force`.
- **Widths** 375 / 768 / 1100 / 1280 px (`boneyard.config.json`). A capture serves every viewport from its width up
  to the next one. 768 is where the sidebar appears (the content drops to 440 px). 1100 is for `/charging`'s
  totals, which switch from one tabbed card to three cards when the content reaches 768 px (`@3xl`; measured
  2026-10-05, first seen at a 1096 px viewport): without it, 1096–1279 replayed the tabbed bones over the grid, about
  190 px short. Keys at 800 and 1000 (Datakällor, economy and patterns reflow there) were measured and dropped: they
  only refine a first visit's skeleton and cost ~13 KB gz on every charging page. `select: 'viewport'`, because the
  sidebar makes the content area narrower than the window.
  *Amended 2026-10-06 (energy step 1c):* a page can capture extra widths of its own (`EXTRA_BREAKPOINTS` in
  `scripts/captureBones.ts`, run as a separate CLI pass with `--breakpoints`; the runtime picks from each file's own
  keys). `/energy` adds **1220**: its Summering card turns wide when the content reaches 860 px, at a 1220 px viewport,
  so 1220–1279 replayed the 1100 (narrow) bones, 125 px too tall. Only `/energy`'s two bones files grow.
- **Bones are committed** (`src/bones/`), and each route imports its own: `import xBones from
  '~/bones/x.bones.json'`, passed as `<SectionSkeleton bones={xBones}>`, which hands them to boneyard's
  `initialBones`. So a page carries only its sections' bones, and the boneyard runtime loads with the first route
  that shows a skeleton, not with the entry chunk. A section not captured yet passes `name="x"` instead (the name
  `bones:capture` finds it by); once captured it switches to `bones`, and `test/sectionSkeletonBones.test.ts` fails
  until it does. **Re-capture after changing a section's layout**, or its skeleton stops matching.
  *Amended 2026-10-05 (roadmap step 4):* this replaces the generated registry (`src/bones/registry.ts`), which
  `SectionSkeleton` imported for its side effect. It put every page's bones (~21 KB gz) on every page with a
  skeleton. The capture script now deletes the registry the CLI writes.
- **Theme and motion.** Bone geometry is theme-independent. The colours are set in `boneyard.config.json`, and
  `SectionSkeleton` passes them (and the `pulse` animation) to boneyard as props. Only those three keys reach it:
  boneyard reads `speed`, `shimmerColor`, `darkShimmerColor` and `shimmerAngle` only from its global config, so
  adding them to `boneyard.config.json` does nothing without a `configureBoneyard` call. boneyard follows the `.dark`
  class `ThemeProvider` sets. The light bone colour `#ebebeb` is deliberately darker than `--muted` (`#f5f5f5`): at
  `--muted` the bones are invisible on the `#fcfcfc` page. Don't "fix" it back. boneyard doesn't honour
  `prefers-reduced-motion` itself, so app.css's reduced-motion block stops the bones' animation (ADR-0015).
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
then captured eight skeletons (`charging-totals`, `-chart`, `-sessions`, `-tariffs`, `-sources`, `-economy`,
`-patterns`, `-timeline`). Known limits, accepted for step 1:
- **Bones are sparse.** Text next to an icon gets no bone, and card outlines aren't drawn, so a tile reads as a few
  bars on the page background.
- **Graphics become slabs.** A chart, the patterns heatmap and the day-by-day calendars are each one solid block, and
  a table's middle columns read as one block. The table part has a known cause and fix (step 2, `/users`): boneyard
  bones a `td`/`th` holding only inline children as the whole cell, and neighbouring cell bones merge. Give each
  cell's content an `inline-block` (or another non-inline element), and leave hover-only or admin-only cells out with
  `SectionSkeleton`'s `excludeSelectors`. Bones are also clipped to the skeleton's wrapper, so a section that bleeds
  past the content column (`-mx-*`) must bleed from a wrapper outside `SectionSkeleton`.
- **One layout per range.** Between two keys a section can still reflow, and its skeleton then shows the layout at
  the lower key, so the content ends up shorter than its bones and the page moves up once:
  - **375 covers 375–767.** Datakällor, economy and patterns reflow around 487, 511, 647 and 711 px (economy's bones
    are 9332 px tall, its content ~6500 by 663).
  - **768 covers 768–1095.** Datakällor, economy and patterns reflow at 776/800 (Datakällor 1127 → ~650–830, economy
    6816 → ~6500, patterns 3717 → ~3080), and patterns and its timeline again at 1000 (~2900 → ~2150, ~1140 → ~770).
- **Size.** Four widths × eight skeletons add ~27 KB gz to every charging page (economy and patterns are ~10 KB each).
  Step 2 added the `/sensors` and `/users` skeletons to the same registry: twelve skeletons, ~26 KB gz in the shared
  `SectionSkeleton` chunk, which every page with a skeleton loads. About 23 KB of that is charging bones that `/sensors`
  and `/users` never use. Accepted for step 2. Splitting the registry per page group is part of step 4. (Step 4 went further: each page
  imports only its own bones, see the "Bones are committed" bullet.)

### 5. Many reads per page: merge per concern, not per transport

*Amendment, 2026-10-05 (roadmap step 3; design in
[the step 3 spec](../superpowers/specs/2026-10-05-client-perf-3-fewer-reads-design.md)).*

A page made of many reads keeps **one query per thing a section shows**: cached, invalidated, polled and failing on
its own. Where several reads are really **one concern**, the server returns them as one procedure, and each section
picks its part (by key, or with `select` where a slice needs its own query state). Examples: the sources' health statuses, each source's recent runs, and a session page
plus its costs.

**Requests are not batched at the transport.** Every request goes through the auth middleware, and the auth lookup
is memoized **per HTTP request**: once per SSR render, and once per RPC.

**Why:**
- **HTTP/2 makes the request count cheap for the browser.** The cost of a request is on the server: an auth check
  and a pooled connection each. Merging per concern removes both, and it removes waterfalls (Query's own
  "restructure your API" advice).
- **Batching was rejected.**
  - In buffered mode the slowest call holds every result (`liveStatus` takes up to 6 s).
  - Streaming mode is unverified on Vercel, and needs per-call timing logs plus a shared auth lookup to pay off.
  - Its saving overlaps with the merges above. The memo is the hook it would use, if a later measurement says
    it's worth it.
- **The memo keeps ADR-0017's guarantee.** It never outlives one HTTP request, so a revoked user is still rejected
  on the next request (an SSR render already in flight finishes its reads; it never mutates). A short cross-request cache of the user lookup was rejected because it would delay revocation.
- **The pool's state goes in the `rpc timing` line**, so the remaining burst cost (§Context 3) is fixed from evidence:
  `poolTotal` / `poolIdle` / `poolWaiting` as the request found the pool, and `poolOpened` / `poolPeakWaiting` for
  what it did while the request ran (instance-wide, so a request also sees its burst's neighbours). The lifetime pair
  tells the fixes apart: connections opened (keep them warm) vs. a queue (pool size). A start-of-request sample can't
  see a burst's queue, which forms after every request in it has started.

**Where the line is.** Merge reads that share a source table and a refresh rhythm. Don't merge across concerns
whose failures should stay apart: `overview` and `costOverview` stay separate so a price problem blanks only the
cost figures (ADR-0020). When a merged read has a part that may fail independently, it returns that part as `null`
rather than failing the whole read (`sessions`' `costs`).

### 6. Per-page bundle: a page loads only the code it renders

*Amendment, 2026-10-05 (roadmap step 4).* A page's JS is its route chunk's static import closure, on top of the
entry and the signed-in shell (~250 KB gz). `bun run bundle:measure` prints it per page. Three things inflated it
for pages that never used them:

- **Phone fields stay out of the global form hook.** Everything in `createFormHook`'s `fieldComponents`
  (`src/hooks/form.ts`) ships in every form's chunk, and the phone input (with its number metadata and country
  flags) is ~95 KB gz. So `PhoneField` and `FloatingPhoneField` aren't registered. A form with a phone field imports
  `PhoneField` from `~/components/form/` and renders it inside `AppField`: it binds through `useFieldContext` like a
  registered field (ADR-0005, amendment 2026-10-05). `/users` still loads `libphonenumber-js` for the table's number
  formatting, imported from `react-phone-number-input/input`, the entry without flags.
- **Admin-only dialogs load on first open.** The dialogs only an admin can open (sensor edit, user invite and edit,
  tariff new/edit/delete, the MySkoda import) are `React.lazy`, wrapped in `LazyDialogMount`
  (`src/components/layout/LazyDialogMount.tsx`). It mounts a dialog the first time it opens and keeps it mounted,
  so Radix still plays its exit animation and a reopen is instant. Until then nothing renders, so a member never
  fetches the dialog or the form code it pulls in. It mounts only after hydration (`useHydrated`): an `open` that
  reads client-only (deferred) data must not differ between the server and the hydrating client, so a URL deep link
  (ADR-0013) opens right after hydration. Admins prefetch the dialog chunks when the browser is idle
  (`useIdlePreload(isAdmin, loaders)`), so their first click isn't dead. Members never fetch them.
- **Each page imports its own bones** (§4). The registry had put all of them on every page with a skeleton.

Measured with `bun run bundle:measure` (KB gz; each page's row is on top of the entry and shell):

| Page | Before step 4 | Phone fields + lazy dialogs | Per-page bones |
|---|---:|---:|---:|
| entry + signed-in shell | 248 | 253 | 253 |
| `/charging` | 179 | 180 | 161 |
| `/charging/settings` | 200 | 61 | 41 |
| `/charging/economy` | 178 | 178 | 159 |
| `/charging/patterns` | 181 | 182 | 171 |
| `/energy` | 172 | 173 | 152 |
| `/sensors` | 278 | 145 | 123 |
| `/users` | 187 | 94 | 72 |
| `/account/profile` | 211 | 212 | 212 |

`/account/profile` renders a phone field on load, so it keeps the phone input.

**The shell grew 5 KB gz without gaining code.** Its set of modules is unchanged (437 sources). But each lazy dialog,
and `PhoneField`'s own entry, is a new dynamic entry, and rolldown groups modules into chunks by which entries reach
them. So modules the shell shares with those entries (Radix primitives, cmdk, `button`, `dialog`, floating-ui …) split
into more, smaller chunks: about +5 KB gz of per-chunk overhead (the figure sums each chunk's gzip): +1.3 KB when `PhoneField` became its own entry, +3.3 KB when the lazy dialogs did, with the same 437 modules throughout; the entry + shell parts are rounded separately, so 172 + 77 reads 248 in the tables and 9 more
`modulepreload` requests on every signed-in page. A rolldown chunk group
(`build.rolldownOptions.output.codeSplitting.groups`) could merge them back. That is left as a follow-up (done in the 2026-10-06 amendment below), since it
needs its own measurement, `/login` included.

*Amendment, 2026-10-06 (roadmap step 6).* Three changes, measured with `bun run bundle:measure` (KB gz):

- **The upload's heavy modules load on pick.** `AvatarUpload` imports `exifreader` and the Vercel Blob client
  with `import()`, started by a click on the upload button and awaited by `handleFile`. `@vercel/blob/client`
  dragged `jose` in through `@vercel/oidc`'s CommonJS browser entry, which can't tree-shake (the locked `@vercel/blob` 2.6.1 and `@vercel/oidc` 3.8.0; on npm 2026-10-06 `@vercel/oidc`
  4.0.0's browser entry still requires `jose` and `@vercel/blob` 2.8.1 still depends on `^3.6.1`), so loading it on
  pick is the fix. `/account/profile` went 213 → 151. `/onboarding` went 150.0 → 88.0 with the upload change alone,
  then 85.6 with the chunk groups.
- **Two chunk groups for the client build** (`config/clientChunkGroups.ts`, `codeSplitting.groups`) merge the shell's
  chunks back: `shell` for modules only the signed-in shell uses, `ui` for those it shares with the signed-out pages.
  Entry + shell went 258 → 252 (28 shell chunks → 13) and modulepreloads on `/charging` 86 → 71. No page grew:
  `/login` 88.4 → 85.9 and `/signed-in` 34.0 → 31.5 dropped, and the signed-in pages stayed put (`/charging` 84,
  settings 44, economy 77, patterns 76, session 65, `/energy` 72, `/sensors` 48, `/users` 73; they moved by 0.2 KB
  at most, settings 43.5 → 43.4). Two rules keep them safe:
  - **No grouped module may be reachable from the entry.** The entry would import the whole group and every page
    would load it. The prototype had one (the router's nested `@tanstack/store`).
  - **No chunk cycles.** A page that loads one module of a group loads all of it, so `ui` holds only what the shell
    shares with `/signed-in`. Groups also drop rolldown's acyclic guarantee: `ui` and `button`'s chunk once imported
    each other, and `/login` crashed on hydration with sizes and tests passing. `bun run build` now fails on a cycle
    (`scripts/checkChunkCycles.ts`, and `bundle:measure` prints a `chunk cycles:` line).
- **Loaders stay in the route tree.** Their imports (for example `date-fns` through the `/energy` loader, about 2 KB gz)
  ship in the entry. Moving loaders out with TanStack's `codeSplittingOptions` cut the entry 176.4 → 170.6 but grew
  every page 2–3 KB gz, and a cold client navigation's queries would start only after the route chunk arrives, against
  §1. Not changed.

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
- **The bones cost bytes.** Each skeleton at four widths. Since step 4 a page loads only its own sections' bones
  (before, every page with a skeleton loaded all of them, ~21 KB gz).
- **`useSuspenseQuery` is now rare.** Reviewers should flag it on data a client navigation defers.
- **Role changes reach the client guard within about 5–10 min** (§2: up to ~2× the cookie cache's 5 min), or on
  the next navigation after the tab regains focus.
- The loader helper is the one place that decides await vs defer. A page whose loader bypasses it reintroduces the
  frozen navigation.
