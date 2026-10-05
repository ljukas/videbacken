import { describe, expect, it } from 'vitest'
import { CREDENTIAL_FIELDS, CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { CREDENTIAL_ENV, envCredential } from './env'

describe('credential env map', () => {
  it('names an env var for every vocabulary field', () => {
    for (const source of CREDENTIAL_SOURCES) {
      expect(Object.keys(CREDENTIAL_ENV[source]).sort()).toEqual(
        [...CREDENTIAL_FIELDS[source]].sort(),
      )
      for (const name of Object.values(CREDENTIAL_ENV[source])) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/)
      }
    }
  })

  it('matches the ADR-0026 names', () => {
    expect(CREDENTIAL_ENV).toEqual({
      zaptec: { username: 'ZAPTEC_USERNAME', password: 'ZAPTEC_PASSWORD' },
      skoda: {
        apiKey: 'SKODA_API_KEY',
        vin: 'SKODA_VIN',
        homeCoordinates: 'SKODA_HOME_COORDINATES',
      },
      emaldo: {
        user: 'EMALDO_USER',
        password: 'EMALDO_PASSWORD',
        appId: 'EMALDO_APP_ID',
        appSecret: 'EMALDO_APP_SECRET',
      },
      gridTariff: { facilityId: 'GRID_FACILITY_ID' },
    })
  })

  it('treats unset and blank as undefined, otherwise returns the raw value', () => {
    expect(envCredential('zaptec', 'username', {})).toBeUndefined()
    expect(envCredential('zaptec', 'username', { ZAPTEC_USERNAME: '' })).toBeUndefined()
    expect(envCredential('zaptec', 'username', { ZAPTEC_USERNAME: '  ' })).toBeUndefined()
    expect(envCredential('zaptec', 'username', { ZAPTEC_USERNAME: ' me ' })).toBe(' me ')
    expect(envCredential('gridTariff', 'facilityId', { GRID_FACILITY_ID: '123' })).toBe('123')
  })

  it('reads process.env on every call by default', () => {
    process.env.GRID_FACILITY_ID = 'a'
    expect(envCredential('gridTariff', 'facilityId')).toBe('a')
    process.env.GRID_FACILITY_ID = 'b'
    expect(envCredential('gridTariff', 'facilityId')).toBe('b')
    delete process.env.GRID_FACILITY_ID
  })
})
