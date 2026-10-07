// Fails the build when the client chunks are unsafe to ship (ADR-0025 §6): two
// chunks that import each other, or the entry reaching a chunk group.
//
//   bun run build      # = vite build && this script && tsc --noEmit
//   vercel-build       # = drizzle-kit migrate && vite build && this script && tsc --noEmit
//
// A cycle crashes a page at module init in prod only: dev doesn't chunk, and no
// test loads the built chunks. See checkChunkGraph in scripts/chunkGraph.ts and the
// rules in config/clientChunkGroups.ts. Fails closed: no assets dir, no chunks or
// no entry chunk exits 1.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkChunkGraph, readChunkGraph } from './chunkGraph'

// Where the client build lands: Nitro's node-server preset (`bun run build`) and
// its Vercel preset (`vercel-build`, NITRO_PRESET=vercel).
const CANDIDATES = ['.output/public/assets', '.vercel/output/static/assets']

// The newest of the dir and its files: a rebuild rewrites the hashed chunks.
const newest = (dir: string) =>
  Math.max(statSync(dir).mtimeMs, ...readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs))

const found = CANDIDATES.filter((dir) => existsSync(dir))
if (!found.length) {
  console.error(
    `No client build found (looked for ${CANDIDATES.join(' and ')}): run \`vite build\` first`,
  )
  process.exit(1)
}
const assets = found.sort((a, b) => newest(b) - newest(a))[0]
console.log(
  found.length > 1
    ? `checking ${assets} (the newer of ${found.join(' and ')})`
    : `checking ${assets}`,
)

const { deps, code } = readChunkGraph(assets)
const problems = checkChunkGraph(deps, code)
if (problems.length) {
  for (const problem of problems) console.error(problem)
  // checkChunkGraph returns the missing-build problems alone.
  console.error(
    problems[0].startsWith('no ')
      ? `${assets} holds no complete client build: run \`vite build\` (this checks its chunks)`
      : 'Chunks that import each other run before each other defines its exports, and a group ' +
          'the entry reaches loads on every page. Fix the groups in config/clientChunkGroups.ts ' +
          '(see the rules at its top).',
  )
  process.exit(1)
}
console.log(`chunk cycles: none; the entry reaches no chunk group (${deps.size} client chunks)`)
