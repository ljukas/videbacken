import type * as React from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { CommandPaletteProvider } from '~/components/command/useCommandPalette'
import { SidebarProvider } from '~/components/ui/sidebar'
import { TooltipProvider } from '~/components/ui/tooltip'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { AppSidebar } from './AppSidebar'

// Component tests are router-free (test/browser/render.tsx): `Link` becomes a
// plain anchor and `useMatchRoute` matches against a scripted current path,
// exactly unless `fuzzy` (the router's own semantics).
const { current } = vi.hoisted(() => ({ current: { path: '/' } }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      to,
      children,
      search: _search,
      activeOptions: _activeOptions,
      ...rest
    }: {
      to: string
      children: React.ReactNode
      search?: unknown
      activeOptions?: unknown
    }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
    useMatchRoute:
      () =>
      ({ to, fuzzy }: { to: string; fuzzy?: boolean }) =>
        fuzzy
          ? current.path === to || current.path.startsWith(to === '/' ? '/' : `${to}/`)
          : current.path === to,
  }
})

// The user menu reads the signed-in user; it isn't under test here.
vi.mock('~/components/user/UserMenu', () => ({ SidebarUserMenu: () => null }))

beforeEach(async () => {
  current.path = '/'
  // Desktop: below md the sidebar is a closed drawer (Sheet).
  await page.viewport(1280, 800)
})

const renderSidebar = () =>
  renderWithProviders(
    <CommandPaletteProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </TooltipProvider>
    </CommandPaletteProvider>,
  )

const active = (el: Element) => el.getAttribute('data-active') === 'true'

test('lists the charging views as sub-items under Laddning', async () => {
  const { screen } = await renderSidebar()
  const overview = screen.getByRole('link', { name: m.nav_charging_overview(), exact: true })
  const patterns = screen.getByRole('link', { name: m.nav_charging_patterns_short(), exact: true })
  await expect.element(overview).toHaveAttribute('href', '/charging')
  await expect.element(patterns).toHaveAttribute('href', '/charging/patterns')
})

test.each([
  ['/charging', true, false],
  ['/charging/patterns', false, true],
] as const)('on %s marks only that view active, and Laddning', async (path, overviewOn, patternsOn) => {
  current.path = path
  const { screen } = await renderSidebar()
  const link = (name: string) => screen.getByRole('link', { name, exact: true }).element()
  expect(active(link(m.nav_charging_overview()))).toBe(overviewOn)
  expect(active(link(m.nav_charging_patterns_short()))).toBe(patternsOn)
  expect(active(link(m.nav_charging()))).toBe(true)
})

test('elsewhere no charging item is active', async () => {
  current.path = '/sensors'
  const { screen } = await renderSidebar()
  const link = (name: string) => screen.getByRole('link', { name, exact: true }).element()
  expect(active(link(m.nav_charging()))).toBe(false)
  expect(active(link(m.nav_charging_overview()))).toBe(false)
  expect(active(link(m.nav_charging_patterns_short()))).toBe(false)
})
