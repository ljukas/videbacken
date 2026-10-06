import { describe, expect, it } from 'vitest'
import { staticClosure } from '../scripts/measureBundle'

describe('staticClosure', () => {
  it('follows static imports transitively, once each, cycles included', () => {
    const deps = new Map([
      ['a.js', ['b.js', 'c.js']],
      ['b.js', ['c.js']],
      ['c.js', ['a.js']],
      ['d.js', []],
    ])
    expect([...staticClosure(deps, 'a.js')].sort()).toEqual(['a.js', 'b.js', 'c.js'])
  })

  it('is just the root when it imports nothing', () => {
    expect([...staticClosure(new Map([['d.js', []]]), 'd.js')]).toEqual(['d.js'])
  })
})
