# Client performance step 6: small bundle items (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> House rule: after each task's commit, two adversarial reviewers (paired per task) start from the assumption that
> the task is wrong and changed behaviour. Fix or rule on every finding before the next task.

**Goal:** The avatar upload loads exifreader and the Vercel Blob client (with `jose`) only when a file is picked.
The body font is preloaded in the SSR `<head>`. The signed-in shell's chunks, split by step 4's lazy dialogs, are
merged back with no page bigger than on `main`. The search-parsing item is measured and recorded, with no code
change.

**Architecture:**
- `AvatarUpload` keeps its UI and flow. Its two heavy imports (`~/lib/files/exif`, `~/lib/effects/storage/clientUpload`)
  become one `import()` pair. A click on the upload button starts it (the OS picker takes seconds, so it's ready),
  and `handleFile` awaits it. If the chunk can't load, the user sees the localized upload error, not a raw
  "Failed to fetch dynamically imported module".
- The body font URL lives in one client-safe constant (`src/lib/fonts.ts`), which `__root.tsx` preloads. A node test
  checks that `app.css`'s Switzer `@font-face` uses the same URL and that the file exists. A mismatch would download
  the font twice.
- Two rolldown `codeSplitting.groups` for the client build only (`config/clientChunkGroups.ts`, wired through
  `environments.client` in `vite.config.ts`): `shell` for the modules only the signed-in shell uses, `ui` for those it
  shares with the signed-out pages. **No grouped module may be reachable from the entry.** One such module (the
  router's nested `@tanstack/store`) put the whole group on every page in the prototype.
- `scripts/measureBundle.ts` also prints the entry alone and the signed-out pages (`/login`, `/onboarding`,
  `/signed-in`, measured beyond the entry only), and watches `exifreader`, `@vercel/blob` and `jose`.

**Tech stack:** React 19, Vite 8.1.5 (rolldown 1.2.0, `output.codeSplitting.groups`), TanStack Start (pinned RC),
Vitest 5 (node + browser projects), bun. No new dependencies.

**Design:** shaped in chat on 2026-10-06 from the measurements below. Owner decisions:
- **Item 5, search parsing out of the shell: record and drop.** The cause isn't search parsing. It is the `/energy`
  loader: `energyOverviewQueryFor` → `stockholmYearMonth` pulls `date-fns` + `@date-fns/tz` into the entry, about
  2 KB gz, which every page that formats dates loads anyway. The general fix (TanStack `codeSplittingOptions`
  `defaultBehavior: [['loader', 'component'], …]`) was prototyped: entry 176.4 → 170.6, shell total 258 → 255, but
  every page +2–3 KB gz, and a cold client navigation's queries would start only after the route chunk arrives,
  against ADR-0025 §1. A narrow `Intl` fix goes against the date-fns preference.
- **Item 4, chunk groups: tune until no page grows.** No page may end up bigger than on `main`, `/onboarding` and
  `/signed-in` included. If no tuning gets there, keep only the `shell` group. If even that grows a page, drop the
  item and record why.

**Roadmap:** `docs/superpowers/roadmaps/2026-10-05-client-performance.md`, row 6. ADR-0025 §6.

## Baseline (`main` at `4376917`, `bun run bundle:measure`, KB gz)

| Page | KB gz | Notes |
|---|---:|---|
| entry alone | 176.4 | 24 chunks |
| entry + signed-in shell | 258 | shell adds 28 chunks (81.3) |
| `/charging` | 84 | |
| `/charging/settings` | 44 | |
| `/charging/economy` | 77 | |
| `/charging/patterns` | 76 | |
| `/charging/sessions/$id` | 65 | |
| `/energy` | 72 | |
| `/sensors` | 48 | |
| `/users` | 73 | |
| `/account/profile` | 213 | AvatarUpload 72 (raw: exifreader 344, @vercel/oidc + jose 146, @vercel/blob 81, bowser 36) |
| `/login` (beyond entry) | 88.4 | 23 chunks |
| `/onboarding` (beyond entry) | 150.0 | 27 chunks; also renders AvatarUpload |
| `/signed-in` (beyond entry) | 34.0 | 12 chunks |

**Where `jose` comes from:** `@vercel/blob/client`'s shared chunk imports `getVercelOidcToken` from `@vercel/oidc`.
That package's browser entry (`dist/index-browser.js`) is CommonJS and `require`s `verify-vercel-oidc-token`, which
requires all of `jose`, so nothing tree-shakes. It is unchanged in `@vercel/oidc` 4.0.0, and `@vercel/blob` 2.8.1
still depends on `^3.6.1`. Patching the dependency is out (owner rule), so the fix is to load it only on upload.

**Chunk-group prototype** (two groups, see Task 4): entry 176.1, entry + shell 251 (shell 10 chunks), pages −0 to −1,
`/login` 84.6 (14 chunks), `/onboarding` 158.0, `/signed-in` 49.1. The last two break the no-growth rule.

## Global Constraints

- No new dependencies. No `bun patch`, no resolve alias that stubs `@vercel/oidc` (owner: never patch dependencies).
- Client code may only `import type` from services (CLAUDE.md gotcha). `src/lib/fonts.ts` is client-safe, with no imports.
- User-facing text is Paraglide-localized. The load-failure toast reuses `m.avatar_upload_error()`, so no new keys.
- Logging only via `~/lib/logger/`; never `console.*`.
- The chunk groups apply to the client environment only (`environments.client.build.rolldownOptions`), never to the
  Nitro/SSR build.
- No page's total may exceed the baseline table above (entry alone, entry + shell, every page, `/login`,
  `/onboarding`, `/signed-in`). Rounding: compare the script's printed values.
- Conventional Commits, ≤72 chars. One PR for the whole step: `perf(bundle): …`.

## Review Focus

1. **The upload chunk fails to load** (offline, or a deploy replaced the hashed chunk). Expected: the localized
   "upload failed" toast, the button usable again, no raw English error. Pinned in Task 2 (`AvatarUpload.loadError`).
2. **A file picked before the warm-up import finishes** (slow phone network). Expected: the upload still runs once
   the import resolves. `handleFile` awaits the same promise. Pinned in Task 2 (the pick test never clicks the
   button first).
3. **The preload URL drifts from the CSS `@font-face` URL** (a font renamed or moved). Expected: a test fails, not a
   silent double download. Pinned in Task 3.
4. **A grouped module that the entry also reaches** (the `@tanstack/store` case). Expected: caught by the entry-alone
   number in `bundle:measure`, and the matcher test pins the known case. Pinned in Task 4.
5. **A lazy admin dialog opened before the shell chunk is cached.** It imports from the `shell`/`ui` chunks. Expected:
   it still opens (they're static imports of the dialog chunk). Checked live in Task 4, Step 7.

---

### Task 1: Measure the signed-out pages and the upload packages

**Files:**
- Modify: `scripts/measureBundle.ts`

**Reviewers:** `code-reviewer` + a general correctness reviewer (the numbers every later task is judged by).

**Interfaces:**
- Produces: `bun run bundle:measure` prints, after `entry + shell`, a line `entry: N KB gz`, and after the signed-in
  pages a `signed-out (beyond the entry)` block with `/login`, `/onboarding`, `/signed-in`. WATCHED gains
  `exifreader`, `@vercel/blob`, `jose`.

- [ ] **Step 1: Add the entry line, the signed-out pages and the watched packages**

In `scripts/measureBundle.ts`:

```ts
// Signed-out pages: they load the entry but not the signed-in shell, so they
// are measured beyond the entry only.
const SIGNED_OUT: Record<string, string> = {
  '/login': 'login',
  '/onboarding': 'onboarding',
  '/signed-in': 'signed-in',
}
const WATCHED = [
  'libphonenumber-js',
  'country-flag-icons',
  '@tanstack/form-core',
  'boneyard-js',
  'maplibre-gl',
  '@vis.gl/react-maplibre',
  'exifreader',
  '@vercel/blob',
  'jose',
]
```

Change `main()` so that the entry's closure is measured before the shell is added, and the per-page loop becomes a
function run twice:

```ts
  const entryOnly = new Set(base)
  // … existing shell merge into `base` …
  console.log(`entry: ${kb(entryOnly).toFixed(1)} KB gz`)
  console.log(`entry + shell: ${kb(base).toFixed(0)} KB gz\n`)

  const report = (pages: Record<string, string>, beyond: Set<string>) => {
    for (const [page, prefix] of Object.entries(pages)) {
      // body of today's loop, with `base` replaced by `beyond`
    }
  }
  report(PAGES, base)
  console.log('\nsigned-out (beyond the entry)')
  report(SIGNED_OUT, entryOnly)
```

Print the signed-out totals with one decimal (`kb(own).toFixed(1)`), as the baseline table does. Keep the
signed-in pages at `toFixed(0)` so their lines read as before.

- [ ] **Step 2: Run it on the unchanged app and compare with the baseline table**

Run: `bun run bundle:measure 2>&1 | sed -n '/^entry:/,$p'`
Expected: `entry: 176.4`, `entry + shell: 258`, the signed-in pages as in the baseline, then `/login +88.4`,
`/onboarding +150.0`, `/signed-in +34.0`. `/account/profile` and `/onboarding` list `exifreader, @vercel/blob, jose`.
If a prefix prints `ambiguous` or `no chunk`, fix the prefix (list `ls .output/public/assets | grep '^<prefix>-'`).

- [ ] **Step 3: Run the script's tests and lint**

Run: `bunx vitest run test/measureBundle.test.ts && bun run check:ci`
Expected: PASS, no Biome findings.

- [ ] **Step 4: Commit**

```bash
git add scripts/measureBundle.ts
git commit -m "chore(perf): measure signed-out pages and upload packages"
```

---

### Task 2: Load the avatar upload's heavy modules on pick

**Files:**
- Modify: `src/components/user/AvatarUpload.tsx`
- Test: `src/components/user/AvatarUpload.browser.test.tsx` (new)
- Test: `src/components/user/AvatarUpload.loadError.browser.test.tsx` (new; a separate file because `vi.mock`
  factories are per file and cached once loaded)

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Interfaces:**
- Consumes: `readImageMetaFromFile(file: File): Promise<{ gps; thumbnail: Blob | null }>` from `~/lib/files/exif`;
  `runUploadFlow(file, { access, contentType, mint, confirm, onProgress })` from
  `~/lib/effects/storage/clientUpload`. Both unchanged.
- Produces: nothing new for later tasks. `AvatarUpload`'s props and markup are unchanged.

- [ ] **Step 1: Write the failing pick test**

`src/components/user/AvatarUpload.browser.test.tsx`:

```tsx
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { RouterOutputs } from '~/lib/orpc/client'
import { orpc } from '~/lib/orpc/client'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { AvatarUpload } from './AvatarUpload'

// The heavy modules are mocked: the test pins that a pick still reads the file and
// runs the upload flow once they arrive through the component's dynamic import.
const mocks = vi.hoisted(() => ({
  readImageMetaFromFile: vi.fn(async () => ({ gps: null, thumbnail: null })),
  runUploadFlow: vi.fn(async () => {}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('~/lib/files/exif', () => ({ readImageMetaFromFile: mocks.readImageMetaFromFile }))
vi.mock('~/lib/effects/storage/clientUpload', () => ({ runUploadFlow: mocks.runUploadFlow }))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

type Me = RouterOutputs['user']['me']
const fakeMe: Me = {
  id: 'user-1',
  name: 'Alice Svensson',
  email: 'alice@example.se',
  emailVerified: true,
  image: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  phone: null,
  deletedAt: null,
  imageBlurhash: null,
  onboardedAt: new Date('2026-01-02T00:00:00Z'),
}

test('a picked image is read and uploaded through the lazily loaded modules', async () => {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.user.me.queryKey(), fakeMe)
  const { screen } = await renderWithProviders(<AvatarUpload />, { queryClient })

  // No button click first: a pick must work even if the warm-up never ran.
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' })
  await userEvent.upload(input, file)

  await expect.poll(() => mocks.runUploadFlow.mock.calls.length).toBe(1)
  expect(mocks.readImageMetaFromFile).toHaveBeenCalledWith(file)
  expect(mocks.runUploadFlow).toHaveBeenCalledWith(
    file,
    expect.objectContaining({ access: 'public', contentType: 'image/png' }),
  )
  await expect.poll(() => mocks.toastSuccess.mock.calls.length).toBe(1)
  expect(mocks.toastError).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it on today's code**

Run: `bunx vitest run --project browser src/components/user/AvatarUpload.browser.test.tsx`
Expected: PASS on today's static imports. This is a safety net: it pins the flow before the imports change (it must
stay green after Step 5).

- [ ] **Step 3: Write the failing load-error test**

`src/components/user/AvatarUpload.loadError.browser.test.tsx`: same `fakeMe`, render and pick as Step 1, but:

```tsx
const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
// The chunk can't be fetched (offline, or a deploy replaced its hash).
vi.mock('~/lib/effects/storage/clientUpload', () => {
  throw new Error('Failed to fetch dynamically imported module')
})
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

test('a module that fails to load shows the localized upload error', async () => {
  // … render with the seeded client, pick `me.png` as in the pick test …
  await expect.poll(() => mocks.toastError.mock.calls.length).toBe(1)
  expect(mocks.toastError).toHaveBeenCalledWith(m.avatar_upload_error())
  expect(mocks.toastSuccess).not.toHaveBeenCalled()
  await expect
    .element(screen.getByRole('button', { name: m.avatar_add_button() }))
    .toBeEnabled()
})
```

(import `m` from `~/paraglide/messages`; `fakeMe.image` is null, so the button is "add".)

Run: `bunx vitest run --project browser src/components/user/AvatarUpload.loadError.browser.test.tsx`
Expected: FAIL. Today the static import makes the whole test file fail to load, or the toast carries the raw
message. Note which one; either way it must pass after Step 5.

- [ ] **Step 4: Load the two modules on demand**

In `AvatarUpload.tsx`, replace the two value imports:

```tsx
import type { UploadProgress } from '~/lib/effects/storage/clientUpload'
```

and add, above the component:

```tsx
// exifreader (~344 KB raw) and @vercel/blob's client, whose @vercel/oidc browser
// entry is CommonJS and requires all of jose, are only needed once a file is
// picked. A click on the upload button starts the import, since the OS picker
// takes seconds, and the pick awaits the same (cached) promise.
const loadUploadModules = () =>
  Promise.all([import('~/lib/files/exif'), import('~/lib/effects/storage/clientUpload')])
```

In `handleFile`, after the content-type checks and before the thumbnail read:

```tsx
      let modules: Awaited<ReturnType<typeof loadUploadModules>>
      try {
        modules = await loadUploadModules()
      } catch {
        toast.error(m.avatar_upload_error())
        return
      }
      const [{ readImageMetaFromFile }, { runUploadFlow }] = modules
```

The early `return` sits inside the outer `try`, so `finally` still resets the input. Leave the rest of `handleFile`
as it is.

Warm the import on both buttons' clicks (the `row` variant's `<button>` and the default variant's `<Button>`):

```tsx
          onClick={() => {
            void loadUploadModules().catch(() => {})
            inputRef.current?.click()
          }}
```

The `.catch` keeps a failed warm-up from becoming an unhandled rejection. The pick retries the import and reports
the failure.

- [ ] **Step 5: Run both tests, the profile and onboarding tests, and typecheck**

Run: `bunx vitest run --project browser src/components/user src/components/onboarding && bun run typecheck`
Expected: all PASS, including the load-error test.

- [ ] **Step 6: Check the bundle**

Run: `bun run bundle:measure 2>&1 | grep -A2 -E '^/account/profile|^/onboarding'`
Expected: `/account/profile` and `/onboarding` no longer list `exifreader`, `@vercel/blob` or `jose`. The
`AvatarUpload` chunk is about 5 KB gz instead of 72 (bowser stays: it sets the input's `accept` on mount).
`/account/profile` is about 213 → 145, `/onboarding` about 150 → 82. Record the exact numbers for Task 5.

- [ ] **Step 7: Commit**

```bash
git add src/components/user/AvatarUpload.tsx src/components/user/AvatarUpload*.browser.test.tsx
git commit -m "perf(avatar): load exifreader and the blob client on pick"
```

---

### Task 3: Preload the body font

**Files:**
- Create: `src/lib/fonts.ts`
- Modify: `src/routes/__root.tsx:31-32` (the `links` array)
- Test: `test/fonts.test.ts` (new, node project)

**Reviewers:** `code-reviewer` + a reviewer loading `web-design-guidelines` + `vercel-react-best-practices`.

**Interfaces:**
- Produces: `export const BODY_FONT_URL = '/fonts/switzer/Switzer-Variable.woff2'` in `src/lib/fonts.ts`.

- [ ] **Step 1: Write the failing guard test**

`test/fonts.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BODY_FONT_URL } from '~/lib/fonts'

// The preload only helps if it names the exact URL the @font-face loads;
// otherwise the browser downloads the font twice.
describe('BODY_FONT_URL', () => {
  it("is the URL app.css's Switzer @font-face loads", () => {
    const css = readFileSync('src/styles/app.css', 'utf8')
    const face = /@font-face\s*{[^}]*font-family:\s*'Switzer'[^}]*}/.exec(css)?.[0]
    expect(face).toBeDefined()
    expect(face).toContain(`url('${BODY_FONT_URL}')`)
  })

  it('exists under public/', () => {
    expect(existsSync(`public${BODY_FONT_URL}`)).toBe(true)
  })
})
```

Run: `bunx vitest run test/fonts.test.ts`
Expected: FAIL, `~/lib/fonts` doesn't exist.

- [ ] **Step 2: Add the constant and the preload**

`src/lib/fonts.ts`:

```ts
// Client-safe. The body font (Switzer, ADR-0015), preloaded from the root head so
// it starts with the CSS instead of after it. Must match app.css's @font-face url
// (test/fonts.test.ts). Headings (Cabinet Grotesk) aren't preloaded: two 42 KB
// fonts would compete with the entry JS.
export const BODY_FONT_URL = '/fonts/switzer/Switzer-Variable.woff2'
```

In `src/routes/__root.tsx`, import it and add, right after the stylesheet link:

```tsx
      // crossOrigin is required for font preloads, even same-origin, or the
      // preloaded response isn't reused.
      { rel: 'preload', href: BODY_FONT_URL, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
```

- [ ] **Step 3: Run the test and check the SSR head**

Run: `bunx vitest run test/fonts.test.ts`
Expected: PASS.

Then start the dev server (`bun run dev`, needs `bun run dev:up`) and run:
`curl -s http://localhost:14600/login | grep -o '<link[^>]*preload[^>]*font[^>]*>'`
Expected: one `<link rel="preload" href="/fonts/switzer/Switzer-Variable.woff2" as="font" type="font/woff2" crossorigin="anonymous">`.
In Chrome DevTools' Network panel on `/login`, the font loads once, with "Initiator: (index)" (the preload), and
the console has no "preloaded but not used" warning.

- [ ] **Step 4: Commit**

```bash
git add src/lib/fonts.ts src/routes/__root.tsx test/fonts.test.ts
git commit -m "perf(fonts): preload the body font"
```

---

### Task 4: Merge the shell's chunks with rolldown chunk groups

**Files:**
- Create: `config/clientChunkGroups.ts`
- Modify: `vite.config.ts` (add `environments.client`, next to `optimizeDeps`)
- Test: `test/clientChunkGroups.test.ts` (new, node project)

**Reviewers:** `code-reviewer` + a general correctness reviewer who re-runs `bun run bundle:measure` and checks every
number against the baseline table (after the implementer's run, never at the same time: vitest/build runs collide).

**Interfaces:**
- Produces: `export const clientChunkGroups: ClientChunkGroup[]`, where
  `type ClientChunkGroup = { name: string; priority: number; includeDependenciesRecursively: false; test: (id: string) => boolean }`.
  rolldown isn't a direct dependency, so the type is local; it matches rolldown's `CodeSplittingGroup` structurally.

- [ ] **Step 1: Write the matcher test**

`test/clientChunkGroups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clientChunkGroups } from '../config/clientChunkGroups'

const groupOf = (id: string) =>
  [...clientChunkGroups].sort((a, b) => b.priority - a.priority).find((g) => g.test(id))?.name
const nm = (p: string) => `/repo/node_modules/${p}`
const src = (p: string) => `/repo/src/${p}`

describe('clientChunkGroups', () => {
  it('puts the shell-only modules in "shell"', () => {
    expect(groupOf(src('components/ui/sidebar.tsx'))).toBe('shell')
    expect(groupOf(nm('cmdk/dist/index.mjs'))).toBe('shell')
    expect(groupOf(nm('@radix-ui/react-dialog/dist/index.mjs'))).toBe('shell')
  })

  it('puts the modules the shell shares with the signed-out pages in "ui"', () => {
    expect(groupOf(nm('@radix-ui/react-popper/dist/index.mjs'))).toBe('ui')
    expect(groupOf(src('components/ui/dropdown-menu.tsx'))).toBe('ui')
  })

  // The entry imports these. A grouped module the entry reaches makes the entry
  // import the whole group, so every page, /login too, would load it.
  it.each([
    nm('@tanstack/react-router/node_modules/@tanstack/react-store/node_modules/@tanstack/store/dist/atom.js'),
    nm('@tanstack/store/dist/atom.js'),
    nm('react-dom/cjs/react-dom.production.js'),
    nm('lucide-react/dist/esm/shared/src/utils/mergeClasses.mjs'),
    src('lib/utils.ts'),
    src('lib/orpc/client.ts'),
  ])('leaves %s ungrouped', (id) => {
    expect(groupOf(id)).toBeUndefined()
  })
})
```

Run: `bunx vitest run test/clientChunkGroups.test.ts`
Expected: FAIL, the module doesn't exist.

- [ ] **Step 2: Add the groups (the prototype) and wire them**

`config/clientChunkGroups.ts`:

```ts
// Client-build chunk groups (ADR-0025 §6, roadmap step 6). Step 4's lazy dialogs
// added dynamic entries, and rolldown splits modules by the set of entries that
// reach them, so the signed-in shell came out as 28 small chunks. These groups
// merge them back.
//
// Rule: never group a module the entry reaches (the router, react-dom, lib/utils,
// lib/orpc/client, the router's nested @tanstack/store …). The entry would then
// import the whole group, and every page, /login included, would load it. Check
// `bun run bundle:measure`'s `entry:` line after any change here.
//
// includeDependenciesRecursively is false so a grouped module's dependencies stay
// where rolldown put them (several are entry modules).
export type ClientChunkGroup = {
  name: string
  priority: number
  includeDependenciesRecursively: false
  test: (id: string) => boolean
}

const SHELL_UI = /[\\/]src[\\/]components[\\/]ui[\\/](sidebar|button-group|command|dialog|sheet|tooltip)\.tsx$/
const SHELL_PACKAGES = /[\\/]node_modules[\\/](@radix-ui[\\/]react-(dialog|tooltip)|cmdk)[\\/]/
const SHELL_ICONS =
  /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](house|piggy-bank|search|thermometer|user|zap)\.mjs$/

const SHARED_UI = /[\\/]src[\\/]components[\\/]ui[\\/](dropdown-menu|input|input-group|avatar|spinner)\.tsx$/
const SHARED_SRC = /[\\/]src[\\/](components[\\/](Logo|flags)\.tsx|lib[\\/]authClient\.ts|lib[\\/]image[\\/]sizes\.ts)$/
const SHARED_PACKAGES = new RegExp(
  String.raw`[\\/]node_modules[\\/](` +
    [
      String.raw`@radix-ui[\\/]react-(avatar|collection|direction|use-is-hydrated|roving-focus|visually-hidden|use-size|arrow|popper|menu|dropdown-menu|presence|dismissable-layer|focus-scope|portal|focus-guards)`,
      '@floating-ui',
      'class-variance-authority',
      'tslib',
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'use-callback-ref',
      'use-sidecar',
      'aria-hidden',
      'react-style-singleton',
      'get-nonce',
      'detect-node-es',
      'better-auth',
      '@better-auth',
      'better-call',
      'nanostores',
      'defu',
      '@better-fetch',
      'blurhash',
      '@unpic',
      'unpic',
    ].join('|') +
    String.raw`)[\\/]`,
)
const SHARED_ICONS = /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](check|sun)\.mjs$/

export const clientChunkGroups: ClientChunkGroup[] = [
  {
    name: 'shell',
    priority: 2,
    includeDependenciesRecursively: false,
    test: (id) => SHELL_UI.test(id) || SHELL_PACKAGES.test(id) || SHELL_ICONS.test(id),
  },
  {
    name: 'ui',
    priority: 1,
    includeDependenciesRecursively: false,
    test: (id) =>
      SHARED_UI.test(id) || SHARED_SRC.test(id) || SHARED_PACKAGES.test(id) || SHARED_ICONS.test(id),
  },
]
```

In `vite.config.ts`, import it and add, right after `optimizeDeps`:

```ts
  // Client only: the Nitro/SSR build keeps rolldown's default chunking.
  environments: {
    client: {
      build: { rolldownOptions: { output: { codeSplitting: { groups: clientChunkGroups } } } },
    },
  },
```

Run: `bunx vitest run test/clientChunkGroups.test.ts && bun run typecheck`
Expected: PASS. If `typecheck` rejects the groups' type, read the type at
`node_modules/rolldown/dist/shared/define-config-*.d.mts` (`CodeSplittingGroup`) and adjust the local type, not
the config.

- [ ] **Step 3: Measure the prototype**

Run: `bun run bundle:measure 2>&1 | sed -n '/^entry:/,$p'`
Expected, about: `entry: 176.1`, `entry + shell: 251`, signed-in pages at or below the baseline, `/login` ≈ 84.6,
but `/onboarding` ≈ 158 and `/signed-in` ≈ 49, both over the baseline. (After Task 2, `/onboarding`'s figure is
lower overall. Compare it with Task 2's measured `/onboarding`, not with 150.0.)

- [ ] **Step 4: Tune until no page grows**

The signed-out pages grow because they now load the whole `ui` chunk, including modules they never used. To find
those modules, list each page's chunks before and after. The plan's prototype measured this with a scratch script
that prints each chunk in a page's static closure beyond the entry, with its source-map packages. Write the same
in the scratchpad, reusing `staticClosure` from `scripts/measureBundle.ts`. Then try, in order, re-measuring after
each:
1. Take `authClient` and the better-auth chain (`better-auth`, `@better-auth`, `better-call`, `nanostores`, `defu`,
   `@better-fetch`, `lib/authClient.ts`) out of `ui`. `/onboarding` didn't load them on `main`.
2. Take whatever `/signed-in` didn't load on `main` out of `ui` (compare its chunk list on `main` and now).
3. If a page still grows: split `ui` into two groups by which signed-out pages use the modules.

Stop at the first configuration where **every** number is at or below the baseline (entry alone, entry + shell,
every signed-in page, `/login`, `/onboarding` after Task 2, `/signed-in`). Update the test's "ui" cases if a
module moved. If none gets there, delete the `ui` group and keep `shell`. If `shell` alone still grows a page,
remove the groups and `config/`, and Task 5 records the measurements instead.

- [ ] **Step 5: Check the build output is sane**

Run: `ls .output/public/assets | grep -E '^(shell|ui)-'` and the entry check:
`grep -l hydrateRoot .output/public/assets/*.js | xargs grep -c '"./\(shell\|ui\)-'`
Expected: one `shell-*.js` (and `ui-*.js` if kept). The entry chunk imports neither (count 0).

- [ ] **Step 6: Run the whole test suite**

Run: `bun run test` (after `bun run db:up && bun run db:migrate`; make sure no other vitest runs: `pgrep -fl vitest`)
Expected: PASS. Chunking doesn't touch tests' module graph, but the config file is shared with Vitest.

- [ ] **Step 7: Live check the prod build**

Run: `bun run build && bunx vite preview` (or `node .output/server/index.mjs`, per the Nitro output's hint), signed
in as the local admin. Check:
- `/charging` loads, the sidebar opens and closes on a phone width, Cmd+K opens the palette, and a tooltip shows.
- `/users`: the invite dialog opens on first click (a lazy dialog importing from `shell`/`ui`).
- `/login` and `/onboarding` render with no console errors (`Failed to fetch`, `is not a function` = a chunk-order
  bug).
- The Network panel on a signed-in page shows fewer `modulepreload`s than `main` (count both).

- [ ] **Step 8: Commit**

```bash
git add config/clientChunkGroups.ts vite.config.ts test/clientChunkGroups.test.ts
git commit -m "perf(bundle): merge the shell's chunks with rolldown groups"
```

---

### Task 5: Record the step

**Files:**
- Modify: `docs/superpowers/roadmaps/2026-10-05-client-performance.md` (row 6, checkpoint 6, a new "Step 6 notes")
- Modify: `docs/adr/0025-deferred-route-loading.md` (§6 amendment)
- Modify: `CLAUDE.md` (Gotchas: one line on chunk groups)

**Reviewers:** `code-reviewer` (the numbers match the commits' measurements) + a general reviewer reading the
docs for claims the measurements don't back.

- [ ] **Step 1: Final measurement**

Run: `bun run bundle:measure 2>&1 | sed -n '/^entry:/,$p'` on the branch head and keep the output.

- [ ] **Step 2: Roadmap**

- Row 6: plan link `../plans/2026-10-06-client-perf-6-small-items.md`, PR link, status `PR open`.
- Checkpoint 6: make it checkable. "Run `bun run bundle:measure` on `main` after the merge: `/account/profile` and
  `/onboarding` list none of exifreader, @vercel/blob, jose; no page above step 6's final measurement; the SSR
  `<head>` of `/login` carries the Switzer preload."
- New `## Step 6 notes` before `## Step 7 notes`: the baseline table (from this plan), the final table, where `jose`
  came from (`@vercel/oidc`'s CommonJS browser entry, unfixed upstream as of 4.0.0), item 5's decision with both
  prototype numbers (record and drop, owner 2026-10-06), the chunk-group configuration kept and the tuning that got
  there (or why the item was dropped), and `modulepreload` counts before and after.

- [ ] **Step 3: ADR-0025 §6**

Add an amendment paragraph dated 2026-10-06 (roadmap step 6) to §6, after "The shell grew 5 KB gz without gaining
code": the upload's heavy modules load on pick, and the chunk groups are client-only with their rule (no module the
entry reaches). Give the final numbers. Say that loaders stay in the route tree, so their imports ship in the entry,
and why that wasn't changed (the prototype numbers, ADR-0025 §1).

- [ ] **Step 4: CLAUDE.md gotcha**

Under Gotchas, add:

```markdown
- **Client chunk groups (`config/clientChunkGroups.ts`) must not capture a module the entry reaches.** The entry then imports the whole group and every page, `/login` included, loads it. After changing a group, check `bun run bundle:measure`'s `entry:` line against the roadmap's step 6 numbers.
```

Add `config/` to the code map's last line (`drizzle/, compose.yaml, vite.config.ts …`): `config/ (client chunk groups; `/build/` is gitignored)`.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(perf): record client-performance step 6"
```

---

## After the tasks

- Branch review (feature-workflow Phase 5): `code-reviewer` over the whole diff plus a general correctness pass. No
  schema, service or auth change, so no migration, test-completeness or security gate.
- Pre-PR gate (`docs/feature-workflow.md#pre-pr-gate`), including the sv/en key check (no new keys expected).
- PR: `perf(bundle): load upload code on pick, preload font, merge shell chunks`, with the template. Verification:
  the before/after table, the curl of the preload, the live checks from Task 4, Step 7. Note that a Vercel Blob
  upload (the prod transport) is only exercised on the preview deployment. Ask the owner to change their avatar
  once on the preview before merge.
