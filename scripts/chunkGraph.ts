// The client build's static chunk-import graph, shared by `measureBundle.ts` and
// `checkChunkCycles.ts` (client-performance roadmap, ADR-0025 §6).
//
// A chunk cycle is two or more chunks that statically import each other. ES
// modules allow it, but one chunk then runs before the other has defined its
// exports, so a call at module init throws (`x is not a function`). The client
// chunk groups (config/clientChunkGroups.ts) can create one, so `bun run build`
// fails on any.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

export function formatChunkCycles(cycles: string[][]): string {
  if (!cycles.length) return 'chunk cycles: none'
  return [
    `chunk cycles: ${cycles.length}`,
    ...cycles.map((cycle) => `  ${cycle.join(' <-> ')}`),
  ].join('\n')
}
