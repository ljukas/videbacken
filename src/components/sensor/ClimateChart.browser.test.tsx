import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('renders one line per visible device with stable per-device colors', async () => {
  const { screen } = await renderWithProviders(
    // A fixed-size wrapper so Recharts' ResponsiveContainer has a box to measure.
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
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

test('draws a connected line per device when series interleave with no shared buckets', async () => {
  // Real-world shape: two battery sensors reporting on independent schedules never
  // land in the same time bucket, so the wide-format pivot interleaves them — every
  // row has exactly ONE device non-null and the other null. Regression test for the
  // prod "data points exist but no line renders" bug: with the nulls left
  // unbridged, each real point is an isolated zero-length "M x,y Z" subpath that
  // (with dots off) draws nothing.
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        rows={[
          { t: 1, a: 20, b: null },
          { t: 2, a: null, b: 25 },
          { t: 3, a: 21, b: null },
          { t: 4, a: null, b: 26 },
        ]}
        devices={[
          { id: 'a', displayName: 'Sensor A', color: 'var(--chart-1)' },
          { id: 'b', displayName: 'Sensor B', color: 'var(--chart-2)' },
        ]}
        unit="°C"
        formatTick={(t) => new Date(t).toISOString()}
      />
    </div>,
  )

  // Every visible device must render an actual drawn segment. A real line contains
  // a line/curve command (L or C); the broken state emits only isolated "M …, Z"
  // move+close subpaths (no L/C) — which is invisible.
  await vi.waitFor(() => {
    const curves = screen.container.querySelectorAll('.recharts-line-curve')
    expect(curves.length).toBe(2)
    for (const curve of curves) {
      const d = curve.getAttribute('d') ?? ''
      expect(d).toMatch(/[CL]/)
    }
  })
})
