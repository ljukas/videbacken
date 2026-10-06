import { describe, expect, test } from 'vitest'
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { m } from '~/paraglide/messages'
import {
  credentialFieldHint,
  credentialFieldLabel,
  credentialFieldList,
  credentialsTitle,
  invalidFieldMessage,
  suspectFieldsMessage,
} from './integrationCredentialsMessage'

describe('credential copy', () => {
  test('every field of every source has a label', () => {
    for (const source of CREDENTIAL_SOURCES)
      for (const field of CREDENTIAL_FIELDS[source])
        expect(credentialFieldLabel(source, field)).not.toBe(field)
  })
  test('hints exist for the fields that need explaining, not for plain secrets', () => {
    expect(credentialFieldHint('zaptec', 'username')).toBe(m.charging_credentials_hint_email())
    expect(credentialFieldHint('emaldo', 'appSecret')).toBe(
      m.charging_credentials_hint_emaldo_app(),
    )
    expect(credentialFieldHint('skoda', 'homeCoordinates')).toBe(m.charging_credentials_hint_home())
    expect(credentialFieldHint('gridTariff', 'facilityId')).toBe(
      m.charging_credentials_hint_facility(),
    )
    expect(credentialFieldHint('zaptec', 'password')).toBeUndefined()
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
  test('credentialFieldList joins labels in vocabulary order', () => {
    expect(credentialFieldList('skoda', ['vin', 'apiKey'])).toBe('API-nyckel och VIN')
    expect(credentialFieldList('emaldo', ['appId', 'user', 'password'])).toBe(
      'Användarnamn, Lösenord och App-id',
    )
  })
  test('suspect fields read as one sentence, in vocabulary order, unknown names dropped', () => {
    expect(suspectFieldsMessage('skoda', ['vin', 'apiKey', 'bogus'])).toBe(
      m.charging_credentials_suspect({ fields: 'API-nyckel och VIN' }),
    )
    expect(suspectFieldsMessage('emaldo', ['appId', 'password', 'user'])).toBe(
      m.charging_credentials_suspect({ fields: 'Användarnamn, Lösenord och App-id' }),
    )
    expect(suspectFieldsMessage('skoda', [])).toBeNull()
    expect(suspectFieldsMessage('skoda', ['bogus'])).toBeNull()
  })
  test('the grid source is titled as the contract, the others as sign-in', () => {
    expect(credentialsTitle('gridTariff')).toBe(m.charging_grid_title())
    expect(credentialsTitle('skoda')).toBe(m.charging_credentials_title({ source: 'Škoda' }))
  })
})
