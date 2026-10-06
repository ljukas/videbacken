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
const { current, linkProps, textOf } = vi.hoisted(() => ({
  textOf: (node: unknown): string =>
    Array.isArray(node)
      ? node.map(textOf).join('')
      : typeof node === 'string'
        ? node
        : typeof node === 'object' && node && 'props' in node
          ? textOf((node as { props: { children?: unknown } }).props.children)
          : '',
  current: { path: '/' },
  // What each Link was given, by `to|text`: the router derives aria-current and the
  // next URL's search from these, and they can't be exercised router-free.
  linkProps: new Map<string, { search?: unknown; activeOptions?: unknown }>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      to,
      children,
      search,
      activeOptions,
      ...rest
    }: {
      to: string
      children: React.ReactNode
      search?: unknown
      activeOptions?: unknown
    }) => {
      linkProps.set(`${to}|${textOf(children)}`, { search, activeOptions })
      return (
        <a href={to} {...rest}>
          {children}
        </a>
      )
    },
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
  linkProps.clear()
  // Desktop: below md the sidebar is a closed drawer (Sheet).
  await page.viewport(1280, 800)
})

const renderSidebar = (role: string | null = 'user') =>
  renderWithProviders(
    <CommandPaletteProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar role={role} />
        </SidebarProvider>
      </TooltipProvider>
    </CommandPaletteProvider>,
  )

const subLink = (
  screen: Awaited<ReturnType<typeof renderSidebar>>['screen'],
  name: string,
  href: string,
) => {
  const el = [...screen.container.querySelectorAll('a')].find(
    (a) => a.textContent === name && a.getAttribute('href') === href,
  )
  if (!el) throw new Error(`no link ${name} → ${href}`)
  return el
}

const active = (el: Element) => el.getAttribute('data-active') === 'true'

test('lists the charging views as sub-items under Laddning', async () => {
  const { screen } = await renderSidebar()
  expect(subLink(screen, m.nav_charging_overview(), '/charging')).toHaveAttribute(
    'href',
    '/charging',
  )
  expect(subLink(screen, m.nav_charging_patterns_short(), '/charging/patterns')).toHaveAttribute(
    'href',
    '/charging/patterns',
  )
})

test.each([
  ['/charging', true, false],
  ['/charging/patterns', false, true],
] as const)('on %s marks only that view active, and Laddning', async (path, overviewOn, patternsOn) => {
  current.path = path
  const { screen } = await renderSidebar()
  expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(overviewOn)
  expect(active(subLink(screen, m.nav_charging_patterns_short(), '/charging/patterns'))).toBe(
    patternsOn,
  )
  expect(active(screen.getByRole('link', { name: m.nav_charging(), exact: true }).element())).toBe(
    true,
  )
})

test('elsewhere no charging item is active', async () => {
  current.path = '/sensors'
  const { screen } = await renderSidebar()
  expect(active(screen.getByRole('link', { name: m.nav_charging(), exact: true }).element())).toBe(
    false,
  )
  expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(false)
  expect(active(subLink(screen, m.nav_charging_patterns_short(), '/charging/patterns'))).toBe(false)
})

test("charging links match exactly, ignoring the views' own params, and keep the year and vehicle scope", async () => {
  current.path = '/charging/patterns'
  await renderSidebar()
  // The section link (Laddning) and its Översikt share /charging, and so the same props.
  for (const key of [
    `/charging|${m.nav_charging()}`,
    `/charging|${m.nav_charging_overview()}`,
    `/charging/patterns|${m.nav_charging_patterns_short()}`,
  ]) {
    const props = linkProps.get(key)
    expect(props, key).toBeDefined()
    expect(props?.activeOptions, key).toEqual({ exact: true, includeSearch: false })
    const search = props?.search as (prev: object) => object
    expect(search({ year: 2025, month: 3, metric: 'plugged' })).toEqual({ year: 2025 })
    expect(search({ year: 2025, vehicle: 'other', month: 3 })).toEqual({
      year: 2025,
      vehicle: 'other',
    })
    // From a page without the params (a session page, another section): a clean URL.
    expect(Object.entries(search({})).filter(([, v]) => v !== undefined)).toEqual([])
    expect(search({ range: '7d' })).toEqual({ year: undefined })
  }
  // Other sections keep the router's default matching.
  expect(linkProps.get(`/sensors|${m.nav_sensors()}`)?.activeOptions).toBeUndefined()
})

test('admins get Inställningar under Laddning', async () => {
  const { screen } = await renderSidebar('admin')
  await expect
    .element(screen.getByRole('link', { name: m.nav_charging_settings_short(), exact: true }))
    .toHaveAttribute('href', '/charging/settings')
})

test('members do not see Inställningar', async () => {
  const { screen } = await renderSidebar('user')
  expect(subLink(screen, m.nav_charging_overview(), '/charging')).toBeTruthy()
  expect(
    screen.getByRole('link', { name: m.nav_charging_settings_short(), exact: true }).elements(),
  ).toHaveLength(0)
})

test('the settings link is exact and carries no page filter', async () => {
  current.path = '/charging'
  await renderSidebar('admin')
  const props = linkProps.get(`/charging/settings|${m.nav_charging_settings_short()}`)
  expect(props?.activeOptions).toEqual({ exact: true, includeSearch: false })
  // A clean URL: the year and vehicle scope belong to the views, not to settings.
  const search = props?.search as (prev: object) => object
  expect(search({ year: 2025, vehicle: 'other' })).toEqual({})
})

test('on /charging/settings only Inställningar (and Laddning) is active', async () => {
  current.path = '/charging/settings'
  const { screen } = await renderSidebar('admin')
  const link = (name: string) => screen.getByRole('link', { name, exact: true }).element()
  expect(active(link(m.nav_charging_settings_short()))).toBe(true)
  expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(false)
  expect(active(link(m.nav_charging()))).toBe(true)
})

test('lists the energy views as sub-items under Energi', async () => {
  const { screen } = await renderSidebar()
  expect(subLink(screen, m.nav_energy_overview(), '/energy')).toBeTruthy()
  expect(subLink(screen, m.nav_energy_battery(), '/energy/battery')).toBeTruthy()
})

test.each([
  ['/energy', true, false],
  ['/energy/battery', false, true],
] as const)('on %s marks only that energy view active, and Energi', async (path, overviewOn, batteryOn) => {
  current.path = path
  const { screen } = await renderSidebar()
  expect(active(subLink(screen, m.nav_energy_overview(), '/energy'))).toBe(overviewOn)
  expect(active(subLink(screen, m.nav_energy_battery(), '/energy/battery'))).toBe(batteryOn)
  expect(active(screen.getByRole('link', { name: m.nav_energy(), exact: true }).element())).toBe(
    true,
  )
  expect(active(subLink(screen, m.nav_charging_overview(), '/charging'))).toBe(false)
})

test('energy links match exactly and carry the period, never the charging year or vehicle', async () => {
  current.path = '/energy/battery'
  await renderSidebar()
  for (const key of [
    `/energy|${m.nav_energy()}`,
    `/energy|${m.nav_energy_overview()}`,
    `/energy/battery|${m.nav_energy_battery()}`,
  ]) {
    const props = linkProps.get(key)
    expect(props, key).toBeDefined()
    expect(props?.activeOptions, key).toEqual({ exact: true, includeSearch: false })
    const search = props?.search as (prev: object) => object
    expect(search({ period: '2026-08', year: 2025, vehicle: 'other' })).toEqual({
      period: '2026-08',
    })
    expect(search({ period: 2026 })).toEqual({ period: 2026 })
    expect(Object.entries(search({})).filter(([, v]) => v !== undefined)).toEqual([])
  }
})

test('lists Energi after Laddning, linking to /energy, active on /energy', async () => {
  current.path = '/energy'
  const { screen } = await renderSidebar()
  const energy = screen.getByRole('link', { name: m.nav_energy(), exact: true })
  await expect.element(energy).toHaveAttribute('href', '/energy')
  expect(active(energy.element())).toBe(true)
  const hrefs = [...screen.container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(hrefs.indexOf('/energy')).toBeGreaterThan(hrefs.lastIndexOf('/charging/economy'))
  expect(hrefs.indexOf('/energy')).toBeLessThan(hrefs.indexOf('/users'))
})
