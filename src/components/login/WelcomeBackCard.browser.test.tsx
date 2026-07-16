import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { WelcomeBackCard } from './WelcomeBackCard'

// `vi.mock` factories are hoisted above the file, so the mocks they reference
// must live in `vi.hoisted` (also hoisted) rather than ordinary top-level
// consts — codebase idiom, see heicTranscode.test.ts.
const { signInSocial, signInMagicLink } = vi.hoisted(() => ({
  signInSocial: vi.fn(),
  signInMagicLink: vi.fn(),
}))

vi.mock('~/lib/authClient', () => ({
  authClient: {
    signIn: {
      social: signInSocial,
      magicLink: signInMagicLink,
    },
  },
}))

const CALLBACK_URL = '/signed-in?redirect=%2F'

function renderCard() {
  return renderWithProviders(
    <WelcomeBackCard
      email="alice@example.se"
      name="Alice Svensson"
      image={null}
      imageBlurhash={null}
      callbackURL={CALLBACK_URL}
      onSent={() => {}}
      onSwitchUser={() => {}}
    />,
  )
}

test('offers the Google button as a secondary option alongside the one-click magic-link resend (no passkey)', async () => {
  const { screen } = await renderCard()

  await expect.element(screen.getByRole('button', { name: m.login_submit() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_google_button() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_switch_user() })).toBeVisible()

  expect(screen.container.textContent?.toLowerCase()).not.toContain('passkey')
})

test('clicking the Google button calls signIn.social with the provider and callbackURL', async () => {
  signInSocial.mockResolvedValue({ error: null })
  const { screen } = await renderCard()

  await screen.getByRole('button', { name: m.login_google_button() }).click()

  expect(signInSocial).toHaveBeenCalledWith({ provider: 'google', callbackURL: CALLBACK_URL })
})

test('clicking the primary button still resends a magic link to the saved email', async () => {
  signInMagicLink.mockResolvedValue({ error: null })
  const onSent = vi.fn()
  const { screen } = await renderWithProviders(
    <WelcomeBackCard
      email="alice@example.se"
      name="Alice Svensson"
      image={null}
      imageBlurhash={null}
      callbackURL={CALLBACK_URL}
      onSent={onSent}
      onSwitchUser={() => {}}
    />,
  )

  await screen.getByRole('button', { name: m.login_submit() }).click()

  await vi.waitFor(() => {
    expect(signInMagicLink).toHaveBeenCalledWith({
      email: 'alice@example.se',
      callbackURL: CALLBACK_URL,
    })
    expect(onSent).toHaveBeenCalledWith('alice@example.se')
  })
})
