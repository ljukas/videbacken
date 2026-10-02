import { z } from 'zod'
import { issuePath, summarizeIssuePaths } from '~/lib/issuePaths'
import { SkodaError } from './errors'
import type { SkodaPart, SkodaVehicleState } from './skoda'

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s))
// Enums are plain strings: the API says new values may appear at any time. A NUL
// is rejected: Postgres `text` cannot store it, so it must invalidate the part
// here rather than fail the whole snapshot insert later.
const label = z
  .string()
  .max(64)
  .refine((s) => !s.includes('\u0000'))
const SAFE_TYPE = /^[A-Z_]{1,64}$/
const MAX_MISSING_PARTS = 20

/** Known-safe `errors[].type` values: deduped, capped, anything else dropped. */
function missingPartsOf(errors: unknown): string[] {
  if (!Array.isArray(errors)) return []
  const types = errors.flatMap((e: unknown) => {
    const t = typeof e === 'object' && e !== null ? (e as { type?: unknown }).type : undefined
    return typeof t === 'string' && SAFE_TYPE.test(t) ? [t] : []
  })
  return [...new Set(types)].slice(0, MAX_MISSING_PARTS)
}

// The envelope must match; each part is parsed on its own so drift in one part
// (a new shape, a null) drops that part — the poll still counts (ADR-0022).
const envelopeSchema = z.object({
  vehicle: z.object({
    charging: z.unknown().optional(),
    odometer: z.unknown().optional(),
    parkingPosition: z.unknown().optional(),
  }),
  // Tolerant: a malformed errors list must not fail the poll (entries are filtered below).
  errors: z.unknown().optional(),
})

const chargingSchema = z.object({
  carCapturedTimestamp: instant.nullish(),
  status: z
    .object({
      state: label.nullish(),
      chargeType: label.nullish(),
      chargePowerInKw: z.number().min(0).nullish(),
      plugConnectionState: label.nullish(),
      battery: z.object({ stateOfChargeInPercent: z.number().min(0).max(100).nullish() }).nullish(),
    })
    .nullish(),
})
const odometerSchema = z.object({
  // Bounded well inside the `integer` column: an overflow would fail every insert.
  mileageInKm: z.number().min(0).max(2_000_000).nullish(),
  carCapturedTimestamp: instant.nullish(),
})
const parkingSchema = z.object({
  state: label.nullish(),
  gpsCoordinates: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .nullish(),
})

export function parseVehicleState(body: unknown): SkodaVehicleState {
  const envelope = envelopeSchema.safeParse(body)
  if (!envelope.success) {
    const at = summarizeIssuePaths(envelope.error.issues.map((i) => issuePath(i.path)))
    throw new SkodaError('unexpected_response', 'vehicle', undefined, {
      message: `Škoda vehicle response has an unexpected shape at: ${at}`,
    })
  }
  const invalidParts: SkodaPart[] = []
  function part<T>(name: SkodaPart, schema: z.ZodType<T>, value: unknown): T | null {
    if (value === undefined || value === null) return null
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    invalidParts.push(name)
    return null
  }
  const { vehicle, errors } = envelope.data
  const charging = part('charging', chargingSchema, vehicle.charging)
  const odometer = part('odometer', odometerSchema, vehicle.odometer)
  const parking = part('parkingPosition', parkingSchema, vehicle.parkingPosition)
  const status = charging?.status
  const soc = status?.battery?.stateOfChargeInPercent
  const km = odometer?.mileageInKm
  return {
    chargingCapturedAt: charging?.carCapturedTimestamp ?? null,
    chargingState: status?.state ?? null,
    chargeType: status?.chargeType ?? null,
    plugState: status?.plugConnectionState ?? null,
    chargePowerKw: status?.chargePowerInKw ?? null,
    socPercent: soc == null ? null : Math.round(soc),
    odometerKm: km == null ? null : Math.round(km),
    odometerCapturedAt: odometer?.carCapturedTimestamp ?? null,
    parking: parking
      ? { state: parking.state ?? null, position: parking.gpsCoordinates ?? null }
      : null,
    missingParts: missingPartsOf(errors),
    invalidParts,
  }
}

/** `X-API-Key-Expires-At` (RFC 3339) → a date; absent or unparseable → null. */
export function parseKeyExpiry(header: string | null): Date | null {
  if (header === null) return null
  const parsed = z.iso.datetime({ offset: true }).safeParse(header)
  return parsed.success ? new Date(parsed.data) : null
}
