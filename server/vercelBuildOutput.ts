import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NitroModule } from 'nitro/types'

// Post-processes the Build Output API config (`.vercel/output/config.json`)
// that Nitro's Vercel preset writes, for a gap in nitro 3.0.260603-beta.
//
// Nitro's Vite integration adds a `/assets/**` route rule with
// `cache-control: public, max-age=31536000, immutable`. Vercel applies it before
// the filesystem check, so when a hashed chunk is *missing* (a tab from a
// previous deploy, or a skew-protection pin to a deployment that predates the
// chunk) the request falls through to the SSR function and its 404 HTML goes
// out with that one-year immutable header. The browser caches it under the
// chunk URL, and every later `import()` of that URL fails from cache — across
// reloads and new deploys — until the user clears site data. TanStack Router's
// reload-once for failed route chunks can't help, because the reload hits the
// same cached 404.
//
// Fix, mirroring upstream nitrojs/nitro#4474 (which skips root-based assets
// like Vite's `/assets`, so it doesn't cover us): answer a filesystem miss under
// `/assets/` with an uncacheable 404 at the edge, before the SSR fallback.

export type VercelRoute = {
  src?: string
  dest?: string
  handle?: string
  status?: number
  headers?: Record<string, string>
  continue?: boolean
  [key: string]: unknown
}

export type VercelBuildConfig = {
  version: number
  routes?: VercelRoute[]
  [key: string]: unknown
}

const ASSETS_SRC = '/assets/(.*)'

const missingAssetRoute: VercelRoute = {
  src: ASSETS_SRC,
  status: 404,
  headers: { 'cache-control': 'no-store' },
  continue: false,
}

export function patchVercelBuildConfig(config: VercelBuildConfig): VercelBuildConfig {
  const routes = [...(config.routes ?? [])]
  const filesystem = routes.findIndex((route) => route.handle === 'filesystem')
  if (filesystem === -1) {
    throw new Error(
      'vercelBuildOutput: no `handle: filesystem` route in .vercel/output/config.json — ' +
        'cannot add the no-store 404 for missing /assets files. Check the Nitro Vercel preset.',
    )
  }

  const next = routes[filesystem + 1]
  if (!(next?.src === ASSETS_SRC && next.status === 404)) {
    routes.splice(filesystem + 1, 0, missingAssetRoute)
  }

  return { ...config, routes }
}

export const vercelBuildOutput: NitroModule = {
  name: 'videbacken:vercel-build-output',
  setup(nitro) {
    if (!nitro.options.preset.startsWith('vercel')) return
    // Modules install after the preset's hooks are registered, so this runs
    // after the preset has written config.json in its own `compiled` hook.
    nitro.hooks.hook('compiled', async () => {
      const path = join(nitro.options.output.dir, 'config.json')
      const config = JSON.parse(await readFile(path, 'utf8')) as VercelBuildConfig
      await writeFile(path, JSON.stringify(patchVercelBuildConfig(config), null, 2))
      nitro.logger.info(
        'Patched .vercel/output/config.json: missing /assets files 404 with no-store',
      )
    })
  },
}
