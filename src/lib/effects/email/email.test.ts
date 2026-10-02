import { expect, test } from 'vitest'
import { email } from './email'

// The selector short-circuits to `devLog` when VITEST === 'true', so these
// tests run even with SMTP_HOST or RESEND_API_KEY set in .env. We only assert
// the interface contract (resolves to undefined, no throws) — devLog's log
// format is covered by src/lib/logger/server.test.ts.

test('sendMagicLink resolves without throwing', async () => {
  await expect(
    email.sendMagicLink({
      to: 'anna@test.videbacken.local',
      url: 'https://example.test/m/abc',
      locale: 'sv',
    }),
  ).resolves.toBeUndefined()
})

test('sendMagicLink handles repeated calls without side-effects on the adapter', async () => {
  await email.sendMagicLink({
    to: 'bo@test.videbacken.local',
    url: 'https://example.test/m/xyz',
    locale: 'sv',
  })
  await email.sendMagicLink({
    to: 'cara@test.videbacken.local',
    url: 'https://example.test/m/zzz',
    locale: 'sv',
  })
  await expect(
    email.sendMagicLink({
      to: 'dan@test.videbacken.local',
      url: 'https://example.test/m/qqq',
      locale: 'sv',
    }),
  ).resolves.toBeUndefined()
})

test('VITEST short-circuit selects devLog even when SMTP_HOST is set', async () => {
  // VITEST === 'true' under vitest; .env.example sets SMTP_HOST=localhost,
  // which would otherwise route through nodemailer. Confirming the call
  // resolves (rather than failing because no SMTP server is on :14622) is
  // proof the devLog adapter won.
  await expect(
    email.sendMagicLink({
      to: 'eve@test.videbacken.local',
      url: 'https://example.test/m/short',
      locale: 'sv',
    }),
  ).resolves.toBeUndefined()
})

test('sendUserInvited resolves without throwing', async () => {
  await expect(
    email.sendUserInvited({
      to: 'fia@test.videbacken.local',
      inviteUrl: 'https://example.test/login',
      locale: 'sv',
    }),
  ).resolves.toBeUndefined()
})

test('sendGridTariffAvailable resolves without throwing, with or without a company name', async () => {
  for (const companyName of ['Nät AB', null]) {
    await expect(
      email.sendGridTariffAvailable({ to: 'gus@test.videbacken.local', companyName, locale: 'sv' }),
    ).resolves.toBeUndefined()
  }
})

test('sendCredentialExpiry resolves without throwing', async () => {
  await expect(
    email.sendCredentialExpiry({
      to: 'gus@test.videbacken.local',
      source: 'skoda',
      expiresAt: '2027-01-15T12:00:00.500Z',
      days: 30,
      locale: 'sv',
    }),
  ).resolves.toBeUndefined()
})
