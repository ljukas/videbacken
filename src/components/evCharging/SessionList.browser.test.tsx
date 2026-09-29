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
      // Priced, so the cost cell isn't a second dash.
      costs={new Map([['s1', priced]])}
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

type SessionCost = RouterOutputs['evCharging']['sessionCosts'][number]
const priced: SessionCost = {
  sessionId: 's1',
  estimated: false,
  kwh: 14.26,
  gridKwh: 14.26,
  fullKwh: 14.26,
  noPriceKwh: 0,
  noTariffKwh: 0,
  spotSek: 8.97,
  feesSek: 13.71,
  totalSek: 22.68,
  avgOre: 159,
  complete: true,
}

function renderWithCost(cost: SessionCost | undefined) {
  return renderWithProviders(
    <div style={{ width: 1024 }}>
      <SessionList
        sessions={[session]}
        hasMore={false}
        onShowMore={noop}
        loadingMore={false}
        costs={new Map(cost ? [[cost.sessionId, cost]] : [])}
      />
    </div>,
  )
}

test('a priced session shows its total and spot share in kronor', async () => {
  const { screen } = await renderWithCost(priced)
  await expect.element(screen.getByText(/22,68\s?kr/)).toBeVisible()
  await expect.element(screen.getByText(/spot 8,97\s?kr/)).toBeVisible()
})

test('an estimated session is marked ≈ with the reason', async () => {
  const { screen } = await renderWithCost({ ...priced, estimated: true })
  await expect.element(screen.getByText(/≈/)).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_sessions_cost_estimated(), { exact: false }))
    .toBeInTheDocument()
})

test('an unpriced or not-yet-loaded session shows a dash, never 0 kr', async () => {
  const unpriced = await renderWithCost({ ...priced, complete: false, totalSek: 0 })
  await expect
    .element(unpriced.screen.getByText(m.charging_sessions_cost_unknown(), { exact: false }))
    .toBeInTheDocument()
  expect(unpriced.screen.getByText(/0,00\s?kr/).elements()).toHaveLength(0)
})
