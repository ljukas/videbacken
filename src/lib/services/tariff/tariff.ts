import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '~/lib/db'
import { isUniqueViolation } from '~/lib/db/pgError'
import { electricityTariff } from '~/lib/db/schema'
import { TARIFF_LIMITS, type TariffAmountField } from '~/lib/evCharging/tariff'
import { bumpAll } from '~/lib/services/sessionCost/invalidate'
import { isStockholmDay } from '~/lib/time/stockholm'
import { TariffDomainError } from './errors'

export type TariffRow = typeof electricityTariff.$inferSelect

/** A tariff period's editable fields; amounts in öre/kWh ex VAT. */
export type TariffInput = {
  validFrom: string
  retailMarkupOre: number
  gridTransferOre: number
  energyTaxOre: number
  vatPercent: number
}

const VALID_FROM_UNIQUE = 'electricity_tariff_valid_from_unique'

// The same bounds as the table's CHECKs (shared with the admin form via
// `TARIFF_LIMITS`), checked first so a bad value is a domain error rather
// than a constraint violation.
function validate(input: TariffInput): void {
  if (!isStockholmDay(input.validFrom)) throw new TariffDomainError('TARIFF_INVALID_DATE')
  for (const field of Object.keys(TARIFF_LIMITS) as TariffAmountField[]) {
    const v = input[field]
    const { min, max } = TARIFF_LIMITS[field]
    if (!(Number.isFinite(v) && v >= min && v <= max)) {
      throw new TariffDomainError('TARIFF_INVALID_VALUE')
    }
  }
}

// Only the editable columns, whatever else a caller's object carries.
function columns(input: TariffInput): TariffInput {
  const { validFrom, retailMarkupOre, gridTransferOre, energyTaxOre, vatPercent } = input
  return { validFrom, retailMarkupOre, gridTransferOre, energyTaxOre, vatPercent }
}

async function exists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: electricityTariff.id })
    .from(electricityTariff)
    .where(eq(electricityTariff.id, id))
    .limit(1)
  return row !== undefined
}

async function validFromTaken(validFrom: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: electricityTariff.id })
    .from(electricityTariff)
    .where(
      exceptId
        ? and(eq(electricityTariff.validFrom, validFrom), ne(electricityTariff.id, exceptId))
        : eq(electricityTariff.validFrom, validFrom),
    )
    .limit(1)
  return row !== undefined
}

// A concurrent write can still win the check-first race; the unique index is
// the backstop, mapped to the same domain error.
async function mapValidFromRace<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isUniqueViolation(error, VALID_FROM_UNIQUE)) {
      throw new TariffDomainError('TARIFF_VALID_FROM_TAKEN')
    }
    throw error
  }
}

/** All tariff periods, oldest first (the order the cost math needs). */
export async function list(): Promise<TariffRow[]> {
  return db.select().from(electricityTariff).orderBy(asc(electricityTariff.validFrom))
}

export async function create(input: TariffInput): Promise<TariffRow> {
  validate(input)
  if (await validFromTaken(input.validFrom)) {
    throw new TariffDomainError('TARIFF_VALID_FROM_TAKEN')
  }
  // A tariff period reaches every day from its validFrom on: every stored cost goes stale.
  return mapValidFromRace(() =>
    db.transaction(async (tx) => {
      const [row] = await tx.insert(electricityTariff).values(columns(input)).returning()
      await bumpAll(tx)
      return row
    }),
  )
}

export async function update(id: string, input: TariffInput): Promise<TariffRow> {
  validate(input)
  if (!(await exists(id))) throw new TariffDomainError('TARIFF_NOT_FOUND')
  if (await validFromTaken(input.validFrom, id)) {
    throw new TariffDomainError('TARIFF_VALID_FROM_TAKEN')
  }
  // A tariff period reaches every day from its validFrom on: every stored cost goes stale.
  const row = await mapValidFromRace(() =>
    db.transaction(async (tx) => {
      const [updated] = await tx
        .update(electricityTariff)
        .set(columns(input))
        .where(eq(electricityTariff.id, id))
        .returning()
      if (updated) await bumpAll(tx)
      return updated
    }),
  )
  // Deleted between the existence check and the write.
  if (!row) throw new TariffDomainError('TARIFF_NOT_FOUND')
  return row
}

/**
 * Deleting the last period is allowed: cost then honestly shows as unknown
 * for the days it covered.
 */
export async function remove(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(electricityTariff)
      .where(eq(electricityTariff.id, id))
      .returning({ id: electricityTariff.id })
    if (deleted.length === 0) throw new TariffDomainError('TARIFF_NOT_FOUND')
    // A tariff period reaches every day from its validFrom on: every stored cost goes stale.
    await bumpAll(tx)
  })
}
