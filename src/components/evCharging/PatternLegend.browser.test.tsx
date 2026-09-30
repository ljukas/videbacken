import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { PatternLegend } from './PatternLegend'

test('is one labelled image with a zero swatch plus five steps and the max label', async () => {
  const { screen } = await renderWithProviders(<PatternLegend maxLabel="48 kWh" />)
  const legend = screen.getByRole('img')
  await expect
    .element(legend)
    .toHaveAccessibleName(
      `${m.charging_patterns_legend_less()} … ${m.charging_patterns_legend_more()}, 48 kWh`,
    )
  const el = legend.element()
  expect(el.querySelectorAll('span.size-3')).toHaveLength(6)
  expect(el.textContent).toContain('48 kWh')
})

test('omits the max label by default', async () => {
  const { screen } = await renderWithProviders(<PatternLegend />)
  const el = screen.getByRole('img').element()
  expect(el.textContent).not.toContain('kWh')
})
