import { beforeEach, expect, test, vi } from 'vitest'
import { type SeriesPoint, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS } from '~/lib/sensor/range'
import type { SeriesBucket } from '~/lib/services/sensor'
import {
  activeDots,
  centre,
  chartSvg,
  hoverCursor,
  legendLabels,
  lineCurves,
  moveAt,
  parkPointer,
  readingDots,
  tooltipText,
  yTickLabels,
} from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { ClimateChart, type ClimateChartDevice } from './ClimateChart'

// Browser mode shares one real pointer across tests and files: one left over a
// chart shows its card and active dot, which these assertions would count.
beforeEach(parkPointer)

const MIN = 60_000
const HOUR = 3_600_000
const T0 = 1_784_000_000_000

const device = (
  id: string,
  points: SeriesPoint[],
  extra: Partial<ClimateChartDevice> = {},
): ClimateChartDevice => ({ id, displayName: id, color: 'var(--chart-1)', points, ...extra })

// Every test renders through here, so a prop the chart gains changes one place.
async function renderChart(
  devices: ClimateChartDevice[],
  { formatTick = (t: number) => String(t) }: { formatTick?: (t: number) => string } = {},
) {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart devices={devices} unit="°C" formatTick={formatTick} />
    </div>,
  )
  return screen.container
}

/** Hovers the plot's centre (the visx overlay, or the element there on recharts). */
async function hoverPlot(root: HTMLElement) {
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  const svg = chartSvg(root)
  if (!svg) throw new Error('chart not rendered')
  const { x, y } = centre(svg)
  moveAt(root, x, y)
}

const moveTos = (d: string | null | undefined) => (d?.match(/M/gi) ?? []).length

test('draws connected lines for hours-apart readings on a coarse range', async () => {
  // End-to-end guard for the epoch-ms gap-threshold bug: buckets → toDeviceSeries
  // → chart. On the 1m range (3h buckets) readings a few hours apart must render
  // as a continuous line, not a scatter of isolated dots.
  const bucketSec = 3 * 3600
  const buckets: SeriesBucket[] = Array.from({ length: 8 }, (_, i) => ({
    t: T0 + i * 3 * HOUR,
    perDevice: { dev: { tempAvg: 14.4 + (i % 3) * 0.1, humAvg: 80 } },
  }))
  const [series] = toDeviceSeries(buckets, 'temp', {
    bucketSec,
    maxGapBuckets: MAX_GAP_BUCKETS,
    cadenceSec: CADENCE_SEC,
  })
  const root = await renderChart([device('dev', series.points)])

  await vi.waitFor(() => {
    // One continuous curve (a single move-to) with real line segments, and no
    // isolated-reading dots: the points connected rather than broke apart.
    const d = lineCurves(root)[0]?.getAttribute('d')
    expect(moveTos(d)).toBe(1)
    expect(d).toMatch(/[CL]/)
    expect(readingDots(root)).toHaveLength(0)
  })
})

test('renders one line per visible device in its own colour, and a legend entry for every device', async () => {
  const root = await renderChart([
    device(
      'a',
      [
        { t: 1, a: 20 },
        { t: 2, a: 21 },
      ],
      { displayName: 'NW corner', color: 'rgb(1, 2, 3)' },
    ),
    device(
      'b',
      [
        { t: 1, b: 25 },
        { t: 2, b: 26 },
      ],
      { displayName: 'Kitchen', color: 'rgb(4, 5, 6)' },
    ),
    device(
      'c',
      [
        { t: 1, c: 30 },
        { t: 2, c: 31 },
      ],
      { displayName: 'Boiler', color: 'rgb(7, 8, 9)', hidden: true },
    ),
  ])

  // Two visible devices → two curves; the hidden one draws none.
  await vi.waitFor(() => {
    const curves = lineCurves(root)
    expect(curves).toHaveLength(2)
    for (const curve of curves) expect(curve.getAttribute('d') ?? '').toMatch(/[CL]/)
  })
  // Each line resolves to its own device's colour (recharts through its CSS
  // variables, visx directly), so the colours survive the swap.
  expect(lineCurves(root).map((c) => getComputedStyle(c).stroke)).toEqual([
    'rgb(1, 2, 3)',
    'rgb(4, 5, 6)',
  ])
  // The legend lists every device, the hidden one too, sorted by name (recharts' order).
  expect(legendLabels(root)).toEqual(['Boiler', 'Kitchen', 'NW corner'])
})

test('breaks the line at an outage marker while keeping each cluster connected', async () => {
  // A device offline mid-window: a null break marker separates two clusters.
  // The path splits into two move-to sub-paths (a visible gap), and neither
  // cluster endpoint is isolated, so no dots.
  const root = await renderChart([
    device('a', [
      { t: 0, a: 20 },
      { t: 1, a: 21 },
      { t: 5, a: null },
      { t: 9, a: 22 },
      { t: 10, a: 23 },
    ]),
  ])

  await vi.waitFor(() => {
    const d = lineCurves(root)[0]?.getAttribute('d')
    expect(moveTos(d)).toBe(2)
    expect(d).toMatch(/[CL]/)
    expect(readingDots(root)).toHaveLength(0)
  })
})

test('x-axis spans hidden devices so toggling a device does not rescale time', async () => {
  // Device A (hidden) spans 0–1000; device B (visible) only 400–500. If the
  // domain spans A, B's segment sits mid-axis; if it wrongly rescaled to B's
  // own 400–500, B's first point would pin to the left edge.
  const root = await renderChart([
    device(
      'a',
      [
        { t: 0, a: 1 },
        { t: 1000, a: 2 },
      ],
      { hidden: true },
    ),
    device('b', [
      { t: 400, b: 3 },
      { t: 500, b: 4 },
    ]),
  ])

  await vi.waitFor(() => {
    const d = lineCurves(root)[0]?.getAttribute('d') ?? ''
    expect(Number(d.match(/M([\d.]+)/)?.[1])).toBeGreaterThan(100)
  })
})

test('formats y-axis tick labels to one decimal for a narrow value range', async () => {
  // A stable room: recharts' own auto-domain gave arbitrary fractional ticks
  // (24.595, 24.49, …) that overflowed the axis. Every tick must read as at most
  // two decimals plus the unit, distinct, on a nice step (1, 2 or 5 × 10ⁿ).
  const root = await renderChart([
    device('a', [
      { t: 1, a: 24.49 },
      { t: 2, a: 24.55 },
      { t: 3, a: 24.58 },
    ]),
    device('b', [
      { t: 1, b: 24.6 },
      { t: 2, b: 24.55 },
      { t: 3, b: 24.5 },
    ]),
  ])

  await vi.waitFor(() => {
    const yTicks = yTickLabels(root)
    expect(yTicks.length).toBeGreaterThan(1)
    expect(new Set(yTicks).size).toBe(yTicks.length)
    for (const text of yTicks) expect(text).toMatch(/^-?\d+(\.\d{1,2})?°C$/)
    const nums = yTicks.map((t) => Number.parseFloat(t)).sort((a, b) => a - b)
    const step = nums[1] - nums[0]
    for (let i = 1; i < nums.length; i++) expect(nums[i] - nums[i - 1]).toBeCloseTo(step, 6)
    const niceFraction = Math.round(step / 10 ** Math.floor(Math.log10(step)))
    expect([1, 2, 5]).toContain(niceFraction)
  })
})

test('a single hover lists every visible sensor at its nearest reading, with the hover line', async () => {
  // Sensors report on different minutes, so no two share a timestamp. The card
  // snaps each line to its nearest reading within the cadence window, so one
  // hover shows both.
  const root = await renderChart(
    [
      device(
        'a',
        [
          { t: T0 + 0 * MIN, a: 15.1 },
          { t: T0 + 20 * MIN, a: 15.3 },
          { t: T0 + 40 * MIN, a: 15.5 },
        ],
        { displayName: 'Fack 1' },
      ),
      device(
        'b',
        [
          { t: T0 + 7 * MIN, b: 14.2 },
          { t: T0 + 27 * MIN, b: 14.4 },
          { t: T0 + 47 * MIN, b: 14.6 },
        ],
        { displayName: 'Fack 3' },
      ),
    ],
    { formatTick: (t) => new Date(t).toISOString().slice(11, 16) },
  )
  await hoverPlot(root)

  await vi.waitFor(() => {
    const tip = tooltipText()
    expect(tip).toContain('Fack 1')
    expect(tip).toContain('Fack 3')
    expect((tip.match(/°C/g) ?? []).length).toBe(2)
    expect(hoverCursor(root)).not.toBeNull()
    expect(activeDots(root).length).toBeGreaterThan(0)
  })
})

test('renders a dot for an isolated reading so it is not invisible', async () => {
  const root = await renderChart([
    device('a', [{ t: 5, a: 20, isolated: true }]),
    device('b', [
      { t: 1, b: 30 },
      { t: 2, b: 31 },
    ]),
  ])

  // Only the isolated reading draws a dot; the continuous line draws none.
  await vi.waitFor(() => expect(readingDots(root)).toHaveLength(1))
})

test('with every device hidden there is no line and no card, and the legend keeps every device', async () => {
  const root = await renderChart([
    device(
      'a',
      [
        { t: T0, a: 20 },
        { t: T0 + HOUR, a: 21 },
      ],
      { hidden: true },
    ),
    device(
      'b',
      [
        { t: T0, b: 30 },
        { t: T0 + HOUR, b: 31 },
      ],
      { hidden: true },
    ),
  ])
  await vi.waitFor(() => expect(legendLabels(root)).toEqual(['a', 'b']))
  expect(lineCurves(root)).toHaveLength(0)
  await hoverPlot(root)
  // Give a card the chance to appear before asserting it didn't.
  await new Promise((r) => setTimeout(r, 200))
  expect(tooltipText()).toBe('')
})
