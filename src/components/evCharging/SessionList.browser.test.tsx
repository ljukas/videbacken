import { expect, test, vi } from 'vitest'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithRouter } from '~test/browser/render'
import { formatDate, formatTime } from './format'
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
  vehicle: 'ours',
}

const noop = () => {}

test('empty (admin): the shared Empty state with a "Synka nu" CTA', async () => {
  const onSync = vi.fn()
  const { screen } = await renderWithRouter(
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
  const { screen } = await renderWithRouter(
    <SessionList sessions={[]} hasMore={false} onShowMore={noop} loadingMore={false} />,
  )
  await expect.element(screen.getByText(m.charging_sessions_empty_title())).toBeVisible()
  expect(screen.getByRole('button', { name: m.charging_sync_now() }).elements()).toHaveLength(0)
})

test('empty: an emptyTitle override replaces the default title', async () => {
  const { screen } = await renderWithRouter(
    <SessionList
      sessions={[]}
      hasMore={false}
      onShowMore={noop}
      loadingMore={false}
      emptyTitle={m.charging_vehicle_sessions_empty_other()}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_sessions_empty_other())).toBeVisible()
  expect(screen.getByText(m.charging_sessions_empty_title()).elements()).toHaveLength(0)
})

test('populated: date, Stockholm start–end, duration, kWh and peak kW', async () => {
  const { screen } = await renderWithRouter(
    <div style={{ width: 1024 }}>
      <SessionList sessions={[session]} hasMore={false} onShowMore={noop} loadingMore={false} />
    </div>,
  )
  await expect.element(screen.getByRole('cell', { name: '18:05–20:20', exact: true })).toBeVisible()
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
  const { screen } = await renderWithRouter(
    <SessionList
      sessions={[{ ...session, peakKw: null }]}
      hasMore={false}
      onShowMore={noop}
      loadingMore={false}
      // Priced, so the cost cell isn't a second dash.
      costs={{ byId: new Map([['s1', priced]]), pending: false }}
    />,
  )
  await expect.element(screen.getByRole('cell', { name: '—' })).toBeInTheDocument()
})

test('"Visa fler" appears while hasMore and asks for more', async () => {
  const onShowMore = vi.fn()
  const { screen } = await renderWithRouter(
    <SessionList sessions={[session]} hasMore onShowMore={onShowMore} loadingMore={false} />,
  )
  await screen.getByRole('button', { name: m.charging_sessions_show_more() }).click()
  expect(onShowMore).toHaveBeenCalledOnce()
})

test('"Visa fler" is disabled while the next page loads', async () => {
  const { screen } = await renderWithRouter(
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

function renderWithCost(cost: SessionCost | undefined, pending = false) {
  return renderWithRouter(
    <div style={{ width: 1024 }}>
      <SessionList
        sessions={[session]}
        hasMore={false}
        onShowMore={noop}
        loadingMore={false}
        costs={{ byId: new Map(cost ? [[cost.sessionId, cost]] : []), pending }}
      />
    </div>,
  )
}

test('a priced session shows its total and spot share in kronor', async () => {
  const { screen } = await renderWithCost(priced)
  await expect.element(screen.getByText(/22,68\s?kr/)).toBeVisible()
  await expect.element(screen.getByText(/varav spotpris 8,97\s?kr/)).toBeVisible()
})

test('an estimated session is marked ≈ with the reason', async () => {
  const { screen } = await renderWithCost({ ...priced, estimated: true })
  await expect.element(screen.getByText('≈', { exact: false }).first()).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_sessions_cost_estimated(), { exact: false }))
    .toBeInTheDocument()
})

test('an unpriced session shows a dash with the reason, never 0 kr', async () => {
  const unpriced = await renderWithCost({ ...priced, complete: false, totalSek: 0 })
  // The dash carries its reason on hover (title) and for screen readers (sr-only).
  const dash = unpriced.screen.getByTitle(m.charging_sessions_cost_unknown())
  await expect.element(dash).toHaveTextContent(`— ${m.charging_sessions_cost_unknown()}`)
  expect(unpriced.screen.getByText(/0,00\s?kr/).elements()).toHaveLength(0)
})

test('an unpriced session adds the — legend under the table; a priced one does not', async () => {
  const unpriced = await renderWithCost({ ...priced, complete: false, totalSek: 0 })
  await expect
    .element(unpriced.screen.getByText(m.charging_sessions_cost_legend_missing(), { exact: true }))
    .toBeVisible()
})

test('a priced session has no — legend', async () => {
  const { screen } = await renderWithCost(priced)
  await expect.element(screen.getByText(/22,68\s?kr/)).toBeVisible()
  expect(
    screen.getByText(m.charging_sessions_cost_legend_missing(), { exact: true }).elements(),
  ).toHaveLength(0)
})

test('a session whose cost is still loading shows a placeholder, not the missing dash', async () => {
  const { screen } = await renderWithCost(undefined, true)
  await expect.element(screen.getByText(m.charging_sessions_cost_loading())).toBeInTheDocument()
  expect(
    screen.getByText(m.charging_sessions_cost_unknown(), { exact: false }).elements(),
  ).toHaveLength(0)
})

test('a session missing from loaded costs (e.g. the query failed) says the cost is missing', async () => {
  const { screen } = await renderWithCost(undefined, false)
  await expect
    .element(screen.getByText(m.charging_sessions_cost_unknown(), { exact: false }))
    .toBeInTheDocument()
})

test('an estimated session adds the ≈ legend under the table', async () => {
  const { screen } = await renderWithCost({ ...priced, estimated: true })
  await expect.element(screen.getByText(m.charging_sessions_cost_legend())).toBeVisible()
})

test('a priced, measured session has no ≈ legend', async () => {
  const { screen } = await renderWithCost(priced)
  await expect.element(screen.getByText(/22,68\s?kr/)).toBeVisible()
  expect(screen.getByText(m.charging_sessions_cost_legend()).elements()).toHaveLength(0)
})

test('without cost (nothing priced yet) there is no cost column', async () => {
  const { screen } = await renderWithRouter(
    <SessionList sessions={[session]} hasMore={false} onShowMore={noop} loadingMore={false} />,
  )
  expect(screen.getByText(m.charging_sessions_col_cost(), { exact: true }).elements()).toHaveLength(
    0,
  )
})

// The browser-test env has no Tailwind, so the phone layout is pinned by its
// classes: the time column hides below `sm` and repeats under the date there,
// and the spot sub-line is `sm`-up only.
test('on a phone the time moves under the date and the spot line hides', async () => {
  const { screen } = await renderWithCost(priced)
  const timeHeader = screen.getByText(m.charging_sessions_col_time(), { exact: true })
  expect(timeHeader.element().className).toMatch(/\bhidden\b.*\bsm:table-cell\b/)
  const dateCell = screen.getByRole('row').nth(1).getByRole('cell').first().element()
  expect(dateCell.querySelector('.sm\\:hidden')?.textContent).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/)
  const spot = screen.getByText(/varav spotpris 8,97\s?kr/).element()
  expect(spot.className).toMatch(/\bhidden\b.*\bsm:inline\b/)
})

test('the date links to the session page', async () => {
  const { screen } = await renderWithRouter(
    <SessionList sessions={[session]} hasMore={false} onShowMore={noop} loadingMore={false} />,
  )
  const link = screen.getByRole('link', {
    name: m.charging_session_link_label({
      date: formatDate(session.startAt),
      time: formatTime(session.startAt),
    }),
  })
  await expect.element(link).toHaveAttribute('href', '/charging/sessions/s1')
})

test('a guest session carries the Gäst badge; our own does not', async () => {
  const { screen } = await renderWithRouter(
    <SessionList
      sessions={[session, { ...session, id: 's2', vehicle: 'other' }]}
      hasMore={false}
      onShowMore={noop}
      loadingMore={false}
    />,
  )
  await expect.element(screen.getByText(m.charging_vehicle_guest_badge())).toBeVisible()
  expect(screen.getByText(m.charging_vehicle_guest_badge()).elements()).toHaveLength(1)
})
