import { describe, expect, test } from 'vitest'
import { STALE_AFTER_MS } from './policy'
import {
  deriveState,
  type HealthSnapshot,
  nextRow,
  type RunStats,
  type SyncOutcome,
} from './transition'

const T0 = new Date('2026-09-28T10:00:00.000Z')
const NOW = new Date('2026-09-28T12:00:00.000Z')
const STARTED = new Date('2026-09-28T11:59:00.000Z')

const stats: RunStats = {
  since: null,
  pages: 1,
  sessionsSeen: 2,
  upserted: 2,
  voided: 0,
  timings: {},
}

const ok: SyncOutcome = { ok: true, stats }
function fail(code: 'auth_failed' | 'unreachable' | 'not_configured'): SyncOutcome {
  return { ok: false, kind: 'failed', code, message: `boom ${code}`, stats }
}

const never: HealthSnapshot = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSuccessStartedAt: null,
  failingSince: null,
  alertedAt: null,
  consecutiveFailures: 0,
  errorCode: null,
  lastErrorMessage: null,
}
const healthy: HealthSnapshot = {
  ...never,
  lastAttemptAt: T0,
  lastSuccessAt: T0,
  lastSuccessStartedAt: T0,
}
function failing(code: 'auth_failed' | 'unreachable' | 'not_configured', n = 2): HealthSnapshot {
  return {
    ...healthy,
    failingSince: T0,
    // The streak alerted iff it ran on an alertable code.
    alertedAt: code === 'not_configured' ? null : T0,
    consecutiveFailures: n,
    errorCode: code,
    lastErrorMessage: 'earlier',
  }
}

describe('nextRow transitions', () => {
  test.each([
    ['never → fail', never, fail('unreachable'), 'started_failing', 1],
    ['ok → fail', healthy, fail('auth_failed'), 'started_failing', 1],
    ['fail → fail (same code)', failing('unreachable'), fail('unreachable'), 'none', 3],
    ['fail → ok', failing('unreachable'), ok, 'recovered', 0],
    ['not_configured start', healthy, fail('not_configured'), 'none', 1],
    ['not_configured start from never', never, fail('not_configured'), 'none', 1],
    ['not_configured → ok', failing('not_configured'), ok, 'none', 0],
    ['code change mid-streak', failing('unreachable'), fail('auth_failed'), 'none', 3],
    [
      'not_configured → alertable',
      failing('not_configured'),
      fail('auth_failed'),
      'started_failing',
      3,
    ],
    ['alertable → not_configured', failing('auth_failed'), fail('not_configured'), 'none', 3],
    ['ok → ok', healthy, ok, 'none', 0],
  ] as const)('%s', (_label, prev, outcome, transition, failures) => {
    const result = nextRow(prev, outcome, NOW, STARTED)
    expect(result.transition).toBe(transition)
    expect(result.row.consecutiveFailures).toBe(failures)
    expect(result.row.lastAttemptAt).toEqual(NOW)
  })

  test('a newly failing row stamps failing_since = now; a continuing streak keeps it', () => {
    expect(nextRow(healthy, fail('unreachable'), NOW, STARTED).row.failingSince).toEqual(NOW)
    expect(
      nextRow(failing('unreachable'), fail('auth_failed'), NOW, STARTED).row.failingSince,
    ).toEqual(T0)
  })

  test('a failure sets the code and sanitized message, keeps the last success', () => {
    const { row } = nextRow(
      healthy,
      { ok: false, kind: 'error', code: 'internal_error', message: 'Bearer abc.def\nx', stats },
      NOW,
      STARTED,
    )
    expect(row.errorCode).toBe('internal_error')
    expect(row.lastErrorMessage).toBe('Bearer <redacted> x')
    expect(row.lastSuccessAt).toEqual(T0)
    expect(row.lastSuccessStartedAt).toEqual(T0)
  })

  test('a success clears the streak and records success times', () => {
    const { row } = nextRow(failing('auth_failed'), ok, NOW, STARTED)
    expect(row).toEqual({
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      lastSuccessStartedAt: STARTED,
      failingSince: null,
      alertedAt: null,
      consecutiveFailures: 0,
      errorCode: null,
      lastErrorMessage: null,
    })
  })

  test('an opened alert is stamped once and kept for the rest of the streak', () => {
    const opened = nextRow(healthy, fail('unreachable'), NOW, STARTED).row
    expect(opened.alertedAt).toEqual(NOW)
    const later = new Date(NOW.getTime() + 60_000)
    expect(nextRow(opened, fail('not_configured'), later, STARTED).row.alertedAt).toEqual(NOW)
    expect(nextRow(opened, fail('auth_failed'), later, STARTED).row.alertedAt).toEqual(NOW)
  })

  test('the watermark is the run start, or `syncedUntil` when the run passes one', () => {
    const until = new Date('2026-06-01T00:00:00.000Z')
    expect(nextRow(healthy, ok, NOW, STARTED).row.lastSuccessStartedAt).toEqual(STARTED)
    expect(
      nextRow(healthy, { ...ok, syncedUntil: until }, NOW, STARTED).row.lastSuccessStartedAt,
    ).toEqual(until)
    // A failed run keeps the previous watermark unless it finished some windows.
    expect(nextRow(healthy, fail('unreachable'), NOW, STARTED).row.lastSuccessStartedAt).toEqual(T0)
    expect(
      nextRow(healthy, { ...fail('unreachable'), syncedUntil: until }, NOW, STARTED).row
        .lastSuccessStartedAt,
    ).toEqual(until)
  })
})

// Mixed-code streaks: `alertedAt` remembers whether this streak alerted, so
// every `recovered` pairs with a `started_failing`, whichever codes the streak
// passed through.
describe('mixed-code streaks pair their alerts', () => {
  function run(steps: SyncOutcome[]) {
    let prev = healthy
    return steps.map((outcome, i) => {
      const result = nextRow(prev, outcome, new Date(NOW.getTime() + i * 1000), STARTED)
      prev = result.row
      return result.transition
    })
  }

  test('ok → auth_failed → not_configured → ok: start alert, then recovery alert', () => {
    expect(run([fail('auth_failed'), fail('not_configured'), ok])).toEqual([
      'started_failing',
      'none',
      'recovered',
    ])
  })

  test('ok → not_configured → auth_failed → ok: start alert on auth_failed, then recovery', () => {
    expect(run([fail('not_configured'), fail('auth_failed'), ok])).toEqual([
      'none',
      'started_failing',
      'recovered',
    ])
  })

  test('ok → not_configured → ok: never alerts', () => {
    expect(run([fail('not_configured'), fail('not_configured'), ok])).toEqual([
      'none',
      'none',
      'none',
    ])
  })

  test('unreachable → not_configured → auth_failed: one alert for the whole streak', () => {
    expect(run([fail('unreachable'), fail('not_configured'), fail('auth_failed'), ok])).toEqual([
      'started_failing',
      'none',
      'none',
      'recovered',
    ])
  })
})

describe('deriveState', () => {
  const stale = STALE_AFTER_MS.zaptec

  test.each([
    ['no row', null, NOW, 'never_synced'],
    ['row without attempt', never, NOW, 'never_synced'],
    ['not_configured', failing('not_configured'), NOW, 'not_configured'],
    ['failing', failing('auth_failed'), NOW, 'failing'],
    ['fresh success', healthy, new Date(T0.getTime() + 1000), 'ok'],
    ['exactly at the stale boundary', healthy, new Date(T0.getTime() + stale), 'ok'],
    ['1 ms past the stale boundary', healthy, new Date(T0.getTime() + stale + 1), 'stale'],
  ] as const)('%s', (_label, row, now, state) => {
    expect(deriveState('zaptec', row, now)).toBe(state)
  })

  test('zaptec goes stale after 3 h', () => {
    expect(STALE_AFTER_MS.zaptec).toBe(3 * 60 * 60 * 1000)
  })
})
