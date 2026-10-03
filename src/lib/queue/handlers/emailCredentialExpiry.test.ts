import { expect, test } from 'vitest'
import { logger } from '~/lib/logger/server'
import { emailCredentialExpiryHandler } from './emailCredentialExpiry'

const META = { meta: { messageId: 'test-msg', deliveryCount: 1 }, log: logger }
const MSG = {
  to: 'admin@test.videbacken.local',
  source: 'skoda',
  expiresAt: '2027-01-15T12:00:00.500Z',
  days: 30,
  locale: 'sv',
} as const

// The email effect short-circuits to devLog under VITEST, so this asserts the
// contract (resolves, no throw); the real send is exercised manually (Mailpit).
test('dispatches the reminder', async () => {
  await expect(emailCredentialExpiryHandler.handle(MSG, META)).resolves.toBeUndefined()
})

test('logs the recipient, source and threshold only', () => {
  expect(emailCredentialExpiryHandler.logFields?.(MSG)).toEqual({
    to: 'admin@test.videbacken.local',
    source: 'skoda',
    days: 30,
  })
})
