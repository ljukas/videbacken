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

const CALLBACK_URL = '/signed-in?redirect=%2F'

test('renders a Google sign-in button alongside the magic-link email form (no passkey)', async () => {
  const { screen } = await renderWithProviders(
    <LoginFormCard onSent={() => {}} callbackURL={CALLBACK_URL} />,
  )

  await expect.element(screen.getByRole('button', { name: m.login_google_button() })).toBeVisible()
  await expect.element(screen.getByLabelText(m.login_email_label())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_submit() })).toBeVisible()

  // Passkeys were removed entirely (Task 4) — the login card must never grow
  // one back.
  expect(screen.container.textContent?.toLowerCase()).not.toContain('passkey')
})

test('clicking the Google button calls signIn.social with the provider and callbackURL', async () => {
  signInSocial.mockResolvedValue({ error: null })
  const { screen } = await renderWithProviders(
    <LoginFormCard onSent={() => {}} callbackURL={CALLBACK_URL} />,
  )

  await screen.getByRole('button', { name: m.login_google_button() }).click()

  expect(signInSocial).toHaveBeenCalledWith({ provider: 'google', callbackURL: CALLBACK_URL })
})

test('submitting the email form still sends a magic link', async () => {
  signInMagicLink.mockResolvedValue({ error: null })
  const onSent = vi.fn()
  const { screen } = await renderWithProviders(
    <LoginFormCard onSent={onSent} callbackURL={CALLBACK_URL} />,
  )

  await screen.getByLabelText(m.login_email_label()).fill('alice@example.se')
  await screen.getByRole('button', { name: m.login_submit() }).click()

  await vi.waitFor(() => {
    expect(signInMagicLink).toHaveBeenCalledWith({
      email: 'alice@example.se',
      callbackURL: CALLBACK_URL,
    })
    expect(onSent).toHaveBeenCalledWith('alice@example.se')
  })
})
