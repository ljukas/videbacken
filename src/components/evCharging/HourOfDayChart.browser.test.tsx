import { expect, test, vi } from 'vitest'
import {
  barHeight,
  bars,
  chartSvg,
  focusTarget,
  seriesBars,
  xTickLabels,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { HourOfDayChart } from './HourOfDayChart'

const hours = Array.from({ length: 24 }, (_, h) => ({ kwh: h * 2, pluggedHours: h }))

test('renders one bar per hour', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 220 }}>
      <HourOfDayChart hours={hours} metric="kwh" />
    </div>,
  )
  await vi.waitFor(() => {
    // Hour 0 is 0 kWh: a genuine 0 draws no bar, so 23 of 24.
    expect(bars(screen.container)).toHaveLength(23)
  })
})

test('exposes the 24 values in an sr-only table', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <HourOfDayChart hours={hours} metric="kwh" />
    </div>,
  )
  await expect.element(screen.getByRole('cell', { name: '46,0 kWh' })).toBeInTheDocument()
  expect(screen.container.querySelectorAll('tbody tr')).toHaveLength(24)
})

test('hides the chart from assistive tech; the table carries the values', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 720 }}>
      <HourOfDayChart hours={hours} metric="kwh" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(chartSvg(screen.container)).not.toBeNull()
  })
  const svg = chartSvg(screen.container)
  expect(focusTarget(screen.container)).toBeNull()
  expect(svg?.hasAttribute('tabindex')).toBe(false)
  expect(svg?.getAttribute('role')).not.toBe('application')
  // The chart is hidden, with nothing in it to Tab to…
  const hidden = svg?.closest('[aria-hidden="true"]')
  expect(hidden).not.toBeNull()
  expect(hidden?.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull()
  // …but the table is not: it carries the values.
  expect(
    screen.container.querySelector('table.sr-only')?.closest('[aria-hidden="true"]'),
  ).toBeNull()
  expect(screen.container.querySelector('table.sr-only caption')).not.toBeNull()
})

test('stays readable at 320 px', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 320 }}>
      <HourOfDayChart hours={hours} metric="plugged" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(bars(screen.container).length).toBeGreaterThan(0)
  })
  const svg = chartSvg(screen.container)
  expect(svg?.getBoundingClientRect().width).toBeLessThanOrEqual(320)
  // Narrow: a tick every 6 h (00, 06, 12, 18), not every 3.
  await vi.waitFor(() => {
    expect(xTickLabels(screen.container)).toHaveLength(4)
  })
})

test('a tiny real hour keeps a visible bar; a genuine 0 hour stays empty', async () => {
  const sparse = Array.from({ length: 24 }, (_, h) => ({
    kwh: h === 6 ? 100 : h === 5 ? 0.01 : 0,
    pluggedHours: 0,
  }))
  const { screen } = await renderWithProviders(
    <div style={{ width: 720, height: 220 }}>
      <HourOfDayChart hours={sparse} metric="kwh" />
    </div>,
  )
  await vi.waitFor(() => expect(bars(screen.container)).toHaveLength(2))
  const heights = seriesBars(screen.container, 0).map(barHeight)
  expect(heights).toHaveLength(2)
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(2)
})
