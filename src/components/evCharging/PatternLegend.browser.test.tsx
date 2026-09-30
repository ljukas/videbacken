import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { PatternLegend } from './PatternLegend'
import { intensity, ZERO_FILL } from './patternChart'

const tenValues = intensity([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

test('reads "mindre ●●●●●● mer" plus the max, with the ranges only in the accessible name', async () => {
  const { screen } = await renderWithProviders(<PatternLegend scale={tenValues} metric="kwh" />)
  const legend = screen.getByRole('img')
  await expect
    .element(legend)
    .toHaveAccessibleName(
      'Färgskala: 0; 1,0–2,0 kWh; 3,0–4,0 kWh; 5,0–6,0 kWh; 7,0–8,0 kWh; 9,0–10,0 kWh',
    )
  const el = legend.element()
  const swatches = el.querySelectorAll<HTMLElement>('[data-swatch]')
  expect(swatches).toHaveLength(tenValues.steps.length + 1)
  expect(swatches[0]?.dataset.swatch).toBe('zero')
  expect(swatches[0]?.style.background).toBe(ZERO_FILL)
  // Visible text: less, more, then the max; no per-step ranges.
  expect(el.textContent).toBe('mindremer10,0 kWh')
  expect(el.textContent).not.toContain('1,0–2,0')
})

test('each step swatch uses its own step colour', async () => {
  const { screen } = await renderWithProviders(<PatternLegend scale={tenValues} metric="kwh" />)
  const steps = [
    ...screen.getByRole('img').element().querySelectorAll<HTMLElement>('[data-swatch="step"]'),
  ]
  expect(steps.map((s) => s.style.background)).toEqual(tenValues.steps.map((s) => s.color))
  expect(new Set(steps.map((s) => s.style.background)).size).toBe(5)
})

test('a single-value step reads as that value, in hours for the plugged-in metric', async () => {
  const { screen } = await renderWithProviders(
    <PatternLegend scale={intensity([0, 5, 5])} metric="plugged" />,
  )
  await expect
    .element(screen.getByRole('img'))
    .toHaveAccessibleName('Färgskala: 0; 5,0 h inkopplad')
})

test('all-zero data shows only the zero swatch', async () => {
  const { screen } = await renderWithProviders(
    <PatternLegend scale={intensity([0, 0])} metric="kwh" />,
  )
  const el = screen.getByRole('img').element()
  expect(el.querySelectorAll('[data-swatch]')).toHaveLength(1)
  expect(el.textContent).toBe('mindremer')
  await expect.element(screen.getByRole('img')).toHaveAccessibleName('Färgskala: 0')
})
