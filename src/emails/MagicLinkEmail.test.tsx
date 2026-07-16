import { expect, test } from 'vitest'
import { renderMagicLink } from './MagicLinkEmail'

const url = 'https://oceanview.example/sign-in/magic-link?token=test-1234'

test('renderMagicLink returns a Swedish subject', async () => {
  const { subject } = await renderMagicLink({ url, locale: 'sv' })
  expect(subject).toBe('Logga in på Oceanview')
})

test('renderMagicLink returns an English subject', async () => {
  const { subject } = await renderMagicLink({ url, locale: 'en' })
  expect(subject).toBe('Sign in to Oceanview')
})

test('renderMagicLink embeds the URL in both html and text', async () => {
  const { html, text } = await renderMagicLink({ url, locale: 'sv' })
  expect(html).toContain(url)
  expect(text).toContain(url)
})

test('renderMagicLink emits non-empty html and text', async () => {
  const { html, text } = await renderMagicLink({ url, locale: 'sv' })
  expect(html.length).toBeGreaterThan(100)
  expect(text.length).toBeGreaterThan(20)
})

test('renderMagicLink includes the brand wordmark in html', async () => {
  const { html } = await renderMagicLink({ url, locale: 'sv' })
  expect(html).toContain('Oceanview')
})

test('renderMagicLink renders the body in the requested locale', async () => {
  const [sv, en] = await Promise.all([
    renderMagicLink({ url, locale: 'sv' }),
    renderMagicLink({ url, locale: 'en' }),
  ])
  expect(sv.html).toContain('lang="sv"')
  expect(sv.text).toContain('Klicka på knappen')
  expect(en.html).toContain('lang="en"')
  expect(en.text).toContain('Click the button')
})
