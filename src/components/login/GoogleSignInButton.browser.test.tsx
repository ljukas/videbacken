import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { GoogleSignInButton } from './GoogleSignInButton'

// The component imports authClient at module load; mock it so construction is
// inert (we don't click in these tests).
vi.mock('~/lib/authClient', () => ({
  authClient: { signIn: { social: vi.fn() } },
}))

test('defaults to the outline (secondary) variant', async () => {
  const { screen } = await renderWithProviders(<GoogleSignInButton callbackURL="/" />)
  const button = screen.container.querySelector('button')
  expect(button?.getAttribute('data-variant')).toBe('outline')
})

test('renders the requested variant and forwards aria-describedby', async () => {
  const { screen } = await renderWithProviders(
    <GoogleSignInButton callbackURL="/" variant="default" aria-describedby="hint-1" />,
  )
  const button = screen.container.querySelector('button')
  expect(button?.getAttribute('data-variant')).toBe('default')
  expect(button?.getAttribute('aria-describedby')).toBe('hint-1')
})
