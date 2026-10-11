import { useCallback } from 'react'
import {
  DEFAULT_SESSION_PAGE_SIZE,
  pageKeepingTopRow,
  type SessionPageSize,
} from '~/lib/evCharging/paging'
import { useListTop } from './useListTop'

// The URL conventions for a session list's `?page=&size=`, shared by
// /charging and /charging/economy so they can't drift: a clean URL is page 1
// at the default size; paging pushes history (back steps to the previous
// page) and brings the list's heading — and focus — back into view; a new size
// is a preference, so it replaces the entry and lands on the page holding the row
// that was at the top of the page (TanStack Table's setPageSize rule); scroll
// and focus stay put.
// Like useUrlDialog, it takes the route's `Route.useNavigate()`; the route
// reads `page`/`size` itself (its own typed `useSearch` selects).

type PagingSearch = { page?: number; size?: SessionPageSize }

type PagingNavigate<TSearch> = (opts: {
  to: '.'
  search: (prev: TSearch) => TSearch
  replace?: boolean
  resetScroll?: boolean
}) => unknown

export function useSessionPaging<TSearch extends PagingSearch>(navigate: PagingNavigate<TSearch>) {
  const top = useListTop()
  const { reveal } = top
  const setPage = useCallback(
    (page: number) => {
      navigate({
        to: '.',
        search: (prev) => ({ ...prev, page: page === 1 ? undefined : page }),
        resetScroll: false,
      })
      reveal()
    },
    [navigate, reveal],
  )
  const setPageSize = useCallback(
    (size: SessionPageSize, fromPage?: number, fromSize?: number) =>
      navigate({
        to: '.',
        search: (prev) => ({
          ...prev,
          page: ((p) => (p === 1 ? undefined : p))(
            pageKeepingTopRow(
              fromPage ?? prev.page ?? 1,
              fromSize ?? prev.size ?? DEFAULT_SESSION_PAGE_SIZE,
              size,
            ),
          ),
          size: size === DEFAULT_SESSION_PAGE_SIZE ? undefined : size,
        }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  )
  /** `headingRef` goes on the list's heading, which needs tabIndex={-1}. */
  return { headingRef: top.ref, setPage, setPageSize }
}
