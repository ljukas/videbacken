// Shared vocabulary for GUI-set integration credentials (ADR-0026): which
// credential owners exist, which fields each one holds, and how a field is
// rendered. Dependency-free and client-safe — no `db`/crypto import here — so
// the settings form can import it without dragging server code into the
// browser bundle. See `src/lib/integrationHealth.ts` for the same pattern.
// Adding a source changes the rendered DB CHECK text: run `bun run db:generate`.
export const CREDENTIAL_SOURCES = ['zaptec', 'skoda', 'emaldo', 'gridTariff'] as const
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]

export const CREDENTIAL_FIELDS = {
  zaptec: ['username', 'password'],
  skoda: ['apiKey', 'vin', 'homeCoordinates'],
  emaldo: ['user', 'password', 'appId', 'appSecret'],
  gridTariff: ['facilityId'],
} as const satisfies Record<CredentialSource, readonly string[]>

/**
 * Every field name across sources, deduplicated, in vocabulary order: the allowed values of the sync tables'
 * `suspect_fields` (names only). Changing it changes the rendered DB CHECK text.
 * Adding a name: `bun run db:generate`. Renaming or removing one: the re-added CHECK rejects rows still
 * holding the old name, so hand-add to the generated migration, before the new CHECKs, on both
 * `integration_sync` and `integration_sync_run`: `UPDATE <t> SET suspect_fields = array_replace(suspect_fields,
 * 'old', 'new')` (removal: `array_remove`, then `NULLIF(…, '{}')`). A rename already needs a data migration
 * for the stored credential JSON keys and `fields_set` (ADR-0026); this is one more line in it.
 */
export const CREDENTIAL_FIELD_NAMES: readonly string[] = [
  ...new Set(Object.values(CREDENTIAL_FIELDS).flat()),
]

export type CredentialField<S extends CredentialSource> = (typeof CREDENTIAL_FIELDS)[S][number]
/** Every credential field name, across sources. */
export type CredentialFieldName = CredentialField<CredentialSource>
export type CredentialValues<S extends CredentialSource> = Partial<
  Record<CredentialField<S>, string>
>
export type CredentialOrigin = 'stored' | 'env' | 'missing'

/** secret → password input; text → plain input (still never pre-filled). Only the VIN is text. */
export const credentialFieldKind = (source: CredentialSource, field: string): 'secret' | 'text' =>
  source === 'skoda' && field === 'vin' ? 'text' : 'secret'

export const isCredentialField = <S extends CredentialSource>(
  source: S,
  field: string,
): field is CredentialField<S> => (CREDENTIAL_FIELDS[source] as readonly string[]).includes(field)
