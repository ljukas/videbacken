import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { EnergyPeriod } from '~/lib/houseEnergy/period'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { PeriodControl } from './PeriodControl'

const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-04', '2026-10']
const CURRENT = { year: 2026, month: 10 }
const feb: EnergyPeriod = { kind: 'month', year: 2026, month: 2 }

async function setup(period: EnergyPeriod = feb) {
  const onChange = vi.fn()
  const r = await renderWithProviders(
    <PeriodControl
      period={period}
      monthsWithReadings={MONTHS}
      current={CURRENT}
      onChange={onChange}
    />,
  )
  return { ...r, onChange }
}

test('the arrows step to the neighbouring months with readings', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: m.energy_period_next_month() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 4 })
  await userEvent.click(screen.getByRole('button', { name: m.energy_period_prev_month() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 1 })
})

test('the arrows disable at the ends and for Totalt', async () => {
  const first = await setup({ kind: 'month', year: 2025, month: 12 })
  await expect
    .element(first.screen.getByRole('button', { name: m.energy_period_prev_month() }))
    .toBeDisabled()
  first.screen.unmount()
  const all = await setup({ kind: 'all' })
  const buttons = all.screen.container.querySelectorAll('button[disabled]')
  expect(buttons.length).toBe(2)
})

test('every possible label is stacked in the label cell, only the current one visible', async () => {
  const { screen } = await setup()
  const { container } = screen
  const cell = container.querySelector('[data-slot="period-labels"]')
  // 5 months + 2 years + Totalt
  expect(cell?.children).toHaveLength(8)
  expect(cell?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(7)
})

test('the picker shows the year’s twelve months, disables those without readings, and picks one', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  await expect.element(dialog).toBeVisible()
  const months = dialog.getByRole('button', {
    name: /^(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)/i,
  })
  expect(months.elements()).toHaveLength(12)
  await expect.element(dialog.getByRole('button', { name: /^mar/i })).toBeDisabled()
  await userEvent.click(dialog.getByRole('button', { name: /^apr/i }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 4 })
})

test('the picker picks the whole year and Totalt, and changes year without closing', async () => {
  const { screen, onChange } = await setup()
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  await userEvent.click(dialog.getByRole('button', { name: m.energy_period_prev_year() }))
  await expect.element(dialog.getByText('2025', { exact: true })).toBeVisible()
  await userEvent.click(
    dialog.getByRole('button', { name: m.energy_period_whole_year({ year: '2025' }) }),
  )
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'year', year: 2025 })
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  await userEvent.click(screen.getByRole('button', { name: m.charging_tile_all_time() }))
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'all' })
})

test('the current month says hittills; Escape closes the picker and returns focus', async () => {
  const { screen } = await setup({ kind: 'month', year: 2026, month: 10 })
  const trigger = screen.getByRole('button', { name: /Välj period|Choose period/ })
  await expect.element(trigger).toHaveTextContent(m.energy_chart_so_far())
  await userEvent.click(trigger)
  await userEvent.keyboard('{Escape}')
  await expect.element(trigger).toHaveFocus()
})
