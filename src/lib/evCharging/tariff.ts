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

/**
 * Swedish energy tax on electricity (normal rate), öre/kWh ex VAT, by calendar
 * year — set by law and changed on 1 January, so it pre-fills a new tariff
 * period instead of being copied from a bill. Still editable: households in
 * some northern municipalities get a 9,6 öre deduction, and a law can change
 * mid-year. Sources: Skatteverket "Sänkt skatt på el 1 januari 2026";
 * Energimarknadsbyrån "Energiskatt – skattesatser". Add each new year's rate
 * when it's decided (usually in the autumn budget).
 */
export const ENERGY_TAX_ORE_BY_YEAR: Readonly<Record<number, number>> = {
  2024: 42.8,
  2025: 43.9,
  2026: 36.0,
}

/** The statutory energy tax for the year of Stockholm `day`, if known. */
export function statutoryEnergyTaxOre(day: string): number | undefined {
  return ENERGY_TAX_ORE_BY_YEAR[Number(day.slice(0, 4))]
}

/** The Swedish standard VAT rate, the default for a new period. */
export const DEFAULT_VAT_PERCENT = 25
