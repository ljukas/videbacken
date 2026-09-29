import { ORPCError } from '@orpc/server'
import { describe, expect, test } from 'vitest'
import { type SerializedError, serializeError } from './serializeError'

const ser = (v: unknown) => serializeError(v) as SerializedError

describe('serializeError', () => {
  test('keeps type, message and stack of a plain Error', () => {
    const out = ser(new Error('boom'))
    expect(out.type).toBe('Error')
    expect(out.message).toBe('boom')
    expect(out.stack).toContain('boom')
    expect(out.name).toBeUndefined()
  })

  test('follows the cause chain and keeps a network error code', () => {
    const network = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const out = ser(new TypeError('fetch failed', { cause: network }))
    expect(out.type).toBe('TypeError')
    const cause = out.cause as SerializedError
    expect(cause.message).toBe('connect ECONNREFUSED')
    expect(cause.code).toBe('ECONNREFUSED')
  })

  test('cuts a cause chain off at the depth cap', () => {
    let err: Error = new Error('root')
    for (let i = 0; i < 10; i++) err = new Error(`level ${i}`, { cause: err })
    let node = ser(err)
    let depth = 0
    while (node.cause) {
      node = node.cause as SerializedError
      depth++
    }
    expect(depth).toBe(5)
    expect(node.message).toBe('[max cause depth reached]')
  })

  test('survives a cause cycle', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as Error & { cause: unknown }).cause = b
    const out = ser(a)
    expect(((out.cause as SerializedError).cause as SerializedError).message).toBe('[circular]')
  })

  test('keeps ORPCError code, status, defined and data', () => {
    const out = ser(
      new ORPCError('DEVICE_NOT_FOUND', { status: 404, defined: true, data: { id: 'x' } }),
    )
    expect(out).toMatchObject({
      type: 'ORPCError',
      code: 'DEVICE_NOT_FOUND',
      status: 404,
      defined: true,
      data: { id: 'x' },
    })
  })

  test('serializes the inner errors of an AggregateError', () => {
    const out = ser(new AggregateError([new Error('one'), new Error('two')], 'several'))
    expect(out.message).toBe('several')
    expect((out.errors as SerializedError[]).map((e) => e.message)).toEqual(['one', 'two'])
  })

  test('reduces a DOMException to its name, without the legacy numeric code', () => {
    const out = ser(new DOMException('The operation timed out.', 'TimeoutError'))
    expect(out.type).toBe('DOMException')
    expect(out.name).toBe('TimeoutError')
    expect(out.code).toBeUndefined()
  })

  test('drops non-allow-listed properties such as an attached response', () => {
    const err = Object.assign(new Error('http 500'), {
      response: { headers: { authorization: 'Bearer secret' } },
      password: 'hunter2',
    })
    const out = serializeError(err) as Record<string, unknown>
    expect(out.response).toBeUndefined()
    expect(out.password).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  test('drops `data` unless the error is a defined oRPC error', () => {
    const undefinedOrpc = ser(new ORPCError('INTERNAL_SERVER_ERROR', { data: { token: 'secret' } }))
    expect(undefinedOrpc.data).toBeUndefined()
    const arbitrary = ser(Object.assign(new Error('x'), { data: { access_token: 'secret' } }))
    expect(arbitrary.data).toBeUndefined()
  })

  test('reduces a non-Error cause to its message and code, never copying it wholesale', () => {
    const body = {
      message: 'upstream said no',
      code: 'E_UPSTREAM',
      headers: { authorization: 'Bearer secret' },
    }
    const out = ser(new Error('fetch failed', { cause: body }))
    expect(out.cause).toEqual({ type: 'Object', message: 'upstream said no', code: 'E_UPSTREAM' })
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  test('reduces non-Error AggregateError members the same way', () => {
    const out = ser(new AggregateError([{ token: 'secret' }, 'plain reason'], 'multi'))
    expect(out.errors).toEqual([{ type: 'Object' }, 'plain reason'])
  })

  test('never throws, even for an error with a throwing getter', () => {
    const hostile = new Error('hostile')
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('getter exploded')
      },
    })
    expect(() => serializeError(hostile)).not.toThrow()
    expect(serializeError(hostile)).toEqual({ type: 'Error', message: '[unserializable error]' })
  })

  test("drops a failed drizzle query's bound params from message and stack", () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    const err = Object.assign(
      new Error('Failed query: insert into "t" values ($1)\nparams: owner@example.com', {
        cause: pgError,
      }),
      { query: 'insert into "t" values ($1)', params: ['owner@example.com'] },
    )
    const out = ser(err)
    expect(out.message).toBe('Failed query: insert into "t" values ($1)')
    expect(out.stack).toContain('Failed query: insert into "t" values ($1)')
    expect(JSON.stringify(out)).not.toContain('owner@example.com')
    expect(out.cause).toMatchObject({ message: 'duplicate key', code: '23505' })
  })

  test('passes non-Error values through unchanged', () => {
    expect(serializeError('just a string')).toBe('just a string')
    expect(serializeError(42)).toBe(42)
    const plain = { message: 'already serialized', stack: 's' }
    expect(serializeError(plain)).toBe(plain)
  })
})
