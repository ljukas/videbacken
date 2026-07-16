import { relations, sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './betterAuth'

export const fileAccessEnum = pgEnum('file_access', ['public', 'private'])

export const file = pgTable(
  'file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    pathname: text('pathname').notNull().unique(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    access: fileAccessEnum('access').notNull(),
    blurhash: text('blurhash'),
    // Set when an async HEIC→JPEG transcode fails permanently (corrupt/undecodable
    // bytes, retries exhausted). null = pending or n/a; non-null = "couldn't process".
    transcodeFailedAt: timestamp('transcode_failed_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('file_owner_id_idx').on(table.ownerId),
    index('file_access_idx').on(table.access),
    check('file_size_bytes_nonneg_check', sql`${table.sizeBytes} >= 0`),
  ],
)

export const fileRelations = relations(file, ({ one }) => ({
  owner: one(user, {
    fields: [file.ownerId],
    references: [user.id],
  }),
}))
