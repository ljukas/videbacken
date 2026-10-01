import { describe, expect, it } from 'vitest'
import { __testClient } from '~/lib/db'
import { setupDatabase } from './setup'

setupDatabase()

// pg-pool discards a connection whose query failed and opens a fresh one; the
// fresh one must still be on this test's schema, or later writes hit `public`.
describe('setupDatabase', () => {
  it('keeps the per-test schema after a failed query replaces the connection', async () => {
    const pool = __testClient!
    await expect(pool.query('select 1/0')).rejects.toThrow()
    const { rows } = await pool.query<{ s: string }>('select current_schema() as s')
    expect(rows[0]?.s).toMatch(/^test_w/)
  })
})
