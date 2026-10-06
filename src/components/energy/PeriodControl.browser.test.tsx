import { useState } from 'react'
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

test('the previous arrow is aria-disabled at the first month and does nothing', async () => {
  const { screen, onChange } = await setup({ kind: 'month', year: 2025, month: 12 })
  const prev = screen.getByRole('button', { name: m.energy_period_prev_month() })
  await expect.element(prev).toHaveAttribute('aria-disabled', 'true')
  // Playwright refuses to click aria-disabled controls; a DOM click is what a user's tap does.
  ;(prev.element() as HTMLElement).click()
  expect(onChange).not.toHaveBeenCalled()
})

test('both arrows are aria-disabled for Totalt', async () => {
  await setup({ kind: 'all' })
  expect(document.querySelectorAll('button[aria-disabled="true"]')).toHaveLength(2)
})

test('focus stays on the arrow when stepping to the end', async () => {
  const onChange = vi.fn()
  function Host() {
    const [p, setP] = useState<EnergyPeriod>({ kind: 'month', year: 2026, month: 4 })
    return (
      <PeriodControl
        period={p}
        monthsWithReadings={MONTHS}
        current={CURRENT}
        onChange={(x) => {
          onChange(x)
          setP(x)
        }}
      />
    )
  }
  const { screen } = await renderWithProviders(<Host />)
  const next = screen.getByRole('button', { name: m.energy_period_next_month() })
  ;(next.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  expect(onChange).toHaveBeenLastCalledWith({ kind: 'month', year: 2026, month: 10 })
  await expect.element(next).toHaveAttribute('aria-disabled', 'true')
  await expect.element(next).toHaveFocus()
})

test('a period without readings still has a visible label', async () => {
  await setup({ kind: 'month', year: 2026, month: 3 })
  const cell = document.querySelector('[data-slot="period-labels"]')
  expect(cell?.children).toHaveLength(9)
  expect(cell?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(8)
})

test('every possible label is stacked in the label cell, only the current one visible', async () => {
  await setup()
  const cell = document.querySelector('[data-slot="period-labels"]')
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

test('the current month says hittills in its name; the picker opens on the selected month', async () => {
  const { screen } = await setup({ kind: 'month', year: 2026, month: 10 })
  const trigger = screen.getByRole('button', { name: /Välj period|Choose period/ })
  await expect
    .element(trigger)
    .toHaveAttribute('aria-label', expect.stringContaining(`(${m.energy_chart_so_far()})`))
  await userEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  await expect.element(dialog).toBeVisible()
  expect(document.activeElement?.getAttribute('aria-current')).toBe('true')
  expect(document.activeElement?.hasAttribute('data-month')).toBe(true)
})

test('Escape closes the picker and returns focus', async () => {
  const { screen } = await setup()
  const trigger = screen.getByRole('button', { name: /Välj period|Choose period/ })
  await userEvent.click(trigger)
  await userEvent.keyboard('{Escape}')
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
})

test('picking a month closes the picker and returns focus', async () => {
  const { screen } = await setup()
  const trigger = screen.getByRole('button', { name: /Välj period|Choose period/ })
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('dialog').getByRole('button', { name: /^apr/i }))
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(trigger).toHaveFocus()
})

test('the picker’s year arrows are aria-disabled at the ends, keep focus and do nothing', async () => {
  const { screen } = await setup()
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  const prev = dialog.getByRole('button', { name: m.energy_period_prev_year() })
  const next = dialog.getByRole('button', { name: m.energy_period_next_year() })
  // 2026 is the last year with readings.
  await expect.element(next).toHaveAttribute('aria-disabled', 'true')
  await expect.element(prev).toHaveAttribute('aria-disabled', 'false')
  ;(prev.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(dialog.getByText('2025', { exact: true })).toBeVisible()
  // The first year: the arrow stays focused inside the dialog.
  await expect.element(prev).toHaveAttribute('aria-disabled', 'true')
  await expect.element(prev).toHaveFocus()
  ;(prev.element() as HTMLElement).click()
  await expect.element(dialog.getByText('2025', { exact: true })).toBeVisible()
  await expect.element(dialog).toBeVisible()
})

test('a selected Hela {år} or Totalt keeps the brand border', async () => {
  const { screen } = await setup({ kind: 'year', year: 2026 })
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  const whole = dialog
    .getByRole('button', { name: m.energy_period_whole_year({ year: '2026' }) })
    .element()
  const total = dialog.getByRole('button', { name: m.charging_tile_all_time() }).element()
  expect(whole.classList).toContain('border-brand')
  expect(whole.classList).not.toContain('border-border')
  expect(total.classList).toContain('border-border')
  expect(total.classList).not.toContain('border-brand')
})

test('a selected Totalt keeps the brand border', async () => {
  const { screen } = await setup({ kind: 'all' })
  await userEvent.click(screen.getByRole('button', { name: /Välj period|Choose period/ }))
  const dialog = screen.getByRole('dialog', { name: m.energy_period_picker() })
  const total = dialog.getByRole('button', { name: m.charging_tile_all_time() }).element()
  expect(total.classList).toContain('border-brand')
  expect(total.classList).not.toContain('border-border')
})
