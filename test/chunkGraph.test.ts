import { describe, expect, it } from 'vitest'
import { chunkCycles, formatChunkCycles } from '../scripts/chunkGraph'

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
