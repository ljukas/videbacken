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

  // sidebar.tsx's trigger icon. Left out, it stayed in the layout's chunk, which
  // imports "shell", so the two chunks imported each other.
  it('puts the sidebar trigger icon in "shell"', () => {
    expect(groupOf(nm('lucide-react/dist/esm/icons/menu.mjs'))).toBe('shell')
  })

  it('puts the modules the shell shares with the signed-out pages in "ui"', () => {
    expect(groupOf(nm('@radix-ui/react-popper/dist/index.mjs'))).toBe('ui')
    expect(groupOf(src('components/ui/dropdown-menu.tsx'))).toBe('ui')
  })

  // /signed-in never loaded these. In "ui" they'd make it load them (and grow
  // /onboarding): every page that loads a group loads all of it.
  it.each([
    src('components/ui/avatar.tsx'),
    src('components/ui/input-group.tsx'),
    src('lib/authClient.ts'),
    nm('better-auth/dist/client/index.mjs'),
    nm('@radix-ui/react-avatar/dist/index.mjs'),
    nm('blurhash/dist/esm/index.js'),
  ])('keeps %s out of "ui"', (id) => {
    expect(groupOf(id)).toBeUndefined()
  })

  // button.tsx and its dependencies. "ui" imports button's Radix primitives, so a
  // group holding one of these makes the button chunk and the group import each
  // other: button ran before cva existed and /login crashed (`i is not a function`).
  it.each([
    src('components/ui/button.tsx'),
    nm('class-variance-authority/dist/index.mjs'),
    nm('@radix-ui/react-slot/dist/index.mjs'),
    nm('@radix-ui/react-primitive/dist/index.mjs'),
  ])('leaves %s ungrouped', (id) => {
    expect(groupOf(id)).toBeUndefined()
  })

  // The entry imports these. A grouped module the entry reaches makes the entry
  // import the whole group, so every page, /login too, would load it.
  it.each([
    nm(
      '@tanstack/react-router/node_modules/@tanstack/react-store/node_modules/@tanstack/store/dist/atom.js',
    ),
    nm('@tanstack/store/dist/atom.js'),
    nm('react-dom/cjs/react-dom.production.js'),
    nm('lucide-react/dist/esm/shared/src/utils/mergeClasses.mjs'),
    src('lib/utils.ts'),
    src('lib/orpc/client.ts'),
  ])('leaves %s ungrouped', (id) => {
    expect(groupOf(id)).toBeUndefined()
  })
})
