// The client build's static chunk-import graph, shared by `measureBundle.ts` and
// `checkChunkCycles.ts` (client-performance roadmap, ADR-0025 §6).
//
// A chunk cycle is two or more chunks that statically import each other. ES
// modules allow it, but one chunk then runs before the other has defined its
// exports, so a call at module init throws (`x is not a function`). The client
// chunk groups (config/clientChunkGroups.ts) can create one, so `bun run build`
// and `vercel-build` fail on any (`checkChunkGraph`, run by checkChunkCycles.ts).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clientChunkGroups } from '../config/clientChunkGroups'

export type ChunkGraph = {
  files: string[]
  code: Map<string, string>
  // Each chunk's static imports (`import … from "./x.js"`, `import "./x.js"`).
  // Dynamic `import("./x.js")` is excluded: it runs after the importer has.
  deps: Map<string, string[]>
}

export function readChunkGraph(assetsDir: string): ChunkGraph {
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
  const code = new Map<string, string>()
  const deps = new Map<string, string[]>()
  for (const file of files) {
    const text = readFileSync(join(assetsDir, file), 'utf8')
    code.set(file, text)
    const imports = [...text.matchAll(/(?:import|from)\s*["']\.\/([^"']+\.js)["']/g)].map(
      (x) => x[1],
    )
    deps.set(file, [...new Set(imports)])
  }
  return { files, code, deps }
}

// Every strongly connected component of more than one chunk, plus every chunk
// that imports itself (Tarjan's algorithm). Each cycle and the list are sorted.
export function chunkCycles(deps: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []
  let next = 0

  const visit = (chunk: string) => {
    index.set(chunk, next)
    low.set(chunk, next)
    next++
    stack.push(chunk)
    onStack.add(chunk)
    for (const dep of deps.get(chunk) ?? []) {
      if (!index.has(dep)) {
        visit(dep)
        low.set(chunk, Math.min(low.get(chunk) as number, low.get(dep) as number))
      } else if (onStack.has(dep)) {
        low.set(chunk, Math.min(low.get(chunk) as number, index.get(dep) as number))
      }
    }
    if (low.get(chunk) !== index.get(chunk)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop() as string
      onStack.delete(member)
      component.push(member)
    } while (member !== chunk)
    if (component.length > 1 || deps.get(chunk)?.includes(chunk)) cycles.push(component.sort())
  }

  for (const chunk of deps.keys()) if (!index.has(chunk)) visit(chunk)
  return cycles.sort((a, b) => a[0].localeCompare(b[0]))
}

export function staticClosure(deps: Map<string, string[]>, root: string): Set<string> {
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    stack.push(...(deps.get(file) ?? []))
  }
  return seen
}

// The entry chunk is the one that hydrates the app.
export function entryChunk(code: Map<string, string>): string | undefined {
  return [...code.keys()].find((f) => code.get(f)?.includes('hydrateRoot'))
}

// Everything wrong with a client build's chunks; empty means it may ship. Fails
// closed: no chunks or no entry is a problem, never a pass. The rules (ADR-0025 §6):
// no chunk cycle, and the entry's static closure reaches no group chunk (a grouped
// module the entry reaches would make every page, /login included, load the group).
export function checkChunkGraph(
  deps: Map<string, string[]>,
  code: Map<string, string>,
  groups: string[] = clientChunkGroups.map((g) => g.name),
): string[] {
  if (!deps.size || !code.size) return ['no client chunks found']
  const entry = entryChunk(code)
  if (!entry) return ['no entry chunk (no chunk calls hydrateRoot)']
  const problems = chunkCycles(deps).map((cycle) => `chunk cycle: ${cycle.join(' <-> ')}`)
  // `ui-<hash>.js`. Any hash length: a missed match would pass silently.
  const isGroupChunk = (f: string) => groups.some((g) => new RegExp(`^${g}-[\\w-]+\\.js$`).test(f))
  for (const f of [...staticClosure(deps, entry)].filter(isGroupChunk).sort())
    problems.push(`the entry (${entry}) reaches group chunk ${f}, so every page loads it`)
  return problems
}

export function formatChunkCycles(cycles: string[][]): string {
  if (!cycles.length) return 'chunk cycles: none'
  return [
    `chunk cycles: ${cycles.length}`,
    ...cycles.map((cycle) => `  ${cycle.join(' <-> ')}`),
  ].join('\n')
}
