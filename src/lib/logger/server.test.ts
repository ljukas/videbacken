import { describe, expect, test } from 'vitest'
import { createRequestLogger, createServerLogger } from './server'

function makeCapturingLogger() {
  const lines: string[] = []
  const destination = {
    write(chunk: string): boolean {
      lines.push(chunk)
      return true
    },
  }
  const log = createServerLogger(destination)
  const parsed = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
  return { log, parsed }
}

describe('server logger', () => {
  test('info writes a JSON line with msg, level and fields', () => {
    const { log, parsed } = makeCapturingLogger()
    log.info('hello', { foo: 'bar' })
    const entries = parsed()
    expect(entries).toHaveLength(1)
    expect(entries[0].msg).toBe('hello')
    expect(entries[0].foo).toBe('bar')
    expect(entries[0].level).toBeTypeOf('number')
    expect(entries[0].service).toBe('oceanview')
  })

  test('warn and error emit at higher levels than info', () => {
    const { log, parsed } = makeCapturingLogger()
    log.warn('a warning')
    log.error('an error')
    const entries = parsed()
    expect(entries).toHaveLength(2)
    expect(entries[0].msg).toBe('a warning')
    expect(entries[1].msg).toBe('an error')
    expect(entries[1].level).toBeGreaterThan(entries[0].level)
  })

  test('child loggers merge their scope into every line', () => {
    const { log, parsed } = makeCapturingLogger()
    const child = log.child({ requestId: 'req-123' })
    child.info('scoped event', { userId: 'u-1' })
    const entry = parsed()[0]
    expect(entry.requestId).toBe('req-123')
    expect(entry.userId).toBe('u-1')
    expect(entry.msg).toBe('scoped event')
  })

  test('authorization and cookie headers are redacted', () => {
    const { log, parsed } = makeCapturingLogger()
    log.info('inbound', {
      headers: {
        authorization: 'Bearer super-secret',
        cookie: 'session=abc',
        'user-agent': 'curl',
      },
    })
    const entry = parsed()[0]
    expect(entry.headers.authorization).toBe('<redacted>')
    expect(entry.headers.cookie).toBe('<redacted>')
    expect(entry.headers['user-agent']).toBe('curl')
  })

  test('createRequestLogger pulls request id from x-vercel-id when present', () => {
    const request = new Request('https://example.test/api/rpc/health', {
      headers: { 'x-vercel-id': 'vercel-abc' },
    })
    const { requestId } = createRequestLogger(request)
    expect(requestId).toBe('vercel-abc')
  })

  test('createRequestLogger generates a uuid when x-vercel-id is missing', () => {
    const request = new Request('https://example.test/api/log')
    const { requestId } = createRequestLogger(request)
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
