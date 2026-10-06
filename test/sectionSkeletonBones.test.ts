import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Each page imports only its own bones (client-performance step 4, ADR-0025 §4).
// A captured section that loses its import silently renders a plain block in prod;
// these pin every SectionSkeleton to a committed capture.
const root = fileURLToPath(new URL('..', import.meta.url))
const bonesDir = join(root, 'src/bones')
const captured = readdirSync(bonesDir)
  .filter((f) => f.endsWith('.bones.json'))
  .map((f) => f.slice(0, -'.bones.json'.length))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'bones' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

type Usage = { file: string; bonesVar?: string; name?: string; imported: Map<string, string> }
const usages: Usage[] = sourceFiles(join(root, 'src')).flatMap((file) => {
  const text = readFileSync(file, 'utf8')
  // `import chargingTotalsBones from '~/bones/charging-totals.bones.json'` → var → bones name
  const imported = new Map(
    [...text.matchAll(/import\s+(\w+)\s+from\s+'~\/bones\/([^']+)\.bones\.json'/g)].map((x) => [
      x[1],
      x[2],
    ]),
  )
  return (text.match(/<SectionSkeleton\b[^>]*/g) ?? []).map((tag) => ({
    file: relative(root, file),
    bonesVar: tag.match(/\bbones=\{(\w+)\}/)?.[1],
    name: tag.match(/\bname="([^"]+)"/)?.[1],
    imported,
  }))
})

describe('section skeleton bones', () => {
  it('finds the SectionSkeleton usages it checks', () => {
    expect(usages.length).toBeGreaterThan(0)
  })

  it('gives every SectionSkeleton bones, or a literal name for a section not captured yet', () => {
    expect(usages.filter((u) => !u.bonesVar === !u.name)).toEqual([])
  })

  it('imports each bones prop from a committed capture in the same file', () => {
    const bad = usages.filter(
      (u) => u.bonesVar && !captured.includes(u.imported.get(u.bonesVar) ?? ''),
    )
    expect(bad).toEqual([])
  })

  it('passes the bones of every captured section (a literal name with a capture is a lost import)', () => {
    const lost = usages.filter((u) => u.name && captured.includes(u.name))
    expect(lost, 'pass bones={…} imported from ~/bones/<name>.bones.json').toEqual([])
  })

  it('names every breakpoint of a capture after its file', () => {
    for (const name of captured) {
      const json = JSON.parse(readFileSync(join(bonesDir, `${name}.bones.json`), 'utf8'))
      const names = Object.values(json.breakpoints as Record<string, { name: string }>).map(
        (b) => b.name,
      )
      expect(names.length, name).toBeGreaterThan(0)
      expect(new Set(names), name).toEqual(new Set([name]))
    }
  })

  it('has no generated registry: pages import their bones', () => {
    expect(existsSync(join(bonesDir, 'registry.ts'))).toBe(false)
  })
})
