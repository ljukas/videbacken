// Fails the build when the server entry loads ~/lib/db at init (server-latency
// roadmap row 9): a Nitro plugin that imports app code statically bundles a
// second copy of it beside the app's, so every instance gets a second pool.
//
//   bun run build      # = vite build && … && this script && tsc --noEmit
//   vercel-build       # = drizzle-kit migrate && bun run db:seed && vite build && … && this script && …
//
// A plugin that needs app code imports it inside its hook
// (server/plugins/queueConsumer.ts). See checkServerBundle in scripts/serverBundle.ts.
import { existsSync, statSync } from 'node:fs'
import { checkServerBundle } from './serverBundle'

// Where the server entry lands: Nitro's node-server preset (`bun run build`) and
// its Vercel preset (`vercel-build`, NITRO_PRESET=vercel).
const CANDIDATES = ['.output/server/index.mjs', '.vercel/output/functions/__server.func/index.mjs']

const found = CANDIDATES.filter((file) => existsSync(file))
if (!found.length) {
  console.error(
    `No server build found (looked for ${CANDIDATES.join(' and ')}): run \`vite build\` first`,
  )
  process.exit(1)
}
const entry = found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
console.log(
  found.length > 1
    ? `checking ${entry} (the newer of ${found.join(' and ')})`
    : `checking ${entry}`,
)

const problems = checkServerBundle(entry)
if (problems.length) {
  for (const problem of problems) console.error(problem)
  // checkServerBundle returns the fail-closed problems alone.
  if (!problems[0].startsWith('no ')) {
    console.error(
      'A Nitro plugin (vite.config.ts) that imports app code statically gives every instance a ' +
        'second copy of it. Import it inside the hook instead, as server/plugins/queueConsumer.ts does.',
    )
  }
  process.exit(1)
}
console.log('server entry: does not load ~/lib/db at init')
