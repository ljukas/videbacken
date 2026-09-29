import { sql } from 'drizzle-orm'
import { check, date, doublePrecision, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'

// One row per tariff period, admin-managed. A period applies from its
// `valid_from` Stockholm calendar date until the next period's, so editing
// today's tariff never re-prices history. All per-kWh amounts are öre ex VAT;
// fixed monthly fees are deliberately not modelled (they don't scale with
// charging). `valid_from` is a `date`, not a timestamptz: it names a local
// calendar day, not an instant.
export const electricityTariff = pgTable(
  'electricity_tariff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Unique: two periods can't start the same day. The unique index also
    // serves the only lookups (list all, tariff in force for a day).
    validFrom: date('valid_from', { mode: 'string' }).notNull().unique(),
    retailMarkupOre: doublePrecision('retail_markup_ore').notNull(),
    gridTransferOre: doublePrecision('grid_transfer_ore').notNull(),
    energyTaxOre: doublePrecision('energy_tax_ore').notNull(),
    vatPercent: doublePrecision('vat_percent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // A retailer can sell below spot ("spot minus X öre"), so only the markup
    // may be negative; grid transfer and energy tax never are.
    check(
      'electricity_tariff_ore_check',
      sql`${table.retailMarkupOre} BETWEEN -1000 AND 1000 AND ${table.gridTransferOre} BETWEEN 0 AND 1000 AND ${table.energyTaxOre} BETWEEN 0 AND 1000`,
    ),
    check('electricity_tariff_vat_percent_check', sql`${table.vatPercent} BETWEEN 0 AND 100`),
  ],
).enableRLS()
