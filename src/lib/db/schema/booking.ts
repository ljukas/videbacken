import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './betterAuth'
import { shareCodeEnum } from './ownership'

// What a wish points at: another share's rotation block ('share', with
// target_share set) or one of the two shoulder periods (ADR-0020).
export const bookingTargetEnum = pgEnum('booking_target', ['share', 'extra_early', 'extra_late'])

// Rotation slots always have a holder; extras may be holder-less — nobody
// sails those weeks. Backstopped by season_slot_rotation_held below.
export const slotKindEnum = pgEnum('slot_kind', ['rotation', 'extra'])

// One row per booking round (= season year). Created lazily by the first
// wish or admin draft action; locked_at NULL = round open. Lock is
// reversible (ADR-0020 product decision 7).
export const seasonBooking = pgTable('season_booking', {
  year: integer('year').primaryKey(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: uuid('locked_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Consent-based trade wishes + extra-period interest, one row per marked
// target (ADR-0020). Rows are kept after lock — the record of what was
// asked for; the UI hides them.
export const seasonWish = pgTable(
  'season_wish',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    year: integer('year')
      .notNull()
      .references(() => seasonBooking.year, { onDelete: 'cascade' }),
    // The wishing share; only its current owner may manage its wishes.
    shareCode: shareCodeEnum('share_code').notNull(),
    targetKind: bookingTargetEnum('target_kind').notNull(),
    // Set iff target_kind = 'share' (CHECK below).
    targetShare: shareCodeEnum('target_share'),
    // Who clicked (ADR-0018 actor precedent); survives user deletion.
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // NULLS NOT DISTINCT is required: extra wishes carry NULL target_share
    // and Postgres treats NULLs as distinct by default, so repeat extra
    // wishes would otherwise duplicate freely. Drizzle 0.45 exposes this on
    // the unique() constraint builder (NOT on uniqueIndex — see the
    // coalesce workaround note in schema/folder.ts).
    unique('season_wish_unique')
      .on(table.year, table.shareCode, table.targetKind, table.targetShare)
      .nullsNotDistinct(),
    check(
      'season_wish_target_share_iff_share_kind',
      sql`(${table.targetKind} = 'share') = (${table.targetShare} IS NOT NULL)`,
    ),
    check(
      'season_wish_no_self_target',
      sql`${table.targetShare} IS NULL OR ${table.targetShare} <> ${table.shareCode}`,
    ),
  ],
)

// The admin draft; becomes THE schedule at lock. Concrete first/last weeks
// per ADR-0019's revisit trigger — never derived from era math at read
// time. A share may hold several slots (its own block + an extra + an
// unassigned share's block); an unassigned share left holding its slot
// means nobody sails those weeks.
export const seasonSlot = pgTable(
  'season_slot',
  {
    year: integer('year')
      .notNull()
      .references(() => seasonBooking.year, { onDelete: 'cascade' }),
    firstWeek: integer('first_week').notNull(),
    lastWeek: integer('last_week').notNull(),
    kind: slotKindEnum('kind').notNull(),
    // NULL only on extras = nobody sails them.
    holder: shareCodeEnum('holder'),
  },
  (table) => [
    primaryKey({ columns: [table.year, table.firstWeek] }),
    check('season_slot_first_week_range', sql`${table.firstWeek} BETWEEN 1 AND 53`),
    check('season_slot_last_week_range', sql`${table.lastWeek} BETWEEN 1 AND 53`),
    check('season_slot_week_order', sql`${table.lastWeek} > ${table.firstWeek}`),
    check('season_slot_rotation_held', sql`${table.kind} = 'extra' OR ${table.holder} IS NOT NULL`),
  ],
)
