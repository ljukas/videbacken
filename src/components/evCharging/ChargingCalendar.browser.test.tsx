import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { renderWithProviders } from '~test/browser/render'
import { ChargingCalendar } from './ChargingCalendar'

const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  kwh: i === 8 ? 120 : 0,
  sessions: i === 8 ? 3 : 0,
}))
const daily = [{ day: '2026-09-05', kwh: 32.1, sessions: 1 }]

function renderCalendar(onPickMonth: (month: number) => void = () => {}) {
  return renderWithProviders(
    <div style={{ width: 1000 }}>
      <ChargingCalendar
        year={2026}
        daily={daily}
        months={months}
        today="2026-09-30"
        onPickMonth={onPickMonth}
      />
    </div>,
  )
}

test('renders 12 month grids with every day and hatches future days', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  // 1 Oct - 31 Dec
  expect(screen.container.querySelectorAll('rect[data-future]').length).toBe(92)
})

test('a month heading picks that month for the timeline', async () => {
  const onPickMonth = vi.fn()
  const { screen } = await renderCalendar(onPickMonth)
  await screen.getByRole('button', { name: /september/i }).click()
  expect(onPickMonth).toHaveBeenCalledWith(9)
})

test('the day total is readable without hovering', async () => {
  const { screen } = await renderCalendar()
  await expect.element(screen.getByRole('cell', { name: /32,1 kWh/ })).toBeInTheDocument()
})

test('hovering a day shows weekday, date, kWh and sessions', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-09-05"]')
  if (!cell) throw new Error('missing cell')
  await userEvent.hover(cell)
  await expect.element(screen.getByText(/5 sep.*32,1 kWh.*1 session/)).toBeInTheDocument()
})
