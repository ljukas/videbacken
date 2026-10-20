import { expect, test } from 'vitest'
import { logger } from '~/lib/logger/server'
import { emailSensorAlertHandler } from './emailSensorAlert'

const META = { meta: { messageId: 'test-msg', deliveryCount: 1 }, log: logger }
const MSG = {
  to: 'gus@test.videbacken.local',
  locale: 'sv',
  transition: 'fired',
  sensorName: 'Förråd',
  kind: 'temperature',
  direction: 'below',
  threshold: 5,
  count: 2,
  value: 4.8,
  since: '2027-01-15T12:00:00Z',
  endedAt: null,
} as const

// The email effect short-circuits to devLog under VITEST, so this asserts the
// contract (resolves, no throw); the real send is exercised manually (Mailpit).
test('dispatches the alert', async () => {
  await expect(emailSensorAlertHandler.handle(MSG, META)).resolves.toBeUndefined()
})

test('logs the recipient, transition and kind only', () => {
  expect(emailSensorAlertHandler.logFields?.(MSG)).toEqual({
    to: 'gus@test.videbacken.local',
    transition: 'fired',
    kind: 'temperature',
  })
})
