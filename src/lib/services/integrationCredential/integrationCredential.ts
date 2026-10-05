import { eq, sql } from 'drizzle-orm'
import { invalidateCredentials } from '~/lib/credentials/cache'
import {
  CredentialsUnreadableError,
  decrypt,
  encrypt,
  isEncryptionKeyConfigured,
} from '~/lib/credentials/crypto'
import { envCredential } from '~/lib/credentials/env'
import { db } from '~/lib/db'
import { integrationCredential } from '~/lib/db/schema'
import { parseFacilityId } from '~/lib/gridTariff/coverage'
import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_SOURCES,
  type CredentialField,
  type CredentialOrigin,
  type CredentialSource,
  type CredentialValues,
  isCredentialField,
} from '~/lib/integrationCredentials'
import { logger } from '~/lib/logger/server'
import { parseHomePoint } from '~/lib/vehicleState/geofence'
import { IntegrationCredentialDomainError } from './errors'

// GUI-set integration credentials (ADR-0026): one encrypted JSON object per
// source. Values never leave this module except through `readStored` (for the
// resolver); `status` reports field names and origins only.
//
// `fields_set` is unauthenticated plaintext beside the ciphertext: it feeds the
// `stored` origin in `status` and nothing else. Reads and merges use the
// decrypted object's keys.

export type CredentialSourceStatus<S extends CredentialSource> = {
  fields: Record<CredentialField<S>, { origin: CredentialOrigin }>
  updatedAt: Date | null
  unreadable: boolean
}

export type CredentialStatus = {
  encryptionKeyConfigured: boolean
  sources: { [S in CredentialSource]: CredentialSourceStatus<S> }
}

const MAX_VALUE_LENGTH = 512
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/

const fieldsOf = <S extends CredentialSource>(source: S) =>
  CREDENTIAL_FIELDS[source] as readonly CredentialField<S>[]

/** Decrypts and shape-checks a row: a plain object of known fields with non-blank string values. */
function parseStored<S extends CredentialSource>(
  source: S,
  ciphertext: string,
): CredentialValues<S> {
  const plaintext = decrypt(source, ciphertext)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new CredentialsUnreadableError(source, 'invalid')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Object.getPrototypeOf(parsed) !== Object.prototype ||
    !Object.entries(parsed).every(
      ([field, value]) =>
        isCredentialField(source, field) && typeof value === 'string' && value.trim() !== '',
    )
  ) {
    throw new CredentialsUnreadableError(source, 'invalid')
  }
  return parsed as CredentialValues<S>
}

/**
 * The stored credentials for `source`, or null when no row exists. Throws
 * `CredentialsUnreadableError` when a row exists but can't be read: key
 * missing or wrong, tampered, or decrypted JSON of the wrong shape.
 */
export async function readStored<S extends CredentialSource>(
  source: S,
): Promise<CredentialValues<S> | null> {
  const [row] = await db
    .select({ ciphertext: integrationCredential.ciphertext })
    .from(integrationCredential)
    .where(eq(integrationCredential.source, source))
  return row ? parseStored(source, row.ciphertext) : null
}

/** Per source and field: where its value would come from. Never returns a value. */
export async function status(): Promise<CredentialStatus> {
  const rows = await db.select().from(integrationCredential)
  const bySource = new Map(rows.map((row) => [row.source, row]))

  const sourceStatus = <S extends CredentialSource>(source: S): CredentialSourceStatus<S> => {
    const row = bySource.get(source)
    let unreadable = false
    if (row) {
      try {
        parseStored(source, row.ciphertext)
      } catch (err) {
        if (!(err instanceof CredentialsUnreadableError)) throw err
        unreadable = true
      }
    }
    const stored = new Set(row?.fieldsSet ?? [])
    const fields = Object.fromEntries(
      fieldsOf(source).map((field) => {
        const origin: CredentialOrigin = stored.has(field)
          ? 'stored'
          : envCredential(source, field) !== undefined
            ? 'env'
            : 'missing'
        return [field, { origin }]
      }),
    ) as CredentialSourceStatus<S>['fields']
    return { fields, updatedAt: row?.updatedAt ?? null, unreadable }
  }

  return {
    encryptionKeyConfigured: isEncryptionKeyConfigured(),
    sources: Object.fromEntries(
      CREDENTIAL_SOURCES.map((source) => [source, sourceStatus(source)]),
    ) as CredentialStatus['sources'],
  }
}

/** The value to store for one field; null for a blank one (keeps the stored value). */
function normalize(source: CredentialSource, field: string, raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw new IntegrationCredentialDomainError('INVALID_FIELD', field)
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = source === 'skoda' && field === 'vin' ? trimmed.toUpperCase() : trimmed
  const valid =
    value.length <= MAX_VALUE_LENGTH &&
    (source === 'skoda' && field === 'vin'
      ? VIN_PATTERN.test(value)
      : source === 'skoda' && field === 'homeCoordinates'
        ? parseHomePoint(value) !== null
        : source === 'gridTariff' && field === 'facilityId'
          ? parseFacilityId(value) !== null
          : true)
  if (!valid) throw new IntegrationCredentialDomainError('INVALID_FIELD', field)
  return value
}

/**
 * Saves the non-blank `fields` over the stored ones (per-field merge), encrypted.
 * Blank or missing fields keep their stored value. Serialized per source by a
 * transaction-scoped advisory lock: `FOR UPDATE` can't lock a row that doesn't
 * exist yet, so two concurrent first saves would otherwise each merge over
 * nothing and the later upsert would drop the earlier one's fields. Default
 * READ COMMITTED: after the lock, the read sees a concurrent save's committed row.
 */
export async function set<S extends CredentialSource>(
  source: S,
  fields: Record<string, string | undefined>,
  userId: string | null,
): Promise<{ fieldsSet: CredentialField<S>[]; updatedAt: Date }> {
  for (const field of Object.keys(fields)) {
    if (!isCredentialField(source, field)) {
      throw new IntegrationCredentialDomainError('INVALID_FIELD', field)
    }
  }
  const updates: CredentialValues<S> = {}
  for (const field of fieldsOf(source)) {
    if (!Object.hasOwn(fields, field)) continue
    const value = normalize(source, field, fields[field])
    if (value !== null) updates[field] = value
  }
  if (Object.keys(updates).length === 0) {
    throw new IntegrationCredentialDomainError('NOTHING_TO_SAVE')
  }
  if (!isEncryptionKeyConfigured()) {
    throw new IntegrationCredentialDomainError('ENCRYPTION_KEY_MISSING')
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('videbacken.integration_credential:' || ${source}))`,
    )
    const [row] = await tx
      .select({ ciphertext: integrationCredential.ciphertext })
      .from(integrationCredential)
      .where(eq(integrationCredential.source, source))
      .for('update')

    let current: CredentialValues<S> = {}
    if (row) {
      try {
        current = parseStored(source, row.ciphertext)
      } catch (err) {
        if (!(err instanceof CredentialsUnreadableError)) throw err
        logger.warn('integration credentials replaced unreadable row', { source })
      }
    }

    const combined: CredentialValues<S> = { ...current, ...updates }
    // Vocabulary order, from the merged object's own keys.
    const fieldsSet = fieldsOf(source).filter((field) => combined[field] !== undefined)
    const merged = Object.fromEntries(fieldsSet.map((field) => [field, combined[field]]))
    const ciphertext = encrypt(source, JSON.stringify(merged))

    const [saved] = await tx
      .insert(integrationCredential)
      .values({ source, ciphertext, fieldsSet, updatedBy: userId })
      .onConflictDoUpdate({
        target: integrationCredential.source,
        set: { ciphertext, fieldsSet, updatedBy: userId, updatedAt: new Date() },
      })
      .returning({ updatedAt: integrationCredential.updatedAt })
    return { fieldsSet, updatedAt: saved.updatedAt }
  })

  invalidateCredentials(source)
  return result
}

/** Deletes the stored row; true when one was deleted. */
export async function clear(source: CredentialSource): Promise<boolean> {
  const deleted = await db
    .delete(integrationCredential)
    .where(eq(integrationCredential.source, source))
    .returning({ source: integrationCredential.source })
  invalidateCredentials(source)
  return deleted.length > 0
}
