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
    expect(integrationErrorMessage(code, { locale }).length).toBeGreaterThan(0)
  })

  test.each(
    HEALTH_STATES,
  )(`integrationHealthTitle returns a non-empty ${locale} string for %s`, (state) => {
    expect(integrationHealthTitle(state, { locale }).length).toBeGreaterThan(0)
  })
}
