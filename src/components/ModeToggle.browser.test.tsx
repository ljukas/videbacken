import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ModeToggle } from '~/components/ModeToggle'

// ModeToggle's unit is the Radix dropdown UI, not theme persistence. The real
// ThemeProvider calls `useRouter()` (router.invalidate after the server fn),
// which would need a RouterProvider — route-level plumbing is out of scope for
// v1. So we mock ModeToggle's only dependency — `useTheme` — and render the
// real component. theme='light' makes 'Ljust' the checked option.
vi.mock('~/components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: () => {} }),
}))

test('ModeToggle shows the trigger with an accessible label', async () => {
  const screen = await render(<ModeToggle />)
  await expect.element(screen.getByRole('button', { name: 'Byt tema' })).toBeVisible()
})

test('opening the menu reveals the three localized theme options', async () => {
  const screen = await render(<ModeToggle />)
  await screen.getByRole('button', { name: 'Byt tema' }).click()
  await expect.element(screen.getByText('System')).toBeVisible()
  await expect.element(screen.getByText('Ljust')).toBeVisible()
  await expect.element(screen.getByText('Mörkt')).toBeVisible()
})

test('the active theme is marked as checked in the menu', async () => {
  const screen = await render(<ModeToggle />)
  await screen.getByRole('button', { name: 'Byt tema' }).click()
  await expect
    .element(screen.getByRole('menuitemradio', { name: 'Ljust', checked: true }))
    .toBeVisible()
})
