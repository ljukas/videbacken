import { environmentManager, type QueryClient, type QueryKey } from '@tanstack/react-query'

// Any oRPC `queryOptions(...)` result. Typed by its key only: each one goes to
// prefetchQuery unchanged, so its queryFn travels at runtime.
export type RouteQuery = { queryKey: QueryKey; [key: string]: unknown }
// `isAdmin && query` reads cleanly in a loader's list.
export type MaybeRouteQuery = RouteQuery | null | false

const present = (q: MaybeRouteQuery): q is RouteQuery => Boolean(q)

/**
 * A route loader's data (ADR-0024 §1). The one place that decides what a
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
