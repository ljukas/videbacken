import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  integer,
  pgTable,
  primaryKey,
  uuid,
} from 'drizzle-orm/pg-core'
import { evChargeSession } from './evCharging'

// Stored charging cost (ADR-0020, amended 2026-10-11): each counted session's
// priced totals per Stockholm month, written by the TS pricing
// (lib/evCharging/costing.ts) and read by costOverview and the session list.
//
// One `ev_session_cost` row per session that has been invalidated or priced.
// Every writer of a cost input (intervals, energy mix, spot slots, tariffs)
// bumps `generation` in its own transaction (services/sessionCost/invalidate).
// The month rows are current only while `priced_generation = generation` and
// `pricing_version` is the code's PRICING_VERSION; anything else, a missing row
// included, is stale and never read. Money in SEK incl VAT, energy in kWh.
export const evSessionCost = pgTable(
  'ev_session_cost',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => evChargeSession.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(0),
    /** The generation the month rows were priced at; null = never priced. */
    pricedGeneration: integer('priced_generation'),
    /** PRICING_VERSION the month rows were priced with. */
    pricingVersion: integer('pricing_version'),
    /** The session has no Zaptec intervals: priced over its whole window. */
    estimated: boolean('estimated'),
  },
  (table) => [
    // A write-back only ever sets priced_generation to the generation it read.
    check(
      'ev_session_cost_generation_check',
      sql`${table.generation} >= 0 AND (${table.pricedGeneration} IS NULL
        OR (${table.pricedGeneration} >= 0 AND ${table.pricedGeneration} <= ${table.generation}))`,
    ),
    // Priced columns are written together, or not at all.
    check(
      'ev_session_cost_priced_check',
      sql`(${table.pricedGeneration} IS NULL) = (${table.pricingVersion} IS NULL)
        AND (${table.pricedGeneration} IS NULL) = (${table.estimated} IS NULL)`,
    ),
  ],
).enableRLS()

export const evSessionCostMonth = pgTable(
  'ev_session_cost_month',
  {
    // Cascades from ev_session_cost, which cascades from the session.
    sessionId: uuid('session_id')
      .notNull()
      .references(() => evSessionCost.sessionId, { onDelete: 'cascade' }),
    /** Stockholm calendar year and month (1–12), as house_energy_month. */
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    kwh: doublePrecision('kwh').notNull(),
    gridKwh: doublePrecision('grid_kwh').notNull(),
    fullKwh: doublePrecision('full_kwh').notNull(),
    noPriceKwh: doublePrecision('no_price_kwh').notNull(),
    noTariffKwh: doublePrecision('no_tariff_kwh').notNull(),
    spotSek: doublePrecision('spot_sek').notNull(),
    feesSek: doublePrecision('fees_sek').notNull(),
    totalSek: doublePrecision('total_sek').notNull(),
    solarKwh: doublePrecision('solar_kwh').notNull(),
    batteryKwh: doublePrecision('battery_kwh').notNull(),
    noHouseDataKwh: doublePrecision('no_house_data_kwh').notNull(),
    solarValueSek: doublePrecision('solar_value_sek').notNull(),
    solarPricedKwh: doublePrecision('solar_priced_kwh').notNull(),
    solarUnpricedKwh: doublePrecision('solar_unpriced_kwh').notNull(),
  },
  (table) => [
    // Serves the reads' join by session, the write-back's delete by session
    // ids and the FK cascade. The month sums scan every row (a few hundred).
    primaryKey({
      name: 'ev_session_cost_month_pk',
      columns: [table.sessionId, table.year, table.month],
    }),
    check('ev_session_cost_month_month_check', sql`${table.month} BETWEEN 1 AND 12`),
    // Finite only ('Infinity' bounds also refuse NaN, which Postgres sorts
    // above every number). No sign bound: spot money is negative on negative
    // prices, and a float residue of −1e-17 kWh would fail a whole write-back.
    check(
      'ev_session_cost_month_finite_check',
      sql.join(
        [
          table.kwh,
          table.gridKwh,
          table.fullKwh,
          table.noPriceKwh,
          table.noTariffKwh,
          table.spotSek,
          table.feesSek,
          table.totalSek,
          table.solarKwh,
          table.batteryKwh,
          table.noHouseDataKwh,
          table.solarValueSek,
          table.solarPricedKwh,
          table.solarUnpricedKwh,
        ].map((c) => sql`${c} > '-Infinity' AND ${c} < 'Infinity'`),
        sql` AND `,
      ),
    ),
  ],
).enableRLS()
