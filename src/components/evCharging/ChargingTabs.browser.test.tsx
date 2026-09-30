import type * as React from 'react'
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ChargingTabs } from './ChargingTabs'

// Component tests are router-free in this project (see test/browser/render.tsx),
// so `Link` becomes a plain anchor. It records the props it received, because the
// real Link's prefix-match `isActive` (which would also mark /charging active on
// /charging/patterns) can't be exercised without a router.
const { linkProps } = vi.hoisted(() => ({
  linkProps: [] as Array<{ to: string; activeOptions?: { exact?: boolean } }>,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      to,
      children,
      search: _search,
      activeOptions,
      ...rest
    }: {
      to: string
      children: React.ReactNode
      search?: unknown
      activeOptions?: { exact?: boolean }
    }) => {
      linkProps.push({ to, activeOptions })
      return (
        <a href={to} {...rest}>
          {children}
        </a>
      )
    },
  }
})

test('marks the current view with aria-current and links both pages', async () => {
  const { screen } = await renderWithProviders(<ChargingTabs current="patterns" />)
  const patterns = screen.getByRole('link', { name: 'Mönster' })
  await expect.element(patterns).toHaveAttribute('aria-current', 'page')
  await expect
    .element(screen.getByRole('link', { name: 'Översikt' }))
    .not.toHaveAttribute('aria-current')
  await expect
    .element(screen.getByRole('link', { name: 'Översikt' }))
    .toHaveAttribute('href', '/charging')
})

test('matches tabs exactly so /charging is not active on /charging/patterns', async () => {
  linkProps.length = 0
  await renderWithProviders(<ChargingTabs current="patterns" />)
  const overview = linkProps.find((p) => p.to === '/charging')
  expect(overview?.activeOptions?.exact).toBe(true)
  expect(linkProps.every((p) => p.activeOptions?.exact === true)).toBe(true)
})
