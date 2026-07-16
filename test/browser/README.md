# Component test harness (Vitest Browser Mode)

React component tests run in **real Chromium** (Playwright) — not jsdom —
because the UI leans on Radix primitives (dialogs, dropdowns, cmdk, tooltips)
that need real pointer/scroll/portal behaviour. Configured as the `browser`
Vitest project in `vitest.browser.config.ts`; the node/DB suite is the separate
`node` project (`vite.config.ts`).

## Writing a test

- Name the file `<Component>.browser.test.tsx`, co-located next to the component.
- `render` is **async** — `await` it. Assert with retry-able `expect.element(...)`
  (no `@testing-library/jest-dom`; Browser Mode ships its own matchers).

```tsx
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { MyComponent } from './MyComponent'

test('does the thing', async () => {
  const screen = await render(<MyComponent />)
  await screen.getByRole('button', { name: 'Spara' }).click()
  await expect.element(screen.getByText('Sparat')).toBeVisible()
})
```

## Components that read data

Default strategy is **cache-seeding** — no network layer. Seed a fresh client
with the oRPC-generated key and render via the wrapper (`render.tsx`):

```tsx
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { orpc } from '~/lib/orpc/client'

const queryClient = makeTestQueryClient()
queryClient.setQueryData(orpc.user.me.key(), fakeMe) // never hand-write the key
const { screen } = await renderWithProviders(<UserMenu />, { queryClient })
```

Reach for MSW only when testing the real fetch→error path (e.g. the
`*ErrorMessage.ts` mappers). Route-/loader-level tests are out of scope for now.

## Gotchas

- **Server functions bundle, routing doesn't.** The browser project loads the
  TanStack Start Vite plugin, so components that transitively import
  `createServerFn` server functions (or the isomorphic `~/lib/orpc/client`)
  bundle fine. But components that call `useRouter`/`useNavigate`/route hooks
  need a `RouterProvider` the harness doesn't yet provide — mock the hook (or
  the small module that owns it) and test the component's own UI. Example:
  `ModeToggle.browser.test.tsx` mocks `useTheme` because the real
  `ThemeProvider` calls `useRouter`.
- **Plugins, not Nitro.** The browser project deliberately omits Nitro/Tailwind/
  devtools (server/build-only). App CSS isn't loaded — assert on roles/text/
  visibility, not computed styles. If a test ever needs real layout, import
  `~/styles/app.css` in `test/browser/setup.ts`.

## Running

- `pnpm test:components` — watch the browser project (the TDD loop).
- `pnpm test` — run everything (node + browser) once.
- `pnpm test:node` — just the DB/service suite.

First-time setup downloads Chromium: `pnpm exec playwright install chromium`.
CI must run that before `pnpm test` (add `pnpm exec playwright install --with-deps chromium`).
