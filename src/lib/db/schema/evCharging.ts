import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// One row per Zaptec charger (`id` is the Zaptec charger id itself — not a
// synthetic uuid — so upserts from the sync run are a plain `ON CONFLICT (id)`).
export const evCharger = pgTable('ev_charger', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  installationId: text('installation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// One row per completed (or voided/replaced) Zaptec charge session, upserted by
// the sync run keyed on `zaptecSessionId`.
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
    energyKwh: real('energy_kwh').notNull(),
    authorizedUserEmail: text('authorized_user_email'),
    authorizedUserName: text('authorized_user_name'),
    tokenName: text('token_name'),
    voided: boolean('voided').notNull().default(false),
    replacedByZaptecSessionId: text('replaced_by_zaptec_session_id'),
    offline: boolean('offline').notNull().default(false),
    reliableClock: boolean('reliable_clock').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ev_charge_session_start_at_idx').on(table.startAt),
    index('ev_charge_session_end_at_idx').on(table.endAt),
    check('ev_charge_session_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
    check('ev_charge_session_end_at_check', sql`${table.endAt} >= ${table.startAt}`),
  ],
)

// Sub-session power intervals (Zaptec's per-charge "ChargerSessions" line items)
// used to reconstruct a session's charging profile.
export const evChargeInterval = pgTable(
  'ev_charge_interval',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    energyKwh: real('energy_kwh').notNull(),
  },
  (table) => [
    uniqueIndex('ev_charge_interval_session_start_uq').on(table.sessionId, table.startAt),
    check('ev_charge_interval_end_at_check', sql`${table.endAt} > ${table.startAt}`),
    check('ev_charge_interval_energy_kwh_nonneg_check', sql`${table.energyKwh} >= 0`),
  ],
)

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
