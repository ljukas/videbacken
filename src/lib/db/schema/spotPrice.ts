import { sql } from 'drizzle-orm'
import {
  check,
  date,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { PRICE_ZONES } from '../../spotPrice/zones'
import { sqlList } from '../sqlList'

// One row per day-ahead spot price slot, upserted by the elpris sync keyed on
// `(zone, slot_start)`. Slots are 15 min since 2025-10-01 and 60 min before, and
// a DST day has 92/100 of them — so `slot_end` is stored, never derived from a
// fixed length. `sek_per_kwh` is ex VAT and can be negative.
export const spotPrice = pgTable(
  'spot_price',
  {
    zone: text('zone').notNull(),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    sekPerKwh: doublePrecision('sek_per_kwh').notNull(),
    // When the sync last wrote this slot (a re-fetched day rewrites it).
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Serves the conflict target, the cost read's slot range scan
    // (`zone = $1 AND slot_start >= $from - 1h AND slot_start < $to`) and
    // replaceDay's day delete and aggregate — no other index needed.
    primaryKey({ name: 'spot_price_pk', columns: [table.zone, table.slotStart] }),
    check('spot_price_zone_check', sql`${table.zone} IN (${sqlList(PRICE_ZONES)})`),
    // The ≤ 1 h bound is load-bearing: the cost read bounds its range scan by
    // `slot_start >= from - 1 hour` to find the slot overlapping `from`.
    check(
      'spot_price_slot_check',
      sql`${table.slotEnd} > ${table.slotStart} AND ${table.slotEnd} - ${table.slotStart} <= interval '1 hour'`,
    ),
    // Absurd-value backstop only (the day-ahead market's limits are roughly
    // −6…+45 SEK/kWh); the elpris parser does the real unit/range validation.
    check(
      'spot_price_sek_per_kwh_check',
      sql`${table.sekPerKwh} > -100 AND ${table.sekPerKwh} < 100`,
    ),
  ],
).enableRLS()

// One row per stored Stockholm day of `spot_price`: its time-weighted average
// SEK/kWh (ex VAT) and how long the day is (23/24/25 h). Written only by
// `spotPrice.replaceDay`, in the same transaction as the day's slots, so it is
// never staler than they are; the economy page reads ~255 of these a year
// instead of grouping ~35 000 slots.
export const spotPriceDay = pgTable(
  'spot_price_day',
  {
    zone: text('zone').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    avgSekPerKwh: doublePrecision('avg_sek_per_kwh').notNull(),
    coveredSeconds: integer('covered_seconds').notNull(),
  },
  (table) => [
    // Serves the economy read (`zone = $1 AND day BETWEEN $2 AND $3`) and the
    // upsert's conflict target.
    primaryKey({ name: 'spot_price_day_pk', columns: [table.zone, table.day] }),
    check('spot_price_day_zone_check', sql`${table.zone} IN (${sqlList(PRICE_ZONES)})`),
    // At most a 25 h DST day. `replaceDay` only stores whole days (23, 24 or
    // 25 h, `validateDaySlots`); the bound is a backstop, not that rule.
    check(
      'spot_price_day_covered_seconds_check',
      sql`${table.coveredSeconds} > 0 AND ${table.coveredSeconds} <= 90000`,
    ),
  ],
).enableRLS()
