import { expect, test, vi } from 'vitest'
import type { TimelineSession } from '~/lib/evCharging/patterns'
import { renderWithProviders } from '~test/browser/render'
import { SessionTimeline } from './SessionTimeline'

const d = (iso: string) => new Date(iso)
const overnight: TimelineSession = {
  id: 'a',
  startAt: d('2026-09-05T19:10:00Z'),
  endAt: d('2026-09-06T05:02:00Z'),
  energyKwh: 32.1,
  chargingHours: 3,
  hourly: true,
  segments: [
    { startAt: d('2026-09-05T19:10:00Z'), endAt: d('2026-09-05T22:10:00Z'), kind: 'charging' },
    { startAt: d('2026-09-05T22:10:00Z'), endAt: d('2026-09-06T05:02:00Z'), kind: 'idle' },
  ],
}
const long: TimelineSession = {
  // plugged Fri 18:00 -> Sun 10:00: past the row's 12:00 edge
  id: 'b',
  startAt: d('2026-09-11T16:00:00Z'),
  endAt: d('2026-09-13T08:00:00Z'),
  energyKwh: 20,
  chargingHours: 2,
  hourly: true,
  segments: [
    { startAt: d('2026-09-11T16:00:00Z'), endAt: d('2026-09-11T18:00:00Z'), kind: 'charging' },
    { startAt: d('2026-09-11T18:00:00Z'), endAt: d('2026-09-13T08:00:00Z'), kind: 'idle' },
  ],
}
const noHourly: TimelineSession = {
  ...overnight,
  id: 'c',
  hourly: false,
  chargingHours: 0,
  segments: [{ startAt: overnight.startAt, endAt: overnight.endAt, kind: 'idle' }],
}
const zeroLength: TimelineSession = {
  ...overnight,
  id: 'z',
  endAt: overnight.startAt,
  hourly: false,
  chargingHours: 0,
  segments: [],
}

const render = (props: Partial<Parameters<typeof SessionTimeline>[0]> = {}) =>
  renderWithProviders(
    <div style={{ width: 900 }}>
      <SessionTimeline
        sessions={[overnight, long, noHourly]}
        year={2026}
        month={9}
        months={[8, 9]}
        onMonth={() => {}}
        {...props}
      />
    </div>,
  )

test('one row per session with real local times and the charging summary', async () => {
  const { screen } = await render()
  await expect.element(screen.getByText(/21:10–07:02/).first()).toBeInTheDocument()
  await expect.element(screen.getByText(/lör 5 sep/).first()).toBeInTheDocument()
  await expect.element(screen.getByText(/laddar 3,0 h av 9,9 h inkopplad/)).toBeInTheDocument()
})

test('a session past the 12:00 edge is clipped with a chevron, never overflowing the track', async () => {
  const { screen } = await render()
  await expect
    .poll(() => screen.container.querySelectorAll('[data-clipped="right"]').length)
    .toBe(1)
  for (const bar of screen.container.querySelectorAll<SVGRectElement>('rect[data-segment]')) {
    const x = Number(bar.getAttribute('x'))
    const w = Number(bar.getAttribute('width'))
    expect(x).toBeGreaterThanOrEqual(0)
    expect(w).toBeGreaterThanOrEqual(0)
  }
})

test('an interval-less session says it has no hourly data', async () => {
  const { screen } = await render()
  await expect.element(screen.getByText('ingen timdata')).toBeInTheDocument()
})

test('a zero-length session keeps its label and draws no bar', async () => {
  const { screen } = await render({ sessions: [zeroLength] })
  await expect.element(screen.getByText(/21:10–21:10/)).toBeInTheDocument()
  await expect.poll(() => screen.container.querySelectorAll('svg').length).toBeGreaterThan(0)
  expect(screen.container.querySelectorAll('rect[data-segment]').length).toBe(0)
  expect(screen.container.innerHTML).not.toContain('NaN')
})

test('the stepper moves between months with sessions and stops at the ends', async () => {
  const onMonth = vi.fn()
  const { screen } = await render({ onMonth })
  await expect.element(screen.getByRole('button', { name: 'Nästa månad' })).toBeDisabled()
  await screen.getByRole('button', { name: 'Föregående månad' }).click()
  expect(onMonth).toHaveBeenCalledWith(8)
})

test('an empty month shows the empty line and keeps the stepper', async () => {
  const { screen } = await render({ sessions: [], month: 12, months: [8, 9] })
  await expect.element(screen.getByText(/Inga laddningar i december/)).toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: 'Föregående månad' })).toBeEnabled()
  await expect.element(screen.getByRole('button', { name: 'Nästa månad' })).toBeDisabled()
})

test('with no months at all both buttons are disabled', async () => {
  const { screen } = await render({ sessions: [], months: [] })
  await expect.element(screen.getByRole('button', { name: 'Föregående månad' })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: 'Nästa månad' })).toBeDisabled()
})

test('an empty month uses the shared Empty', async () => {
  const { screen } = await render({ sessions: [] })
  await expect.poll(() => screen.container.querySelector('[data-slot="empty"]')).not.toBeNull()
})

test('a clipped row draws a marker and announces that it continues', async () => {
  const { screen } = await render()
  await expect
    .poll(() => screen.container.querySelectorAll('path[data-clipped="right"]').length)
    .toBe(1)
  await expect.element(screen.getByText(/fortsätter efter 12:00/)).toBeInTheDocument()
})

test('the rows are a list and the month label is a polite live region', async () => {
  const { screen } = await render()
  await expect.element(screen.getByRole('list')).toBeInTheDocument()
  expect(screen.container.querySelector('[aria-live="polite"]')?.textContent).toMatch(
    /september 2026/i,
  )
})

test('a five-minute charge is still at least 2 px wide', async () => {
  const short: TimelineSession = {
    ...overnight,
    id: 's',
    segments: [
      { startAt: d('2026-09-05T19:10:00Z'), endAt: d('2026-09-05T19:15:00Z'), kind: 'charging' },
      { startAt: d('2026-09-05T19:15:00Z'), endAt: d('2026-09-06T05:02:00Z'), kind: 'idle' },
    ],
  }
  const { screen } = await render({ sessions: [short] })
  await expect
    .poll(() => screen.container.querySelector('rect[data-segment="charging"]'))
    .not.toBeNull()
  const w = Number(
    screen.container.querySelector('rect[data-segment="charging"]')?.getAttribute('width'),
  )
  expect(w).toBeGreaterThanOrEqual(2)
})

test('the night band sits at the true 22:00-06:00 instants on a spring-forward row', async () => {
  // Sat 28 Mar 2026 12:00 CET -> Sun 29 Mar 12:00 CEST is a 23 h row.
  const dst: TimelineSession = {
    ...overnight,
    id: 'dst',
    startAt: d('2026-03-28T20:00:00Z'),
    endAt: d('2026-03-29T06:00:00Z'),
    segments: [
      { startAt: d('2026-03-28T20:00:00Z'), endAt: d('2026-03-29T06:00:00Z'), kind: 'idle' },
    ],
  }
  const { screen } = await render({ sessions: [dst], month: 3, months: [3] })
  await expect.poll(() => screen.container.querySelector('rect[data-night]')).not.toBeNull()
  const band = screen.container.querySelector('rect[data-night]') as SVGRectElement
  const trackW = Number(band.closest('svg')?.getAttribute('width'))
  // Row: 11:00Z -> 10:00Z (23 h). Night: 21:00Z -> 04:00Z (7 h, starting 10 h in).
  expect(Number(band.getAttribute('x'))).toBeCloseTo((10 / 23) * trackW, 3)
  expect(Number(band.getAttribute('width'))).toBeCloseTo((7 / 23) * trackW, 3)
})
