// Server-only: the env var each credential field falls back to (ADR-0026).
import {
  CREDENTIAL_ENV_VARS,
  type CredentialField,
  type CredentialSource,
} from '~/lib/integrationCredentials'

type Env = Record<string, string | undefined>

/** The env value for a field; undefined when unset or blank after trim, otherwise the raw value. */
export function envCredential<S extends CredentialSource>(
  source: S,
  field: CredentialField<S>,
  env: Env = process.env,
): string | undefined {
  const names: Record<string, string> = CREDENTIAL_ENV_VARS[source]
  const value = env[names[field]]
  return value === undefined || value.trim() === '' ? undefined : value
}
