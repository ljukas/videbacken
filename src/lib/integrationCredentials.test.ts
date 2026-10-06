import { describe, expect, test } from 'vitest'
import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_SOURCES,
  credentialFieldKind,
  isOptionalCredentialField,
} from './integrationCredentials'

describe('isOptionalCredentialField', () => {
  // The remove confirm relies on this matching each adapter's own "configured" rule
  // (Škoda: apiKey && vin in selectSkodaAdapter).
  test("only Škoda's home position is optional", () => {
    for (const source of CREDENTIAL_SOURCES)
      for (const field of CREDENTIAL_FIELDS[source])
        expect(isOptionalCredentialField(source, field), `${source}.${field}`).toBe(
          source === 'skoda' && field === 'homeCoordinates',
        )
  })
})

describe('credentialFieldKind', () => {
  test('only the VIN is text, only the home position is a position, the rest are secret', () => {
    for (const source of CREDENTIAL_SOURCES)
      for (const field of CREDENTIAL_FIELDS[source]) {
        const expected =
          source === 'skoda' && field === 'vin'
            ? 'text'
            : source === 'skoda' && field === 'homeCoordinates'
              ? 'position'
              : 'secret'
        expect(credentialFieldKind(source, field), `${source}.${field}`).toBe(expected)
      }
  })

  test('the field names only count under the Škoda source', () => {
    expect(credentialFieldKind('emaldo', 'vin')).toBe('secret')
    expect(credentialFieldKind('zaptec', 'homeCoordinates')).toBe('secret')
  })
})
