import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkChunkGraph,
  chunkCycles,
  formatChunkCycles,
  readChunkGraph,
} from '../scripts/chunkGraph'

const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges))

describe('chunkCycles', () => {
  it('finds none in an acyclic graph', () => {
    expect(chunkCycles(graph({ 'a.js': ['b.js'], 'b.js': ['c.js'], 'c.js': [] }))).toEqual([])
  })

  it('finds a 2-cycle', () => {
    expect(chunkCycles(graph({ 'ui.js': ['button.js'], 'button.js': ['ui.js'] }))).toEqual([
      ['button.js', 'ui.js'],
    ])
  })

  it('finds a 3-cycle, and not the chunk that only imports into it', () => {
    const deps = graph({
      'entry.js': ['a.js'],
      'a.js': ['b.js'],
      'b.js': ['c.js'],
      'c.js': ['a.js'],
    })
    expect(chunkCycles(deps)).toEqual([['a.js', 'b.js', 'c.js']])
  })

  it('finds a chunk that imports itself', () => {
    expect(chunkCycles(graph({ 'a.js': ['a.js', 'b.js'], 'b.js': [] }))).toEqual([['a.js']])
  })

  it('finds two separate cycles', () => {
    const deps = graph({
      'shell.js': ['_authenticated.js', 'ui.js'],
      '_authenticated.js': ['shell.js'],
      'ui.js': ['button.js'],
      'button.js': ['ui.js'],
    })
    expect(chunkCycles(deps)).toEqual([
      ['_authenticated.js', 'shell.js'],
      ['button.js', 'ui.js'],
    ])
  })

  it('finds none in a diamond', () => {
    const deps = graph({
      'a.js': ['b.js', 'c.js'],
      'b.js': ['d.js'],
      'c.js': ['d.js'],
      'd.js': [],
    })
    expect(chunkCycles(deps)).toEqual([])
  })

  it('ignores an import of a chunk the graph lacks', () => {
    expect(chunkCycles(graph({ 'a.js': ['gone.js'] }))).toEqual([])
  })
})

describe('formatChunkCycles', () => {
  it('says none, or lists each cycle', () => {
    expect(formatChunkCycles([])).toBe('chunk cycles: none')
    expect(formatChunkCycles([['button.js', 'ui.js']])).toBe(
      'chunk cycles: 1\n  button.js <-> ui.js',
    )
  })
})

describe('checkChunkGraph', () => {
  const entry = 'import{h as r}from"./client-AbCd1234.js";r.hydrateRoot(document)'
  const code = (chunks: Record<string, string>) => new Map(Object.entries(chunks))

  it('fails an empty graph: no chunks is never a pass', () => {
    expect(checkChunkGraph(new Map(), new Map())).toEqual(['no client chunks found'])
  })

  it('fails a build with no entry chunk', () => {
    expect(
      checkChunkGraph(graph({ 'a-AbCd1234.js': [] }), code({ 'a-AbCd1234.js': 'x()' })),
    ).toEqual(['no entry chunk (no chunk calls hydrateRoot)'])
  })

  it('fails on a chunk cycle', () => {
    const deps = graph({
      'index-AbCd1234.js': [],
      'button-AbCd1234.js': ['ui-EfGh5678.js'],
      'ui-EfGh5678.js': ['button-AbCd1234.js'],
    })
    expect(checkChunkGraph(deps, code({ 'index-AbCd1234.js': entry }))).toEqual([
      'chunk cycle: button-AbCd1234.js <-> ui-EfGh5678.js',
    ])
  })

  it('fails when the entry reaches a group chunk, directly or not', () => {
    const deps = graph({
      'index-AbCd1234.js': ['utils-AbCd1234.js'],
      'utils-AbCd1234.js': ['ui-x.js'],
      'ui-x.js': [],
      'shell-AbCd1234.js': ['ui-x.js'],
    })
    expect(checkChunkGraph(deps, code({ 'index-AbCd1234.js': entry }))).toEqual([
      'the entry (index-AbCd1234.js) reaches group chunk ui-x.js, so every page loads it',
    ])
  })

  it('passes a clean graph: groups only reached from page chunks', () => {
    const deps = graph({
      'index-AbCd1234.js': ['utils-AbCd1234.js'],
      'utils-AbCd1234.js': [],
      'login-AbCd1234.js': ['ui-EfGh5678.js', 'utils-AbCd1234.js'],
      '_authenticated-AbCd1234.js': ['shell-EfGh5678.js', 'ui-EfGh5678.js'],
      'shell-EfGh5678.js': ['ui-EfGh5678.js', 'utils-AbCd1234.js'],
      'ui-EfGh5678.js': ['utils-AbCd1234.js'],
    })
    expect(checkChunkGraph(deps, code({ 'index-AbCd1234.js': entry }))).toEqual([])
  })

  it('reads the group names from config/clientChunkGroups.ts', () => {
    const deps = graph({ 'index-AbCd1234.js': ['shell-x.js'], 'shell-x.js': [] })
    expect(checkChunkGraph(deps, code({ 'index-AbCd1234.js': entry }))).toHaveLength(1)
    expect(checkChunkGraph(deps, code({ 'index-AbCd1234.js': entry }), ['ui'])).toEqual([])
  })
})

describe('readChunkGraph', () => {
  it('reads minified static imports and re-exports as edges, not dynamic imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chunk-graph-'))
    try {
      writeFileSync(
        join(dir, 'a.js'),
        'import{a as t}from"./x.js";import"./y.js";export*from"./z.js";' +
          'const l=()=>import(`./d.js`),m=()=>import("./e.js");',
      )
      for (const f of ['x.js', 'y.js', 'z.js', 'd.js', 'e.js']) writeFileSync(join(dir, f), '')
      writeFileSync(join(dir, 'a.js.map'), '{}')
      const { files, deps, code } = readChunkGraph(dir)
      expect(files.sort()).toEqual(['a.js', 'd.js', 'e.js', 'x.js', 'y.js', 'z.js'])
      expect(deps.get('a.js')?.sort()).toEqual(['x.js', 'y.js', 'z.js'])
      expect(code.get('a.js')).toContain('import(`./d.js`)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
