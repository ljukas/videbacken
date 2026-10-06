import { expect, test } from 'vitest'
import { credentialLink } from './credentialLink'
import type { SourceHealth } from './syncHealth'

const base: SourceHealth = {
  source: 'skoda',
  state: 'failing',
  running: false,
  progress: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  failingSince: null,
  consecutiveFailures: 1,
  code: null,
  adminDetail: null,
}
const detail = (suspectFields: string[] | null) =>
  ({ lastErrorMessage: null, credentialExpiry: null, suspectFields }) as never

test('not configured → configure', () => {
  expect(credentialLink({ ...base, state: 'not_configured', code: 'not_configured' })).toEqual({
    source: 'skoda',
    kind: 'configure',
  })
})
test('credential failures → update', () => {
  for (const code of ['auth_failed', 'credentials_unreadable'] as const)
    expect(credentialLink({ ...base, source: 'zaptec', code })).toEqual({
      source: 'zaptec',
      kind: 'update',
    })
  expect(credentialLink({ ...base, code: 'forbidden' })).toEqual({
    source: 'skoda',
    kind: 'update',
  })
})
test('forbidden is a credential problem only for Škoda', () => {
  expect(credentialLink({ ...base, source: 'zaptec', code: 'forbidden' })).toBeNull()
})
test('any failure with stored suspect fields → update', () => {
  expect(
    credentialLink({
      ...base,
      source: 'emaldo',
      code: 'unexpected_response',
      adminDetail: detail(['appId']),
    }),
  ).toEqual({ source: 'emaldo', kind: 'update' })
})
test('elpris never links; ok and plain outages never link', () => {
  expect(
    credentialLink({ ...base, source: 'elpris', state: 'not_configured', code: 'not_configured' }),
  ).toBeNull()
  expect(credentialLink({ ...base, state: 'ok' })).toBeNull()
  expect(credentialLink({ ...base, code: 'unreachable' })).toBeNull()
})
