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
  expect(sv.subject).toBe('Nättarifferna finns nu i Eltariff-API')
  expect(en.subject).toBe('Our grid tariffs are now in the Eltariff API')
})

test('names the company in the preview and body, never in the subject', async () => {
  const { subject, html, text } = await renderGridTariffAvailable({
    companyName: 'Nät AB',
    locale: 'sv',
  })
  // The preview is a hidden div in the html only.
  expect(html).toContain('Nät AB publicerar nu sina nättariffer via Eltariff-API.')
  expect(text).toContain('Nät AB publicerar nu sina nättariffer via Eltariff-API, och vår')
  expect(subject).not.toContain('Nät AB')
})

test('says nothing is automatic yet, and why it repeats, in the body', async () => {
  const [sv, en] = await Promise.all([
    renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'sv' }),
    renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'en' }),
  ])
  expect(sv.text).toContain('behöver byggas först')
  expect(sv.text).toContain('en gång i månaden')
  expect(en.text).toContain('has to be built first')
  expect(en.text).toContain('once a month')
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
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('links to /charging in both html and text', async () => {
  const { html, text } = await renderGridTariffAvailable({ companyName: 'Nät AB', locale: 'sv' })
  expect(html).toContain('/charging')
  expect(text).toContain('/charging')
})
