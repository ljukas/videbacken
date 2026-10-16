import { beforeEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SignaturePoint, SignatureResult } from '~/lib/heatPump/signature'
import { m } from '~/paraglide/messages'
import { centre, moveAt, settle, tooltipText } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { SignatureScatter } from './SignatureScatter'

const pt = (
  day: string,
  deltaT: number,
  kwh: number,
  set: 'before' | 'after',
  extrapolated = false,
): SignaturePoint => ({
  day,
  deltaT,
  kwh,
  set,
  extrapolated,
})
const points = [
  pt('2026-01-04', 4, 4.1, 'before'),
  pt('2026-01-12', 12, 8, 'before'),
  pt('2026-01-19', 19, 11.6, 'before'),
  pt('2026-01-21', 5, 4.05, 'after'),
  pt('2026-02-03', 18, 9.9, 'after'),
  pt('2026-02-04', 25, 12, 'after', true),
]
const ok: SignatureResult = {
  state: 'ok',
  points,
  fit: { a: 2, b: 0.5 },
  afterFit: { a: 1.8, b: 0.45 },
  change: -0.1,
  margin: 0.007,
  beforeDays: 3,
  afterDays: 2,
}
const q = (sel: string) => [...document.querySelectorAll(sel)]
const draw = async (result: SignatureResult, width = 900) => {
  const r = await renderWithProviders(
    <div style={{ width }}>
      <SignatureScatter result={result} />
    </div>,
  )
  await vi.waitFor(() => expect(q('[data-point]')).toHaveLength(result.points.length))
  return r
}

beforeEach(async () => {
  await page.viewport(1440, 900)
})

test('a filled circle per before-day, a filled square per after-day, a hollow square when extrapolated', async () => {
  await draw(ok)
  expect(q('circle[data-set="before"]')).toHaveLength(3)
  expect(q('rect[data-set="after"]')).toHaveLength(3)
  const hollow = q('[data-extrapolated]')
  expect(hollow.map((e) => e.getAttribute('data-point'))).toEqual(['2026-02-04'])
  expect(hollow[0].getAttribute('fill')).toBe('var(--card)')
  expect(hollow[0].getAttribute('stroke')).toBe('var(--signature-after)')
  expect(q('rect[data-set="after"]:not([data-extrapolated])')[0].getAttribute('fill')).toBe(
    'var(--signature-after)',
  )
})

const fits = () => q('[data-fit]').map((e) => e.getAttribute('data-fit'))

test('ok draws both lines', async () => {
  await draw(ok)
  expect(fits()).toEqual(['before', 'after'])
})

test('not_enough_after draws the before line only', async () => {
  await draw({ state: 'not_enough_after', after: 2, needed: 14, points, fit: ok.fit })
  expect(fits()).toEqual(['before'])
})

test('not_enough_before draws no line', async () => {
  await draw({ state: 'not_enough_before', before: 3, points })
  expect(fits()).toHaveLength(0)
})

test('axis titles and a three-item legend', async () => {
  await draw(ok)
  expect(document.querySelector('[data-axis-label="x"]')?.textContent).toBe(
    m.heat_pump_signature_axis_x(),
  )
  expect(document.querySelector('[data-axis-label="y"]')?.textContent).toBe(
    m.heat_pump_signature_axis_y(),
  )
  expect(q('[data-slot="signature-legend"] [data-legend-item]').map((e) => e.textContent)).toEqual([
    m.heat_pump_signature_before(),
    m.heat_pump_signature_after(),
    m.heat_pump_signature_extrapolated(),
  ])
})

test('hovering near a point shows its day, ΔT and kWh', async () => {
  const { screen } = await draw(ok)
  const target = document.querySelector('[data-point="2026-01-12"]') as Element
  const c = centre(target)
  moveAt(screen.container, c.x + 5, c.y + 5)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.heat_pump_signature_tooltip_delta()))
  // A no-break space: the number and its unit never wrap apart.
  expect(tooltipText()).toMatch(/12[,.]0\u00a0°C/)
  expect(tooltipText()).toMatch(/8[,.]0\u00a0kWh/)
  expect(tooltipText()).toContain(m.heat_pump_signature_before())
})

test('every point stays inside the plot on a phone', async () => {
  await page.viewport(390, 844)
  await draw(ok, 340)
  await settle()
  const plot = document.querySelector('[data-hover-overlay]')?.getBoundingClientRect()
  for (const e of q('[data-point]')) {
    const b = e.getBoundingClientRect()
    expect(b.left + b.width / 2).toBeGreaterThanOrEqual((plot?.left ?? 0) - 0.5)
    expect(b.left + b.width / 2).toBeLessThanOrEqual((plot?.right ?? 0) + 0.5)
  }
})

test('a fit line below 0 kWh is clipped to the plot; the axis still starts at 0', async () => {
  // A real-looking signature: a = −3,40, b = 0,71 crosses 0 near ΔT 4,8 (−1,27 kWh at ΔT 3).
  const low: SignatureResult = {
    state: 'not_enough_after',
    after: 0,
    needed: 14,
    points: [pt('2026-01-04', 3, 0.4, 'before'), pt('2026-01-19', 19, 10, 'before')],
    fit: { a: -3.4, b: 0.71 },
  }
  await draw(low)
  const line = document.querySelector('[data-fit="before"]') as SVGLineElement
  expect(Number(line.getAttribute('y1'))).toBeGreaterThan(
    Number(document.querySelector('[data-hover-overlay]')?.getAttribute('height')),
  )
  const clipped = line.closest('[clip-path]')
  const id = clipped?.getAttribute('clip-path')?.match(/^url\(#(.+)\)$/)?.[1] ?? ''
  const rect = document.getElementById(id)?.querySelector('rect')
  const overlay = document.querySelector('[data-hover-overlay]')
  expect(rect?.getAttribute('width')).toBe(overlay?.getAttribute('width'))
  expect(rect?.getAttribute('height')).toBe(overlay?.getAttribute('height'))
  const yTicks = q('[data-axis="y"] .visx-axis-tick').map((t) => t.textContent)
  expect(yTicks[0]).toBe('0')
})

test('the after line is dashed, and the legend shows each set’s line beside its marker', async () => {
  await draw(ok)
  expect(document.querySelector('[data-fit="before"]')?.getAttribute('stroke-dasharray')).toBeNull()
  expect(document.querySelector('[data-fit="after"]')?.getAttribute('stroke-dasharray')).toBe('6 4')
  const items = q('[data-slot="signature-legend"] [data-legend-item]')
  const stroke = (i: number) => items[i].querySelector('line')
  expect(stroke(0)?.getAttribute('stroke-dasharray')).toBeNull()
  expect(stroke(0)?.getAttribute('stroke')).toBe('var(--signature-before)')
  expect(stroke(1)?.getAttribute('stroke-dasharray')).toBe('6 4')
  expect(stroke(1)?.getAttribute('stroke')).toBe('var(--signature-after)')
  expect(stroke(2)).toBeNull() // not counted: no line
  expect(document.querySelector('[data-slot="signature-legend"]')?.className).toMatch(/\btext-sm\b/)
})
