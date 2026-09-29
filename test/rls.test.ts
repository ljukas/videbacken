import { sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import { setupDatabase } from '~test/setup'

setupDatabase()

// Defense in depth for Supabase: RLS with no policies denies its `anon` /
// `authenticated` roles even if they are ever granted table access or the Data
// API is switched on, while the app (the table owner, not FORCEd) bypasses it.
// Every table must opt in — schema tables via `.enableRLS()`, Better Auth's via
// `scripts/patchBetterAuthSchema.mjs` — so a new table can't slip through.
test('every table has row-level security enabled', async () => {
  const rows = await db.execute<{
    relname: string
    relrowsecurity: boolean
    relforcerowsecurity: boolean
  }>(sql`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
  `)
  const tables = [...rows]

  expect(tables.length).toBeGreaterThanOrEqual(14)
  expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([])
  // FORCE would subject the owner too — with no policies that locks the app
  // out wherever its role lacks BYPASSRLS. The local superuser can't catch it.
  expect(tables.filter((t) => t.relforcerowsecurity).map((t) => t.relname)).toEqual([])
})

// The local/CI role is a superuser (bypasses RLS), so prove the deny with a
// throwaway role granted table access the way Supabase grants `anon`. It all
// runs in a transaction that is rolled back, so the role never persists.
test('a non-owner role with table grants sees no rows (default deny)', async () => {
  await db.execute(sql`INSERT INTO approved_email (email, role) VALUES ('rls@example.com', 'user')`)
  const [{ schema }] = [
    ...(await db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`)),
  ]
  const probe = `rls_probe_${process.env.VITEST_POOL_ID ?? '0'}`
  const rollback = new Error('rollback')
  const counts: { owner?: number; probe?: number } = {}

  const result = await db
    .transaction(async (tx) => {
      const count = async () =>
        [
          ...(await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM approved_email`)),
        ][0].n
      await tx.execute(sql.raw(`CREATE ROLE ${probe} NOLOGIN`))
      await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA "${schema}" TO ${probe}`))
      await tx.execute(sql.raw(`GRANT SELECT ON approved_email TO ${probe}`))
      counts.owner = await count()
      await tx.execute(sql.raw(`SET LOCAL ROLE ${probe}`))
      counts.probe = await count()
      throw rollback
    })
    .catch((error: unknown) => error)

  expect(result).toBe(rollback)
  expect(counts).toEqual({ owner: 1, probe: 0 })
})
