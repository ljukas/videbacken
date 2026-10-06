// Measures what each page's JS costs (client-performance roadmap, ADR-0025).
//
//   bun run bundle:measure      # = vite build --sourcemap && this script
//
// A page's cost is the gzipped size of its route chunk's *static* import closure,
// minus the entry's closure and the signed-in shell's. Dynamic imports
// (`React.lazy`, route preloads) are excluded: they load on demand. Packages are
// read from each chunk's source map; bones from its code (the source map can
// omit an inlined JSON module).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const ASSETS = '.output/public/assets'
// Route chunk name prefixes (TanStack names a split route chunk after its file).
const PAGES: Record<string, string> = {
  '/charging': 'charging',
  '/charging/settings': 'settings',
  '/charging/economy': 'economy',
  '/charging/patterns': 'patterns',
  '/charging/sessions/$id': '_sessionId',
  '/energy': 'energy',
  '/sensors': 'sensors',
  '/users': 'users',
  '/account/profile': 'profile',
}
const WATCHED = ['libphonenumber-js', 'country-flag-icons', '@tanstack/form-core', 'boneyard-js']

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

function main() {
  if (!existsSync(ASSETS)) throw new Error(`${ASSETS} is missing: run \`bun run bundle:measure\``)
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'))
  const captured = readdirSync('src/bones')
    .filter((f) => f.endsWith('.bones.json'))
    .map((f) => f.slice(0, -'.bones.json'.length))
    .sort()
  const gz = new Map<string, number>()
  const deps = new Map<string, string[]>()
  const sources = new Map<string, string[]>()
  const code = new Map<string, string>()
  for (const file of files) {
    const text = readFileSync(join(ASSETS, file), 'utf8')
    code.set(file, text)
    gz.set(file, gzipSync(text).length)
    const imports = [...text.matchAll(/(?:import|from)\s*["']\.\/([^"']+\.js)["']/g)].map(
      (x) => x[1],
    )
    deps.set(file, [...new Set(imports)])
    const map = join(ASSETS, `${file}.map`)
    sources.set(
      file,
      existsSync(map) ? (JSON.parse(readFileSync(map, 'utf8')).sources as string[]) : [],
    )
  }
  const kb = (set: Set<string>) => [...set].reduce((sum, f) => sum + (gz.get(f) ?? 0), 0) / 1024
  const byPrefix = (prefix: string) => files.filter((f) => f.startsWith(`${prefix}-`))

  const entry = files.find((f) => readFileSync(join(ASSETS, f), 'utf8').includes('hydrateRoot'))
  if (!entry) throw new Error('No entry chunk (none calls hydrateRoot)')
  const base = staticClosure(deps, entry)
  // Two route chunks are named _authenticated (the layout and the dashboard); the shell is the bigger closure.
  const shell = byPrefix('_authenticated')
    .map((f) => staticClosure(deps, f))
    .sort((a, b) => kb(b) - kb(a))[0]
  for (const f of shell ?? []) base.add(f)
  console.log(`entry + shell: ${kb(base).toFixed(0)} KB gz\n`)

  for (const [page, prefix] of Object.entries(PAGES)) {
    const [chunk, ...more] = byPrefix(prefix)
    if (!chunk || more.length) {
      console.log(`${page}: ${chunk ? 'ambiguous' : 'no'} chunk for prefix "${prefix}"`)
      continue
    }
    const own = staticClosure(deps, chunk)
    for (const f of base) own.delete(f)
    const all = [...own].flatMap((f) => sources.get(f) ?? [])
    const packages = WATCHED.filter((p) => all.some((s) => s.includes(`node_modules/${p}/`)))
    // Every breakpoint of a capture is named after it (test/sectionSkeletonBones.test.ts):
    // `name:"x"` as an object literal, `"name":"x"` inside a big one's JSON.parse string.
    const bones = captured.filter((name) =>
      [...own].some((f) => new RegExp(`\\bname"?:["'\`]${name}["'\`]`).test(code.get(f) ?? '')),
    )
    const top = [...own]
      .sort((a, b) => (gz.get(b) ?? 0) - (gz.get(a) ?? 0))
      .slice(0, 5)
      .map((f) => `${f.replace(/-[\w-]{8}\.js$/, '')} ${((gz.get(f) ?? 0) / 1024).toFixed(0)}`)
    console.log(`${page.padEnd(24)} +${kb(own).toFixed(0).padStart(4)} KB gz | ${top.join(', ')}`)
    console.log(`${''.padEnd(26)}packages: ${packages.join(', ') || '—'}`)
    console.log(`${''.padEnd(26)}bones: ${bones.join(', ') || '—'}`)
  }
}

if (import.meta.main) main()
