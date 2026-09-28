import { beforeAll, expect, test } from 'vitest'
import { renderIntegrationSyncAlert } from './IntegrationSyncAlertEmail'

// The action button is built from BETTER_AUTH_URL directly (no per-message
// deep link — see the template's comment). `.env` sets it for a real run, but
// this test file doesn't import `~test/setup` (no DB needed), so `.env` is
// never loaded here — default it so the test doesn't depend on ambient shell
// state. Same pattern as `src/lib/effects/storage/adapters/s3.test.ts`.
beforeAll(() => {
  process.env.BETTER_AUTH_URL ??= 'https://videbacken.example'
})

test('renderIntegrationSyncAlert returns the Swedish failing/recovered subjects verbatim', async () => {
  const [failing, recovered] = await Promise.all([
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'started_failing',
      code: 'auth_failed',
      locale: 'sv',
    }),
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'recovered',
      code: null,
      locale: 'sv',
    }),
  ])
  expect(failing.subject).toBe('Zaptec-synkningen fungerar inte')
  expect(recovered.subject).toBe('Zaptec-synkningen fungerar igen')
})

test('renderIntegrationSyncAlert returns the English failing/recovered subjects', async () => {
  const [failing, recovered] = await Promise.all([
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'started_failing',
      code: 'auth_failed',
      locale: 'en',
    }),
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'recovered',
      code: null,
      locale: 'en',
    }),
  ])
  expect(failing.subject).toBe("Zaptec sync isn't working")
  expect(recovered.subject).toBe('Zaptec sync is working again')
})

test('renderIntegrationSyncAlert embeds the /charging link in both html and text, for both transitions', async () => {
  const [failing, recovered] = await Promise.all([
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'started_failing',
      code: 'auth_failed',
      locale: 'sv',
    }),
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'recovered',
      code: null,
      locale: 'en',
    }),
  ])
  expect(failing.html).toContain('/charging')
  expect(failing.text).toContain('/charging')
  expect(recovered.html).toContain('/charging')
  expect(recovered.text).toContain('/charging')
})

test('renderIntegrationSyncAlert includes the code-specific explanation when failing', async () => {
  const { html, text } = await renderIntegrationSyncAlert({
    source: 'zaptec',
    transition: 'started_failing',
    code: 'auth_failed',
    locale: 'sv',
  })
  expect(html).toContain('Zaptec-lösenordet')
  expect(text).toContain('Zaptec-lösenordet')
})

test('renderIntegrationSyncAlert emits non-empty html and text for both transitions', async () => {
  const [failing, recovered] = await Promise.all([
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'started_failing',
      code: 'auth_failed',
      locale: 'sv',
    }),
    renderIntegrationSyncAlert({
      source: 'zaptec',
      transition: 'recovered',
      code: null,
      locale: 'en',
    }),
  ])
  for (const { html, text } of [failing, recovered]) {
    expect(html.length).toBeGreaterThan(100)
    expect(text.length).toBeGreaterThan(20)
  }
})

test('renderIntegrationSyncAlert includes the brand wordmark in html', async () => {
  const { html } = await renderIntegrationSyncAlert({
    source: 'zaptec',
    transition: 'recovered',
    code: null,
    locale: 'sv',
  })
  expect(html).toContain('Videbacken')
})
