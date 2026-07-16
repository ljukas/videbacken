import { desc, sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './betterAuth'
import { document } from './document'

// Audit log for document lifecycle. `document_id` is `ON DELETE SET NULL` so the
// history survives `hard_delete` — services MUST write the event row before
// deleting the underlying entity. `correlation_id` groups events that belong to
// one admin decision (e.g. folder cascade soft-delete).
//
// Payload shape per kind (jsonb; not enforced at the type level):
//   upload      to_value: { name, folderId }
//   rename      from_value: { name }              to_value: { name }
//   move        from_value: { folderId, name }    to_value: { folderId, name }
//   soft_delete                                   to_value: { name }
//   restore     —
//   hard_delete                                   to_value: { name, pathname }
export const documentEventKindEnum = pgEnum('document_event_kind', [
  'upload',
  'rename',
  'move',
  'soft_delete',
  'restore',
  'hard_delete',
])

export const documentEvent = pgTable(
  'document_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').references(() => document.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    kind: documentEventKindEnum('kind').notNull(),
    fromValue: jsonb('from_value'),
    toValue: jsonb('to_value'),
    correlationId: uuid('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('document_event_document_id_occurred_at_idx').on(
      table.documentId,
      desc(table.occurredAt),
    ),
    index('document_event_actor_id_occurred_at_idx').on(table.actorId, desc(table.occurredAt)),
    index('document_event_correlation_id_idx')
      .on(table.correlationId)
      .where(sql`${table.correlationId} IS NOT NULL`),
  ],
)
