import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { type SeriesPoint, toDeviceSeries } from '~/lib/sensor/chartData'
import { CADENCE_SEC, MAX_GAP_BUCKETS } from '~/lib/sensor/range'
import { makeTimeAxis, type TimeAxis } from '~/lib/sensor/tickFormat'
import type { SeriesBucket } from '~/lib/services/sensor'
import { m } from '~/paraglide/messages'
import {
  activeDots,
  centre,
  chartSvg,
  focusChart,
  gridLines,
  hoverCursor,
  legend,
  lineCurves,
  moveAt,
  parkPointer,
  readingDots,
  settle,
  tapOn,
  tooltipNodes,
  tooltipText,
  xTickLabels,
  xTickTexts,
  yTickLabels,
} from '~test/browser/chartDom'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
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
  {
    formatTick = (t: number) => String(t),
    timeAxis = makeTimeAxis('24h', 'sv-SE'),
  }: { formatTick?: (t: number) => string; timeAxis?: TimeAxis } = {},
) {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={devices}
        unit="°C"
        formatTick={formatTick}
        timeAxis={timeAxis}
        label="Temperatur"
      />
    </div>,
  )
  return screen.container
}

// A re-render with new data, as a poll's refetch or a device toggle does.
// renderWithProviders wraps the first render in the provider, so the rerender
// wraps it too: the same tree, so the chart keeps its state instead of remounting.
async function renderRefetchable(
  devices: ClimateChartDevice[],
  formatTick: (t: number) => string = (t) => String(t),
) {
  const queryClient = makeTestQueryClient()
  const ui = (ds: ClimateChartDevice[]) => (
    <div style={{ width: 600, height: 300 }}>
      <ClimateChart
        devices={ds}
        unit="°C"
        formatTick={formatTick}
        timeAxis={makeTimeAxis('24h', 'sv-SE')}
        label="Temperatur"
      />
    </div>
  )
  const { screen } = await renderWithProviders(ui(devices), { queryClient })
  return {
    screen,
    root: screen.container,
    rerender: (ds: ClimateChartDevice[]) =>
      screen.rerender(<QueryClientProvider client={queryClient}>{ui(ds)}</QueryClientProvider>),
  }
}

/** Hovers the plot's centre (the visx overlay). */
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

test('renders one line per visible device in its own colour, and no legend', async () => {
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
  // Each line resolves to its own device's colour.
  expect(lineCurves(root).map((c) => getComputedStyle(c).stroke)).toEqual([
    'rgb(1, 2, 3)',
    'rgb(4, 5, 6)',
  ])
  // The page's sensor chips are the key; the chart draws none.
  expect(legend(root)).toBeNull()
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
  // Idle baseline: once drawn, nothing is hovered, so no cursor, dots or card.
  await vi.waitFor(() => expect(lineCurves(root)).toHaveLength(2))
  expect(hoverCursor(root)).toBeNull()
  expect(activeDots(root)).toHaveLength(0)
  expect(tooltipText()).not.toContain('Fack')
  await hoverPlot(root)

  await vi.waitFor(() => {
    const tip = tooltipText()
    expect(tip).toContain('Fack 1')
    expect(tip).toContain('Fack 3')
    expect((tip.match(/°C/g) ?? []).length).toBe(2)
    expect(hoverCursor(root)).not.toBeNull()
    // One dot per card row (accepted difference 2).
    expect(activeDots(root)).toHaveLength(2)
  })
})

test('axis labels are 13 px and the hover card is 14 px with a 13 px row time', async () => {
  const root = await renderChart(
    [
      device('a', [
        { t: T0, a: 15.1 },
        { t: T0 + 20 * MIN, a: 15.3 },
      ]),
      device('b', [
        { t: T0 + 7 * MIN, b: 14.2 },
        { t: T0 + 27 * MIN, b: 14.4 },
      ]),
    ],
    { formatTick: (t) => new Date(t).toISOString().slice(11, 16) },
  )
  await vi.waitFor(() => expect(xTickTexts(root).length).toBeGreaterThan(0))
  for (const text of xTickTexts(root)) expect(text.getAttribute('font-size')).toBe('13')
  const yText = root.querySelector('[data-axis="y"] text')
  expect(yText?.getAttribute('font-size')).toBe('13')
  // The chart box carries the card's text size (browser tests have no app.css: classes, not pixels).
  const box = root.querySelector('[data-chart="line"]')
  expect(box?.className).toContain('text-sm')
  expect(box?.className).not.toContain('text-xs')
  await hoverPlot(root)
  await vi.waitFor(() => {
    // The card is portaled to the body, outside the box: it sets its own size.
    const card = tooltipNodes()[0]
    expect(card?.className).toContain('text-sm')
    expect(card?.className).not.toContain('text-xs')
    // b's nearest reading is 7 min off a's, so its row shows its own time.
    const rowTime = [...(card?.querySelectorAll('span') ?? [])].find((s) =>
      s.className.includes('text-[13px]'),
    )
    expect(rowTime).toBeDefined()
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

test('with every device hidden there is no line and no card', async () => {
  const points = (id: string, v: number) => [
    { t: T0, [id]: v },
    { t: T0 + HOUR, [id]: v + 1 },
  ]
  const devices = (hideB: boolean) => [
    device('a', points('a', 20), { hidden: true }),
    device('b', points('b', 30), { displayName: 'Visible one', hidden: hideB }),
  ]
  const { root, rerender } = await renderRefetchable(devices(true))
  // Drawn: the time axis keeps its ticks even with nothing visible.
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(0))
  expect(lineCurves(root)).toHaveLength(0)
  await hoverPlot(root)
  // Give a card the chance to appear before asserting it didn't.
  await settle()
  await settle()
  expect(tooltipText()).toBe('')

  // Positive control: the same mounted chart and hover, with one device toggled
  // visible, opens a card. Without it the "no card" above could pass on a chart
  // nothing hovers.
  await rerender(devices(false))
  await vi.waitFor(() => expect(lineCurves(root)).toHaveLength(1))
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).toContain('Visible one'))
})

// Two sensors a day long, reporting every 2 h on different minutes (the 24 h shape).
const day = () => {
  const start = new Date('2026-08-02T10:20:00').getTime()
  return [
    device(
      'a',
      Array.from({ length: 12 }, (_, i) => ({ t: start + i * 2 * HOUR, a: 20 + (i % 3) * 0.2 })),
      { displayName: 'Fack 1' },
    ),
    device(
      'b',
      Array.from({ length: 12 }, (_, i) => ({
        t: start + i * 2 * HOUR + 41 * MIN,
        b: 5 - (i % 4),
      })),
      { displayName: 'Fack 3' },
    ),
  ]
}

test('the 24 h axis labels round hours', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(2))
  for (const label of xTickLabels(root)) {
    const [h, m] = label.split(/[:.]/).map(Number)
    expect(m).toBe(0)
    expect(h % 3).toBe(0)
  }
})

test('a label on a tick at the domain end stays inside the chart', async () => {
  // A day ending 1 min after 21:00: the 21:00 tick sits a pixel short of the
  // plot's end, where a centred label would run past the svg's right edge.
  const end = new Date('2026-08-03T21:01:00').getTime()
  const root = await renderChart([
    device(
      'a',
      Array.from({ length: 25 }, (_, i) => ({ t: end - (24 - i) * HOUR, a: 20 + (i % 3) * 0.2 })),
    ),
  ])
  await vi.waitFor(() => expect(xTickTexts(root).length).toBeGreaterThan(2))
  const texts = xTickTexts(root)
  const last = texts[texts.length - 1]
  expect(last.textContent).toMatch(/^21[:.]00$/)
  const svg = chartSvg(root)
  if (!svg) throw new Error('chart not rendered')
  expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(svg.getBoundingClientRect().right)
})

test('a hover puts one dot on each card row’s reading', async () => {
  const root = await renderChart(day())
  await hoverPlot(root)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain('Fack 1')
    expect(tooltipText()).toContain('Fack 3')
    expect(activeDots(root)).toHaveLength(2)
  })
})

test('the hover line and dots paint over the lines and axes', async () => {
  // recharts drew its cursor (z 1100) and active dots (z 1200) over the curves
  // (400) and axes (500); an svg paints in DOM order, so they must come later.
  const root = await renderChart(day())
  await hoverPlot(root)
  await vi.waitFor(() => expect(activeDots(root)).toHaveLength(2))
  const xAxis = root.querySelector('[data-axis="x"]')
  const cursor = hoverCursor(root)
  if (!xAxis || !cursor) throw new Error('no x axis or hover line')
  const after = (el: Element) =>
    (xAxis.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  expect(after(cursor)).toBe(true)
  for (const dot of activeDots(root)) expect(after(dot)).toBe(true)
})

test('a sensor silent around the hovered time is left out of the card and gets no dot', async () => {
  const [a, b] = day()
  // b stops after its first four readings; the plot's centre is hours later.
  const root = await renderChart([a, { ...b, points: b.points.slice(0, 4) }])
  await hoverPlot(root)
  await vi.waitFor(() => {
    expect(tooltipText()).toContain('Fack 1')
    expect(tooltipText()).not.toContain('Fack 3')
    expect(activeDots(root)).toHaveLength(1)
  })
})

test('a tap keeps the card; the mouse leaving the plot closes it', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(root.querySelector('[data-hover-overlay]')).not.toBeNull())
  const overlay = () => root.querySelector('[data-hover-overlay]') as Element
  tapOn(root, overlay)
  await vi.waitFor(() => expect(tooltipText()).toContain('Fack 1'))
  // A lifted finger keeps it.
  // React's onPointerLeave listens for pointerout (relatedTarget outside), not a dispatched pointerleave.
  const leave = (pointerType: string) =>
    overlay().dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, pointerType, relatedTarget: document.body }),
    )
  leave('touch')
  await new Promise((r) => setTimeout(r, 150))
  expect(tooltipText()).toContain('Fack 1')
  // A mouse leaving closes it, and the hover line goes with it.
  await hoverPlot(root)
  leave('mouse')
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('')
    expect(hoverCursor(root)).toBeNull()
  })
})

test('every device hidden: the time axis keeps its ticks, with no y labels and no grid', async () => {
  const root = await renderChart(day().map((d) => ({ ...d, hidden: true })))
  await vi.waitFor(() => expect(xTickLabels(root).length).toBeGreaterThan(2))
  expect(yTickLabels(root)).toEqual([])
  expect(gridLines(root)).toHaveLength(0)
})

test('a refetch that adds a reading keeps the open card on its time', async () => {
  const devices = day()
  const { root, rerender } = await renderRefetchable(devices, (t) => new Date(t).toISOString())
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const header = tooltipNodes()[0]?.firstElementChild?.textContent
  expect(header).toBeTruthy()
  const [a, b] = devices
  const later = a.points[a.points.length - 1].t + 2 * HOUR
  await rerender([{ ...a, points: [...a.points, { t: later, a: 21 }] }, b])
  await new Promise((r) => setTimeout(r, 150))
  expect(tooltipNodes()[0]?.firstElementChild?.textContent).toBe(header)
})

test('when the data moves away from an open card, no card or hover line is left', async () => {
  const devices = day()
  const { root, rerender } = await renderRefetchable(devices)
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  // The same chart throughout: it updates in place, never remounts.
  const svg = chartSvg(root)
  // A range switch: the same sensors, readings a year earlier.
  const shifted = devices.map((d) => ({
    ...d,
    points: d.points.map((p) => ({ ...p, t: p.t - 365 * 24 * HOUR })),
  }))
  await rerender(shifted)
  await vi.waitFor(() => {
    expect(tooltipText()).toBe('')
    expect(hoverCursor(root)).toBeNull()
    expect(activeDots(root)).toHaveLength(0)
  })
  expect(chartSvg(root)).toBe(svg)
  // A later refetch bringing that time back doesn't pop the card up unprompted.
  await rerender(devices)
  await vi.waitFor(() => expect(lineCurves(root)).toHaveLength(2))
  await settle()
  expect(tooltipText()).toBe('')
  expect(hoverCursor(root)).toBeNull()
  expect(activeDots(root)).toHaveLength(0)
})

test('a finger can drag across the plot: it only lets the page pan vertically', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(root.querySelector('[data-hover-overlay]')).not.toBeNull())
  const overlay = root.querySelector('[data-hover-overlay]') as SVGRectElement
  expect(overlay.style.touchAction).toBe('pan-y')
})

test('the chart is one named Tab stop, its svg hidden from assistive tech', async () => {
  const { screen, root } = await renderRefetchable(day())
  const group = screen.getByRole('group', { name: 'Temperatur' })
  await expect.element(group).toBeInTheDocument()
  expect(group.element().getAttribute('tabindex')).toBe('0')
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  expect(chartSvg(root)?.getAttribute('aria-hidden')).toBe('true')
})

const header = () => tooltipNodes()[0]?.firstElementChild?.textContent ?? null
const announced = (root: HTMLElement) =>
  root.querySelector('[data-chart-announce]')?.textContent ?? ''
const allTimes = (devices: ClimateChartDevice[]) =>
  [...new Set(devices.flatMap((d) => d.points.map((p) => p.t)))].sort((a, b) => a - b)

test('the chart is one named Tab stop whose arrows walk the readings', async () => {
  const devices = day()
  const root = await renderChart(devices)
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  const group = focusChart(root)
  expect(group.getAttribute('role')).toBe('group')
  expect(group.getAttribute('aria-label')).toBe('Temperatur')
  expect(tooltipText()).toBe('')

  const times = allTimes(devices)
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[0]))
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[1]))
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  expect(header()).toBe(String(times[0]))
  // Clamped at the first reading.
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  expect(header()).toBe(String(times[0]))
  await userEvent.keyboard('{End}')
  await settle()
  expect(header()).toBe(String(times[times.length - 1]))
  await userEvent.keyboard('{Home}')
  await settle()
  expect(header()).toBe(String(times[0]))
  // Each step is announced with its card's content.
  expect(announced(root)).toContain(String(times[0]))
  expect(announced(root)).toContain('Fack 1')
  // The hint names the group; the live region is polite and read whole.
  const hint = document.getElementById(group.getAttribute('aria-describedby') ?? '')
  expect(hint?.textContent).toBe(m.sensors_chart_keyboard_hint())
  const live = root.querySelector('[data-chart-announce]')
  expect(live?.getAttribute('aria-live')).toBe('polite')
  expect(live?.getAttribute('aria-atomic')).toBe('true')
})

test('← from nothing starts at the last reading; Escape and Tab-out close the card', async () => {
  const devices = day()
  const root = await renderChart(devices)
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowLeft}')
  await settle()
  const last = Math.max(...devices.flatMap((d) => d.points.map((p) => p.t)))
  expect(header()).toBe(String(last))
  await userEvent.keyboard('{Escape}')
  await settle()
  expect(tooltipText()).toBe('')
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(allTimes(devices)[0]))
  ;(document.activeElement as HTMLElement).blur()
  await settle()
  expect(tooltipText()).toBe('')
  expect(announced(root)).toBe('')
})

test('after a refetch adds a reading, → continues from the shown time', async () => {
  const devices = day()
  const { root, rerender } = await renderRefetchable(devices)
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  const times = allTimes(devices)
  for (let i = 0; i < 3; i++) {
    await userEvent.keyboard('{ArrowRight}')
    await settle()
  }
  expect(header()).toBe(String(times[2]))
  // A new reading before the shown one shifts every index by one.
  const [a, b] = devices
  const earlier = times[0] - HOUR
  await rerender([{ ...a, points: [{ t: earlier, a: 19 }, ...a.points] }, b])
  await settle()
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[3]))
})

test('when the data moves away from a keyboard card, → starts again from the first reading', async () => {
  const devices = day()
  const { root, rerender } = await renderRefetchable(devices)
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowRight}{ArrowRight}')
  await settle()
  expect(tooltipText()).not.toBe('')
  const shifted = devices.map((d) => ({
    ...d,
    points: d.points.map((p) => ({ ...p, t: p.t - 365 * 24 * HOUR })),
  }))
  await rerender(shifted)
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  // The announcement goes with the card.
  expect(announced(root)).toBe('')
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(allTimes(shifted)[0]))
})

test('with every device hidden the keys do nothing', async () => {
  const root = await renderChart(day().map((d) => ({ ...d, hidden: true })))
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowRight}{End}')
  await settle()
  expect(tooltipText()).toBe('')
  expect(announced(root)).toBe('')
})

test('a mouse leaving the plot clears the keyboard’s announcement with the card', async () => {
  const root = await renderChart(day())
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(announced(root)).not.toBe('')
  expect(tooltipText()).not.toBe('')
  // No pointer move in between: the announcement is still set when the leave fires.
  const overlay = root.querySelector('[data-hover-overlay]') as Element
  overlay.dispatchEvent(
    new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: document.body,
    }),
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
  expect(announced(root)).toBe('')
})

test('→ after a hover continues from the hovered reading', async () => {
  const devices = day()
  const root = await renderChart(devices)
  await hoverPlot(root)
  await vi.waitFor(() => expect(tooltipText()).not.toBe(''))
  const times = allTimes(devices)
  const k = times.indexOf(Number(header()))
  expect(k).toBeGreaterThanOrEqual(0)
  focusChart(root)
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(header()).toBe(String(times[k + 1]))
})

test('a mouse move after the keys shows the pointer’s time and clears the announcement', async () => {
  const devices = day()
  const root = await renderChart(devices)
  await vi.waitFor(() => expect(chartSvg(root)).not.toBeNull())
  focusChart(root)
  await userEvent.keyboard('{Home}')
  await settle()
  expect(announced(root)).not.toBe('')
  const first = header()
  await hoverPlot(root)
  await vi.waitFor(() => expect(header()).not.toBe(first))
  expect(announced(root)).toBe('')
  expect(allTimes(devices)).toContain(Number(header()))
})
