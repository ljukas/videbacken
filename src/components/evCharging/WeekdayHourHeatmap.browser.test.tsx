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
