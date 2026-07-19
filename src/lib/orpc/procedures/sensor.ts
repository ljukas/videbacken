import { z } from 'zod'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as sensorService from '~/lib/services/sensor'
import { SERIES_RANGES, SensorDomainError, type SensorDomainErrorCode } from '~/lib/services/sensor'

// Only DEVICE_NOT_FOUND is reachable from these procedures — INVALID_MAC is a
// webhook-ingest concern (never thrown by rename/delete), so it is deliberately
// not part of the client-facing typed-error surface. `Partial` keeps that honest
// while `satisfies` still locks the key to the domain union.
const sensorErrors = {
  DEVICE_NOT_FOUND: { status: 404 },
} satisfies Partial<Record<SensorDomainErrorCode, { status: number }>>

const rangeSchema = z.enum(SERIES_RANGES)

export const sensorRouter = {
  // Reads — any signed-in (approved) user; the app is read-only for non-admins.
  listDevices: protectedProcedure.handler(() => sensorService.listDevices()),

  series: protectedProcedure
    .input(z.object({ range: rangeSchema, deviceIds: z.array(z.uuid()).optional() }))
    .handler(({ input }) => sensorService.getSeries(input)),

  renameDevice: adminProcedure
    .errors(sensorErrors)
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(80).nullable(),
        location: z.string().trim().max(120).nullable(),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      try {
        await sensorService.renameDevice(input.id, { name: input.name, location: input.location })
        context.log.info('admin renamed sensor device', { deviceId: input.id })
      } catch (err) {
        if (err instanceof SensorDomainError && err.code === 'DEVICE_NOT_FOUND') {
          throw errors.DEVICE_NOT_FOUND()
        }
        throw err
      }
    }),

  deleteDevice: adminProcedure
    .errors(sensorErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await sensorService.deleteDevice(input.id)
        context.log.info('admin deleted sensor device', { deviceId: input.id })
      } catch (err) {
        if (err instanceof SensorDomainError && err.code === 'DEVICE_NOT_FOUND') {
          throw errors.DEVICE_NOT_FOUND()
        }
        throw err
      }
    }),
}
