import { beforeAll, expect, test } from 'vitest'
import { renderCredentialExpiry } from './CredentialExpiryEmail'

beforeAll(() => {
  process.env.BETTER_AUTH_URL ??= 'https://videbacken.example'
})

const EXPIRES = '2027-01-15T12:00:00.500Z'

test('the subject names the expiry date per locale', async () => {
  const [sv, en] = await Promise.all([
    renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 30, locale: 'sv' }),
    renderCredentialExpiry({ source: 'skoda', expiresAt: EXPIRES, days: 30, locale: 'en' }),
  ])
  expect(sv.subject).toBe('Škoda-nyckeln går ut den 15 januari 2027')
  expect(en.subject).toBe('The Škoda key expires on 15 January 2027')
})

test('the date is the Stockholm calendar date', async () => {
  const { subject } = await renderCredentialExpiry({
    source: 'skoda',
    expiresAt: '2027-01-15T23:30:00Z',
    days: 30,
    locale: 'sv',
  })
  expect(subject).toBe('Škoda-nyckeln går ut den 16 januari 2027')
})

test('the 7-day reminder has its own subject', async () => {
  const { subject } = await renderCredentialExpiry({
    source: 'skoda',
    expiresAt: EXPIRES,
    days: 7,
    locale: 'sv',
  })
  expect(subject).toBe('Sista påminnelsen: Škoda-nyckeln går ut den 15 januari 2027')
})

test('says how to renew, in html and text, both locales', async () => {
  for (const locale of ['sv', 'en'] as const) {
    const { html, text } = await renderCredentialExpiry({
      source: 'skoda',
      expiresAt: EXPIRES,
      days: 30,
      locale,
    })
    for (const out of [html, text]) {
      expect(out).toContain('https://go.skoda.eu/api-keys')
      expect(out).toContain('SKODA_API_KEY')
      expect(out).toContain('/charging')
    }
  }
})
