import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'

// Adjacency list (`parent_id`) + denormalized `path` for cheap subtree queries.
// Services own `path` writes; CHECK constraints enforce the format invariants
// so a hand-written UPDATE that breaks the shape fails fast (see ADR-0010).
export const folder = pgTable(
  'folder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folder.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    // '/' for direct children of root; '/Manuals/Engine/' for nested. Always
    // leads and trails with a slash so `LIKE path || '%'` matches descendants.
    path: text('path').notNull(),
    // Denormalized `path || ' ' || name`; rewritten on rename / move so the
    // GIN trigram index can drive natural-language search without a join.
    searchHaystack: text('search_haystack').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('folder_parent_id_idx').on(table.parentId),
    index('folder_path_idx').on(table.path),
    index('folder_search_haystack_trgm_idx').using(
      'gin',
      sql`${table.searchHaystack} gin_trgm_ops`,
    ),
    // Coalesce parent_id to a sentinel uuid so root folders (parent_id NULL)
    // collide on name. Without this, Postgres treats each NULL as distinct
    // and the partial index silently allows duplicate root-folder names.
    // (`nullsNotDistinct()` would also work but Drizzle 0.45 doesn't expose
    // it on the uniqueIndex builder.)
    uniqueIndex('folder_unique_name_per_parent_idx')
      .on(
        sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.name,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    check('folder_name_no_slash_check', sql`position('/' in ${table.name}) = 0`),
    check('folder_path_format_check', sql`${table.path} LIKE '/%' AND ${table.path} LIKE '%/'`),
  ],
)

export const folderRelations = relations(folder, ({ one, many }) => ({
  parent: one(folder, {
    fields: [folder.parentId],
    references: [folder.id],
    relationName: 'folder_parent',
  }),
  children: many(folder, { relationName: 'folder_parent' }),
  creator: one(user, {
    fields: [folder.createdBy],
    references: [user.id],
  }),
}))
