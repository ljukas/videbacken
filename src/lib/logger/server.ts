import { type DestinationStream, pino } from 'pino'
import { serverRedactPaths } from './redact'
import type { LogFields, Logger } from './types'

const NODE_ENV = process.env.NODE_ENV ?? 'development'
const isDev = NODE_ENV === 'development'
const defaultLevel = isDev ? 'debug' : 'info'

type PinoOptions = Parameters<typeof pino>[0]

function buildOptions(): PinoOptions {
  const base: PinoOptions = {
    level: process.env.LOG_LEVEL ?? defaultLevel,
    base: { service: 'oceanview', env: NODE_ENV },
    redact: { paths: serverRedactPaths, censor: '<redacted>' },
  }
  if (isDev) {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', singleLine: false },
      },
    }
  }
  return base
}

function wrap(p: ReturnType<typeof pino>): Logger {
  return {
    debug: (msg, fields) => p.debug(fields ?? {}, msg),
    info: (msg, fields) => p.info(fields ?? {}, msg),
    warn: (msg, fields) => p.warn(fields ?? {}, msg),
    error: (msg, fields) => p.error(fields ?? {}, msg),
    child: (fields) => wrap(p.child(fields)),
  }
}

export function createServerLogger(destination?: DestinationStream): Logger {
  const options = buildOptions()
  // pino-pretty transport spawns a worker and ignores any custom destination,
  // so when a destination is supplied we drop the transport.
  const instance = destination
    ? pino({ ...options, transport: undefined }, destination)
    : pino(options)
  return wrap(instance)
}

export const logger: Logger = createServerLogger()

export function createRequestLogger(request: Request): { log: Logger; requestId: string } {
  const requestId = request.headers.get('x-vercel-id') ?? crypto.randomUUID()
  let path = ''
  try {
    path = new URL(request.url).pathname
  } catch {
    path = request.url
  }
  const fields: LogFields = { requestId, path }
  return { log: logger.child(fields), requestId }
}
