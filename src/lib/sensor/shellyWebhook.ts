import { z } from 'zod'
import { logger } from '~/lib/logger/server'
import { secretMatches } from '~/lib/secretMatches'
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
  shellyName: string | null
}

// An empty/whitespace query value means "the placeholder produced nothing" —
// treat it as absent (→ null), NOT as 0. Otherwise `t=` would coerce to a
// phantom 0 °C reading. A real zero still arrives as the string "0".
function numParam(raw: string | null): string | undefined {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The longest Shelly name we keep; a longer one is dropped, not cut. Matches the admin name's bound. */
export const SHELLY_NAME_MAX = 80

// The device's name from the Shelly app (`${config.sys.device.name}`). An
// unnamed device sends `null`, an empty value, or — when Shelly can't evaluate
// the token — the token itself, copied verbatim; all of those, and an
// over-long value, mean "no name". So does any C0 control character or DEL
// (Postgres text rejects NUL; we drop such a name rather than strip it). Never
// a reason to reject the reading.
function nameParam(raw: string | null): string | null {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined' || trimmed.startsWith('${')) {
    return null
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed.length > SHELLY_NAME_MAX ? null : trimmed
}

export function parseShellyQuery(
  params: URLSearchParams,
): { ok: true; value: ParsedShellyReading } | { ok: false } {
  const parsed = querySchema.safeParse({
    mac: params.get('mac') ?? undefined,
    t: numParam(params.get('t')),
    h: numParam(params.get('h')),
    batt: numParam(params.get('batt')),
  })
  if (!parsed.success) return { ok: false }
  return {
    ok: true,
    value: {
      mac: parsed.data.mac,
      temperatureC: parsed.data.t ?? null,
      humidityPct: parsed.data.h ?? null,
      batteryPct: parsed.data.batt ?? null,
      shellyName: nameParam(params.get('name')),
    },
  }
}

// The full receiver: token gate → parse → service → response. Kept out of the
// route file so the whole flow is unit-testable. No `db.` here — the service
// owns all persistence (ADR-0002).
export async function handleShellyWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!secretMatches(url.searchParams.get('token'), process.env.SHELLY_WEBHOOK_TOKEN)) {
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
      hasName: parsed.value.shellyName != null,
    })
    return new Response(null, { status: 204 })
  } catch (err) {
    // A malformed MAC is caller error, not a server fault → 400.
    if (err instanceof SensorDomainError && err.code === 'INVALID_MAC') {
      return new Response(null, { status: 400 })
    }
    // Everything else (e.g. DB unavailable) is a server fault — log it (a Shelly
    // wakes rarely, so a silent ingest failure could go unnoticed for a long
    // time) before letting it surface as a 500.
    logger.error('shelly webhook failed to store reading', { error: err })
    throw err
  }
}
