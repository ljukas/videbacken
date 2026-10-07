// Fails the build when the client chunks import each other in a loop (ADR-0025 §6).
//
//   bun run build      # = vite build && this script && tsc --noEmit
//
// A cycle crashes a page at module init in prod only: dev doesn't chunk, and no
// test loads the built chunks. See scripts/chunkGraph.ts and the rule in
// config/clientChunkGroups.ts.
import { existsSync } from 'node:fs'
import { chunkCycles, formatChunkCycles, readChunkGraph } from './chunkGraph'

const ASSETS = '.output/public/assets'

if (!existsSync(ASSETS)) {
  console.error(`${ASSETS} is missing: run \`vite build\` first (this checks its client chunks)`)
  process.exit(1)
}
const cycles = chunkCycles(readChunkGraph(ASSETS).deps)
if (cycles.length) {
  console.error(formatChunkCycles(cycles))
  console.error(
    'These chunks import each other, so one runs before the other defines its exports. ' +
      'Fix the groups in config/clientChunkGroups.ts (see the rule at its top).',
  )
  process.exit(1)
}
console.log(formatChunkCycles(cycles))
