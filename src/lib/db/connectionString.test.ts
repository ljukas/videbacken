import { describe, expect, it } from 'vitest'
import { resolvePooledUrl, resolveUnpooledUrl } from './connectionString'

// A stand-in for the transaction-pooler URL the Supabase↔Vercel integration
// provisions, including the `?workaround=` marker it appends.
const POOLED = 'postgres://postgres.ref:p%40ss@aws-0-eu-north-1.pooler.supabase.com:6543/postgres'
const DIRECT = 'postgres://postgres.ref:p%40ss@aws-0-eu-north-1.pooler.supabase.com:5432/postgres'

describe('resolvePooledUrl', () => {
  it('prefers an explicit DATABASE_URL over the integration-provided POSTGRES_URL', () => {
    expect(resolvePooledUrl({ DATABASE_URL: 'postgres://local/db', POSTGRES_URL: POOLED })).toBe(
      'postgres://local/db',
    )
  })

  it('falls back to POSTGRES_URL when DATABASE_URL is unset', () => {
    expect(resolvePooledUrl({ POSTGRES_URL: POOLED })).toBe(POOLED)
  })

  it('returns undefined when neither is set', () => {
    expect(resolvePooledUrl({})).toBeUndefined()
  })

  it('strips the Vercel-only `workaround` param (sole param)', () => {
    expect(resolvePooledUrl({ POSTGRES_URL: `${POOLED}?workaround=supabase-pooler.vercel` })).toBe(
      POOLED,
    )
  })

  it('strips `workaround` while preserving other query params, in any order', () => {
    expect(resolvePooledUrl({ POSTGRES_URL: `${POOLED}?workaround=x&sslmode=require` })).toBe(
      `${POOLED}?sslmode=require`,
    )
    expect(resolvePooledUrl({ POSTGRES_URL: `${POOLED}?sslmode=require&workaround=x` })).toBe(
      `${POOLED}?sslmode=require`,
    )
  })

  it('leaves the password (with encoded specials) untouched', () => {
    expect(resolvePooledUrl({ POSTGRES_URL: POOLED })).toContain('p%40ss')
  })
})

describe('resolveUnpooledUrl', () => {
  it('prefers DATABASE_URL_UNPOOLED, then POSTGRES_URL_NON_POOLING', () => {
    expect(
      resolveUnpooledUrl({ DATABASE_URL_UNPOOLED: DIRECT, POSTGRES_URL_NON_POOLING: POOLED }),
    ).toBe(DIRECT)
    expect(resolveUnpooledUrl({ POSTGRES_URL_NON_POOLING: DIRECT })).toBe(DIRECT)
  })

  it('falls back to the pooled URL when no unpooled URL is present', () => {
    expect(resolveUnpooledUrl({ DATABASE_URL: POOLED })).toBe(POOLED)
    expect(resolveUnpooledUrl({ POSTGRES_URL: POOLED })).toBe(POOLED)
  })

  it('returns undefined when nothing is set', () => {
    expect(resolveUnpooledUrl({})).toBeUndefined()
  })
})
