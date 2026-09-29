import { describe, expect, test } from 'vitest'
import { secretMatches } from './secretMatches'

describe('secretMatches', () => {
  test('accepts a matching token', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
  })
  test('rejects a wrong or missing token', () => {
    expect(secretMatches('nope', 's3cret')).toBe(false)
    expect(secretMatches(null, 's3cret')).toBe(false)
  })
  test('rejects when no server secret is configured (fail closed)', () => {
    expect(secretMatches('anything', undefined)).toBe(false)
    expect(secretMatches('anything', '')).toBe(false)
  })
  test('rejects a token of a different length without throwing', () => {
    expect(secretMatches('short', 'a-much-longer-secret')).toBe(false)
  })
  test('rejects a same-length token with different content', () => {
    // Exercises the timingSafeEqual content compare itself — every other
    // rejection here differs in length and is caught by the length guard alone,
    // so without this an impl that skipped the content compare would pass.
    expect(secretMatches('wrongpw!', 'rightpw!')).toBe(false)
  })
})
