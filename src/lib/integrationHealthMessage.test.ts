import { expect, test } from 'vitest'
import type { HealthState } from '~/lib/integrationHealth'
import { INTEGRATION_ERROR_CODES, INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import {
  integrationErrorMessage,
  integrationHealthTitle,
  integrationSourceName,
} from './integrationHealthMessage'

const HEALTH_STATES: HealthState[] = ['never_synced', 'not_configured', 'ok', 'stale', 'failing']
const LOCALES = ['sv', 'en'] as const

test.each(
  INTEGRATION_SOURCES,
)('integrationSourceName returns a non-empty string for %s', (source) => {
  expect(integrationSourceName(source).length).toBeGreaterThan(0)
})

for (const locale of LOCALES) {
  test.each(
    INTEGRATION_ERROR_CODES,
  )(`integrationErrorMessage returns a non-empty ${locale} string for %s`, (code) => {
    for (const source of INTEGRATION_SOURCES) {
      expect(integrationErrorMessage(code, { source, locale }).length).toBeGreaterThan(0)
    }
  })

  test.each(
    INTEGRATION_ERROR_CODES,
  )(`integrationErrorMessage (${locale}) never names another source for %s`, (code) => {
    for (const source of INTEGRATION_SOURCES) {
      const message = integrationErrorMessage(code, { source, locale })
      for (const other of INTEGRATION_SOURCES.filter((s) => s !== source)) {
        expect(message).not.toContain(integrationSourceName(other))
      }
    }
  })

  test.each(
    HEALTH_STATES,
  )(`integrationHealthTitle returns a non-empty ${locale} string for %s`, (state) => {
    expect(integrationHealthTitle(state, { locale }).length).toBeGreaterThan(0)
  })
}

test('an elpris failure names elprisetjustnu.se, not Zaptec', () => {
  const message = integrationErrorMessage('unreachable', { source: 'elpris', locale: 'sv' })
  expect(message).toContain('elprisetjustnu.se')
  expect(message).not.toContain('Zaptec')
})

test('emaldo is a source with its own name', () => {
  expect(INTEGRATION_SOURCES).toContain('emaldo')
  expect(integrationSourceName('emaldo')).toBe('Emaldo')
})

test('an unexpected Emaldo answer hints that the app key may have changed', () => {
  expect(
    integrationErrorMessage('unexpected_response', { source: 'emaldo', locale: 'sv' }),
  ).toContain('nyckel')
  expect(
    integrationErrorMessage('unexpected_response', { source: 'emaldo', locale: 'en' }),
  ).toContain('key')
  // Other codes keep the shared, source-named copy.
  expect(integrationErrorMessage('unreachable', { source: 'emaldo', locale: 'en' })).toContain(
    'Emaldo',
  )
})
