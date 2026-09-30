import type * as React from 'react'
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ChargingTabs } from './ChargingTabs'

// Component tests are router-free in this project (see test/browser/render.tsx),
// so `Link` becomes a plain anchor; router-only props are dropped.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({
      to,
      children,
      search: _search,
      ...rest
    }: {
      to: string
      children: React.ReactNode
      search?: unknown
    }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
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
