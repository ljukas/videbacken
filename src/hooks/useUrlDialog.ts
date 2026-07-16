import { useCallback, useMemo } from 'react'

// Shared open/close/active state machine for URL-driven dialogs (ADR-0013).
//
// owners / seasons / shares (and, from Thread 3, documents) all drive a single
// open dialog from a `?dialog=<name>` search param. The boilerplate —
// open via `navigate({ search })`, close while clearing the entity id(s),
// derive which dialog is active — was hand-rolled per route and drifting (each
// re-implemented "close"). This hook concentrates *only* that state machine. The
// route still owns its `validateSearch` schema, loader prefetch, and the
// dialog-name → component render map (all irreducibly route-specific).
//
// Pass the route's `useNavigate()` result and the current `dialog` value in, plus
// the dialog union as the first type arg and the route's search type as the
// second (so the functional `search` updater stays fully typed):
//
//   const { isOpen, open, close } = useUrlDialog<Dialog, Search>({
//     current: dialog, navigate, clearKeys: ['userId'],
//   })

type SearchUpdater<TSearch> = (prev: TSearch) => TSearch

type DialogNavigate<TSearch> = (opts: {
  to: '.'
  search: SearchUpdater<TSearch>
  replace?: boolean
  resetScroll?: boolean
}) => unknown

export function useUrlDialog<
  TDialog extends string,
  TSearch extends { dialog?: TDialog } = { dialog?: TDialog },
>({
  current,
  navigate,
  clearKeys,
}: {
  /** The active dialog from `Route.useSearch({ select: (s) => s.dialog })`. */
  current: TDialog | undefined
  /** The route's `Route.useNavigate()`. */
  navigate: DialogNavigate<TSearch>
  /** Entity-id search keys to reset on close (e.g. `['userId']`). */
  clearKeys?: ReadonlyArray<keyof TSearch & string>
}) {
  // `resetScroll: false` on both — a dialog is an overlay on the same page, so
  // toggling it must not jump the scroll position to the top (navigate defaults
  // to resetting scroll on every search change).
  const open = useCallback(
    (dialog: TDialog, params?: Partial<TSearch>) =>
      // Functional updater preserves unrelated params (e.g. owners' `filter`).
      navigate({ to: '.', search: (prev) => ({ ...prev, dialog, ...params }), resetScroll: false }),
    [navigate],
  )

  const close = useCallback(
    () =>
      navigate({
        to: '.',
        resetScroll: false,
        search: (prev) => {
          const next: TSearch = { ...prev, dialog: undefined }
          for (const key of clearKeys ?? []) next[key] = undefined as TSearch[typeof key]
          return next
        },
      }),
    [navigate, clearKeys],
  )

  return useMemo(
    () => ({ dialog: current, isOpen: (d: TDialog) => current === d, open, close }),
    [current, open, close],
  )
}
