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

// nav_charging_settings_short per locale (m.x() without a locale is always sv).
const settingsWord = { sv: 'Inställningar', en: 'Settings' } as const

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
      expect(out).not.toContain('SKODA_API_KEY')
      expect(out).toContain('/charging/settings')
      expect(out).toContain(settingsWord[locale])
    }
  }
})

test('the 7-day reminder has its own subject in English too', async () => {
  const { subject } = await renderCredentialExpiry({
    source: 'skoda',
    expiresAt: EXPIRES,
    days: 7,
    locale: 'en',
  })
  expect(subject).toBe('Final reminder: the Škoda key expires on 15 January 2027')
})

test('a summer (CEST) expiry late on the 30th is 1 July in Stockholm', async () => {
  const expiresAt = '2027-06-30T22:30:00Z'
  const [sv, en] = await Promise.all([
    renderCredentialExpiry({ source: 'skoda', expiresAt, days: 30, locale: 'sv' }),
    renderCredentialExpiry({ source: 'skoda', expiresAt, days: 30, locale: 'en' }),
  ])
  expect(sv.subject).toBe('Škoda-nyckeln går ut den 1 juli 2027')
  expect(en.subject).toBe('The Škoda key expires on 1 July 2027')
})

test('the date is in html and text, both locales', async () => {
  const dates = { sv: '15 januari 2027', en: '15 January 2027' } as const
  for (const locale of ['sv', 'en'] as const) {
    const { html, text } = await renderCredentialExpiry({
      source: 'skoda',
      expiresAt: EXPIRES,
      days: 30,
      locale,
    })
    for (const out of [html, text]) {
      expect(out).toContain(dates[locale])
    }
  }
})

test('says what an expired key does and that saving the new one syncs at once, in html and text', async () => {
  const sentences = {
    sv: [
      'Efter det räknas nya laddningar som vår bil, även om en gäst laddade.',
      'Synken körs direkt när du sparar.',
    ],
    en: [
      'After that, new charging sessions count as our car, even if a guest charged.',
      'The sync runs as soon as you save.',
    ],
  } as const
  for (const locale of ['sv', 'en'] as const) {
    const { html, text } = await renderCredentialExpiry({
      source: 'skoda',
      expiresAt: EXPIRES,
      days: 30,
      locale,
    })
    // React escapes the apostrophe in the html body.
    for (const out of [html.replaceAll('&#x27;', "'"), text]) {
      for (const sentence of sentences[locale]) expect(out).toContain(sentence)
    }
  }
})
