import { expect, test } from 'vitest'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SyncSourceMark } from './SyncSourceMark'
import { syncSourceCadence, syncSourceRole } from './syncSourceCopy'

const ICON_CLASS = {
  zaptec: 'lucide-ev-charger',
  elpris: 'lucide-chart-line',
  skoda: 'lucide-car-front',
  emaldo: 'lucide-sun-medium',
} as const

const ROLE = {
  zaptec: m.charging_source_role_zaptec,
  elpris: m.charging_source_role_elpris,
  skoda: m.charging_source_role_skoda,
  emaldo: m.charging_source_role_emaldo,
} as const

const CADENCE = {
  zaptec: m.charging_source_cadence_zaptec,
  elpris: m.charging_source_cadence_elpris,
  skoda: m.charging_source_cadence_skoda,
  emaldo: m.charging_source_cadence_emaldo,
} as const

test.each(INTEGRATION_SOURCES)('%s has its own decorative icon in its own tone', async (source) => {
  const { screen } = await renderWithProviders(<SyncSourceMark source={source} />)
  const icon = screen.container.querySelector(`svg.${ICON_CLASS[source]}`)
  expect(icon).not.toBeNull()
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
  const mark = icon?.parentElement
  expect(mark?.className).toContain(`bg-source-${source}/`)
  expect(mark?.className).toContain(`text-source-${source}`)
  expect(mark?.className).toContain(`dark:bg-source-${source}/`)
})

test.each(INTEGRATION_SOURCES)('%s has its own role and cadence copy', (source) => {
  expect(syncSourceRole(source)).toBe(ROLE[source]())
  expect(syncSourceCadence(source)).toBe(CADENCE[source]())
})

test('the roles tell the sources apart', () => {
  expect(new Set(INTEGRATION_SOURCES.map(syncSourceRole)).size).toBe(INTEGRATION_SOURCES.length)
})
