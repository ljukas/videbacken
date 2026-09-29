import { z } from 'zod'
import type {
  ChargeInterval,
  LiveMode,
  ZaptecCharger,
  ZaptecLiveState,
  ZaptecSession,
} from '~/lib/evCharging/types'
import { ZaptecError, type ZaptecOp } from './errors'

// Zod schemas for the Zaptec payloads we read, plus their mapping to the
// domain types in `~/lib/evCharging/types`. A schema failure becomes
// `unexpected_response` whose message lists field paths only — payloads carry
// owner email/name and session signatures, so no value may leak into it.

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

/**
 * ISO-8601 instant. Zaptec timestamps are UTC; one without an explicit offset
 * is read as UTC rather than the server's local time.
 */
const instant = z.string().transform((s, ctx) => {
  const d = new Date(HAS_OFFSET.test(s) ? s : `${s}Z`)
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'invalid timestamp' })
    return z.NEVER
  }
  return d
})

const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null)

// --- token -------------------------------------------------------------------

export const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
})

/** Only the OAuth `error` code of a token error body is ever read. */
export const tokenErrorSchema = z.object({ error: z.string() })

// --- chargers ----------------------------------------------------------------

const chargersSchema = z.object({
  // Absent → one page. More than one page is never read (we don't page
  // /api/chargers), so it fails loudly rather than silently dropping chargers.
  Pages: z.number().int().nonnegative().optional(),
  Data: z.array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      InstallationId: z.string(),
      IsOnline: z.boolean(),
    }),
  ),
})

export function parseChargers(body: unknown): ZaptecCharger[] {
  const parsed = parse('chargers', chargersSchema, body)
  if (parsed.Pages !== undefined && parsed.Pages > 1) {
    throw new ZaptecError('unexpected_response', 'chargers', undefined, {
      message: `Zaptec chargers response spans ${parsed.Pages} pages; only one is supported`,
    })
  }
  return parsed.Data.map((c) => ({
    id: c.Id,
    name: c.Name,
    installationId: c.InstallationId,
    isOnline: c.IsOnline,
  }))
}

// --- sessions ----------------------------------------------------------------

const energyPointSchema = z.object({ timestamp: instant, energy: z.number() })

const sessionSchema = z.object({
  id: z.string(),
  chargerId: z.string(),
  startDateTime: instant,
  endDateTime: instant,
  energy: z.number(),
  energyDetails: z
    .array(energyPointSchema)
    .nullish()
    .transform((v) => v ?? []),
  authorizedUser: z.object({ email: nullableString, fullName: nullableString }).nullish(),
  tokenName: nullableString,
  voided: z.boolean(),
  replacedBySessionId: nullableString,
  offline: z.boolean(),
  reliableClock: z.boolean(),
})

// A page with at least this many sessions, all rejected, is a shape change.
const SHAPE_CHANGE_MIN_SESSIONS = 3

const sessionsPageSchema = z.object({
  sessions: z.array(z.unknown()),
  cursor: nullableString,
  hasMore: z.boolean(),
})

export type SessionsPage = {
  sessions: ZaptecSession[]
  /** Sessions dropped because they didn't match the schema. */
  rejected: number
  cursor: string | null
  hasMore: boolean
}

export function parseSessionsPage(body: unknown): SessionsPage {
  const page = parse('sessions', sessionsPageSchema, body)
  const sessions: ZaptecSession[] = []
  const rejectedPaths: string[] = []
  for (const [index, raw] of page.sessions.entries()) {
    const result = sessionSchema.safeParse(raw)
    if (result.success) {
      sessions.push(toSession(result.data))
    } else {
      for (const issue of result.error.issues) {
        rejectedPaths.push(['sessions', index, ...issue.path].join('.'))
      }
    }
  }
  // Sessions are validated one by one: an odd session (a null `energy`, a
  // missing flag) is dropped and counted instead of failing the page — and
  // with it every later run, since the watermark only moves past a page once
  // it imports. But several sessions all rejected is a shape change: fail
  // loudly rather than report a healthy run that imported nothing. (A page of
  // one or two bad sessions, a quiet week, is still just skipped.)
  if (page.sessions.length >= SHAPE_CHANGE_MIN_SESSIONS && sessions.length === 0) {
    throw shapeError('sessions', rejectedPaths)
  }
  return {
    sessions,
    rejected: page.sessions.length - sessions.length,
    cursor: page.cursor,
    hasMore: page.hasMore,
  }
}

function toSession(s: z.output<typeof sessionSchema>): ZaptecSession {
  return {
    id: s.id,
    chargerId: s.chargerId,
    // Session-level energy / start / end are passed through as-is (not
    // reconciled with the intervals). The charging service's import skips a
    // session with negative energy, end before start, or an invalid interval.
    startAt: s.startDateTime,
    endAt: s.endDateTime,
    energyKwh: s.energy,
    intervals: toIntervals(s.energyDetails),
    authorizedUser: s.authorizedUser
      ? { email: s.authorizedUser.email, name: s.authorizedUser.fullName }
      : null,
    tokenName: s.tokenName,
    voided: s.voided,
    replacedBySessionId: s.replacedBySessionId,
    offline: s.offline,
    reliableClock: s.reliableClock,
  }
}

/**
 * `energyDetails` → `[start, end)` intervals. Each point's `energy` is the kWh
 * delivered in the interval *ending* at that point (the first point is a 0-kWh
 * start marker), so interval i = [p[i], p[i+1]) with energy p[i+1].energy.
 *
 * Points are sorted; a repeated timestamp keeps its first point; negative float
 * noise is clamped to 0. The output satisfies the `ev_charge_interval` CHECKs:
 * `end_at > start_at`, `energy_kwh >= 0`, unique `start_at` per session.
 */
export function toIntervals(points: { timestamp: Date; energy: number }[]): ChargeInterval[] {
  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  const distinct = sorted.filter(
    (p, i) => i === 0 || p.timestamp.getTime() !== sorted[i - 1].timestamp.getTime(),
  )
  const intervals: ChargeInterval[] = []
  for (let i = 0; i + 1 < distinct.length; i++) {
    intervals.push({
      startAt: distinct[i].timestamp,
      endAt: distinct[i + 1].timestamp,
      energyKwh: Math.max(0, distinct[i + 1].energy),
    })
  }
  return intervals
}

// --- live state --------------------------------------------------------------

const STATE_MODE = 710
const STATE_POWER_KW = 513
const STATE_SESSION_KWH = 553

const MODES: Record<string, LiveMode> = {
  '1': 'disconnected',
  '2': 'connected_requesting',
  '3': 'charging',
  '5': 'connected_finished',
}

const stateSchema = z.array(z.object({ StateId: z.number(), ValueAsString: nullableString }))

export function parseLiveState(body: unknown, observedAt: Date): ZaptecLiveState {
  const values = new Map<number, string | null>()
  for (const s of parse('state', stateSchema, body)) values.set(s.StateId, s.ValueAsString)
  const mode = values.get(STATE_MODE)
  return {
    mode: (mode != null && MODES[mode.trim()]) || 'unknown',
    powerKw: toNumber(values.get(STATE_POWER_KW)),
    sessionKwh: toNumber(values.get(STATE_SESSION_KWH)),
    observedAt,
  }
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// --- shared ------------------------------------------------------------------

export function parse<S extends z.ZodType>(op: ZaptecOp, schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body)
  if (result.success) return result.data
  throw shapeError(
    op,
    result.error.issues.map((i) => i.path.join('.') || '(root)'),
  )
}

// Lists field paths only — never a value.
function shapeError(op: ZaptecOp, issuePaths: string[]): ZaptecError {
  const paths = [...new Set(issuePaths)]
  const shown = paths.slice(0, 10).join(', ')
  const more = paths.length > 10 ? ` (+${paths.length - 10} more)` : ''
  return new ZaptecError('unexpected_response', op, undefined, {
    message: `Zaptec ${op} response has an unexpected shape at: ${shown}${more}`,
  })
}
