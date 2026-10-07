import { describe, expect, it } from 'vitest'
import {
  currentQueueMs,
  edgeQueueMs,
  formatServerTiming,
  recordServerTiming,
  rpcServerTimings,
  withServerTiming,
} from './serverTiming'

const EDGE_MS = 1_791_382_772_833
const vercelId = (ms: number | string) => `arn1::v9n86-${ms}-39642b699205`

describe('formatServerTiming', () => {
  it('joins metrics with their durations rounded to 0.1 ms', () => {
    expect(
      formatServerTiming([
        { name: 'queue', dur: 198.04 },
        { name: 'app', dur: 24 },
      ]),
    ).toBe('queue;dur=198, app;dur=24')
    expect(formatServerTiming([{ name: 'app', dur: 1.26 }])).toBe('app;dur=1.3')
  })

  it('quotes a description and escapes quotes and backslashes in it', () => {
    expect(formatServerTiming([{ name: 'pool', desc: 'opened=2 "a\\b"' }])).toBe(
      'pool;desc="opened=2 \\"a\\\\b\\""',
    )
  })

  it('drops characters a header cannot carry', () => {
    expect(formatServerTiming([{ name: 'cost compute/ms', dur: 1, desc: 'åtta\nrad' }])).toBe(
      'cost_compute_ms;dur=1;desc="ttarad"',
    )
  })

  it('skips a metric whose name is empty after cleaning or whose duration is not finite', () => {
    expect(
      formatServerTiming([
        { name: 'åäö', dur: 1 },
        { name: 'bad', dur: Number.NaN },
        { name: 'ok', dur: 2 },
      ]),
    ).toBe('ok;dur=2')
  })
})

describe('edgeQueueMs', () => {
  it('is the time from the edge stamp in x-vercel-id to now', () => {
    expect(edgeQueueMs(vercelId(EDGE_MS), EDGE_MS + 198)).toBe(198)
  })

  it('reads the stamp from the last segment of a multi-region id', () => {
    expect(edgeQueueMs(`fra1::arn1::abc12-${EDGE_MS}-ff00`, EDGE_MS + 5)).toBe(5)
  })

  it('is undefined without a parsable id (local dev, a format change)', () => {
    expect(edgeQueueMs(null, EDGE_MS)).toBeUndefined()
    expect(edgeQueueMs('some-uuid-value', EDGE_MS)).toBeUndefined()
    expect(edgeQueueMs(vercelId('12345'), EDGE_MS)).toBeUndefined()
  })

  it('is undefined for an implausible gap (clock skew, not a timestamp)', () => {
    expect(edgeQueueMs(vercelId(EDGE_MS), EDGE_MS - 1)).toBeUndefined()
    expect(edgeQueueMs(vercelId(EDGE_MS), EDGE_MS + 60_001)).toBeUndefined()
  })
})

describe('rpcServerTimings', () => {
  it('turns the rpc timing fields into metrics, dropping the Ms suffix', () => {
    expect(
      rpcServerTimings({
        totalMs: 159,
        timings: { getSessionMs: 1, costComputeMs: 71 },
        pool: { poolTotal: 1, poolIdle: 1, poolWaiting: 0 },
        poolActivity: { poolOpened: 2, poolPeakWaiting: 2 },
      }),
    ).toEqual([
      { name: 'rpc', dur: 159 },
      { name: 'getSession', dur: 1 },
      { name: 'costCompute', dur: 71 },
      { name: 'pool', desc: 'total=1 idle=1 waiting=0 opened=2 peakWaiting=2' },
    ])
  })

  it('leaves out pool activity the request never got (the handler threw)', () => {
    expect(
      rpcServerTimings({
        totalMs: 3,
        timings: {},
        pool: { poolTotal: 0, poolIdle: 0, poolWaiting: 0 },
        poolActivity: undefined,
      }),
    ).toEqual([
      { name: 'rpc', dur: 3 },
      { name: 'pool', desc: 'total=0 idle=0 waiting=0' },
    ])
  })
})

describe('withServerTiming', () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://app.test/api/rpc/x', { headers })

  it('adds queue, app and the metrics recorded during the request', async () => {
    let seenQueue: number | undefined
    const response = await withServerTiming(
      request({ 'x-vercel-id': vercelId(EDGE_MS) }),
      async () => {
        seenQueue = currentQueueMs()
        recordServerTiming({ name: 'costCompute', dur: 71 })
        return new Response('ok')
      },
      () => EDGE_MS + 198,
    )
    expect(seenQueue).toBe(198)
    expect(response.headers.get('server-timing')).toMatch(
      /^queue;dur=198, app;dur=[\d.]+, costCompute;dur=71$/,
    )
    expect(await response.text()).toBe('ok')
  })

  it('has no queue metric off Vercel', async () => {
    const response = await withServerTiming(request(), async () => new Response('ok'))
    expect(response.headers.get('server-timing')).toMatch(/^app;dur=[\d.]+$/)
  })

  it('rebuilds a response whose headers are read-only, keeping status, headers and body', async () => {
    const redirect = Response.redirect('https://app.test/login', 307)
    expect(() => redirect.headers.set('x', 'y')).toThrow()
    const response = await withServerTiming(request(), async () => redirect)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://app.test/login')
    expect(response.headers.get('server-timing')).toMatch(/^app;dur=/)
  })

  it('keeps every Set-Cookie when it rebuilds a response (auth sets several)', async () => {
    const original = new Response(null, { status: 204 })
    original.headers.append('set-cookie', 'a=1; Path=/')
    original.headers.append('set-cookie', 'b=2; Path=/')
    // Stand in for a response whose headers are read-only.
    original.headers.append = () => {
      throw new TypeError('immutable')
    }
    const response = await withServerTiming(request(), async () => original)
    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
    expect(response.headers.get('server-timing')).toMatch(/^app;dur=/)
  })

  it('keeps metrics of concurrent requests apart', async () => {
    const run = (name: string, delayMs: number) =>
      withServerTiming(request(), async () => {
        await new Promise((r) => setTimeout(r, delayMs))
        recordServerTiming({ name, dur: 1 })
        return new Response(name)
      })
    const [a, b] = await Promise.all([run('first', 10), run('second', 1)])
    expect(a.headers.get('server-timing')).toMatch(/, first;dur=1$/)
    expect(b.headers.get('server-timing')).toMatch(/, second;dur=1$/)
  })

  it('records nothing outside a request', () => {
    expect(() => recordServerTiming({ name: 'x', dur: 1 })).not.toThrow()
    expect(currentQueueMs()).toBeUndefined()
  })
})
