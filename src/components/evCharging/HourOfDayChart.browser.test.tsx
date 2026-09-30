import { expect, test, vi } from 'vitest'
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
    // Hour 0 is 0 kWh: Recharts omits a zero-height rectangle, so 23 of 24.
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(23)
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

test('stays readable at 320 px', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 320 }}>
      <HourOfDayChart hours={hours} metric="plugged" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0)
  })
  const svg = screen.container.querySelector('svg.recharts-surface')
  expect(svg?.getBoundingClientRect().width).toBeLessThanOrEqual(320)
  // Narrow: a tick every 6 h (00, 06, 12, 18), not every 3.
  await vi.waitFor(() => {
    expect(
      screen.container.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick'),
    ).toHaveLength(4)
  })
})
