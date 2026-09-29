// Dependency-free, client-safe. The allowed range of each tariff amount — one
// source for the admin form's validation, the procedure input, the tariff
// service's check-first rule, and (mirrored by hand) the table's CHECK.
// Amounts are öre/kWh ex VAT; only the retail markup may be negative (a
// retailer selling below spot).
export const TARIFF_LIMITS = {
  retailMarkupOre: { min: -1000, max: 1000 },
  gridTransferOre: { min: 0, max: 1000 },
  energyTaxOre: { min: 0, max: 1000 },
  vatPercent: { min: 0, max: 100 },
} as const

export type TariffAmountField = keyof typeof TARIFF_LIMITS
