import { expect, test } from 'vitest'
import {
  DEFAULT_SESSION_PAGE_SIZE,
  pageCount,
  pageItems,
  SESSION_PAGE_SIZES,
  sessionPagingSearch,
} from './paging'

test('offers 10, 25 and 50 rows per page, 10 by default', () => {
  expect(SESSION_PAGE_SIZES).toEqual([10, 25, 50])
  expect(DEFAULT_SESSION_PAGE_SIZE).toBe(10)
})

test('pageCount rounds up and never drops below one page', () => {
  expect(pageCount(0, 10)).toBe(1)
  expect(pageCount(1, 10)).toBe(1)
  expect(pageCount(10, 10)).toBe(1)
  expect(pageCount(11, 10)).toBe(2)
  expect(pageCount(214, 10)).toBe(22)
})

test('pageItems lists every page when they all fit in seven slots', () => {
  expect(pageItems(1, 1)).toEqual([1])
  expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5])
  expect(pageItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
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

test('pageItems clamps an out-of-range page', () => {
  expect(pageItems(99, 3)).toEqual([1, 2, 3])
  expect(pageItems(0, 22)).toEqual(pageItems(1, 22))
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
})
