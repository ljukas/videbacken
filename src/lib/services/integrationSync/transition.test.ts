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
      consecutiveFailures: 0,
      errorCode: null,
      lastErrorMessage: null,
    })
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
