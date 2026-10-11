import { expect, test } from 'vitest'
import {
  DEFAULT_SESSION_PAGE_SIZE,
  MAX_SESSION_PAGE,
  MAX_SESSION_PAGE_SIZE,
  pageCount,
  pageItems,
  pageKeepingTopRow,
  pageSlice,
  SESSION_PAGE_SIZES,
  sessionPageSize,
  sessionPagingSearch,
} from './paging'

test('offers 10, 25 and 50 rows per page, 10 by default', () => {
  expect(SESSION_PAGE_SIZES).toEqual([10, 25, 50])
  expect(DEFAULT_SESSION_PAGE_SIZE).toBe(10)
  expect(MAX_SESSION_PAGE_SIZE).toBe(Math.max(...SESSION_PAGE_SIZES))
})

test('pageCount rounds up and never drops below one page', () => {
  expect(pageCount(0, 10)).toBe(1)
  expect(pageCount(1, 10)).toBe(1)
  expect(pageCount(10, 10)).toBe(1)
  expect(pageCount(11, 10)).toBe(2)
  expect(pageCount(214, 10)).toBe(22)
  expect(pageCount(25, 25)).toBe(1)
  expect(pageCount(26, 25)).toBe(2)
  expect(pageCount(214, 25)).toBe(9)
  expect(pageCount(50, 50)).toBe(1)
  expect(pageCount(51, 50)).toBe(2)
})

test('pageItems lists every page when they all fit in seven slots', () => {
  expect(pageItems(1, 1)).toEqual([1])
  expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5])
  expect(pageItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

test('pageItems collapses from eight pages, pivoting between pages 4 and 5', () => {
  expect(pageItems(1, 8)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 8])
  expect(pageItems(4, 8)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 8])
  expect(pageItems(5, 8)).toEqual([1, 'ellipsis', 4, 5, 6, 7, 8])
  expect(pageItems(8, 8)).toEqual([1, 'ellipsis', 4, 5, 6, 7, 8])
})

test('pageItems collapses the far end near the start', () => {
  expect(pageItems(1, 22)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 22])
  expect(pageItems(4, 22)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 22])
})

test('pageItems collapses the near end close to the last page', () => {
  expect(pageItems(22, 22)).toEqual([1, 'ellipsis', 18, 19, 20, 21, 22])
  expect(pageItems(19, 22)).toEqual([1, 'ellipsis', 18, 19, 20, 21, 22])
})

test('pageItems keeps one neighbour on each side in the middle', () => {
  expect(pageItems(5, 22)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 22])
  expect(pageItems(18, 22)).toEqual([1, 'ellipsis', 17, 18, 19, 'ellipsis', 22])
})

test('pageItems always has seven slots once pages overflow, so the control never jumps', () => {
  for (let page = 1; page <= 30; page++) expect(pageItems(page, 30)).toHaveLength(7)
})

test('pageItems treats an out-of-range or NaN page as the nearest real one', () => {
  expect(pageItems(99, 3)).toEqual([1, 2, 3])
  expect(pageItems(99, 22)).toEqual(pageItems(22, 22))
  expect(pageItems(0, 22)).toEqual(pageItems(1, 22))
  expect(pageItems(Number.NaN, 22)).toEqual(pageItems(1, 22))
})

test('sessionPageSize accepts only the offered sizes', () => {
  for (const size of SESSION_PAGE_SIZES) expect(sessionPageSize.parse(size)).toBe(size)
  expect(sessionPageSize.safeParse(7).success).toBe(false)
  expect(sessionPageSize.safeParse('10').success).toBe(false)
})

test('the URL paging params fall back to defaults instead of erroring', () => {
  expect(sessionPagingSearch.parse({})).toEqual({ page: undefined, size: undefined })
  expect(sessionPagingSearch.parse({ page: 3, size: 25 })).toEqual({ page: 3, size: 25 })
  expect(sessionPagingSearch.parse({ page: 0, size: 7 })).toEqual({
    page: undefined,
    size: undefined,
  })
  expect(sessionPagingSearch.parse({ page: 'x', size: '10' })).toEqual({
    page: undefined,
    size: undefined,
  })
  expect(sessionPagingSearch.parse({ page: 1.5 })).toEqual({ page: undefined, size: undefined })
  expect(sessionPagingSearch.parse({ page: MAX_SESSION_PAGE })).toEqual({
    page: MAX_SESSION_PAGE,
    size: undefined,
  })
  expect(sessionPagingSearch.parse({ page: MAX_SESSION_PAGE + 1 })).toEqual({
    page: undefined,
    size: undefined,
  })
})

test('a bad URL paging param falls back on its own, keeping the other', () => {
  expect(sessionPagingSearch.parse({ page: 3, size: 7 })).toEqual({ page: 3, size: undefined })
  expect(sessionPagingSearch.parse({ page: 0, size: 25 })).toEqual({ page: undefined, size: 25 })
})

test('pageSlice serves one page of rows, clamping a page past the end like the server', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i + 1)
  expect(pageSlice(rows, 1, 10)).toEqual({ rows: rows.slice(0, 10), page: 1 })
  expect(pageSlice(rows, 3, 10)).toEqual({ rows: [21, 22, 23], page: 3 })
  expect(pageSlice(rows, 9, 10)).toEqual({ rows: [21, 22, 23], page: 3 })
  expect(pageSlice(rows, 0, 10)).toEqual({ rows: rows.slice(0, 10), page: 1 })
  expect(pageSlice(rows, 1, 25)).toEqual({ rows, page: 1 })
  expect(pageSlice([], 4, 10)).toEqual({ rows: [], page: 1 })
})

test('pageKeepingTopRow keeps the first row of the page in view at the new size', () => {
  // Page 3 at 10 shows rows 21–30: row 21 is on page 1 at 25 and at 50.
  expect(pageKeepingTopRow(3, 10, 25)).toBe(1)
  expect(pageKeepingTopRow(3, 10, 50)).toBe(1)
  // Page 4 at 10 starts at row 31: page 2 at 25 (rows 26–50).
  expect(pageKeepingTopRow(4, 10, 25)).toBe(2)
  // Shrinking: page 2 at 50 starts at row 51, page 6 at 10 (rows 51–60).
  expect(pageKeepingTopRow(2, 50, 10)).toBe(6)
  expect(pageKeepingTopRow(1, 25, 10)).toBe(1)
  // The same size is the same page.
  expect(pageKeepingTopRow(7, 25, 25)).toBe(7)
})
