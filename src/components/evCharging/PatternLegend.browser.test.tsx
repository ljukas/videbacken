import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { PatternLegend } from './PatternLegend'

test('shows the less/more ends and the optional max label', async () => {
  const { screen } = await renderWithProviders(<PatternLegend maxLabel="0 … 48 kWh" />)
  await expect.element(screen.getByText(m.charging_patterns_legend_less())).toBeVisible()
  await expect.element(screen.getByText(m.charging_patterns_legend_more())).toBeVisible()
  await expect.element(screen.getByText('0 … 48 kWh')).toBeVisible()
})

test('omits the max label by default', async () => {
  const { screen } = await renderWithProviders(<PatternLegend />)
  await expect.element(screen.getByText('kWh')).not.toBeInTheDocument()
})
