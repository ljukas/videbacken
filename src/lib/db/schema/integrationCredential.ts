import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { CREDENTIAL_SOURCES } from '../../integrationCredentials'
import { sqlList } from '../sqlList'
import { user } from './betterAuth'

// GUI-set integration credentials (ADR-0026): one row per credential owner, the
// fields as one AES-256-GCM-encrypted JSON object. Only the field *names* and
// who/when are plaintext. Read and written only by services/integrationCredential.
export const integrationCredential = pgTable(
  'integration_credential',
  {
    source: text('source').primaryKey(),
    // `v1.<iv>.<tag>.<ciphertext>`, base64url parts; the version prefix leaves room for key rotation.
    ciphertext: text('ciphertext').notNull(),
    fieldsSet: text('fields_set').array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: uuid('updated_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    check(
      'integration_credential_source_check',
      sql`${table.source} IN (${sqlList(CREDENTIAL_SOURCES)})`,
    ),
    check('integration_credential_ciphertext_check', sql`${table.ciphertext} LIKE 'v1.%'`),
    check('integration_credential_fields_set_check', sql`cardinality(${table.fieldsSet}) > 0`),
  ],
).enableRLS()
