import { z } from 'zod'

// Dependency-free, client-safe paging vocabulary for the session lists
// (/charging, /charging/economy). The `sessions` procedure's input, both
// routes' URL params and the pagination control all read these, so the
// allowed page sizes are single-sourced.
export const SESSION_PAGE_SIZES = [10, 25, 50] as const
export type SessionPageSize = (typeof SESSION_PAGE_SIZES)[number]
export const DEFAULT_SESSION_PAGE_SIZE: SessionPageSize = 10

/** One of the offered page sizes; the `sessions` procedure's input rejects anything else. */
export const sessionPageSize = z.literal(SESSION_PAGE_SIZES)
/** A page past any real list: bounds the offset a hand-edited URL can ask for. */
export const MAX_SESSION_PAGE = 10_000

// `?page=&size=`: a clean URL means the first page at the default size, and
// garbage (`size=7`, `page=0`) falls back to that instead of erroring the loader.
export const sessionPagingSearch = z.object({
  page: z.number().int().min(1).max(MAX_SESSION_PAGE).optional().catch(undefined),
  size: sessionPageSize.optional().catch(undefined),
})

/** How many pages `total` rows fill; an empty list is still one (empty) page. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

export type PageItem = number | 'ellipsis'

// First, last, the current page and one neighbour each side, with an ellipsis
// for each gap. Once pages overflow, the list is always seven slots long (a gap
// next to an end is filled with pages instead), so the control keeps its width
// while you page through it.
const SLOTS = 7

export function pageItems(page: number, count: number): PageItem[] {
  // A NaN page would slip past min/max; treat it as the first page.
  const current = Number.isNaN(page) ? 1 : Math.min(Math.max(page, 1), count)
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
  if (count <= SLOTS) return range(1, count)
  // The first/last five pages are reachable without a leading/trailing gap.
  const edge = SLOTS - 2
  if (current <= edge - 1) return [...range(1, edge), 'ellipsis', count]
  if (current >= count - edge + 2) return [1, 'ellipsis', ...range(count - edge + 1, count)]
  return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', count]
}

/**
 * One page of rows already in hand (a list the page loaded whole), clamped like
 * the `sessions` procedure: a page past the end is the last page, and `page`
 * says which one was served.
 */
export function pageSlice<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number } {
  const served = Math.min(Math.max(page, 1), pageCount(rows.length, pageSize))
  return { rows: rows.slice((served - 1) * pageSize, served * pageSize), page: served }
}
