import { z } from 'zod'
import { TARIFF_LIMITS } from '~/lib/evCharging/tariff'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as tariffService from '~/lib/services/tariff'
import { TariffDomainError, type TariffDomainErrorCode } from '~/lib/services/tariff'

const tariffErrors = {
  TARIFF_NOT_FOUND: { status: 404 },
  TARIFF_VALID_FROM_TAKEN: { status: 409 },
  TARIFF_INVALID_VALUE: { status: 422 },
  TARIFF_INVALID_DATE: { status: 422 },
} satisfies Record<TariffDomainErrorCode, { status: number }>

const amount = (field: keyof typeof TARIFF_LIMITS) =>
  z.number().min(TARIFF_LIMITS[field].min).max(TARIFF_LIMITS[field].max)

// The shape is validated here; the calendar-day check and the bounds are
// re-checked in the service (the source of the typed domain errors).
const tariffInput = z.object({
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  retailMarkupOre: amount('retailMarkupOre'),
  gridTransferOre: amount('gridTransferOre'),
  energyTaxOre: amount('energyTaxOre'),
  vatPercent: amount('vatPercent'),
})

// Maps a service domain error to its typed oRPC error (code only — the client
// owns the i18n, see `tariffErrorMessage`); anything else propagates.
function mapTariffError(
  err: unknown,
  errors: { [K in TariffDomainErrorCode]: () => Error },
): never {
  if (err instanceof TariffDomainError) throw errors[err.code]()
  throw err
}

export const tariffRouter = {
  // Everyone signed in may see the tariffs the costs are computed from.
  list: protectedProcedure.handler(() => tariffService.list()),

  create: adminProcedure
    .errors(tariffErrors)
    .input(tariffInput)
    .handler(async ({ input, context, errors }) => {
      try {
        const row = await tariffService.create(input)
        context.log.info('admin created tariff period', {
          tariffId: row.id,
          validFrom: row.validFrom,
        })
        return row
      } catch (err) {
        mapTariffError(err, errors)
      }
    }),

  update: adminProcedure
    .errors(tariffErrors)
    .input(tariffInput.extend({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      const { id, ...fields } = input
      try {
        const row = await tariffService.update(id, fields)
        context.log.info('admin updated tariff period', { tariffId: id, validFrom: row.validFrom })
        return row
      } catch (err) {
        mapTariffError(err, errors)
      }
    }),

  remove: adminProcedure
    .errors(tariffErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await tariffService.remove(input.id)
        context.log.info('admin removed tariff period', { tariffId: input.id })
      } catch (err) {
        mapTariffError(err, errors)
      }
    }),
}
