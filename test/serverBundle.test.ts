import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkServerBundle,
  DB_MODULE_MARKER,
  staticClosure,
  staticImports,
} from '../scripts/serverBundle'

describe('staticImports', () => {
  it('finds static imports, side-effect imports and re-exports', () => {
    const code = [
      'import { o as __toESM } from "./_runtime.mjs"',
      "import './_chunks/side.mjs';",
      'export { t as logger } from "../_chunks/server.mjs"',
      'export * from "./_libs/all.mjs"',
    ].join('\n')
    expect(staticImports(code)).toEqual([
      './_runtime.mjs',
      './_chunks/side.mjs',
      '../_chunks/server.mjs',
      './_libs/all.mjs',
    ])
  })

  it('finds an import whose bindings span lines', () => {
    expect(staticImports('import {\n  a as b,\n  c\n} from "./_libs/x.mjs";')).toEqual([
      './_libs/x.mjs',
    ])
  })

  it('skips dynamic imports and packages', () => {
    const code = [
      'import { Pool } from "pg"',
      'const services = { ssr: lazyService(() => import("./_ssr/ssr.mjs")) }',
      'const { dispatchQueueMessage } = await import("./_chunks/queue2.mjs");',
    ].join('\n')
    expect(staticImports(code)).toEqual([])
  })
})

describe('checkServerBundle', () => {
  let dir: string
  const write = (file: string, code: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), code)
  }
  const dbModule = `throw new Error("${DB_MODULE_MARKER}")`

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-bundle-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes when only a dynamic import reaches the db module', () => {
    write('index.mjs', 'import "./_chunks/lazy.mjs"\nawait import("./_chunks/queue.mjs")')
    write('_chunks/lazy.mjs', 'export const lazy = 1')
    write('_chunks/queue.mjs', 'import "../_ssr/db.mjs"')
    write('_ssr/db.mjs', dbModule)

    expect(staticClosure(join(dir, 'index.mjs')).map((f) => f.slice(dir.length + 1))).toEqual([
      'index.mjs',
      '_chunks/lazy.mjs',
    ])
    expect(checkServerBundle(join(dir, 'index.mjs'))).toEqual([])
  })

  it('fails when the entry holds the db module', () => {
    write('index.mjs', dbModule)
    expect(checkServerBundle(join(dir, 'index.mjs'))).toEqual([
      'index.mjs holds ~/lib/db, and index.mjs loads it at init',
    ])
  })

  it('fails when the entry reaches it through a chain of static imports', () => {
    write('index.mjs', 'import { a } from "./_chunks/a.mjs"')
    write('_chunks/a.mjs', 'export { db } from "../_chunks/db.mjs"')
    write('_chunks/db.mjs', dbModule)

    expect(checkServerBundle(join(dir, 'index.mjs'))).toEqual([
      '_chunks/db.mjs holds ~/lib/db, and index.mjs loads it at init',
    ])
  })

  it('fails closed when no module holds the marker', () => {
    write('index.mjs', 'export const x = 1')
    // A traced package doesn't count.
    write('node_modules/pkg/index.js', dbModule)

    expect(checkServerBundle(join(dir, 'index.mjs'))).toEqual([
      expect.stringContaining('no module under'),
    ])
  })

  it('fails closed when there is no entry', () => {
    expect(checkServerBundle(join(dir, 'index.mjs'))).toEqual([
      `no server entry at ${join(dir, 'index.mjs')}`,
    ])
  })
})

describe('DB_MODULE_MARKER', () => {
  it('is still the error message in ~/lib/db', () => {
    expect(readFileSync('src/lib/db/index.ts', 'utf8')).toContain(DB_MODULE_MARKER)
  })
})
