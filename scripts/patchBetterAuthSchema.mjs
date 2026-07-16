#!/usr/bin/env node
// Post-processor for `@better-auth/cli generate`. The CLI emits every column
// as `timestamp('snake_name')`, which compiles to `timestamp without time
// zone` and silently reinterprets values in the session TZ (see ADR-ish
// note in CLAUDE.md "All timestamp columns use timestamptz"). The CLI has
// no flag for timestamptz (verified against better-auth.com/docs/concepts/
// database and .../adapters/drizzle), so we rewrite the generated file in
// place. Idempotent: skips columns that already declare `withTimezone`.
//
// Run via `pnpm auth:schema`, which invokes the CLI first.

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
const patched = source.replace(pattern, (_, quote, name) => {
  count += 1
  return `timestamp(${quote}${name}${quote}, { withTimezone: true })`
})

if (count === 0) {
  console.log('[patchBetterAuthSchema] no changes (already patched or unexpected output)')
} else {
  writeFileSync(target, patched)
  console.log(`[patchBetterAuthSchema] patched ${count} timestamp column(s) to withTimezone: true`)
}
