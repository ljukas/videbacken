import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineProject } from 'vitest/config'

// Component tests run in a REAL browser (Chromium via Playwright) — not jsdom —
// because the app leans on Radix primitives (dialogs, dropdowns, cmdk, tooltips)
// whose pointer/scroll/resize/portal behaviour jsdom can't emulate without a
// polyfill pile. This project carries only the plugins component tests need
// (Paraglide messages, the TanStack Start server-fn transform, React) — NOT the
// app's Nitro/Tailwind/devtools chain, which is server/build-only and would keep
// a dev server alive past the run (the reason the node project stays plugin-free
// via `extends: true`).
export default defineProject({
  plugins: [
    // Same options as the app's Paraglide plugin in vite.config.ts, so compiled
    // `m.*()` message functions resolve identically in tests.
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      strategy: ['cookie', 'baseLocale'],
      cookieName: 'oceanview-locale',
      cookieMaxAge: 60 * 60 * 24 * 365,
    }),
    // Rewrites `createServerFn` server functions into client RPC stubs and
    // resolves the isomorphic split, so components that transitively import
    // server code (ThemeProvider via themeFns, the oRPC client, …) can bundle
    // for the browser. Without this, Rolldown tries to bundle
    // @tanstack/react-start/server and fails. Nitro is intentionally omitted.
    tanstackStart({ srcDirectory: 'src' }),
    viteReact(),
  ],
  // Mirror the root `~/*` path-alias resolution. The node project inherits this
  // via `extends: true`; this standalone file must restate it.
  resolve: { tsconfigPaths: true },
  test: {
    name: 'browser',
    // Distinct groupOrder from the node project (vite.config.ts): Vitest 4
    // refuses to co-run projects that share a groupOrder but differ in
    // maxWorkers. Group 1 runs after the node/DB group.
    sequence: { groupOrder: 1 },
    include: ['src/**/*.browser.test.tsx', 'test/**/*.browser.test.tsx'],
    setupFiles: ['./test/browser/setup.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})
