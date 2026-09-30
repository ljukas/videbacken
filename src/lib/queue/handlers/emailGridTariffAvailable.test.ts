import { expect, test } from 'vitest'
import { logger } from '~/lib/logger/server'
import { emailGridTariffAvailableHandler } from './emailGridTariffAvailable'

const META = { meta: { messageId: 'test-msg', deliveryCount: 1 }, log: logger }

// The email effect short-circuits to devLog under VITEST, so the handler is a
// pure pass-through here — we assert the contract (resolves, no throw). The
// real SMTP/Resend send is exercised in manual e2e (Mailpit).
test('dispatches the notice with and without a company name', async () => {
  for (const companyName of ['Nät AB', null]) {
    await expect(
      emailGridTariffAvailableHandler.handle(
        { to: 'admin@test.videbacken.local', companyName, locale: 'sv' },
        META,
      ),
    ).resolves.toBeUndefined()
  }
})

test('logs only the recipient', () => {
  expect(
    emailGridTariffAvailableHandler.logFields?.({
      to: 'admin@test.videbacken.local',
      companyName: 'Nät AB',
      locale: 'sv',
    }),
  ).toEqual({ to: 'admin@test.videbacken.local' })
})
