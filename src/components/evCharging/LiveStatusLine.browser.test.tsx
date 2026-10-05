import { beforeEach, expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { LiveStatusLine, useLiveStatus } from './LiveStatusLine'

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
  return <LiveStatusLine live={useLiveStatus()} />
}

type Live = NonNullable<RouterOutputs['evCharging']['liveStatus']>

const observedAt = new Date('2026-09-28T10:00:00Z')

test('charging: shows the mode, power and session energy', async () => {
  const live: Live = { mode: 'charging', powerKw: 7.36, sessionKwh: 12.04, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
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
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(label())).toBeVisible()
  expect(screen.getByText(/kW$/).elements()).toHaveLength(0)
})

test('null (no charger / Zaptec unavailable): says live status is unavailable', async () => {
  const { screen } = await renderWithProviders(<LiveStatusLine live={null} />)
  await expect.element(screen.getByText(m.charging_live_unavailable())).toBeVisible()
})

test('undefined (loading): names the line without a reading', async () => {
  const { screen } = await renderWithProviders(<LiveStatusLine live={undefined} />)
  // The name is screen-reader-only text (no app CSS in tests, so it is in the DOM).
  await expect
    .element(screen.getByText(m.charging_live_title(), { exact: false }))
    .toBeInTheDocument()
  expect(screen.getByText(m.charging_live_unavailable()).elements()).toHaveLength(0)
  expect(screen.getByText(m.charging_live_mode_disconnected()).elements()).toHaveLength(0)
})

test('every state carries the line’s name for a screen reader', async () => {
  const live: Live = { mode: 'disconnected', powerKw: 0, sessionKwh: null, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect
    .element(screen.getByText(m.charging_live_title(), { exact: false }))
    .toBeInTheDocument()
})

test('connected, waiting: shows the session energy but no power', async () => {
  const live: Live = { mode: 'connected_requesting', powerKw: 0, sessionKwh: 3.14, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(m.charging_live_mode_connected_requesting())).toBeVisible()
  await expect.element(screen.getByText(m.charging_live_session_kwh({ kwh: '3,1' }))).toBeVisible()
  expect(screen.getByText(/kW$/).elements()).toHaveLength(0)
})

test('disconnected: never shows a leftover session energy', async () => {
  const live: Live = { mode: 'disconnected', powerKw: 0, sessionKwh: 9.9, observedAt }
  const { screen } = await renderWithProviders(<LiveStatusLine live={live} />)
  await expect.element(screen.getByText(m.charging_live_mode_disconnected())).toBeVisible()
  expect(screen.getByText(m.charging_live_session_kwh({ kwh: '9,9' })).elements()).toHaveLength(0)
})

test('a failed liveStatus request shows unavailable instead of an endless skeleton', async () => {
  liveFn.mockRejectedValue(new Error('network down'))
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_live_unavailable())).toBeVisible()
})

test('stays unavailable, not a skeleton, while a failed liveStatus poll retries', async () => {
  liveFn.mockRejectedValueOnce(new Error('network down')).mockImplementationOnce(
    () => new Promise(() => {}), // the next poll hangs in flight
  )
  const { screen, queryClient } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText(m.charging_live_unavailable())).toBeVisible()
  void queryClient.refetchQueries({ queryKey: ['evCharging', 'liveStatus'] })
  await expect.poll(() => liveFn.mock.calls.length).toBe(2)
  await new Promise((resolve) => setTimeout(resolve, 50)) // let the refetch's render land
  expect(screen.getByText(m.charging_live_unavailable()).elements()).toHaveLength(1)
})

test('a successful liveStatus request renders the reading', async () => {
  liveFn.mockResolvedValue({ mode: 'charging', powerKw: 7.36, sessionKwh: null, observedAt })
  const { screen } = await renderWithProviders(<Harness />)
  await expect.element(screen.getByText('7,4 kW')).toBeVisible()
})
