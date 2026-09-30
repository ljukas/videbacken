import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { renderWithProviders } from '~test/browser/render'
import { WeekdayHourHeatmap } from './WeekdayHourHeatmap'

const grid = Array.from({ length: 7 }, (_, w) =>
  Array.from({ length: 24 }, (_, h) => ({
    kwh: w === 1 && h === 21 ? 38.4 : 0,
    pluggedHours: h >= 18 ? 2 : 0,
  })),
)

test('draws 168 cells and exposes the numbers in an sr-only table', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-cell]').length).toBe(168)
  await expect.element(screen.getByRole('cell', { name: /38,4 kWh/ })).toBeInTheDocument()
})

test('is 24 columns wide on desktop and transposed to 7 columns on a phone', async () => {
  const wide = await renderWithProviders(
    <div style={{ width: 900 }}>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect
    .poll(() => wide.screen.container.querySelector('svg')?.dataset.orientation)
    .toBe('hours-across')
  const narrow = await renderWithProviders(
    <div style={{ width: 360 }}>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect
    .poll(() => narrow.screen.container.querySelector('svg')?.dataset.orientation)
    .toBe('weekdays-across')
})

test('the plugged-in metric shows hours plugged in', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}>
      <WeekdayHourHeatmap grid={grid} metric="plugged" />
    </div>,
  )
  await expect
    .element(screen.getByRole('cell', { name: /2,0 h inkopplad/ }).first())
    .toBeInTheDocument()
})

test('hovering a cell shows its weekday, hour and value', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect.poll(() => screen.container.querySelector('rect[data-cell="1-21"]')).not.toBeNull()
  const cell = screen.container.querySelector('rect[data-cell="1-21"]')
  if (!cell) throw new Error('cell missing')
  await userEvent.hover(cell)
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
})

function touch(type: string) {
  return new PointerEvent(type, { pointerType: 'touch', bubbles: true })
}

async function renderWide() {
  const r = await renderWithProviders(
    <div style={{ width: 900 }}>
      <p data-testid="outside">outside</p>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect.poll(() => r.screen.container.querySelector('rect[data-cell="1-21"]')).not.toBeNull()
  const cell = r.screen.container.querySelector('rect[data-cell="1-21"]')
  const svg = r.screen.container.querySelector('svg')
  if (!cell || !svg) throw new Error('chart missing')
  return { ...r, cell, svg }
}

// React derives onPointerLeave from pointerout/pointerover, so that's what we dispatch.
function out(pointerType: 'touch' | 'mouse') {
  return new PointerEvent('pointerout', { pointerType, bubbles: true, relatedTarget: null })
}

test('a touch tap keeps the tooltip open after the finger lifts', async () => {
  const { screen, cell } = await renderWide()
  cell.dispatchEvent(touch('pointerdown'))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
  cell.dispatchEvent(touch('pointerup'))
  cell.dispatchEvent(out('touch'))
  await new Promise((r) => setTimeout(r, 50))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
})

test('a mouse leaving the chart hides the tooltip', async () => {
  const { screen, cell } = await renderWide()
  cell.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
  cell.dispatchEvent(out('mouse'))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).not.toBeInTheDocument()
})

test('a tap outside the chart hides the tooltip', async () => {
  const { screen, cell } = await renderWide()
  cell.dispatchEvent(touch('pointerdown'))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
  screen.container.querySelector('[data-testid="outside"]')?.dispatchEvent(touch('pointerdown'))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).not.toBeInTheDocument()
})

test('Escape hides the tooltip', async () => {
  const { screen, cell } = await renderWide()
  cell.dispatchEvent(touch('pointerdown'))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).toBeInTheDocument()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await expect.element(screen.getByText(/tis 21–22 · 38,4 kWh/)).not.toBeInTheDocument()
})

test('the transposed layout stays short at 600 px', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 600 }}>
      <WeekdayHourHeatmap grid={grid} metric="kwh" />
    </div>,
  )
  await expect
    .poll(() => screen.container.querySelector('svg')?.dataset.orientation)
    .toBe('weekdays-across')
  const height = Number(screen.container.querySelector('svg')?.getAttribute('height'))
  expect(height).toBeLessThanOrEqual(16 + 24 * 24)
})

test('cells are coloured by quantile step; empty cells are muted with a border', async () => {
  // Five distinct evening values: one per step, darkest for the biggest.
  const stepped = Array.from({ length: 7 }, (_, w) =>
    Array.from({ length: 24 }, (_, h) => ({ kwh: h === 20 && w < 5 ? w + 1 : 0, pluggedHours: 0 })),
  )
  const { screen } = await renderWithProviders(
    <div style={{ width: 900 }}>
      <WeekdayHourHeatmap grid={stepped} metric="kwh" />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-cell]').length).toBe(168)
  const fill = (id: string) =>
    screen.container.querySelector<SVGRectElement>(`rect[data-cell="${id}"]`)?.style
  const fills = [0, 1, 2, 3, 4].map((w) => fill(`${w}-20`)?.fill)
  expect(fills).toEqual(
    [20, 40, 60, 80, 100].map((p) => `color-mix(in oklab, var(--brand) ${p}%, var(--card))`),
  )
  expect(fill('0-0')?.fill).toBe('var(--muted)')
  expect(fill('0-0')?.stroke).toBe('var(--border)')
  expect(fill('0-20')?.stroke).toBe('')
})
