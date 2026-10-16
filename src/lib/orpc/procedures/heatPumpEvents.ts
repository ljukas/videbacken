import { z } from 'zod'
import { HEAT_PUMP_EVENT_KINDS } from '~/lib/heatPump/events'
import { adminProcedure, protectedProcedure } from '~/lib/orpc/context'
import * as heatPumpService from '~/lib/services/heatPump'
import { HeatPumpDomainError, type HeatPumpEventErrorCode } from '~/lib/services/heatPump'
import { isStockholmDay } from '~/lib/time/stockholm'

const heatPumpEventErrors = {
  UNKNOWN_HEAT_PUMP: { status: 422 },
  FUTURE_DATE: { status: 422 },
  EVENT_NOT_FOUND: { status: 404 },
  NOTE_TOO_LONG: { status: 422 },
} satisfies Record<HeatPumpEventErrorCode, { status: number }>

const isEventCode = (code: string): code is HeatPumpEventErrorCode => code in heatPumpEventErrors

// An abuse guard only: Zod counts UTF-16 units, so the exact 500-character rule (code points,
// trimmed) is the service's, which answers with the typed NOTE_TOO_LONG.
const NOTE_INPUT_MAX = 2000

// The shape is validated here (a real calendar day, a uuid, a known kind); the future-date and
// note rules are the service's, the source of the typed domain errors.
const eventInput = z.object({
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isStockholmDay),
  heatPumpId: z.uuid().nullable(),
  kind: z.enum(HEAT_PUMP_EVENT_KINDS),
  // Postgres text can't hold a NUL: refused here as a bad request, not a failed insert (a 500).
  note: z
    .string()
    .max(NOTE_INPUT_MAX)
    .refine((s) => !s.includes('\u0000'))
    .nullable(),
})

// Maps an event domain error to its typed oRPC error (code only; the client owns the copy, see
// heatPumpEventErrorMessage). Anything else, `INVALID_READING` included, propagates (a 500).
function mapEventError(
  err: unknown,
  errors: { [K in HeatPumpEventErrorCode]: () => Error },
): never {
  if (err instanceof HeatPumpDomainError && isEventCode(err.code)) throw errors[err.code]()
  throw err
}

export const heatPumpEventsRouter = {
  // Everyone signed in sees the log (ADR-0027 decision 10). One small query: no sub-timings.
  list: protectedProcedure.handler(() => heatPumpService.listEvents()),

  create: adminProcedure
    .errors(heatPumpEventErrors)
    .input(eventInput)
    .handler(async ({ input, context, errors }) => {
      try {
        const event = await heatPumpService.createEvent(input, context.user.id)
        // Never the note: free text.
        context.log.info('admin created heat pump event', {
          eventId: event.id,
          occurredOn: event.occurredOn,
          kind: event.kind,
        })
        return event
      } catch (err) {
        mapEventError(err, errors)
      }
    }),

  update: adminProcedure
    .errors(heatPumpEventErrors)
    .input(eventInput.extend({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      const { id, ...fields } = input
      try {
        const event = await heatPumpService.updateEvent(id, fields)
        context.log.info('admin updated heat pump event', {
          eventId: id,
          occurredOn: event.occurredOn,
          kind: event.kind,
        })
        return event
      } catch (err) {
        mapEventError(err, errors)
      }
    }),

  delete: adminProcedure
    .errors(heatPumpEventErrors)
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context, errors }) => {
      try {
        await heatPumpService.deleteEvent(input.id)
        context.log.info('admin deleted heat pump event', { eventId: input.id })
      } catch (err) {
        mapEventError(err, errors)
      }
    }),
}
