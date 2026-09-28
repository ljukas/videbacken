import { beforeEach, expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { LiveStatusTile, useLiveStatus } from './LiveStatusTile'

// Mock the oRPC client so `useLiveStatus` runs a scripted query function.
const { liveFn } = vi.hoisted(() => ({ liveFn: vi.fn() }))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    evCharging: {
      liveStatus: {
        queryOptions: () => ({ queryKey: ['evCharging', 'liveStatus'], queryFn: liveFn }),
      },
    },
  },
}))

beforeEach(() => {
  liveFn.mockReset()
})

function Harness() {
  return <LiveStatusTile live={useLiveStatus()} />
}

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

test('a failed liveStatus request shows unavailable instead of an endless skeleton', async () => {
  liveFn.mockRejectedValue(new Error('network down'))
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_live_unavailable())).toBeVisible()
})

test('a successful liveStatus request renders the reading', async () => {
  liveFn.mockResolvedValue({ mode: 'charging', powerKw: 7.36, sessionKwh: null, observedAt })
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText('7,4 kW')).toBeVisible()
})
