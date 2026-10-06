import { z } from 'zod'
import { GeocoderError, geocoder, newGeocoderStats } from '~/lib/effects/geocoder'
import { CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { adminProcedure } from '~/lib/orpc/context'
import * as credentialService from '~/lib/services/integrationCredential'
import {
  IntegrationCredentialDomainError,
  type IntegrationCredentialDomainErrorCode,
} from '~/lib/services/integrationCredential'

// Field names only, never values (ADR-0026). `data` is sent to the client.
const fieldNames = z.object({ fields: z.array(z.string()) })

const credentialErrors = {
  INVALID_FIELD: { status: 422, data: fieldNames },
  REENTER_ALL_FIELDS: { status: 422, data: fieldNames },
  NOTHING_TO_SAVE: { status: 422 },
  ENCRYPTION_KEY_MISSING: { status: 409 },
  // homePosition only: the stored Škoda row can't be read (never falls back to env).
  UNREADABLE: { status: 409 },
} satisfies Record<IntegrationCredentialDomainErrorCode, { status: number; data?: unknown }>

// Bounds the payload only; the service enforces the real limits (512 chars, per-field
// formats) and names each failing field in INVALID_FIELD.
const value = z.string().max(4096).optional()

// An unknown key is not echoed: Zod's default unrecognized_keys message names the keys, and
// that message reaches the warn log. Returning undefined keeps the default for other issues.
const fieldsOf = <T extends z.core.$ZodShape>(shape: T) =>
  z.strictObject(shape, {
    error: (issue) => (issue.code === 'unrecognized_keys' ? 'Unknown credential field' : undefined),
  })

// One branch per source, each with exactly that source's fields (CREDENTIAL_FIELDS;
// a test pins the match): a field of another source is a BAD_REQUEST.
export const setCredentialsInput = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('zaptec'),
    fields: fieldsOf({ username: value, password: value }),
  }),
  z.object({
    source: z.literal('skoda'),
    fields: fieldsOf({ apiKey: value, vin: value, homeCoordinates: value }),
  }),
  z.object({
    source: z.literal('emaldo'),
    fields: fieldsOf({ user: value, password: value, appId: value, appSecret: value }),
  }),
  z.object({ source: z.literal('gridTariff'), fields: fieldsOf({ facilityId: value }) }),
])

export const credentialsRouter = {
  // A read, but admin-only: where each credential comes from is admin detail. Never values.
  status: adminProcedure.handler(() => credentialService.status()),

  set: adminProcedure
    .errors(credentialErrors)
    .input(setCredentialsInput)
    .handler(async ({ input, context, errors }) => {
      // The names the admin filled in, for the log line — never the values.
      const fields = Object.entries(input.fields)
        .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
        .map(([name]) => name)
      const started = performance.now()
      try {
        const result = await credentialService.set(input.source, input.fields, context.user.id)
        context.log.info('admin set integration credentials', { source: input.source, fields })
        return result
      } catch (err) {
        if (err instanceof IntegrationCredentialDomainError) {
          if (err.code === 'INVALID_FIELD' || err.code === 'REENTER_ALL_FIELDS') {
            throw errors[err.code]({ data: { fields: [...err.fields] } })
          }
          throw errors[err.code]()
        }
        throw err
      } finally {
        if (context.timings)
          context.timings.credentialsSetMs = Math.round(performance.now() - started)
      }
    }),

  clear: adminProcedure
    .input(z.object({ source: z.enum(CREDENTIAL_SOURCES) }))
    .handler(async ({ input, context }) => {
      const cleared = await credentialService.clear(input.source)
      context.log.info('admin cleared integration credentials', { source: input.source, cleared })
      return { cleared }
    }),

  // The one credential value an admin can read back (ADR-0026, 2026-10-06 amendment):
  // fetched only while the picker is open, never in a loader. Never logged.
  homePosition: adminProcedure
    .errors({ UNREADABLE: credentialErrors.UNREADABLE })
    .handler(async ({ context, errors }) => {
      const started = performance.now()
      try {
        return await credentialService.homePosition()
      } catch (err) {
        if (err instanceof IntegrationCredentialDomainError && err.code === 'UNREADABLE') {
          throw errors.UNREADABLE()
        }
        throw err
      } finally {
        if (context.timings)
          context.timings.homePositionMs = Math.round(performance.now() - started)
      }
    }),

  // Address search for the picker, proxied so the admin's IP and browser stay
  // private (the text itself still reaches OpenStreetMap). Neither the query nor
  // a result is logged: only the hit count, the cache flag and timings.
  searchAddress: adminProcedure
    .errors({ GEOCODER_UNAVAILABLE: { status: 503 } })
    .input(z.object({ query: z.string().trim().min(2).max(200) }))
    .handler(async ({ input, context, errors }) => {
      const stats = newGeocoderStats()
      const started = performance.now()
      try {
        const hits = await geocoder.search(input.query, {
          stats,
          signal: AbortSignal.timeout(8_000),
        })
        context.log.debug('credentials: address search', {
          hits: hits.length,
          cached: stats.cached,
        })
        return hits
      } catch (err) {
        if (err instanceof GeocoderError) {
          context.log.warn('credentials: address search unavailable', { code: err.code })
          throw errors.GEOCODER_UNAVAILABLE()
        }
        throw err
      } finally {
        if (context.timings) {
          context.timings.addressSearchMs = Math.round(performance.now() - started)
          context.timings.addressSearchRequests = stats.requests
          context.timings.addressSearchCached = stats.cached ? 1 : 0
        }
      }
    }),
}
