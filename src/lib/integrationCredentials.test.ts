import { describe, expect, test } from 'vitest'
import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_SOURCES,
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
