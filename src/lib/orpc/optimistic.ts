import type { DataTag, QueryClient, QueryKey } from '@tanstack/react-query'

// Optimistic cache helpers for list queries: paint a mutation into the cache
// before the server round-trip, so in-place lists (document table, bin) react
// instantly. Reconciliation is the caller's job — invalidate the namespace in
// `onSettled` so both success and error re-sync from the server (which also
// rolls a failed optimistic patch back). See ADR-0004 for the realtime
// invalidate that sits behind these as a second safety net.
//
// The `queryKey` param is a `DataTag`-branded orpc key (`orpc.x.y.queryKey(...)`),
// so the element type `T` is *inferred from the key* — `getQueryData`/`setQueryData`
// stay fully typed with no generic argument and no cast.

/** Optimistically drop matching items from a cached list before the round-trip. */
export async function optimisticRemove<T, TError = unknown>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, Array<T>, TError>,
  match: (item: T) => boolean,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueryData(queryKey, (old) => old?.filter((item) => !match(item)) ?? old)
}

/**
 * Optimistically replace a single cached value (a detail query, e.g. `getById`)
 * before the round-trip. Sibling to the list helpers above, for the case where an
 * instant-close edit dialog prefills from a detail query: patch that cache too, or
 * the next open reads the stale pre-edit value (invalidate-on-settle only marks it
 * stale, and nothing refetches it while the dialog is closed).
 */
export async function optimisticReplace<T, TError = unknown>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, T, TError>,
  patch: (old: T) => T,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueryData(queryKey, (old) => (old === undefined ? old : patch(old)))
}

/**
 * Optimistically append an item to a cached list before the round-trip. The caller
 * fabricates the item (with a temporary id) since the server-assigned id isn't known
 * yet; `onSettled` invalidation refetches the list and swaps in the real row. Append
 * order is fine for sorted lists — the refetch reconciles position.
 */
export async function optimisticInsert<T, TError = unknown>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, Array<T>, TError>,
  item: T,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueryData(queryKey, (old) => (old ? [...old, item] : old))
}

/** Optimistically patch matching items in a cached list before the round-trip. */
export async function optimisticPatch<T, TError = unknown>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, Array<T>, TError>,
  match: (item: T) => boolean,
  patch: (item: T) => T,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey })
  queryClient.setQueryData(
    queryKey,
    (old) => old?.map((item) => (match(item) ? patch(item) : item)) ?? old,
  )
}
