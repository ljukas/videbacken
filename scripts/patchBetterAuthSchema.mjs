#!/usr/bin/env node
// Post-processor for `@better-auth/cli generate`. The CLI emits every column
// as `timestamp('snake_name')`, which compiles to `timestamp without time
// zone` and silently reinterprets values in the session TZ (see ADR-ish
// note in CLAUDE.md "All timestamp columns use timestamptz"). The CLI has
// no flag for timestamptz (verified against better-auth.com/docs/concepts/
// database and .../adapters/drizzle), so we rewrite the generated file in
// place. Idempotent: skips columns that already declare `withTimezone`.
//
// It also enables row-level security on every generated table (`.enableRLS()`,
// no policies → default deny for Supabase's `anon`/`authenticated` roles, as
// defense in depth; the app connects as the table owner, which bypasses RLS).
// Every table in `src/lib/db/schema/` does the same — `test/rls.test.ts`
// enforces it.
//
// Run via `bun run auth:schema`, which invokes the CLI first.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, '../src/lib/db/schema/betterAuth.ts')

const source = readFileSync(target, 'utf8')

// Match `timestamp('col_name')` — no existing options object. The CLI's
// output is mechanical enough that this single shape covers every column;
// if a future Better Auth version emits a second argument, we'll see the
// pattern fail to match and can extend here.
const pattern = /timestamp\((['"])([^'"]+)\1\)(?!\s*,\s*\{)/g

let count = 0
let patched = source.replace(pattern, (_, quote, name) => {
  count += 1
  return `timestamp(${quote}${name}${quote}, { withTimezone: true })`
})

// Each generated table is `export const x = pgTable(…` closed by a column-0
// `});` or `);` line. Append `.enableRLS()` to that closing line unless it is
// already there.
const lines = patched.split('\n')
let rls = 0
let tables = 0
for (let i = 0; i < lines.length; i++) {
  if (!/^export const \w+ = pgTable\(/.test(lines[i])) continue
  tables += 1
  const end = lines.findIndex((line, j) => j > i && /^\}?\)(\.enableRLS\(\))?;$/.test(line))
  if (end === -1) {
    console.error(`[patchBetterAuthSchema] could not find the end of the table at line ${i + 1}`)
    process.exit(1)
  }
  if (!lines[end].includes('.enableRLS()')) {
    lines[end] = lines[end].replace(/;$/, '.enableRLS();')
    rls += 1
  }
}
patched = lines.join('\n')

// Fail loudly rather than skip silently if the CLI output changes shape (a
// renamed/aliased table builder would otherwise match nothing).
const tableCalls = (patched.match(/\bpgTable\(/g) ?? []).length
const rlsCalls = (patched.match(/\.enableRLS\(\)/g) ?? []).length
if (tables === 0 || tables !== tableCalls || rlsCalls !== tables) {
  console.error(
    `[patchBetterAuthSchema] expected .enableRLS() on every table: ${tables} matched, ` +
      `${tableCalls} pgTable( call(s), ${rlsCalls} .enableRLS() call(s)`,
  )
  process.exit(1)
}

if (count === 0 && rls === 0) {
  console.log('[patchBetterAuthSchema] no changes (already patched or unexpected output)')
} else {
  writeFileSync(target, patched)
  console.log(
    `[patchBetterAuthSchema] patched ${count} timestamp column(s) to withTimezone: true, ` +
      `enabled RLS on ${rls} of ${tables} table(s)`,
  )
}
