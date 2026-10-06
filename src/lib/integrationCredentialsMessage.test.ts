import { describe, expect, test } from 'vitest'
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { m } from '~/paraglide/messages'
import {
  credentialFieldLabel,
  credentialsTitle,
  invalidFieldMessage,
  suspectFieldsMessage,
} from './integrationCredentialsMessage'

describe('credential copy', () => {
  test('every field of every source has a label', () => {
    for (const source of CREDENTIAL_SOURCES)
      for (const field of CREDENTIAL_FIELDS[source])
        expect(credentialFieldLabel(source, field)).not.toBe('')
  })
  test('format fields get their own invalid message, the rest a shared one', () => {
    expect(invalidFieldMessage('skoda', 'vin')).toBe(m.charging_credentials_invalid_vin())
    expect(invalidFieldMessage('skoda', 'homeCoordinates')).toBe(
      m.charging_credentials_invalid_home(),
    )
    expect(invalidFieldMessage('gridTariff', 'facilityId')).toBe(
      m.charging_credentials_invalid_facility(),
    )
    expect(invalidFieldMessage('zaptec', 'password')).toBe(m.charging_credentials_invalid_other())
  })
  test('suspect fields read as one sentence, in vocabulary order, unknown names dropped', () => {
    expect(suspectFieldsMessage('skoda', ['vin', 'apiKey', 'bogus'])).toBe(
      m.charging_credentials_suspect({ fields: 'API-nyckel och VIN' }),
    )
    expect(suspectFieldsMessage('skoda', [])).toBeNull()
    expect(suspectFieldsMessage('skoda', ['bogus'])).toBeNull()
  })
  test('the grid source is titled as the contract, the others as sign-in', () => {
    expect(credentialsTitle('gridTariff')).toBe(m.charging_grid_title())
    expect(credentialsTitle('skoda')).toBe(m.charging_credentials_title({ source: 'Škoda' }))
  })
})
