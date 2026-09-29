import { describe, expect, test } from 'vitest'
import { issuePath, summarizeIssuePaths } from './issuePaths'

describe('issuePath', () => {
  test('joins keys and indices with dots, unwrapping { key } segments', () => {
    expect(issuePath(['sessions', 3, { key: 'energy' }])).toBe('sessions.3.energy')
  })

  test('is empty at the root', () => {
    expect(issuePath([])).toBe('')
  })
})

describe('summarizeIssuePaths', () => {
  test('dedupes and names the root', () => {
    expect(summarizeIssuePaths(['', 'a.b', 'a.b', ''])).toBe('(root), a.b')
  })

  test('names exactly 10 paths without a count', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `p${i}`)
    expect(summarizeIssuePaths(paths)).toBe(paths.join(', '))
  })

  test('names the first 10 distinct paths, then counts the rest', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `p${i}`)
    expect(summarizeIssuePaths([...paths, 'p0'])).toBe(`${paths.slice(0, 10).join(', ')} (+3 more)`)
  })
})
