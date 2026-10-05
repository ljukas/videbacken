// Server-only: the env var each credential field falls back to (ADR-0026).
import type { CredentialField, CredentialSource } from '~/lib/integrationCredentials'

type Env = Record<string, string | undefined>

export const CREDENTIAL_ENV: { [S in CredentialSource]: Record<CredentialField<S>, string> } = {
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
}

/** The env value for a field; undefined when unset or blank after trim, otherwise the raw value. */
export function envCredential<S extends CredentialSource>(
  source: S,
  field: CredentialField<S>,
  env: Env = process.env,
): string | undefined {
  const names: Record<string, string> = CREDENTIAL_ENV[source]
  const value = env[names[field]]
  return value === undefined || value.trim() === '' ? undefined : value
}
