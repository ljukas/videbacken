import { expect, test } from 'vitest'
import { logger } from '~/lib/logger/server'
import { handleEmailIntegrationSyncAlertMessage } from './emailIntegrationSyncAlert'

const META = { meta: { messageId: 'test-msg', deliveryCount: 1 }, log: logger }

// The email effect short-circuits to devLog under VITEST, so the handler is a
// pure pass-through here — we assert the contract (resolves, no throw). The
// real SMTP/Resend send is exercised in manual e2e (Mailpit).
test('handleEmailIntegrationSyncAlertMessage dispatches the failing alert without throwing', async () => {
  await expect(
    handleEmailIntegrationSyncAlertMessage(
      {
        to: 'admin@test.videbacken.local',
        source: 'zaptec',
        transition: 'started_failing',
        code: 'auth_failed',
        failingSince: '2026-09-28T06:00:00.000Z',
        locale: 'sv',
      },
      META,
    ),
  ).resolves.toBeUndefined()
})

test('handleEmailIntegrationSyncAlertMessage dispatches the recovered alert without throwing', async () => {
  await expect(
    handleEmailIntegrationSyncAlertMessage(
      {
        to: 'admin@test.videbacken.local',
        source: 'zaptec',
        transition: 'recovered',
        code: null,
        failingSince: null,
        locale: 'en',
      },
      META,
    ),
  ).resolves.toBeUndefined()
})
