import { describe, expect, test, vi } from 'vitest'
import { createServerLogger } from '~/lib/logger/server'
import { createQueueDispatcher, PermanentQueueError, type QueueHandlerTable } from './dispatch'

function capturingLogger() {
  const lines: string[] = []
  const log = createServerLogger({
    write(chunk: string) {
      lines.push(chunk)
      return true
    },
  })
  const entries = () =>
    lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const outcome = () => entries().find((e) => e.msg === 'queue message')
  return { log, entries, outcome }
}

// A fake table whose blurhash handler runs whatever the test injects; the other
// topics are inert. The dispatcher is tested through its interface only.
function setup(blurhash: (ctx: { log: { info(msg: string): void } }) => Promise<void>) {
  const cap = capturingLogger()
  const table: QueueHandlerTable = {
    blurhash: {
      handle: (_msg, ctx) => blurhash(ctx),
      logFields: (msg) => ({ fileId: msg.fileId }),
    },
    email_user_invited: { handle: async () => {} },
    heic_transcode: { handle: async () => {} },
    email_integration_sync_alert: { handle: async () => {} },
    email_grid_tariff_available: { handle: async () => {} },
  }
  let t = 0
  const dispatch = createQueueDispatcher(table, {
    log: cap.log,
    maxDeliveries: 5,
    now: () => (t += 40), // each now() call advances 40 ms
  })
  return { ...cap, dispatch }
}

const PAYLOAD = { fileId: 'f-1', kind: 'avatar', userId: 'u-1' }
const meta = (deliveryCount: number) => ({ messageId: 'm-1', deliveryCount })

describe('queue dispatcher', () => {
  test('ok: resolves and logs one outcome line with topic, ids, logFields and duration', async () => {
    const { dispatch, outcome, entries } = setup(async () => {})
    await expect(dispatch('blurhash', PAYLOAD, meta(1))).resolves.toBeUndefined()
    expect(entries().filter((e) => e.msg === 'queue message')).toHaveLength(1)
    expect(outcome()).toMatchObject({
      level: 30,
      topic: 'blurhash',
      messageId: 'm-1',
      deliveryCount: 1,
      fileId: 'f-1',
      outcome: 'ok',
      durationMs: 40,
    })
  })

  test('hands the handler a logger already scoped to the message', async () => {
    const { dispatch, entries } = setup(async ({ log }) => log.info('inside handler'))
    await dispatch('blurhash', PAYLOAD, meta(1))
    expect(entries().find((e) => e.msg === 'inside handler')).toMatchObject({
      topic: 'blurhash',
      messageId: 'm-1',
      fileId: 'f-1',
    })
  })

  test('retry: a generic throw is logged at warn and rethrown so the runtime redelivers', async () => {
    const boom = new Error('download failed 503')
    const { dispatch, outcome } = setup(async () => {
      throw boom
    })
    await expect(dispatch('blurhash', PAYLOAD, meta(2))).rejects.toBe(boom)
    expect(outcome()).toMatchObject({ level: 40, outcome: 'retry', deliveryCount: 2 })
  })

  test('the delivery before the cap still retries', async () => {
    const { dispatch, outcome } = setup(async () => {
      throw new Error('still failing')
    })
    await expect(dispatch('blurhash', PAYLOAD, meta(4))).rejects.toThrow('still failing')
    expect(outcome()).toMatchObject({ outcome: 'retry', deliveryCount: 4 })
  })

  test('exhausted: a throw on the last allowed delivery is dropped (acked) at error', async () => {
    const { dispatch, outcome } = setup(async () => {
      throw new Error('still failing')
    })
    await expect(dispatch('blurhash', PAYLOAD, meta(5))).resolves.toBeUndefined()
    expect(outcome()).toMatchObject({ level: 50, outcome: 'dropped', reason: 'exhausted' })
  })

  test('permanent: PermanentQueueError is dropped (acked) at error on the first delivery', async () => {
    const { dispatch, outcome } = setup(async () => {
      throw new PermanentQueueError('recipient rejected', 'smtp_5xx')
    })
    await expect(dispatch('blurhash', PAYLOAD, meta(1))).resolves.toBeUndefined()
    expect(outcome()).toMatchObject({
      level: 50,
      outcome: 'dropped',
      reason: 'permanent',
      code: 'smtp_5xx',
    })
  })

  test('unknown topic: dropped (acked) at error without calling any handler', async () => {
    const handler = vi.fn(async () => {})
    const { dispatch, outcome } = setup(handler)
    await expect(dispatch('no_such_topic', {}, meta(1))).resolves.toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
    expect(outcome()).toMatchObject({
      level: 50,
      topic: 'no_such_topic',
      outcome: 'dropped',
      reason: 'unknown_topic',
    })
  })

  test('a prototype key is not mistaken for a topic', async () => {
    const { dispatch, outcome } = setup(async () => {})
    await dispatch('toString', {}, meta(1))
    expect(outcome()).toMatchObject({ outcome: 'dropped', reason: 'unknown_topic' })
  })

  test('a logFields that throws on a malformed payload does not stop the handler', async () => {
    const { dispatch, outcome } = setup(async () => {})
    await expect(dispatch('blurhash', null, meta(1))).resolves.toBeUndefined()
    expect(outcome()).toMatchObject({ outcome: 'ok' })
  })

  test('never logs the payload itself', async () => {
    const { dispatch, entries } = setup(async () => {})
    await dispatch('blurhash', { ...PAYLOAD, secret: 'do-not-log' }, meta(1))
    expect(JSON.stringify(entries())).not.toContain('do-not-log')
  })
})
