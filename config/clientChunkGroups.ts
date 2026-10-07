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
// `ui` holds only what the shell shares with /signed-in, the smallest signed-out
// page. A page that loads one module of a group loads all of it, so adding a module
// /signed-in doesn't use (the avatar, the inputs, authClient and better-auth) grows
// /signed-in, and /onboarding with it. Check the signed-out lines after a change.
//
// includeDependenciesRecursively is false so a grouped module's dependencies stay
// where rolldown put them (several are entry modules). The cost: rolldown no longer
// keeps the chunk graph acyclic. If an ungrouped module imports a grouped one while
// the group imports that module's chunk, the two chunks import each other, and one
// runs before the other's exports exist. class-variance-authority in `ui` did that:
// button.tsx imports it, `ui` imports button's Radix primitives, and /login crashed
// (`i is not a function`). So button.tsx's dependencies stay ungrouped, and
// sidebar.tsx's `menu` icon sits in `shell`, not in the layout's chunk. After a
// change, load /login on a prod build and check no chunk imports itself in a loop.
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
      'tslib',
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'use-callback-ref',
      'use-sidecar',
      'aria-hidden',
      'react-style-singleton',
      'get-nonce',
      'detect-node-es',
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
