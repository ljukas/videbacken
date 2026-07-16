import { relations, sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'

export const shareCodeEnum = pgEnum('share_code', [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
])

// The group's schedule convention, effective-dated (ADR-0019). Append-only:
// season year Y is governed by the row with the greatest from_year <= Y;
// start_share anchors the -3/year rotation at from_year. Rows are only ever
// inserted — via data migration, never from app code (see the ADR runbook).
// A season is 20 consecutive weeks, so week 33 is the last start that keeps
// the whole season inside one ISO year (33 + 19 = 52) — hence the CHECK.
export const seasonEra = pgTable(
  'season_era',
  {
    fromYear: integer('from_year').primaryKey(),
    startWeek: integer('start_week').notNull(),
    startShare: shareCodeEnum('start_share').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check('season_era_start_week_check', sql`${table.startWeek} BETWEEN 1 AND 33`)],
)

// One row per ownership stint: `userId` owned `shareCode` from `assignedFrom`
// (inclusive) until `assignedTo` (exclusive); NULL assignedTo = active. Rows
// are only ever closed, never deleted — this table IS the per-share history.
// Shares are indivisible (ADR-0018): the share_code enum is the share (no
// share table), and each row is one whole admin decision, so `actorUserId`
// lives here directly (nullable so admin deletion doesn't fail, and so
// system-generated rows can record no actor).
export const ownershipAssignment = pgTable(
  'ownership_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shareCode: shareCodeEnum('share_code').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    // Half-open: owner from `assignedFrom` (inclusive) until `assignedTo`
    // (exclusive). `assignedTo IS NULL` means the assignment is still active.
    assignedFrom: date('assigned_from', { mode: 'date' }).notNull(),
    assignedTo: date('assigned_to', { mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ownership_assignment_share_code_idx').on(table.shareCode),
    index('ownership_assignment_user_id_idx').on(table.userId),
    uniqueIndex('ownership_assignment_one_current_per_share_idx')
      .on(table.shareCode)
      .where(sql`${table.assignedTo} IS NULL`),
    check(
      'ownership_assignment_range_check',
      sql`${table.assignedTo} IS NULL OR ${table.assignedTo} > ${table.assignedFrom}`,
    ),
  ],
)

export const ownershipAssignmentRelations = relations(ownershipAssignment, ({ one }) => ({
  user: one(user, {
    fields: [ownershipAssignment.userId],
    references: [user.id],
  }),
  actor: one(user, {
    fields: [ownershipAssignment.actorUserId],
    references: [user.id],
  }),
}))
