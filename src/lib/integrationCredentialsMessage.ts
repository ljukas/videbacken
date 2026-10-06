// Client-safe copy for GUI-set credentials (ADR-0026): labels, hints and what an error means, per source
// and field. Same pattern as integrationHealthMessage.ts: Paraglide `m` plus dependency-free vocabulary only.
import { getIntlLocale } from '~/lib/i18n/format'
import { CREDENTIAL_FIELDS, type CredentialSource } from '~/lib/integrationCredentials'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { m } from '~/paraglide/messages'

export function credentialsTitle(source: CredentialSource): string {
  return source === 'gridTariff'
    ? m.charging_grid_title()
    : m.charging_credentials_title({ source: integrationSourceName(source) })
}

export function credentialFieldLabel(source: CredentialSource, field: string): string {
  switch (`${source}.${field}`) {
    case 'zaptec.username':
      return m.charging_credentials_field_zaptec_username()
    case 'zaptec.password':
    case 'emaldo.password':
      return m.charging_credentials_field_password()
    case 'skoda.apiKey':
      return m.charging_credentials_field_skoda_apiKey()
    case 'skoda.vin':
      return m.charging_credentials_field_skoda_vin()
    case 'skoda.homeCoordinates':
      return m.charging_credentials_field_skoda_homeCoordinates()
    case 'emaldo.user':
      return m.charging_credentials_field_emaldo_user()
    case 'emaldo.appId':
      return m.charging_credentials_field_emaldo_appId()
    case 'emaldo.appSecret':
      return m.charging_credentials_field_emaldo_appSecret()
    case 'gridTariff.facilityId':
      return m.charging_credentials_field_gridTariff_facilityId()
    default:
      return field
  }
}

export function credentialFieldHint(source: CredentialSource, field: string): string | undefined {
  switch (`${source}.${field}`) {
    case 'zaptec.username':
    case 'emaldo.user':
      return m.charging_credentials_hint_email()
    case 'skoda.vin':
      return m.charging_credentials_hint_vin()
    case 'skoda.homeCoordinates':
      return m.charging_credentials_hint_home()
    case 'emaldo.appId':
    case 'emaldo.appSecret':
      return m.charging_credentials_hint_emaldo_app()
    case 'gridTariff.facilityId':
      return m.charging_credentials_hint_facility()
    default:
      return undefined
  }
}

/** What `INVALID_FIELD` means for one field: the format rule where there is one (the service's validation). */
export function invalidFieldMessage(source: CredentialSource, field: string): string {
  switch (`${source}.${field}`) {
    case 'skoda.vin':
      return m.charging_credentials_invalid_vin()
    case 'skoda.homeCoordinates':
      return m.charging_credentials_invalid_home()
    case 'gridTariff.facilityId':
      return m.charging_credentials_invalid_facility()
    default:
      return m.charging_credentials_invalid_other()
  }
}

/** "API-nyckel och VIN fungerade inte vid senaste synken." — vocabulary order; null when none is known. */
export function suspectFieldsMessage(
  source: CredentialSource,
  fields: readonly string[],
): string | null {
  const known = (CREDENTIAL_FIELDS[source] as readonly string[]).filter((f) => fields.includes(f))
  if (known.length === 0) return null
  const names = new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(
    known.map((f) => credentialFieldLabel(source, f)),
  )
  return m.charging_credentials_suspect({ fields: names })
}
