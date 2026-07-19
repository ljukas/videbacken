import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('renders one line per visible device with stable per-device colors', async () => {
  const { screen } = await renderWithProviders(
    // A fixed-size wrapper so Recharts' ResponsiveContainer has a box to measure.
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        title="Temperature over time"
        rows={[
          { t: 1000, a: 20, b: 25, c: 30 },
          { t: 2000, a: 21, b: 26, c: 31 },
        ]}
        devices={[
          { id: 'a', displayName: 'NW corner', color: 'var(--chart-1)' },
          { id: 'b', displayName: 'Kitchen', color: 'var(--chart-2)' },
          { id: 'c', displayName: 'Boiler', color: 'var(--chart-3)', hidden: true },
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
    const paths = [...curves].map((p) => p.getAttribute('d'))
    expect(new Set(paths).size).toBe(2) // distinct dataKeys, not one line drawn twice
  })

  // Each device gets its OWN stable color CSS var from the config (proves the
  // per-device color wiring, which the legend text alone can't catch).
  const style = screen.container.querySelector('style')?.textContent ?? ''
  expect(style).toContain('--color-a: var(--chart-1)')
  expect(style).toContain('--color-b: var(--chart-2)')
})
