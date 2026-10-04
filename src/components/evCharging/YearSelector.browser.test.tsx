import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { YearSelector } from './YearSelector'

test('shows the selected year and reports a picked one as a number', async () => {
  const onChange = vi.fn()
  const { screen } = await renderWithProviders(
    <YearSelector years={[2026, 2025, 2024]} value={2026} onChange={onChange} />,
  )
  const trigger = screen.getByRole('combobox', { name: m.charging_year_label() })
  await expect.element(trigger).toHaveTextContent('2026')

  await trigger.click()
  await screen.getByRole('option', { name: '2024' }).click()
  expect(onChange).toHaveBeenCalledWith(2024)
})

test('keeps a selected year without data selectable', async () => {
  const { screen } = await renderWithProviders(
    <YearSelector years={[2026]} value={2021} onChange={() => {}} />,
  )
  await expect
    .element(screen.getByRole('combobox', { name: m.charging_year_label() }))
    .toHaveTextContent('2021')
})

test('the server render already shows the year, so it never pops in on hydration', () => {
  const html = renderToStaticMarkup(
    <YearSelector years={[2026, 2025]} value={2026} onChange={() => {}} />,
  )
  expect(html).toMatch(/data-slot="select-value"[^>]*>2026<\/span>/)
})
