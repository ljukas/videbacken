import { relations, sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { file } from './file'
import { folder } from './folder'

export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => file.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Extension split into its own column (no leading dot, null = none) so it
    // stays immutable on rename — the stored byte's format must not drift.
    extension: text('extension'),
    folderId: uuid('folder_id').references(() => folder.id, { onDelete: 'restrict' }),
    thumbnailPathname: text('thumbnail_pathname'),
    searchHaystack: text('search_haystack').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('document_folder_id_idx').on(table.folderId),
    index('document_search_haystack_trgm_idx').using(
      'gin',
      sql`${table.searchHaystack} gin_trgm_ops`,
    ),
  ],
)

export const documentRelations = relations(document, ({ one }) => ({
  file: one(file, {
    fields: [document.fileId],
    references: [file.id],
  }),
  folder: one(folder, {
    fields: [document.folderId],
    references: [folder.id],
  }),
}))
