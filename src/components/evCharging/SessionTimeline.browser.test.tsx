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
const daytime: TimelineSession = {
  // Mon 14 Sep 09:39-14:46 CEST: a solar-hours charge, inside its own day
  id: 'day',
  startAt: d('2026-09-14T07:39:00Z'),
  endAt: d('2026-09-14T12:46:00Z'),
  energyKwh: 15,
  chargingHours: 4,
  hourly: true,
  segments: [
    { startAt: d('2026-09-14T07:39:00Z'), endAt: d('2026-09-14T11:39:00Z'), kind: 'charging' },
    { startAt: d('2026-09-14T11:39:00Z'), endAt: d('2026-09-14T12:46:00Z'), kind: 'idle' },
  ],
}
const long: TimelineSession = {
  // plugged Fri 18:00 -> Sun 10:00: past its day's midnight
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
        sessions={[overnight, daytime, long, noHourly]}
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

test('a session past midnight is clipped with a chevron, never overflowing the track', async () => {
  const { screen } = await render()
  // overnight, long and noHourly end the next day; daytime does not.
  await expect
    .poll(() => screen.container.querySelectorAll('[data-clipped="right"]').length)
    .toBe(3)
  expect(screen.container.querySelectorAll('[data-clipped="left"]').length).toBe(0)
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

test('a clipped row draws a marker and announces that it continues past midnight', async () => {
  const { screen } = await render({ sessions: [long] })
  await expect
    .poll(() => screen.container.querySelectorAll('path[data-clipped="right"]').length)
    .toBe(1)
  await expect
    .element(screen.getByText(/laddar 2,0 h av 40,0 h inkopplad · fortsätter efter midnatt/))
    .toBeInTheDocument()
  await expect.element(screen.getByText(/^› fortsätter efter midnatt · Zaptec/)).toBeInTheDocument()
})

test('a daytime session sits mid-row, unclipped, and the clip note is left out', async () => {
  const { screen } = await render({ sessions: [daytime] })
  await expect.poll(() => screen.container.querySelector('rect[data-segment]')).not.toBeNull()
  expect(screen.container.querySelectorAll('[data-clipped]').length).toBe(0)
  expect(screen.container.textContent).not.toContain('fortsätter efter midnatt')
  await expect.element(screen.getByText(/^Zaptec rapporterar/)).toBeInTheDocument()
  const charging = screen.container.querySelector('rect[data-segment="charging"]') as SVGRectElement
  const trackW = Number(charging.closest('svg')?.getAttribute('width'))
  // 09:39 on a 24 h day
  expect(Number(charging.getAttribute('x'))).toBeCloseTo(((9 + 39 / 60) / 24) * trackW, 3)
  expect(Number(charging.getAttribute('width'))).toBeCloseTo((4 / 24) * trackW, 3)
})

test('the label column fits a full row label on one line at desktop width', async () => {
  const { screen } = await render({ sessions: [daytime] })
  const label = screen.getByText('mån 14 sep. · 09:39–14:46 · 15,0 kWh')
  await expect.element(label).toBeInTheDocument()
  // No Tailwind in the browser project: pin the column's inline width.
  expect((label.element().parentElement as HTMLElement).style.width).toBe('240px')
})

test('the axis runs 00 to 24 in 3 h steps', async () => {
  const { screen } = await render({ sessions: [daytime] })
  await expect.poll(() => screen.container.querySelectorAll('svg text').length).toBe(9)
  const ticks = [...screen.container.querySelectorAll('svg text')].map((t) => t.textContent)
  expect(ticks).toEqual(['00', '03', '06', '09', '12', '15', '18', '21', '24'])
})

test('the night band is 00-06 and 22-24 of its day', async () => {
  const { screen } = await render({ sessions: [daytime] })
  await expect.poll(() => screen.container.querySelectorAll('rect[data-night]').length).toBe(2)
  const morning = screen.container.querySelector('rect[data-night="morning"]') as SVGRectElement
  const evening = screen.container.querySelector('rect[data-night="evening"]') as SVGRectElement
  const trackW = Number(morning.closest('svg')?.getAttribute('width'))
  expect(Number(morning.getAttribute('x'))).toBe(0)
  expect(Number(morning.getAttribute('width'))).toBeCloseTo((6 / 24) * trackW, 3)
  expect(Number(evening.getAttribute('x'))).toBeCloseTo((22 / 24) * trackW, 3)
  expect(Number(evening.getAttribute('width'))).toBeCloseTo((2 / 24) * trackW, 3)
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

test('the night band sits at the true instants on a spring-forward day', async () => {
  // Sun 29 Mar 2026 is 23 h long: 00:00 CET (23:00Z) -> 24:00 CEST (22:00Z).
  const dst: TimelineSession = {
    ...overnight,
    id: 'dst',
    startAt: d('2026-03-29T06:00:00Z'),
    endAt: d('2026-03-29T10:00:00Z'),
    segments: [
      { startAt: d('2026-03-29T06:00:00Z'), endAt: d('2026-03-29T10:00:00Z'), kind: 'idle' },
    ],
  }
  const { screen } = await render({ sessions: [dst], month: 3, months: [3] })
  await expect.poll(() => screen.container.querySelectorAll('rect[data-night]').length).toBe(2)
  const morning = screen.container.querySelector('rect[data-night="morning"]') as SVGRectElement
  const evening = screen.container.querySelector('rect[data-night="evening"]') as SVGRectElement
  const trackW = Number(morning.closest('svg')?.getAttribute('width'))
  // 00:00-06:00 CEST is 5 true hours; 22:00-24:00 starts 21 h in.
  expect(Number(morning.getAttribute('x'))).toBe(0)
  expect(Number(morning.getAttribute('width'))).toBeCloseTo((5 / 23) * trackW, 3)
  expect(Number(evening.getAttribute('x'))).toBeCloseTo((21 / 23) * trackW, 3)
  expect(Number(evening.getAttribute('width'))).toBeCloseTo((2 / 23) * trackW, 3)
})
