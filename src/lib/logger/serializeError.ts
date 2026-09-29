// Turns an Error into a plain, JSON-safe object for both logger adapters.
//
// Why this exists: pino only serializes the `err` key, and JSON.stringify drops
// every Error property, so `log.error('…', { error })` used to land in Vercel
// Runtime Logs as `"error": {}` — no message, no stack.
//
// Allow-list only: we copy a fixed set of fields and never an error's arbitrary
// enumerable properties, so an HTTP client error carrying its `request` /
// `response` (headers, bodies, tokens) can't leak into logs. The same holds down
// the `cause` chain: a non-Error cause (e.g. a parsed response body) is reduced
// to its message/code, never copied wholesale.
// Dependency-free: this module is shared with the browser adapter.

export type SerializedError = {
  type: string
  name?: string
  message: string
  stack?: string
  code?: string | number
  status?: number
  defined?: boolean
  data?: unknown
  cause?: unknown
  errors?: unknown[]
}

// Cause chains deeper than this are cut off (a runaway or self-built chain
// shouldn't be able to bloat a log line).
const MAX_DEPTH = 5

/**
 * Serializes an Error (and its `cause` chain); any other top-level value passes
 * through unchanged. Never throws — a log call must not fail (or, inside the
 * rpc `onError` interceptor, mask the real error) because an error is hostile.
 */
export function serializeError(value: unknown): unknown {
  try {
    return serialize(value, 0, new WeakSet())
  } catch {
    return { type: 'Error', message: '[unserializable error]' }
  }
}

function serialize(value: unknown, depth: number, seen: WeakSet<Error>): unknown {
  if (!(value instanceof Error)) return value
  const type = value.constructor?.name || 'Error'
  if (seen.has(value)) return { type, message: '[circular]' }
  if (depth >= MAX_DEPTH) return { type, message: '[max cause depth reached]' }
  seen.add(value)

  const e = value as Error & Record<string, unknown>
  const message = String(value.message)
  // A failed drizzle query (duck-typed: `query` + `params`) has the SQL *and
  // its bound params* as its message — user data, and unbounded in size (a
  // batch insert binds thousands). Keep the SQL; the `cause` is the Postgres
  // error that explains the failure.
  const safeMessage =
    typeof e.query === 'string' && 'params' in e ? `Failed query: ${e.query}` : message

  const out: SerializedError = { type, message: safeMessage }
  if (value.name && value.name !== type) out.name = String(value.name)
  if (typeof value.stack === 'string') {
    // The stack's first line repeats the message.
    out.stack =
      safeMessage === message ? value.stack : value.stack.replace(message, () => safeMessage)
  }

  // DOMException's numeric `code` is a meaningless legacy constant — its `name`
  // (e.g. TimeoutError, AbortError) is the useful part.
  const isDomException = typeof DOMException !== 'undefined' && value instanceof DOMException
  if (!isDomException && (typeof e.code === 'string' || typeof e.code === 'number')) {
    out.code = e.code
  }
  // ORPCError shape (code/status/defined/data) — duck-typed so this module stays
  // import-free and works for client- and server-side oRPC errors alike.
  if (typeof e.status === 'number') out.status = e.status
  if (typeof e.defined === 'boolean') out.defined = e.defined
  // `data` only for *defined* (typed, author-declared) oRPC errors, whose payload
  // is ours. Any other error's `data` is arbitrary and may hold bodies/tokens.
  if (e.defined === true && e.data !== undefined) out.data = e.data

  if (value.cause !== undefined) out.cause = serializeNested(value.cause, depth + 1, seen)
  if (value instanceof AggregateError) {
    out.errors = value.errors.map((inner) => serializeNested(inner, depth + 1, seen))
  }
  return out
}

// Below the top level, non-Error values are untrusted too: primitives are kept,
// objects are reduced to a string `message`/`code` if they have one.
function serializeNested(value: unknown, depth: number, seen: WeakSet<Error>): unknown {
  if (value instanceof Error) return serialize(value, depth, seen)
  if (value === null || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = { type: 'Object' }
  if (typeof obj.message === 'string') out.message = obj.message
  if (typeof obj.code === 'string' || typeof obj.code === 'number') out.code = obj.code
  return out
}
