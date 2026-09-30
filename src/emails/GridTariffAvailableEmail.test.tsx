import { beforeAll, expect, test } from 'vitest'
import { renderGridTariffAvailable } from './GridTariffAvailableEmail'

// The action button is built from BETTER_AUTH_URL directly (no DB, so `.env`
// isn't loaded here): default it, like IntegrationSyncAlertEmail.test.tsx.
beforeAll(() => {
  process.env.BETTER_AUTH_URL ??= 'https://videbacken.example'
})

test('the subject is the fixed heading in each locale', async () => {
  const [sv, en] = await Promise.all([
    renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'sv' }),
    renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'en' }),
  ])
  expect(sv.subject).toBe('Nätavgiften kan nu hämtas automatiskt')
  expect(en.subject).toBe('The grid fee can now be fetched automatically')
})

test('names the company in the body, never in the subject', async () => {
  const { subject, html, text } = await renderGridTariffAvailable({
    companyName: 'Nät AB',
    locale: 'sv',
  })
  expect(text).toContain('Nät AB publicerar nu sina nättariffer via Eltariff-API')
  expect(html).toContain('Nät AB publicerar nu sina nättariffer')
  expect(subject).not.toContain('Nät AB')
})

test('falls back to a generic company when the catalogue has no name', async () => {
  const [sv, en] = await Promise.all([
    renderGridTariffAvailable({ companyName: null, locale: 'sv' }),
    renderGridTariffAvailable({ companyName: null, locale: 'en' }),
  ])
  expect(sv.text).toContain('Vårt nätbolag publicerar nu')
  expect(en.text).toContain('Our grid company now publishes')
  expect(sv.text).not.toContain('null')
})

test('escapes catalogue text in the html', async () => {
  const { html } = await renderGridTariffAvailable({
    companyName: '<script>alert(1)</script>',
    locale: 'sv',
  })
  expect(html).not.toContain('<script>alert(1)</script>')
})

test('links to /charging in both html and text, and says why it repeats', async () => {
  const { html, text } = await renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'sv' })
  expect(html).toContain('/charging')
  expect(text).toContain('/charging')
  expect(text).toContain('en gång i månaden')
})
