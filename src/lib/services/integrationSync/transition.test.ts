import { describe, expect, test } from 'vitest'
import type { CredentialFieldName } from '~/lib/integrationCredentials'
import { ALERT_AFTER_FAILURES, STALE_AFTER_MS } from './policy'
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
function fail(
  code: 'auth_failed' | 'unreachable' | 'rate_limited' | 'not_configured',
): SyncOutcome {
  return { ok: false, kind: 'failed', code, message: `boom ${code}`, stats }
}

const never: HealthSnapshot = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSuccessStartedAt: null,
  failingSince: null,
  alertedAt: null,
  consecutiveFailures: 0,
  alertableFailures: 0,
  errorCode: null,
  lastErrorMessage: null,
  suspectFields: null,
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
    alertableFailures: code === 'not_configured' ? 0 : n,
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
      alertableFailures: 0,
      errorCode: null,
      lastErrorMessage: null,
      suspectFields: null,
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

  test('skoda goes stale after 1 h', () => {
    const minutes = (m: number) => new Date(T0.getTime() + m * 60_000)
    expect(STALE_AFTER_MS.skoda).toBe(60 * 60 * 1000)
    expect(deriveState('skoda', healthy, minutes(59))).toBe('ok')
    expect(deriveState('skoda', healthy, new Date(T0.getTime() + STALE_AFTER_MS.skoda))).toBe('ok')
    expect(deriveState('skoda', healthy, new Date(T0.getTime() + STALE_AFTER_MS.skoda + 1))).toBe(
      'stale',
    )
    expect(deriveState('skoda', healthy, minutes(61))).toBe('stale')
  })

  test('zaptec goes stale after 3 h', () => {
    expect(STALE_AFTER_MS.zaptec).toBe(3 * 60 * 60 * 1000)
  })

  test('emaldo goes stale after 3 h, like Zaptec', () => {
    expect(STALE_AFTER_MS.emaldo).toBe(3 * 60 * 60 * 1000)
    expect(deriveState('emaldo', healthy, new Date(T0.getTime() + STALE_AFTER_MS.emaldo))).toBe(
      'ok',
    )
    expect(deriveState('emaldo', healthy, new Date(T0.getTime() + STALE_AFTER_MS.emaldo + 1))).toBe(
      'stale',
    )
  })
})

describe('alert threshold', () => {
  function runAt3(steps: SyncOutcome[]) {
    let prev = healthy
    return steps.map((outcome) => {
      const result = nextRow(prev, outcome, NOW, STARTED, 3)
      prev = result.row
      return result.transition
    })
  }

  test('the threshold table is pinned', () => {
    expect(ALERT_AFTER_FAILURES).toEqual({ zaptec: 1, elpris: 1, skoda: 3, emaldo: 1 })
  })

  test('two failures then success: no alert, streak cleared', () => {
    const failed2 = nextRow(
      nextRow(healthy, fail('unreachable'), NOW, STARTED, 3).row,
      fail('unreachable'),
      NOW,
      STARTED,
      3,
    ).row
    expect(failed2.alertedAt).toBeNull()
    const result = nextRow(failed2, ok, NOW, STARTED, 3)
    expect(result.transition).toBe('none')
    expect(result.row.alertedAt).toBeNull()
    expect(result.row.consecutiveFailures).toBe(0)
  })

  test('after the alert opens, a further failure stays silent', () => {
    expect(runAt3(Array(4).fill(fail('unreachable')))).toEqual([
      'none',
      'none',
      'started_failing',
      'none',
    ])
  })

  test('a not_configured prefix does not use up the threshold', () => {
    const nc = fail('not_configured')
    const u = fail('unreachable')
    expect(runAt3([nc, nc, u, u])).toEqual(['none', 'none', 'none', 'none'])
    expect(runAt3([nc, nc, u, u, u])).toEqual(['none', 'none', 'none', 'none', 'started_failing'])
  })

  test('a not_configured run in the middle restarts the count', () => {
    const nc = fail('not_configured')
    const u = fail('unreachable')
    expect(runAt3([u, nc, u, u])).toEqual(['none', 'none', 'none', 'none'])
    expect(runAt3([u, nc, u, u, u])).toEqual(['none', 'none', 'none', 'none', 'started_failing'])
  })

  test('three alertable failures in a row open the alert on the third', () => {
    const u = fail('unreachable')
    expect(runAt3([u, u, u])).toEqual(['none', 'none', 'started_failing'])
  })

  test('a success resets the alertable count', () => {
    const one = nextRow(healthy, fail('unreachable'), NOW, STARTED, 3).row
    expect(one.alertableFailures).toBe(1)
    expect(nextRow(one, ok, NOW, STARTED, 3).row.alertableFailures).toBe(0)
    const nc = nextRow(one, fail('not_configured'), NOW, STARTED, 3).row
    expect(nc.alertableFailures).toBe(0)
    expect(nc.consecutiveFailures).toBe(2)
  })

  test('with a threshold of 3, the alert opens on the third alertable failure in a row', () => {
    const first = nextRow(healthy, fail('unreachable'), NOW, STARTED, 3)
    expect(first.transition).toBe('none')
    expect(first.row.alertedAt).toBeNull()
    const second = nextRow(first.row, fail('rate_limited'), NOW, STARTED, 3)
    expect(second.transition).toBe('none')
    const third = nextRow(second.row, fail('unreachable'), NOW, STARTED, 3)
    expect(third.transition).toBe('started_failing')
    expect(third.row.alertedAt).toEqual(NOW)
  })

  test('a streak shorter than the threshold recovers silently', () => {
    const failed = nextRow(healthy, fail('unreachable'), NOW, STARTED, 3).row
    expect(nextRow(failed, ok, NOW, STARTED, 3).transition).toBe('none')
  })

  test('not_configured never alerts, whatever the threshold', () => {
    let row = healthy
    for (let i = 0; i < 5; i++) {
      const next = nextRow(row, fail('not_configured'), NOW, STARTED, 3)
      expect(next.transition).toBe('none')
      row = next.row
    }
  })
})

describe('suspect fields', () => {
  const authFailed = (suspectFields?: readonly CredentialFieldName[] | null): SyncOutcome => ({
    ok: false,
    kind: 'failed',
    code: 'auth_failed',
    message: 'refused',
    stats,
    suspectFields,
  })

  test('a failure records its suspect fields', () => {
    expect(nextRow(healthy, authFailed(['apiKey']), NOW, STARTED).row.suspectFields).toEqual([
      'apiKey',
    ])
  })
  test('none or an empty list is null', () => {
    expect(nextRow(healthy, authFailed(), NOW, STARTED).row.suspectFields).toBeNull()
    expect(nextRow(healthy, authFailed([]), NOW, STARTED).row.suspectFields).toBeNull()
  })
  test('duplicates are deduped', () => {
    expect(nextRow(healthy, authFailed(['vin', 'vin']), NOW, STARTED).row.suspectFields).toEqual([
      'vin',
    ])
  })
  test('a later failure without suspects clears them', () => {
    const first = nextRow(healthy, authFailed(['apiKey']), NOW, STARTED).row
    expect(nextRow(first, fail('unreachable'), NOW, STARTED).row.suspectFields).toBeNull()
  })
  test('success clears them', () => {
    const first = nextRow(healthy, authFailed(['vin']), NOW, STARTED).row
    expect(nextRow(first, ok, NOW, STARTED).row.suspectFields).toBeNull()
  })
})
