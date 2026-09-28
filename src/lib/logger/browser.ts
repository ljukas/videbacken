import { serializeError } from './serializeError'
import type { LogFields, Logger } from './types'

// JSON.stringify turns an Error into `{}`, so serialize the error keys (same
// contract as the server adapter) before the fields leave the browser.
function toWireFields(fields: LogFields): LogFields {
  const out: LogFields = { ...fields }
  if ('error' in out) out.error = serializeError(out.error)
  if ('err' in out) out.err = serializeError(out.err)
  return out
}

function forward(level: 'warn' | 'error', msg: string, fields: LogFields): void {
  if (typeof fetch === 'undefined') return
  try {
    fetch('/api/log', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, msg, fields: toWireFields(fields) }),
    }).catch(() => {})
  } catch {
    // Never let the logger throw.
  }
}

function makeLogger(scope: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => ({ ...scope, ...(fields ?? {}) })
  return {
    debug(msg, fields) {
      // biome-ignore lint/suspicious/noConsole: browser logger is the sanctioned console wrapper
      console.debug(msg, merge(fields))
    },
    info(msg, fields) {
      // biome-ignore lint/suspicious/noConsole: browser logger is the sanctioned console wrapper
      console.info(msg, merge(fields))
    },
    warn(msg, fields) {
      const merged = merge(fields)
      console.warn(msg, merged)
      forward('warn', msg, merged)
    },
    error(msg, fields) {
      const merged = merge(fields)
      console.error(msg, merged)
      forward('error', msg, merged)
    },
    child(fields) {
      return makeLogger({ ...scope, ...fields })
    },
  }
}

export const logger: Logger = makeLogger({})

let handlersInstalled = false

export function installGlobalHandlers(): void {
  if (handlersInstalled || typeof window === 'undefined') return
  handlersInstalled = true
  window.addEventListener('error', (event) => {
    logger.error('window.error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('unhandledrejection', { reason: serializeError(event.reason) })
  })
}
