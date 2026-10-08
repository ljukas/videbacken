# Design — server latency step 5: a paged economy session list

Roadmap: [server latency](../roadmaps/2026-10-07-server-latency.md), step 5. Follows the `/charging` session list's
existing pattern (ADR-0025: the page isn't a loader dep), so no new ADR.

## Why

`evCharging/economy` (`/charging/economy`) returns every counted session of the selected year, each with four full
`CostTotals` (actual, immediate, optimal, dearest), and the browser slices one page of 10 (25, 50) out of it. It is the
largest RPC on the charging pages: 12.8 kB gzip on prod (owner's DevTools, 2026-10-08), next largest 4.0 kB.

Measured on the local DB (208 sessions in 2026, more than prod):

| | raw | gzip |
|---|---|---|
| whole response | 227.6 KB | 21.4 KB |
| tiles + months + years | 3.7 KB | 0.8 KB |
| session rows (all 208) | 223.9 KB | 20.7 KB |
| the same rows, only the fields the table renders | 59.6 KB | 10.9 KB |
| 10 such rows (the default page) | 3.3 KB | 0.8 KB |

The loader awaits the query on the server, so a full load also writes the whole year into the HTML for hydration.
The bytes are not most of the RPC's time (`totalMs` 211–223 after #139, mostly `economyDailySpotMs`: step 6), but
they grow with every session, and the page renders 10 of them.

## Decision

Split the procedure in two, both keyed by `year` and `vehicle`: one for the page (tiles, charts, years) and one for
the list, fully paged on the server. The list prefetches the pages its controls point at.

### Procedures (`src/lib/orpc/procedures/evCharging.ts`)

- **`economy`**: input unchanged (`{ year, vehicle }`). Returns `{ year, years, tiles, months }`: no `sessions`.
- **`economySessions`** (new, `protectedProcedure`): input `{ year, vehicle, page, pageSize }`. `page` and `pageSize`
  use the `sessions` procedure's schema (`z.number().int().min(1).max(MAX_SESSION_PAGE)`, `sessionPageSize`).
  Returns `{ page, pageSize, total, rows }`:
  - `rows`: the page's sessions, newest first, as `EconomyListRow`.
  - `page`: the page served. A page past the end comes back as the last page, through `pageSlice` from
    `~/lib/evCharging/paging`, as `sessions` does.
  - `total`: the year's counted sessions in scope, which the pagination needs.

### Row shape: only what `EconomySessionTable` renders

```ts
export type EconomyListRow = {
  sessionId: string
  startAt: Date
  endAt: Date
  vehicle: Vehicle
  /** The session's `energyKwh`, as SessionList shows it. */
  kwh: number
  /** The actual cost, SEK; null unless every kWh is priced (was `actualComplete` + `actual.totalSek`). */
  actualSek: number | null
  excluded: EconomyExclusion | null
  counterfactual: {
    savedVsImmediateSek: number
    leftOnTableSek: number
    score: number | null
    /** dearest − optimal total, SEK: the "no spread" label's figure when `score` is null. */
    spreadSek: number
  } | null
}
```

`counterfactual` is non-null exactly when `excluded` is null, as in `SessionEconomy`. The mapping from
`EconomySessionRow` is a pure function beside the read model, so it is tested without a DB.

### Read model (`src/lib/evCharging/chargingEconomy.ts`)

- `getEconomyOverview` stops building `sessions` rows. It still analyzes every session of the year, because the
  tiles and month sums need them (step 3 stores those totals).
- New `getEconomySessions({ year, vehicle, page, pageSize, timings })`:
  1. Lists the year's session energy, already ~15 ms: `listSessionEnergy`, filtered to the year as today.
  2. Reverses it to newest first, then `pageSlice`.
  3. Loads tariffs and the spot slots of the page's windows only.
  4. Runs `analyzeSession` for the page's sessions, then maps them to `EconomyListRow`.
- It records `energyMs`, `tariffMs`, `slotsMs` and `computeMs`, through the procedure as `economySessions*`
  sub-timings (timing rule).

### Route (`src/routes/_authenticated/charging/economy.tsx`)

- Two queries:
  - `economyQuery(year, vehicle)`.
  - `economySessionsQuery(year, vehicle, page, size)`, with `placeholderData: keepPreviousData`. The old rows stay,
    dimmed (`isPlaceholderData`), until the next page lands.
- `page` and `size` stay out of `loaderDeps`. As on `/charging`, the loader reads them with
  `sessionPagingSearch.parse(location.search)` and puts the list query beside the overview in `critical`. SSR and a
  shared link render the right page, and a page click never blocks on the loader.
- `EconomySessionsCard` loses its client slicing and its `shownPage` state. The served `page` and `total` come from
  the response, and it reads `stale` from the list query itself.
- A year or scope change still resets `page`, as today.
- The card renders while the overview has sessions (`tiles.sessions > 0`), as today. Both queries share the scope,
  so they agree on emptiness.

### Prefetch (`SessionPagination`, shared with `/charging`)

- New optional prop `prefetchPage?: (page: number) => void`.
- Called on `pointerenter`, `focus` and `touchstart` of each page number and each available arrow. Never for the
  current page, an ellipsis, or an `aria-disabled` arrow.
- Each route passes `(p) => queryClient.prefetchQuery(listQuery(p, …))`. `prefetchQuery` skips a query that is fresh
  (`staleTime` 20 s, `src/router.tsx`) or already in flight, so repeated hovers cost nothing.
- **Next page, eagerly:** once a list query has data and isn't a placeholder, the route prefetches page `page + 1`
  when it exists. On a phone, without hover, "next" is then instant. That is one small request per page viewed.
- `/charging` wires the same prop to its `sessionsQuery`, so both lists behave alike. That is the reason the prop
  lives in the shared control, not in each route.

### Rejected

- **Only slimming the rows (keep client paging):** halves the bytes (10.9 KB gzip), but they still grow with the
  year, and every page view still ships the whole year.
- **Real `<Link>`s with the router's intent preload:** a hover would run the whole route loader, so once the page's
  other queries are stale it refetches them too (`costOverview`-sized work). It also does nothing on a phone.

## Tests

- **Node: `chargingEconomy.test.ts`.** `getEconomySessions` cases:
  - page 1 and a middle page, newest first;
  - a page past the end serves the last page;
  - `total`;
  - the vehicle scope, and the year filter by Stockholm start;
  - a page's rows match the same sessions' rows from the full-year analysis, figures unchanged;
  - `actualSek` is null when the cost is incomplete;
  - an excluded session has a null `counterfactual`.
- **Node: the pure row mapping.**
  - `spreadSek` equals dearest − optimal.
  - `getEconomyOverview` no longer returns `sessions`.
- **Browser.**
  - `EconomySessionTable` with the new rows. Every existing case is kept: the folded values below `sm`, the
    estimate marker, the unknown cost, the no-spread label.
  - `SessionPagination` calls `prefetchPage` on hover, focus and touch of numbers and arrows, and never for the
    current page or a disabled arrow.
  - The `-vehicleScope` route test is updated for the second query.
- **Procedure.** `economySessions` is a `protectedProcedure` with the paging input bounds.

## Verification

- **Payload:** the local measurement above repeated after the change, with both responses' sizes in the PR. Target:
  the default page loads ≤ 2 KB gzip together, and the size no longer grows with the year.
- **Live, desktop / tablet / mobile:**
  - hovering a page number then clicking shows the page with no request in the Network tab;
  - "next" on a phone is instant after the first page;
  - a year or scope switch dims, then lands on page 1;
  - a shared `?page=3` URL renders page 3 on a full load.
- `bun run bones:capture /charging/economy` only if the section's layout changed.

## Checkpoint 5 (prod)

In DevTools on prod:
- `economy` and `economySessions` together are under 3 kB in the Size column (headers included, ~0.3 kB each),
  against 12.8 kB before.
- A hovered or next page renders from cache: no request, or one already finished.
- `rpc timing` shows `economySessions` well under `economy`'s `totalMs`, because it computes one page.
