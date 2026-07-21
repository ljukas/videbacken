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
