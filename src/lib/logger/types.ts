export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structured fields for a log line. Put a caught error at the top-level `error`
 * key (`err` also works): both adapters serialize it to
 * `{ type, message, stack, code, cause, … }`. An Error nested deeper
 * (`{ ctx: { error } }`) is NOT serialized and would log as `{}`.
 */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}
