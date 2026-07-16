import { expect, test } from 'vitest'
import { renderInviteUser } from './InviteUserEmail'

const inviteUrl = 'https://oceanview.example/api/auth/verify-email?token=test-1234&callbackURL=%2F'

test('renderInviteUser returns a Swedish subject', async () => {
  const { subject } = await renderInviteUser({ inviteUrl, locale: 'sv' })
  expect(subject).toBe('Du har blivit inbjuden till Oceanview')
})

test('renderInviteUser returns an English subject', async () => {
  const { subject } = await renderInviteUser({ inviteUrl, locale: 'en' })
  expect(subject).toBe("You've been invited to Oceanview")
})

test('renderInviteUser embeds the invite URL in both html and text', async () => {
  const { html, text } = await renderInviteUser({ inviteUrl, locale: 'sv' })
  // HTML escapes `&` in href to `&amp;` — same destination once the client decodes it.
  expect(html).toContain(inviteUrl.replace(/&/g, '&amp;'))
  expect(text).toContain(inviteUrl)
})

test('renderInviteUser emits non-empty html and text', async () => {
  const { html, text } = await renderInviteUser({ inviteUrl, locale: 'sv' })
  expect(html.length).toBeGreaterThan(100)
  expect(text.length).toBeGreaterThan(20)
})

test('renderInviteUser includes the brand wordmark in html', async () => {
  const { html } = await renderInviteUser({ inviteUrl, locale: 'sv' })
  expect(html).toContain('Oceanview')
})

test('renderInviteUser renders the body in the requested locale', async () => {
  const [sv, en] = await Promise.all([
    renderInviteUser({ inviteUrl, locale: 'sv' }),
    renderInviteUser({ inviteUrl, locale: 'en' }),
  ])
  expect(sv.html).toContain('lang="sv"')
  expect(sv.text).toContain('inbjuden till Oceanview')
  expect(en.html).toContain('lang="en"')
  expect(en.text).toContain('invited to Oceanview')
})
