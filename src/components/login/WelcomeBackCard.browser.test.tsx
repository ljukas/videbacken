import { expect, test, vi } from 'vitest'
import type { LoginMethod } from '~/lib/lastLoginMethodFns'
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

// Magic link lands on /signed-in in a new tab; Google stays in this tab and
// goes straight to the destination. The two callbacks are deliberately distinct.
const MAGIC_LINK_CALLBACK_URL = '/signed-in?redirect=%2F'
const GOOGLE_CALLBACK_URL = '/'

function renderCard(
  lastMethod: LoginMethod | null = null,
  onSent: (email: string) => void = () => {},
) {
  return renderWithProviders(
    <WelcomeBackCard
      email="alice@example.se"
      name="Alice Svensson"
      image={null}
      imageBlurhash={null}
      lastMethod={lastMethod}
      magicLinkCallbackURL={MAGIC_LINK_CALLBACK_URL}
      googleCallbackURL={GOOGLE_CALLBACK_URL}
      onSent={onSent}
      onSwitchUser={() => {}}
    />,
  )
}

// DOM index of each action button (-1 if absent). Lower index = earlier in the
// document = the primary position / earlier keyboard traversal.
function buttonOrder(container: Element) {
  const buttons = Array.from(container.querySelectorAll('button'))
  return {
    google: buttons.findIndex((b) => b.textContent?.includes(m.login_google_button())),
    magicLink: buttons.findIndex((b) => b.textContent?.includes(m.login_submit())),
  }
}

function findButton(container: Element, label: string) {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  )
}

test('offers the Google button as a secondary option alongside the one-click magic-link resend (no passkey)', async () => {
  const { screen } = await renderCard()

  await expect.element(screen.getByRole('button', { name: m.login_submit() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_google_button() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.login_switch_user() })).toBeVisible()

  expect(screen.container.textContent?.toLowerCase()).not.toContain('passkey')
})

test('defaults to magic-link as the primary (filled, first) action with the last-used caption', async () => {
  const { screen } = await renderCard(null)
  const order = buttonOrder(screen.container)
  expect(order.magicLink).toBeLessThan(order.google)

  const magic = findButton(screen.container, m.login_submit())
  const google = findButton(screen.container, m.login_google_button())
  expect(magic?.getAttribute('data-variant')).toBe('default')
  expect(google?.getAttribute('data-variant')).toBe('outline')

  const describedBy = magic?.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(screen.container.querySelector(`#${describedBy}`)?.textContent).toBe(m.login_last_used())
})

test('promotes Google to the primary (filled, first) action when it was last used', async () => {
  const { screen } = await renderCard('google')
  const order = buttonOrder(screen.container)
  expect(order.google).toBeLessThan(order.magicLink)

  const google = findButton(screen.container, m.login_google_button())
  const magic = findButton(screen.container, m.login_submit())
  expect(google?.getAttribute('data-variant')).toBe('default')
  expect(magic?.getAttribute('data-variant')).toBe('outline')

  const describedBy = google?.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(screen.container.querySelector(`#${describedBy}`)?.textContent).toBe(m.login_last_used())
})

test('clicking the Google button calls signIn.social with the provider and the same-tab destination', async () => {
  signInSocial.mockResolvedValue({ error: null })
  const { screen } = await renderCard()

  await screen.getByRole('button', { name: m.login_google_button() }).click()

  // Google must NOT route through /signed-in — it uses the plain destination.
  expect(signInSocial).toHaveBeenCalledWith({
    provider: 'google',
    callbackURL: GOOGLE_CALLBACK_URL,
  })
})

test('clicking the primary button still resends a magic link to the saved email', async () => {
  signInMagicLink.mockResolvedValue({ error: null })
  const onSent = vi.fn()
  const { screen } = await renderCard(null, onSent)

  await screen.getByRole('button', { name: m.login_submit() }).click()

  await vi.waitFor(() => {
    expect(signInMagicLink).toHaveBeenCalledWith({
      email: 'alice@example.se',
      callbackURL: MAGIC_LINK_CALLBACK_URL,
    })
    expect(onSent).toHaveBeenCalledWith('alice@example.se')
  })
})
