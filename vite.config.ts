import { paraglideVitePlugin } from '@inlang/paraglide-js'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vitest/config'
import { IMAGE_SIZES } from './src/lib/image/sizes'

const isTest = process.env.VITEST === 'true'

// Local `pnpm test` is force-pointed at the local `db` service. With the plain
// Postgres container (Neon Local paused — see compose.yaml) there is no pooler,
// so connections are direct sessions; the `max: 1` pinned connection in test
// mode (`src/lib/db/index.ts`) keeps the `SET search_path` alive across queries.
// Tests create per-test schemas (`test_w*`); the dev app's `public` schema is
// untouched. In CI (`CI=true`) we inherit DATABASE_URL from the job env instead.
const TEST_DATABASE_URL = 'postgres://neon:npg@localhost:14520/neondb'

export default defineConfig({
  server: {
    port: 14500,
  },
  resolve: {
    tsconfigPaths: true,
  },
  // App build pulls in the TanStack Start + React + Tailwind + Nitro plugin chain.
  // Vitest runs server-only modules under `environment: 'node'`, so loading those
  // plugins would (a) try to evaluate React's CJS entry as ESM and (b) keep a Vite
  // dev server alive past test completion. Skip them under VITEST.
  plugins: isTest
    ? []
    : [
        devtools(),
        // Compiles messages/{sv,en}.json into typed functions in src/paraglide/
        // (gitignored build artifact — `pnpm i18n:compile` covers editor/tests).
        // Locale strategy is cookie-only: URLs stay English per CLAUDE.md.
        paraglideVitePlugin({
          project: './project.inlang',
          outdir: './src/paraglide',
          strategy: ['cookie', 'baseLocale'],
          cookieName: 'oceanview-locale',
          cookieMaxAge: 60 * 60 * 24 * 365,
        }),
        tailwindcss(),
        tanstackStart({
          srcDirectory: 'src',
        }),
        viteReact(),
        // `@better-auth/passkey` → `@simplewebauthn/server` → `@peculiar/x509`
        // uses tsyringe decorators that call `Reflect.getMetadata` at module-
        // load time. The polyfill lives at the top of x509's ESM build as a
        // bare `import 'reflect-metadata'`, which Nitro's Rolldown pipeline
        // tree-shakes out by default — so SSR crashes with
        // `TypeError: Reflect.getMetadata is not a function` on the first page
        // request in prod. Tell Rolldown to keep bare side-effect imports of
        // reflect-metadata (and re-state Nitro's own polyfill defaults so we
        // don't accidentally drop those either).
        // See https://github.com/better-auth/better-auth/issues/7463.
        nitro({
          // Baseline security headers on every response. Deliberately no CSP:
          // the inline theme script + Blob/Analytics/SSE origins make a
          // correct policy real work, and the app's XSS surface is minimal
          // (no user-controlled HTML). Revisit if that changes.
          routeRules: {
            '/**': {
              headers: {
                'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'strict-origin-when-cross-origin',
                'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
              },
            },
          },
          // TanStack Start manages Nitro's serverDir; declare the queue
          // consumer plugin explicitly so it survives the rolldown bundle.
          // The file uses the `vercel:queue` runtime hook — see
          // `server/plugins/queueConsumer.ts`.
          plugins: ['./server/plugins/queueConsumer.ts'],
          // Activates Vercel Image Optimization for `/_vercel/image?url=…&w=…&q=…`.
          // The `unpic/providers/vercel` transformer (used by ~/lib/image/transformer)
          // produces URLs that resolve here in production. In `pnpm dev` the
          // transformer falls back to the raw source URL — see that module.
          vercel: {
            config: {
              version: 3,
              // `sizes` is the optimizer's allow-list — any `?w=` not in the
              // array is rejected with INVALID_IMAGE_OPTIMIZE_REQUEST. Source
              // of truth is `src/lib/image/sizes.ts` (shared with
              // `snapBreakpoints`, which components use to build srcsets).
              images: {
                sizes: [...IMAGE_SIZES],
                domains: [],
                remotePatterns: [
                  { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
                ],
                formats: ['image/webp'],
                minimumCacheTTL: 2_678_400,
              },
            },
            // Subscribes the Vercel preset's queue handler to each topic.
            // Producers call `queue.publish('<topic>', …)` from oRPC
            // procedures; the consumer lives in
            // `server/plugins/queueConsumer.ts` (vercel:queue hook), which
            // dispatches by topic name. `pdf_thumbnail` is reserved but not
            // yet produced/consumed — no trigger until the renderer ships.
            queues: {
              triggers: [
                { topic: 'blurhash' },
                { topic: 'image_thumbnail' },
                { topic: 'email_user_invited' },
                { topic: 'heic_transcode' },
              ],
            },
          },
          rollupConfig: {
            treeshake: {
              moduleSideEffects: (id: string) => {
                if (id.includes('reflect-metadata')) return true
                if (id.includes('unenv/polyfill/')) return true
                if (id.includes('node-fetch-native/polyfill')) return true
                return false
              },
            },
          },
        }),
      ],
  test: {
    projects: [
      {
        // Existing node/DB suite — behaviour unchanged. `extends: true` inherits
        // the root `resolve` (so `~/*` aliases resolve) and the root `plugins`,
        // which are already `[]` under VITEST (see the isTest guard above).
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          pool: 'forks',
          // Distinct groupOrder from the browser project: Vitest 4 refuses to
          // co-run projects that share a groupOrder but differ in maxWorkers.
          // Group 0 runs first (node/DB), then group 1 (browser) — see
          // vitest.browser.config.ts.
          sequence: { groupOrder: 0 },
          // Each test creates its own Postgres schema (see test/setup.ts). Cap
          // workers so the CREATE/DROP SCHEMA churn against Neon Local stays
          // bounded; bump cautiously after observing CI stability.
          maxWorkers: 4,
          hookTimeout: 20_000,
          // Per-test schema CREATE + migrations + DROP is the dominant cost; a
          // single service-driven test with a couple of transactions can easily
          // burn 5–10s. Default Vitest timeout is 5s — raise it so realistic
          // multi-mutation scenarios don't false-fail.
          testTimeout: 15_000,
          // TEST_SCHEMA flips src/lib/db/index.ts into test mode (pinned single
          // connection + exposed __testClient). Setting it here means the runner
          // injects it into the worker before any module evaluates, so setup.ts
          // can use a normal static import.
          env: {
            TEST_SCHEMA: '1',
            ...(process.env.CI ? {} : { DATABASE_URL: TEST_DATABASE_URL }),
          },
          include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
          // Component tests run in the browser project, not here.
          exclude: ['**/*.browser.test.*', '**/node_modules/**'],
        },
      },
      // Real-browser component tests live in their own standalone config so they
      // can carry React + Paraglide plugins without the node project (or the
      // app's Start/Nitro build chain) inheriting them.
      './vitest.browser.config.ts',
    ],
  },
})
