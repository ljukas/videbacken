import { useEffect } from 'react'

// Once a session list's page has landed (not a placeholder), fetch the page
// after it, so "next" is instant on a phone too, where nothing hovers. One small
// request per page viewed; prefetchQuery skips it while that page is fresh.
export function useNextPagePrefetch(
  list: { data?: { page: number; pageSize: number; total: number }; isPlaceholderData: boolean },
  prefetchPage: (page: number) => void,
): void {
  const { data, isPlaceholderData } = list
  useEffect(() => {
    if (!data || isPlaceholderData) return
    if (data.page * data.pageSize < data.total) prefetchPage(data.page + 1)
  }, [data, isPlaceholderData, prefetchPage])
}
