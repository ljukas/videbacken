import { desc, sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './betterAuth'
import { folder } from './folder'

// Sibling of `documentEvent`. `folder_id` is `ON DELETE SET NULL` so history
// survives hard-delete. `correlation_id` groups cascade ops (subtree
// soft-delete / restore) so the bin UI can render "Lukas deleted /Manuals/ (3
// folders, 12 documents)" as one entry.
//
// Payload shape per kind (jsonb; not enforced at the type level):
//   create      to_value: { name, parentId, path }
//   rename      from_value: { name, path }       to_value: { name, path }
//   move        from_value: { parentId, path }   to_value: { parentId, path }
//   soft_delete                                  to_value: { name, path }
//   restore     —
//   hard_delete                                  to_value: { name, path }
export const folderEventKindEnum = pgEnum('folder_event_kind', [
  'create',
  'rename',
  'move',
  'soft_delete',
  'restore',
  'hard_delete',
])

export const folderEvent = pgTable(
  'folder_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id').references(() => folder.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    kind: folderEventKindEnum('kind').notNull(),
    fromValue: jsonb('from_value'),
    toValue: jsonb('to_value'),
    correlationId: uuid('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('folder_event_folder_id_occurred_at_idx').on(table.folderId, desc(table.occurredAt)),
    index('folder_event_actor_id_occurred_at_idx').on(table.actorId, desc(table.occurredAt)),
    index('folder_event_correlation_id_idx')
      .on(table.correlationId)
      .where(sql`${table.correlationId} IS NOT NULL`),
  ],
)
