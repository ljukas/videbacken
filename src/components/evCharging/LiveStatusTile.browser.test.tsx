import { expect, test } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { LiveStatusTile } from './LiveStatusTile'

type Live = NonNullable<RouterOutputs['evCharging']['liveStatus']>

const observedAt = new Date('2026-09-28T10:00:00Z')

test('charging: shows the mode, power and session energy', async () => {
  const live: Live = { mode: 'charging', powerKw: 7.36, sessionKwh: 12.04, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusTile live={live} />)
  await expect.element(screen.getByText(m.charging_live_mode_charging())).toBeVisible()
  await expect.element(screen.getByText('7,4 kW')).toBeVisible()
  await expect.element(screen.getByText(m.charging_live_session_kwh({ kwh: '12,0' }))).toBeVisible()
})

test.each([
  ['disconnected', m.charging_live_mode_disconnected],
  ['connected_requesting', m.charging_live_mode_connected_requesting],
  ['connected_finished', m.charging_live_mode_connected_finished],
  ['unknown', m.charging_live_mode_unknown],
] as const)('%s: shows its label and no power reading', async (mode, label) => {
  const live: Live = { mode, powerKw: 0, sessionKwh: null, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusTile live={live} />)
  await expect.element(screen.getByText(label())).toBeVisible()
  expect(screen.getByText(/kW$/).elements()).toHaveLength(0)
})

test('null (no charger / Zaptec unavailable): says live status is unavailable', async () => {
  const { screen } = await renderWithProviders(<LiveStatusTile live={null} />)
  await expect.element(screen.getByText(m.charging_live_unavailable())).toBeVisible()
})

test('undefined (loading): renders the title without a reading', async () => {
  const { screen } = await renderWithProviders(<LiveStatusTile live={undefined} />)
  await expect.element(screen.getByText(m.charging_live_title())).toBeVisible()
  expect(screen.getByText(m.charging_live_unavailable()).elements()).toHaveLength(0)
})
