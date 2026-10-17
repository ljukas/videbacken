// The server build's static import graph, for `checkServerBundle.ts`
// (server-latency roadmap row 9).
//
// Nitro bundles its server plugins into the server entry (`index.mjs`), apart
// from the app (`_ssr/`, loaded on the first request). App code a plugin
// imports statically is a second copy that every instance loads at init. For
// ~/lib/db that is a second pool, so the build fails when the entry reaches it.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// A string only ~/lib/db's module holds (its missing-URL error, src/lib/db/index.ts).
// test/serverBundle.test.ts keeps the two in step.
export const DB_MODULE_MARKER = 'DATABASE_URL (or POSTGRES_URL) environment variable is not set'

// A module's static relative imports and re-exports (`import … from "./x.mjs"`,
// `import "./x.mjs"`, `export … from "../x.mjs"`). Dynamic `import("./x.mjs")`
// is excluded: it loads when it runs, not with the importer. Bare specifiers
// (packages) aren't followed: app code is never one.
export function staticImports(code: string): string[] {
  // Not after a word character, `$` or `.` (`reimport`, `x.import`); anything else
  // may precede one in valid ESM, minified (`}import{a}from"./x.mjs"`) included.
  const found = code.matchAll(
    /(?:^|[^\w$.])(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["'](\.\.?\/[^"']+)["']/g,
  )
  return [...new Set([...found].map((match) => match[1]))]
}

/**
 * Every file the entry loads statically, the entry included (absolute paths),
 * and each static import that doesn't resolve to a file: the walk can't see
 * past one, so the check fails on it rather than pass blind.
 */
export function staticClosure(entry: string): {
  files: string[]
  unresolved: { from: string; spec: string }[]
} {
  const seen = new Set<string>()
  const unresolved: { from: string; spec: string }[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      const target = resolve(dirname(file), spec)
      if (existsSync(target)) visit(target)
      else unresolved.push({ from: file, spec })
    }
  }
  if (existsSync(entry)) visit(resolve(entry))
  return { files: [...seen], unresolved }
}

// The built JavaScript modules under `dir`, outside node_modules (traced packages).
function builtModules(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.m?js$/.test(f) && !f.split(/[\\/]/).includes('node_modules'))
    .map((f) => join(dir, f))
}

/**
 * Problems with the server build whose entry is `entry`: none when the db
 * module is in the build but the entry doesn't reach it statically. Fails
 * closed: no entry, or no module holding the marker (the check would see nothing).
 */
export function checkServerBundle(entry: string): string[] {
  if (!existsSync(entry)) return [`no server entry at ${entry}`]
  const dir = dirname(entry)
  const holdsDb = (file: string) => readFileSync(file, 'utf8').includes(DB_MODULE_MARKER)
  if (!builtModules(dir).some(holdsDb)) {
    return [
      `no module under ${dir} holds the db module's marker: has its error message in src/lib/db/index.ts changed?`,
    ]
  }
  const { files, unresolved } = staticClosure(entry)
  return [
    ...unresolved.map(
      ({ from, spec }) =>
        `${relative(dir, from)} imports ${spec}, which isn't a file: the check can't follow it`,
    ),
    ...files
      .filter(holdsDb)
      .map(
        (file) =>
          `${relative(dir, file)} holds ~/lib/db, and ${relative(dir, entry)} loads it at init`,
      ),
  ]
}
