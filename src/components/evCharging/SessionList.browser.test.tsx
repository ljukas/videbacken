import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SessionList } from './SessionList'

type Session = RouterOutputs['evCharging']['sessions']['sessions'][number]

// 2026-09-27 18:05 → 20:20 Stockholm (CEST, UTC+2).
const session: Session = {
  id: 's1',
  startAt: new Date('2026-09-27T16:05:00Z'),
  endAt: new Date('2026-09-27T18:20:00Z'),
  energyKwh: 14.26,
  peakKw: 7.2,
  offline: false,
  reliableClock: true,
}

const noop = () => {}

test('empty (admin): the shared Empty state with a "Synka nu" CTA', async () => {
  const onSync = vi.fn()
  const { screen } = await renderWithProviders(
    <SessionList
      sessions={[]}
      hasMore={false}
      onShowMore={noop}
      loadingMore={false}
      onSync={onSync}
    />,
  )
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  await screen.getByRole('button', { name: m.charging_sync_now() }).click()
  expect(onSync).toHaveBeenCalledOnce()
  expect(screen.getByRole('table').elements()).toHaveLength(0)
})

test('empty (non-admin): no CTA', async () => {
  const { screen } = await renderWithProviders(
    <SessionList sessions={[]} hasMore={false} onShowMore={noop} loadingMore={false} />,
  )
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(0)
})

test('populated: date, Stockholm start–end, duration, kWh and peak kW', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1024 }}>
      <SessionList sessions={[session]} hasMore={false} onShowMore={noop} loadingMore={false} />
    </div>,
  )
  await expect.element(screen.getByRole('cell', { name: '18:05–20:20' })).toBeVisible()
  await expect
    .element(
      screen.getByRole('cell', {
        name: m.charging_duration_hours_minutes({ hours: 2, minutes: 15 }),
      }),
    )
    .toBeInTheDocument()
  await expect.element(screen.getByRole('cell', { name: '14,3 kWh' })).toBeVisible()
  await expect.element(screen.getByRole('cell', { name: '7,2 kW' })).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: m.charging_sessions_show_more() }).elements(),
  ).toHaveLength(0)
})

test('a session without intervals shows an em-dash for peak power', async () => {
  const { screen } = await renderWithProviders(
    <SessionList
      sessions={[{ ...session, peakKw: null }]}
      hasMore={false}
      onShowMore={noop}
      loadingMore={false}
    />,
  )
  await expect.element(screen.getByRole('cell', { name: '—' })).toBeInTheDocument()
})

test('"Visa fler" appears while hasMore and asks for more', async () => {
  const onShowMore = vi.fn()
  const { screen } = await renderWithProviders(
    <SessionList sessions={[session]} hasMore onShowMore={onShowMore} loadingMore={false} />,
  )
  await screen.getByRole('button', { name: m.charging_sessions_show_more() }).click()
  expect(onShowMore).toHaveBeenCalledOnce()
})

test('"Visa fler" is disabled while the next page loads', async () => {
  const { screen } = await renderWithProviders(
    <SessionList sessions={[session]} hasMore onShowMore={noop} loadingMore />,
  )
  await expect
    .element(screen.getByRole('button', { name: m.charging_sessions_show_more() }))
    .toBeDisabled()
})
