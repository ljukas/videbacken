import type { LogFields, Logger } from './types'

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return err
}

function forward(level: 'warn' | 'error', msg: string, fields: LogFields): void {
  if (typeof fetch === 'undefined') return
  try {
    fetch('/api/log', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, msg, fields }),
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
      error: serializeError(event.error),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('unhandledrejection', { reason: serializeError(event.reason) })
  })
}
