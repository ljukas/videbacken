// Client-build chunk groups (ADR-0025 §6, roadmap step 6). Step 4's lazy dialogs
// added dynamic entries, and rolldown splits modules by the set of entries that
// reach them, so the signed-in shell came out as 28 small chunks. These groups
// merge them back.
//
// Rule: never group a module the entry reaches (the router, react-dom, lib/utils,
// lib/orpc/client, the router's nested @tanstack/store …). The entry would then
// import the whole group, and every page, /login included, would load it. The build
// fails on it; `bun run bundle:measure`'s `entry:` line shows the size.
//
// `ui` holds only what the shell shares with /signed-in, the smallest signed-out
// page. A page that loads one module of a group loads all of it, so adding a module
// /signed-in doesn't use (the avatar, the inputs, authClient and better-auth) grows
// /signed-in, and /onboarding with it. Check the signed-out lines after a change.
//
// includeDependenciesRecursively is false so a grouped module's dependencies stay
// where rolldown put them (several are entry modules). The cost: rolldown no longer
// keeps the chunk graph acyclic, and chunks that import each other crash at module
// init (one runs before the other has defined its exports). The rule that avoids it:
// a module that a group member imports, and that isn't in the group itself, must not
// import any group member, nor share a chunk with a module that does. So a new import
// used only by `shell` members belongs in `shell`. Two breaches so far: class-variance-authority in `ui` (button.tsx imports
// it, `ui` imports button's Radix primitives) crashed /login with
// `i is not a function`, so button.tsx's dependencies stay ungrouped; and
// sidebar.tsx's `menu` icon, left in the layout's chunk, looped `_authenticated` and
// `shell` (a cycle of that kind only crashes signed-in pages), so it's in `shell`.
// `bun run build` and `vercel-build` fail on any cycle and on the entry reaching a
// group (scripts/checkChunkCycles.ts); `bun run bundle:measure` prints the cycles
// under its `entry:` line.
export type ClientChunkGroup = {
  name: string
  priority: number
  includeDependenciesRecursively: false
  test: (id: string) => boolean
}

const SHELL_UI =
  /[\\/]src[\\/]components[\\/]ui[\\/](sidebar|button-group|command|dialog|sheet|tooltip)\.tsx$/
const SHELL_PACKAGES = /[\\/]node_modules[\\/](@radix-ui[\\/]react-(dialog|tooltip)|cmdk)[\\/]/
const SHELL_ICONS =
  /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](house|menu|piggy-bank|search|thermometer|user|zap)\.mjs$/

const SHARED_SRC = /[\\/]src[\\/]components[\\/](ui[\\/]dropdown-menu|Logo|flags)\.tsx$/
const SHARED_PACKAGES = new RegExp(
  String.raw`[\\/]node_modules[\\/](` +
    [
      String.raw`@radix-ui[\\/]react-(collection|direction|use-is-hydrated|roving-focus|use-size|arrow|popper|menu|dropdown-menu|presence|dismissable-layer|focus-scope|portal|focus-guards)`,
      '@floating-ui',
      // If an entry-path package ever imports tslib, the entry imports `ui` (the `entry:` line shows it).
      'tslib',
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'use-callback-ref',
      'use-sidecar',
      'aria-hidden',
      'react-style-singleton',
      'get-nonce',
    ].join('|') +
    String.raw`)[\\/]`,
)
const SHARED_ICONS =
  /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](check|sun)\.mjs$/

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
    test: (id) => SHARED_SRC.test(id) || SHARED_PACKAGES.test(id) || SHARED_ICONS.test(id),
  },
]
