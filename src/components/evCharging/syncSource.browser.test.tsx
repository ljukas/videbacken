import { expect, test } from 'vitest'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceMark, syncSourceCadence, syncSourceRole } from './syncSource'

const ICON_CLASS = {
  zaptec: 'lucide-ev-charger',
  elpris: 'lucide-chart-line',
  skoda: 'lucide-car-front',
  emaldo: 'lucide-sun-medium',
} as const

test.each(INTEGRATION_SOURCES)('%s has its own decorative icon', async (source) => {
  const { screen } = await renderWithProviders(<SyncSourceMark source={source} />)
  const icon = screen.container.querySelector(`svg.${ICON_CLASS[source]}`)
  expect(icon).not.toBeNull()
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
})

test('every source has a distinct role', () => {
  const roles = INTEGRATION_SOURCES.map(syncSourceRole)
  expect(new Set(roles).size).toBe(INTEGRATION_SOURCES.length)
  expect(syncSourceRole('zaptec')).toBe(m.charging_source_role_zaptec())
})

test('every source has a cadence line', () => {
  for (const source of INTEGRATION_SOURCES) expect(syncSourceCadence(source)).not.toBe('')
  expect(syncSourceCadence('skoda')).toBe(m.charging_source_cadence_skoda())
})
