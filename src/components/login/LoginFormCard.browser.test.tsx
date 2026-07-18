import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { LoginFormCard } from './LoginFormCard'

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

// Magic link lands on /signed-in in a new tab; Google stays in this tab and
// goes straight to the destination. The two callbacks are deliberately distinct.
const MAGIC_LINK_CALLBACK_URL = '/signed-in?redirect=%2F'
const GOOGLE_CALLBACK_URL = '/'

test('renders a Google sign-in button alongside the magic-link email form (no passkey)', async () => {
  const { screen } = await renderWithProviders(
    <LoginFormCard
      onSent={() => {}}
      magicLinkCallbackURL={MAGIC_LINK_CALLBACK_URL}
      googleCallbackURL={GOOGLE_CALLBACK_URL}
    />,
  )

  await expect.element(screen.getByRole('button', { name: m.login_google_button() })).toBeVisible()
  await expect.element(screen.getByLabelText(m.login_email_label())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_submit() })).toBeVisible()

  // Passkeys were removed entirely (Task 4) — the login card must never grow
  // one back.
  expect(screen.container.textContent?.toLowerCase()).not.toContain('passkey')
})

test('clicking the Google button calls signIn.social with the provider and the same-tab destination', async () => {
  signInSocial.mockResolvedValue({ error: null })
  const { screen } = await renderWithProviders(
    <LoginFormCard
      onSent={() => {}}
      magicLinkCallbackURL={MAGIC_LINK_CALLBACK_URL}
      googleCallbackURL={GOOGLE_CALLBACK_URL}
    />,
  )

  await screen.getByRole('button', { name: m.login_google_button() }).click()

  // Google must NOT route through /signed-in — it uses the plain destination.
  expect(signInSocial).toHaveBeenCalledWith({
    provider: 'google',
    callbackURL: GOOGLE_CALLBACK_URL,
  })
})

test('submitting the email form still sends a magic link via the /signed-in callback', async () => {
  signInMagicLink.mockResolvedValue({ error: null })
  const onSent = vi.fn()
  const { screen } = await renderWithProviders(
    <LoginFormCard
      onSent={onSent}
      magicLinkCallbackURL={MAGIC_LINK_CALLBACK_URL}
      googleCallbackURL={GOOGLE_CALLBACK_URL}
    />,
  )

  await screen.getByLabelText(m.login_email_label()).fill('alice@example.se')
  await screen.getByRole('button', { name: m.login_submit() }).click()

  await vi.waitFor(() => {
    expect(signInMagicLink).toHaveBeenCalledWith({
      email: 'alice@example.se',
      callbackURL: MAGIC_LINK_CALLBACK_URL,
    })
    expect(onSent).toHaveBeenCalledWith('alice@example.se')
  })
})
