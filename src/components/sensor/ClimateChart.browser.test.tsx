import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('renders one line per visible device with stable per-device colors', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'NW corner',
            color: 'var(--chart-1)',
            points: [
              { t: 1, a: 20 },
              { t: 2, a: 21 },
            ],
          },
          {
            id: 'b',
            displayName: 'Kitchen',
            color: 'var(--chart-2)',
            points: [
              { t: 1, b: 25 },
              { t: 2, b: 26 },
            ],
          },
          {
            id: 'c',
            displayName: 'Boiler',
            color: 'var(--chart-3)',
            hidden: true,
            points: [
              { t: 1, c: 30 },
              { t: 2, c: 31 },
            ],
          },
        ]}
        unit="°C"
        formatTick={(t) => new Date(t).toISOString()}
      />
    </div>,
  )

  // Legend echoes a visible device's name.
  await expect.element(screen.getByText('NW corner')).toBeVisible()

  // Two visible devices → two distinct line curves; the hidden one renders none.
  await vi.waitFor(() => {
    const curves = screen.container.querySelectorAll('.recharts-line-curve')
    expect(curves.length).toBe(2)
    for (const curve of curves) expect(curve.getAttribute('d') ?? '').toMatch(/[CL]/)
  })

  // Each device gets its OWN stable color CSS var from the config.
  const style = screen.container.querySelector('style')?.textContent ?? ''
  expect(style).toContain('--color-a: var(--chart-1)')
  expect(style).toContain('--color-b: var(--chart-2)')
})

test('breaks the line at an outage marker while keeping each cluster connected', async () => {
  // A device offline mid-window: a null break marker separates two clusters. With
  // connectNulls off, the path splits into two move-to sub-paths (a visible gap),
  // and neither cluster endpoint is isolated, so no dots.
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'Sensor A',
            color: 'var(--chart-1)',
            points: [
              { t: 0, a: 20 },
              { t: 1, a: 21 },
              { t: 5, a: null },
              { t: 9, a: 22 },
              { t: 10, a: 23 },
            ],
          },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  await vi.waitFor(() => {
    const d = screen.container.querySelector('.recharts-line-curve')?.getAttribute('d') ?? ''
    expect((d.match(/M/gi) || []).length).toBe(2) // two segments, gap between
    expect(d).toMatch(/[CL]/) // each cluster is a real drawn segment
    expect(screen.container.querySelectorAll('.recharts-dot').length).toBe(0)
  })
})

test('x-axis spans hidden devices so toggling a device does not rescale time', async () => {
  // A hidden device with the widest time span must still bound the x-axis, so
  // toggling visibility never rescales the time axis. Device A (hidden) spans
  // 0–1000; device B (visible) only 400–500. The axis must still reach past 500.
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'A',
            color: 'var(--chart-1)',
            hidden: true,
            points: [
              { t: 0, a: 1 },
              { t: 1000, a: 2 },
            ],
          },
          {
            id: 'b',
            displayName: 'B',
            color: 'var(--chart-2)',
            points: [
              { t: 400, b: 3 },
              { t: 500, b: 4 },
            ],
          },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  // The visible device B (t=400–500) is the only rendered line. If the axis domain
  // spans the hidden device (0–1000), B's segment sits mid-axis (first x well right
  // of the left edge, ~48px). If the domain wrongly rescaled to B's own 400–500,
  // its first point would pin to the left edge instead.
  await vi.waitFor(() => {
    const d = screen.container.querySelector('.recharts-line-curve')?.getAttribute('d') ?? ''
    const firstX = Number(d.match(/M([\d.]+)/)?.[1])
    expect(firstX).toBeGreaterThan(100)
  })
})

test('renders a dot for an isolated reading so it is not invisible', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'Sensor A',
            color: 'var(--chart-1)',
            points: [{ t: 5, a: 20, isolated: true }],
          },
          {
            id: 'b',
            displayName: 'Sensor B',
            color: 'var(--chart-2)',
            points: [
              { t: 1, b: 30 },
              { t: 2, b: 31 },
            ],
          },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  // Only the isolated reading draws a dot; the continuous line draws none.
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('.recharts-dot').length).toBe(1)
  })
})
