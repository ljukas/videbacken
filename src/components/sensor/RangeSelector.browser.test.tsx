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

test('offers the 1-week range and reports it when picked', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(<RangeSelector value="24h" onChange={onChange} />)

  await screen.getByText(m.sensors_range_1w()).click()
  expect(onChange).toHaveBeenCalledWith('1w')
})

test('re-pressing the active range does not report an empty value', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(<RangeSelector value="24h" onChange={onChange} />)
  // Radix fires '' when the active item is re-pressed; the `if (v)` guard must
  // swallow it so the range never becomes an invalid empty string.
  await screen.getByText(m.sensors_range_24h()).click()
  expect(onChange).not.toHaveBeenCalled()
})

test('range items are 40 px tall with 14 px text, in a 4-column grid on a phone', async () => {
  const { screen } = await renderWithProviders(<RangeSelector value="24h" onChange={() => {}} />)
  const group = screen.getByRole('radiogroup', { name: m.sensors_range_label() })
  await expect.element(group).toBeVisible()
  expect(group.element().className).toContain('grid-cols-4')
  expect(group.element().className).toContain('sm:flex')
  const item = screen.getByRole('radio', { name: m.sensors_range_24h() })
  expect(item.element().className).toContain('h-10')
  expect(item.element().className).toContain('text-sm')
})
