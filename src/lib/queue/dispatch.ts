import type { QueuePayloadMap, QueueTopic } from '~/lib/effects/queue/queue'
import type { LogFields, Logger } from '~/lib/logger'

/**
 * The one place a queue message is turned into a handler call — shared by the
 * production consumer (`server/plugins/queueConsumer.ts`) and the local BullMQ
 * worker (`scripts/devQueueWorker.ts`), so both runtimes retry, drop and log
 * identically. See ADR-0007 "Handler contract".
 *
 * Handler contract:
 *   - return normally          → `ok` (ack). Expected no-ops (file gone) are ok.
 *   - throw PermanentQueueError → `dropped` (ack, logged at error) — retrying can't help.
 *   - throw anything else       → `retry` (rethrown so the runtime redelivers), until
 *     `deliveryCount >= maxDeliveries`, then `dropped` / `exhausted` (ack). Vercel
 *     Queues has no max-delivery count of its own: without this cap a
 *     permanently failing message retries silently until it expires (24 h).
 *   - unknown topic             → `dropped` / `unknown_topic` (ack) — retrying can't help.
 *
 * Every message produces exactly one `queue message` log line with its outcome
 * and duration. Payloads are never logged (they carry email addresses);
 * handlers expose identifiers through `logFields`.
 */

export type QueueMessageMeta = { messageId: string; deliveryCount: number }

export type QueueHandlerContext = {
  meta: QueueMessageMeta
  /** Child logger already scoped to topic, messageId, deliveryCount and `logFields`. */
  log: Logger
}

export type QueueHandler<T extends QueueTopic> = {
  handle(msg: QueuePayloadMap[T], ctx: QueueHandlerContext): Promise<void>
  /** Identifiers to put on every log line for this message (never the payload itself). */
  logFields?(msg: QueuePayloadMap[T]): LogFields
}

/** One handler per topic — a topic without a handler is a compile error. */
export type QueueHandlerTable = { [T in QueueTopic]: QueueHandler<T> }

/** Throw from a handler when a retry can't succeed; the message is acked and dropped. */
export class PermanentQueueError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PermanentQueueError'
  }
}

export type QueueDispatcher = (
  topic: string,
  message: unknown,
  meta: QueueMessageMeta,
) => Promise<void>

export function createQueueDispatcher(
  table: QueueHandlerTable,
  opts: { log: Logger; maxDeliveries: number; now?: () => number },
): QueueDispatcher {
  const now = opts.now ?? (() => performance.now())

  return async function dispatch(topic, message, meta) {
    const scoped = opts.log.child({
      topic,
      messageId: meta.messageId,
      deliveryCount: meta.deliveryCount,
    })

    if (!Object.hasOwn(table, topic)) {
      scoped.error('queue message', { outcome: 'dropped', reason: 'unknown_topic', durationMs: 0 })
      return
    }
    // The table is keyed by the full topic union, so a looked-up handler takes
    // "some topic's payload" — the runtime topic name guarantees they match.
    const handler = table[topic as QueueTopic] as unknown as QueueHandler<QueueTopic>
    const payload = message as QueuePayloadMap[QueueTopic]
    const log = scoped.child(safeLogFields(handler, payload))

    const startedAt = now()
    const elapsed = () => Math.round(now() - startedAt)
    try {
      await handler.handle(payload, { meta, log })
      log.info('queue message', { outcome: 'ok', durationMs: elapsed() })
    } catch (error) {
      const durationMs = elapsed()
      if (error instanceof PermanentQueueError) {
        log.error('queue message', {
          outcome: 'dropped',
          reason: 'permanent',
          code: error.code,
          durationMs,
          error,
        })
        return
      }
      if (meta.deliveryCount >= opts.maxDeliveries) {
        log.error('queue message', { outcome: 'dropped', reason: 'exhausted', durationMs, error })
        return
      }
      log.warn('queue message', { outcome: 'retry', durationMs, error })
      throw error
    }
  }
}

// A malformed payload must not make the dispatcher itself throw before the
// handler runs (that would retry forever without an outcome line).
function safeLogFields(handler: QueueHandler<QueueTopic>, payload: unknown): LogFields {
  try {
    return handler.logFields?.(payload as QueuePayloadMap[QueueTopic]) ?? {}
  } catch {
    return {}
  }
}
