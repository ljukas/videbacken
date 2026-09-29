import { describe, expect, test } from 'vitest'
import {
  patchVercelBuildConfig,
  type VercelBuildConfig,
  type VercelRoute,
} from '../server/vercelBuildOutput'

// The routes Nitro's Vercel preset emits for this app (`.vercel/output/config.json`
// from `NITRO_PRESET=vercel bunx vite build`), trimmed to what matters here.
// Nitro's Vite integration adds the `/assets/**` immutable header rule, which
// Vercel applies before the filesystem check — so it also lands on whatever
// answers a *missing* asset.
function generatedConfig(): VercelBuildConfig {
  return {
    version: 3,
    routes: [
      { src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
      { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff' } },
      { handle: 'filesystem' },
      { src: '/_vercel/queues/consumer', dest: '/_vercel/queues/consumer' },
      { src: '/(.*)', dest: '/__server' },
    ],
  }
}

// First route after `handle: filesystem` whose `src` matches: what Vercel does
// with a request the static output doesn't contain.
function onFilesystemMiss(config: VercelBuildConfig, path: string): VercelRoute | undefined {
  const routes = config.routes ?? []
  const afterFilesystem = routes.slice(routes.findIndex((r) => r.handle === 'filesystem') + 1)
  return afterFilesystem.find((r) => r.src && new RegExp(`^${r.src}$`).test(path))
}

describe('patchVercelBuildConfig — missing hashed assets', () => {
  test('a missing /assets file is an uncacheable 404, not the SSR page with the immutable header', () => {
    // A chunk from a previous deploy (or reached through a stale skew-protection
    // pin) must not be cached for a year: the browser would keep serving the
    // 404 HTML for that URL across reloads until site data is cleared.
    const route = onFilesystemMiss(
      patchVercelBuildConfig(generatedConfig()),
      '/assets/_authenticated-BqfgCgBl.js',
    )

    expect(route).toMatchObject({ status: 404, headers: { 'cache-control': 'no-store' } })
    expect(route?.dest).toBeUndefined()
  })

  test('other paths still fall through to the server function', () => {
    const config = patchVercelBuildConfig(generatedConfig())

    for (const path of ['/users', '/assetsx/a.js', '/api/rpc/user/me', '/fonts/switzer.woff2']) {
      expect(onFilesystemMiss(config, path), path).toMatchObject({ dest: '/__server' })
    }
  })

  test('leaves the header routes before the filesystem check untouched', () => {
    const before = generatedConfig().routes ?? []
    const after = patchVercelBuildConfig(generatedConfig()).routes ?? []
    const upToFilesystem = (routes: VercelRoute[]) =>
      routes.slice(0, routes.findIndex((r) => r.handle === 'filesystem') + 1)

    expect(upToFilesystem(after)).toEqual(upToFilesystem(before))
  })

  test('is idempotent', () => {
    const once = patchVercelBuildConfig(generatedConfig())

    expect(patchVercelBuildConfig(structuredClone(once))).toEqual(once)
  })

  test('fails the build if the preset stops emitting a filesystem handle', () => {
    // A silent no-op would bring the one-year 404 caching back unnoticed.
    expect(() => patchVercelBuildConfig({ version: 3, routes: [] })).toThrow(/filesystem/)
  })
})
