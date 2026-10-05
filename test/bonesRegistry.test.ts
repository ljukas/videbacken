import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// Capture-time helper, imported from scripts/ like lanIp.test.ts does.
import { capturedSkeletons, renderBonesRegistry } from '../scripts/bonesRegistry'

// A SectionSkeleton whose name has no bones (or isn't registered) silently
// renders a plain block in prod (ADR-0025 §4). These pin the source's names to
// the committed bones and registry.
const root = fileURLToPath(new URL('..', import.meta.url))
const bonesDir = join(root, 'src/bones')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'bones' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Every `<SectionSkeleton … name="…">` in app code (tests use made-up names).
function skeletonNamesInSource(): { file: string; name: string | undefined }[] {
  return sourceFiles(join(root, 'src')).flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    const usages = text.match(/<SectionSkeleton\b[^>]*/g) ?? []
    return usages.map((usage) => ({
      file: relative(root, file),
      name: usage.match(/\bname="([^"]+)"/)?.[1],
    }))
  })
}

function registeredNames(): string[] {
  const registry = readFileSync(join(bonesDir, 'registry.ts'), 'utf8')
  return [...registry.matchAll(/^ {2}"([^"]+)": _/gm)].map((m) => m[1])
}

describe('section skeleton bones', () => {
  const usages = skeletonNamesInSource()

  it('finds the SectionSkeleton usages it checks', () => {
    // Guards the scan itself: a regex that matched nothing would pass everything below.
    expect(usages.length).toBeGreaterThan(0)
  })

  it('gives every SectionSkeleton a literal name', () => {
    // A dynamic name can't be checked here, and boneyard captures by literal name.
    expect(usages.filter((u) => u.name === undefined)).toEqual([])
  })

  it('has captured bones for every SectionSkeleton name', () => {
    const captured = new Set(capturedSkeletons(bonesDir))
    const missing = usages.filter((u) => u.name !== undefined && !captured.has(u.name))
    expect(missing, 'run `bun run bones:capture <path>` for these').toEqual([])
  })

  it('registers every SectionSkeleton name', () => {
    const registered = new Set(registeredNames())
    const missing = usages.filter((u) => u.name !== undefined && !registered.has(u.name))
    expect(missing).toEqual([])
  })

  it('commits the registry the capture script writes: every bones file, in order', () => {
    const config = JSON.parse(readFileSync(join(root, 'boneyard.config.json'), 'utf8'))
    expect(readFileSync(join(bonesDir, 'registry.ts'), 'utf8')).toBe(
      renderBonesRegistry(capturedSkeletons(bonesDir), config),
    )
  })
})
