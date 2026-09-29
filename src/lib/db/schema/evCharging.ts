import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

// One row per Zaptec charger (`id` is the Zaptec charger id itself — not a
// synthetic uuid — so upserts from the sync run are a plain `ON CONFLICT (id)`).
export const evCharger = pgTable('ev_charger', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  installationId: text('installation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
}).enableRLS()

// One row per completed (or voided/replaced) Zaptec charge session, upserted by
// the sync run keyed on `zaptecSessionId`. `energyKwh` is `doublePrecision`
// (float8), not `real` (float4): sessions are summed repeatedly (totals,
// per-charger rollups), and float4 rounding drift compounds across sums in a
// way that would later force a lossy `ALTER ... TYPE` migration.
export const evChargeSession = pgTable(
  'ev_charge_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    zaptecSessionId: text('zaptec_session_id').notNull().unique(),
    chargerId: text('charger_id')
      .notNull()
      .references(() => evCharger.id),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    authorizedUserEmail: text('authorized_user_email'),
    authorizedUserName: text('authorized_user_name'),
    tokenName: text('token_name'),
    voided: boolean('voided').notNull().default(false),
    replacedByZaptecSessionId: text('replaced_by_zaptec_session_id'),
    offline: boolean('offline').notNull().default(false),
    reliableClock: boolean('reliable_clock').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // No end_at index: nothing queries by end_at alone (start_at covers the
    // recency/range queries the overview and health views need).
    index('ev_charge_session_start_at_idx').on(table.startAt),
    // Covers the `charger_id` FK (an `ev_charger` delete/key check would
    // otherwise scan every session) and "the charger's latest session", which
    // picks the charger the live-status tile reads.
    index('ev_charge_session_charger_id_start_at_idx').on(table.chargerId, table.startAt),
    check('ev_charge_session_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
    check('ev_charge_session_end_at_check', sql`${table.endAt} >= ${table.startAt}`),
  ],
).enableRLS()

// Sub-session power intervals (Zaptec's per-charge "ChargerSessions" line
// items) used to reconstruct a session's charging profile. No synthetic id:
// `(session_id, start_at)` is already the natural key the sync run upserts on,
// so it doubles as the primary key instead of a redundant separate uuid + a
// separate unique index over the same columns.
export const evChargeInterval = pgTable(
  'ev_charge_interval',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
  },
  (table) => [
    primaryKey({ name: 'ev_charge_interval_pk', columns: [table.sessionId, table.startAt] }),
    check('ev_charge_interval_end_at_check', sql`${table.endAt} > ${table.startAt}`),
    check('ev_charge_interval_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
  ],
).enableRLS()

export const evChargerRelations = relations(evCharger, ({ many }) => ({
  sessions: many(evChargeSession),
}))

export const evChargeSessionRelations = relations(evChargeSession, ({ one, many }) => ({
  charger: one(evCharger, {
    fields: [evChargeSession.chargerId],
    references: [evCharger.id],
  }),
  intervals: many(evChargeInterval),
}))

export const evChargeIntervalRelations = relations(evChargeInterval, ({ one }) => ({
  session: one(evChargeSession, {
    fields: [evChargeInterval.sessionId],
    references: [evChargeSession.id],
  }),
}))
