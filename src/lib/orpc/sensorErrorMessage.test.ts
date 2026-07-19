import { expect, test } from 'vitest'
import { sensorErrorMessage } from '~/lib/orpc/sensorErrorMessage'
import { m } from '~/paraglide/messages'

test('maps DEVICE_NOT_FOUND to the not-found message', () => {
  expect(sensorErrorMessage('DEVICE_NOT_FOUND')).toBe(m.sensors_error_device_not_found())
})

test('maps INVALID_MAC to the generic save-error message', () => {
  expect(sensorErrorMessage('INVALID_MAC')).toBe(m.sensors_save_error())
})
