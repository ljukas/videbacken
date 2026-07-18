import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { logger } from '~/lib/logger/server'
import { recordReading, SensorDomainError } from '~/lib/services/sensor'

// Shelly interpolates urlencoded values into GET query params. Numbers are
// optional per-event but range-validated; mac identifies the device. MAC
// *format* validity (12 hex after normalization) is enforced by the service as
// a domain invariant — here we only require it to be present.
const querySchema = z.object({
  mac: z.string().min(1),
  t: z.coerce.number().min(-60).max(100).optional(),
  h: z.coerce.number().min(0).max(100).optional(),
  batt: z.coerce.number().int().min(0).max(100).optional(),
})

export type ParsedShellyReading = {
  mac: string
  temperatureC: number | null
  humidityPct: number | null
  batteryPct: number | null
}

export function parseShellyQuery(
  params: URLSearchParams,
): { ok: true; value: ParsedShellyReading } | { ok: false } {
  const parsed = querySchema.safeParse({
    mac: params.get('mac') ?? undefined,
    t: params.get('t') ?? undefined,
    h: params.get('h') ?? undefined,
    batt: params.get('batt') ?? undefined,
  })
  if (!parsed.success) return { ok: false }
  return {
    ok: true,
    value: {
      mac: parsed.data.mac,
      temperatureC: parsed.data.t ?? null,
      humidityPct: parsed.data.h ?? null,
      batteryPct: parsed.data.batt ?? null,
    },
  }
}

// Constant-time compare so a wrong token can't be probed by timing. Returns
// false when no server secret is configured (fail closed).
export function verifyWebhookToken(provided: string | null, expected: string | undefined): boolean {
  if (!expected || provided == null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// The full receiver: token gate → parse → service → response. Kept out of the
// route file so the whole flow is unit-testable. No `db.` here — the service
// owns all persistence (ADR-0002).
export async function handleShellyWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!verifyWebhookToken(url.searchParams.get('token'), process.env.SHELLY_WEBHOOK_TOKEN)) {
    return new Response(null, { status: 401 })
  }
  const parsed = parseShellyQuery(url.searchParams)
  if (!parsed.ok) return new Response(null, { status: 400 })
  try {
    const { deviceId } = await recordReading(parsed.value)
    logger.info('shelly webhook stored reading', {
      deviceId,
      hasTemp: parsed.value.temperatureC != null,
      hasHum: parsed.value.humidityPct != null,
    })
    return new Response(null, { status: 204 })
  } catch (err) {
    // A malformed MAC is caller error, not a server fault → 400.
    if (err instanceof SensorDomainError && err.code === 'INVALID_MAC') {
      return new Response(null, { status: 400 })
    }
    throw err
  }
}
