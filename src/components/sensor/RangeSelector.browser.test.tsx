import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { RangeSelector } from './RangeSelector'

test('renders every range and reports the picked value', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(<RangeSelector value="24h" onChange={onChange} />)

  await expect.element(screen.getByText(m.sensors_range_24h())).toBeVisible()
  await expect.element(screen.getByText(m.sensors_range_all())).toBeVisible()

  await screen.getByText(m.sensors_range_3m()).click()
  expect(onChange).toHaveBeenCalledWith('3m')
})
