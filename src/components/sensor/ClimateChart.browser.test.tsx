import { expect, test, vi } from 'vitest'
import { toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS } from '~/lib/sensor/range'
import type { SeriesBucket } from '~/lib/services/sensor'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart } from './ClimateChart'

test('draws connected lines for hours-apart readings on a coarse range', async () => {
  // End-to-end guard for the epoch-ms gap-threshold bug: buckets → toDeviceSeries
  // → chart. On the 1m range (3h buckets) readings a few hours apart must render
  // as a continuous line, not a scatter of isolated dots.
  const HOUR = 3_600_000
  const t0 = 1_784_000_000_000
  const bucketSec = 3 * 3600
  const buckets: SeriesBucket[] = Array.from({ length: 8 }, (_, i) => ({
    t: t0 + i * 3 * HOUR,
    perDevice: { dev: { tempAvg: 14.4 + (i % 3) * 0.1, humAvg: 80 } },
  }))
  const [series] = toDeviceSeries(buckets, 'temp', {
    bucketSec,
    maxGapBuckets: MAX_GAP_BUCKETS,
    cadenceSec: CADENCE_SEC,
  })

  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          { id: 'dev', displayName: 'Sensor', color: 'var(--chart-1)', points: series.points },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  await vi.waitFor(() => {
    // One continuous curve (a single move-to) with real line segments, and no
    // isolated-reading dots — proof the points connected rather than broke apart.
    const d = screen.container.querySelector('.recharts-line-curve')?.getAttribute('d') ?? ''
    expect((d.match(/M/gi) || []).length).toBe(1)
    expect(d).toMatch(/[CL]/)
    expect(screen.container.querySelectorAll('.recharts-dot').length).toBe(0)
  })
})

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

test('formats y-axis tick labels to one decimal for a narrow value range', async () => {
  // Regression: with a tiny spread (a stable room), Recharts equal-divides the
  // auto-domain into arbitrary fractional ticks (24.595, 24.49, …). Unformatted +
  // the unit those labels overflow the axis and get clipped. Every tick must read
  // as at most one decimal plus the unit, matching the tooltip's precision.
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={[
          {
            id: 'a',
            displayName: 'NW corner',
            color: 'var(--chart-1)',
            points: [
              { t: 1, a: 24.49 },
              { t: 2, a: 24.55 },
              { t: 3, a: 24.58 },
            ],
          },
          {
            id: 'b',
            displayName: 'Kitchen',
            color: 'var(--chart-2)',
            points: [
              { t: 1, b: 24.6 },
              { t: 2, b: 24.55 },
              { t: 3, b: 24.5 },
            ],
          },
        ]}
        unit="°C"
        formatTick={(t) => String(t)}
      />
    </div>,
  )

  await vi.waitFor(() => {
    // Y-axis ticks carry the unit suffix ("24.5°C"); x-axis ticks are bare numbers.
    const yTicks = [...screen.container.querySelectorAll('.recharts-cartesian-axis-tick-value')]
      .map((t) => t.textContent ?? '')
      .filter((text) => text.endsWith('°C'))
    expect(yTicks.length).toBeGreaterThan(1)
    // Distinct labels — rounding must never collapse ticks into repeats.
    expect(new Set(yTicks).size).toBe(yTicks.length)
    // Clean formatting: at most two decimals + the unit, never the arbitrary
    // three-decimal noise ("24.595°C") the auto-domain produced.
    for (const text of yTicks) expect(text).toMatch(/^-?\d+(\.\d{1,2})?°C$/)
    // Evenly spaced on a genuinely "nice" step (1, 2, or 5 × 10ⁿ) — the buggy
    // auto-domain used a 0.03 step, which fails this.
    const nums = yTicks.map((t) => Number.parseFloat(t)).sort((a, b) => a - b)
    const step = nums[1] - nums[0]
    for (let i = 1; i < nums.length; i++) expect(nums[i] - nums[i - 1]).toBeCloseTo(step, 6)
    const niceFraction = Math.round(step / 10 ** Math.floor(Math.log10(step)))
    expect([1, 2, 5]).toContain(niceFraction)
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
