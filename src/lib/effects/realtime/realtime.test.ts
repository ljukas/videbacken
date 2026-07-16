import { describe, expect, test } from 'vitest'
import type { Logger } from '~/lib/logger'
import { createInMemoryRealtime } from './adapters/inMemory'
import { type RealtimeEnvelope, shouldDeliver } from './realtime'

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
}

async function collect(
  iter: AsyncIterable<RealtimeEnvelope>,
  count: number,
): Promise<RealtimeEnvelope[]> {
  const out: RealtimeEnvelope[] = []
  for await (const envelope of iter) {
    out.push(envelope)
    if (out.length >= count) break
  }
  return out
}

describe('inMemory realtime adapter', () => {
  test('publish delivers events to a subscriber', async () => {
    const realtime = createInMemoryRealtime()
    const ctrl = new AbortController()
    const received = collect(realtime.subscribe({ signal: ctrl.signal, log: noopLogger }), 2)

    // Yield a microtask so the subscriber's async generator can install its
    // listener before we publish — EventPublisher only buffers after subscribe.
    await Promise.resolve()
    await realtime.publish({ kind: 'user.changed', ids: ['a'] })
    await realtime.publish({ kind: 'user.changed', ids: ['b'] })

    const events = await received
    expect(events).toEqual([
      { event: { kind: 'user.changed', ids: ['a'] }, source: undefined },
      { event: { kind: 'user.changed', ids: ['b'] }, source: undefined },
    ])
    ctrl.abort()
  })

  test('publish carries the source through the envelope', async () => {
    const realtime = createInMemoryRealtime()
    const ctrl = new AbortController()
    const received = collect(realtime.subscribe({ signal: ctrl.signal, log: noopLogger }), 2)

    await Promise.resolve()
    await realtime.publish({ kind: 'document.changed', ids: ['d'] }, { source: 'user-1' })
    await realtime.publish({ kind: 'document.changed', ids: ['e'] })

    expect(await received).toEqual([
      { event: { kind: 'document.changed', ids: ['d'] }, source: 'user-1' },
      { event: { kind: 'document.changed', ids: ['e'] }, source: undefined },
    ])
    ctrl.abort()
  })

  test('multiple subscribers each receive every event', async () => {
    const realtime = createInMemoryRealtime()
    const a = new AbortController()
    const b = new AbortController()

    const recA = collect(realtime.subscribe({ signal: a.signal, log: noopLogger }), 1)
    const recB = collect(realtime.subscribe({ signal: b.signal, log: noopLogger }), 1)

    await Promise.resolve()
    await realtime.publish({ kind: 'user.changed', ids: ['shared'] })

    expect(await recA).toEqual([
      { event: { kind: 'user.changed', ids: ['shared'] }, source: undefined },
    ])
    expect(await recB).toEqual([
      { event: { kind: 'user.changed', ids: ['shared'] }, source: undefined },
    ])
    a.abort()
    b.abort()
  })

  test('signal.abort ends the iterator', async () => {
    const realtime = createInMemoryRealtime()
    const ctrl = new AbortController()
    const iter = realtime.subscribe({ signal: ctrl.signal, log: noopLogger })

    const done = (async () => {
      // Consume until the iterator finishes naturally on abort.
      const events: RealtimeEnvelope[] = []
      try {
        for await (const envelope of iter) events.push(envelope)
      } catch {
        // EventPublisher's iterator throws AbortError on signal — that also
        // counts as a clean teardown.
      }
      return events
    })()

    await Promise.resolve()
    ctrl.abort()

    // The promise should settle promptly; if abort doesn't tear down we'd hang.
    await expect(
      Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 500))]),
    ).resolves.toEqual([])
  })
})

describe('shouldDeliver (echo suppression)', () => {
  test('suppresses an event for the actor that caused it', () => {
    expect(shouldDeliver('user-1', 'user-1')).toBe(false)
  })

  test('delivers an event to a different actor', () => {
    expect(shouldDeliver('user-1', 'user-2')).toBe(true)
  })

  test('always delivers a sourceless (broadcast) event', () => {
    expect(shouldDeliver(undefined, 'user-1')).toBe(true)
  })
})
