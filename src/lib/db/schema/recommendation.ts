import { desc, relations, sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'
import { file } from './file'

// A place recommendation — one location, many photos, the "why" in description.
export const recommendation = pgTable(
  'recommendation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('recommendation_author_id_idx').on(table.authorId),
    index('recommendation_active_idx')
      .on(desc(table.createdAt))
      .where(sql`${table.deletedAt} IS NULL`),
    check('recommendation_lat_range_check', sql`${table.lat} BETWEEN -90 AND 90`),
    check('recommendation_lng_range_check', sql`${table.lng} BETWEEN -180 AND 180`),
  ],
)

// Many photos per recommendation; cover = lowest sort_order. Each → a public file row.
export const recommendationPhoto = pgTable(
  'recommendation_photo',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendation.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => file.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('recommendation_photo_recommendation_id_idx').on(table.recommendationId),
    check('recommendation_photo_sort_order_nonneg_check', sql`${table.sortOrder} >= 0`),
  ],
)

// Fixed, curated, seeded tag vocabulary — NO user-created tags.
export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('tag_sort_order_idx').on(table.sortOrder)],
)

// Many-to-many join. PK leads with recommendation_id (forward lookup free); index tag_id for reverse.
export const recommendationTag = pgTable(
  'recommendation_tag',
  {
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendation.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.recommendationId, table.tagId] }),
    index('recommendation_tag_tag_id_idx').on(table.tagId),
  ],
)

export const recommendationRelations = relations(recommendation, ({ one, many }) => ({
  author: one(user, { fields: [recommendation.authorId], references: [user.id] }),
  photos: many(recommendationPhoto),
  tags: many(recommendationTag),
}))

export const recommendationPhotoRelations = relations(recommendationPhoto, ({ one }) => ({
  recommendation: one(recommendation, {
    fields: [recommendationPhoto.recommendationId],
    references: [recommendation.id],
  }),
  file: one(file, { fields: [recommendationPhoto.fileId], references: [file.id] }),
}))

export const recommendationTagRelations = relations(recommendationTag, ({ one }) => ({
  recommendation: one(recommendation, {
    fields: [recommendationTag.recommendationId],
    references: [recommendation.id],
  }),
  tag: one(tag, { fields: [recommendationTag.tagId], references: [tag.id] }),
}))
