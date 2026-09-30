import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { renderWithProviders } from '~test/browser/render'
import { ChargingCalendar } from './ChargingCalendar'

const months = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  kwh: i === 8 ? 120 : 0,
  sessions: i === 8 ? 3 : 0,
}))
const daily = [
  { day: '2026-09-05', kwh: 32.1, sessions: 1 },
  { day: '2026-09-12', kwh: 10.5, sessions: 2 },
]

function renderCalendar(onPickMonth: (month: number) => void = () => {}, width = 1000) {
  return renderWithProviders(
    <div style={{ width }}>
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
  const button = screen.getByRole('button', { name: /visa september/i })
  await button.click()
  expect(onPickMonth).toHaveBeenCalledWith(9)
  // The browser project has no Tailwind, so pin the 24 px target by its class.
  expect(button.element().className).toContain('min-h-6')
})

test('the day total is readable without hovering', async () => {
  const { screen } = await renderCalendar()
  await expect.element(screen.getByRole('cell', { name: /32,1 kWh/ })).toBeInTheDocument()
  await expect.element(screen.getByRole('table', { name: /september 2026/i })).toBeInTheDocument()
})

test('hovering a day opens a singular-session tooltip above that cell', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-09-05"]')
  if (!cell) throw new Error('missing cell')
  await userEvent.hover(cell)
  const tip = screen.getByText(/5 sep.*32,1 kWh · 1 session$/)
  await expect.element(tip).toBeInTheDocument()
  const t = tip.element().getBoundingClientRect()
  const c = cell.getBoundingClientRect()
  expect(t.bottom).toBeLessThanOrEqual(c.top + 4)
  expect(t.left).toBeLessThan(c.right)
  expect(t.right).toBeGreaterThan(c.left)
})

test('a two-session day says sessioner', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-09-12"]')
  if (!cell) throw new Error('missing cell')
  await userEvent.hover(cell)
  await expect.element(screen.getByText(/12 sep.*10,5 kWh · 2 sessioner$/)).toBeInTheDocument()
})

test('future days open no tooltip', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-10-05"]')
  if (!cell) throw new Error('missing cell')
  await userEvent.hover(cell)
  expect(screen.container.textContent).not.toMatch(/5 okt/)
})

test('the grid auto-fills 8.5 rem columns and the cells scale with their card', async () => {
  // No Tailwind in the browser project: pin the class, and that the SVG follows its wrapper.
  const { screen } = await renderCalendar(() => {}, 288)
  expect(screen.container.querySelector('[class*="auto-fill"][class*="8.5rem"]')).not.toBeNull()
  await expect
    .poll(() => screen.container.querySelector('rect[data-day]')?.getBoundingClientRect().width)
    .toBeGreaterThan(15)
})

test('days are coloured by quantile step and empty days are muted', async () => {
  const { screen } = await renderCalendar()
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const style = (day: string) =>
    screen.container.querySelector<SVGRectElement>(`rect[data-day="${day}"]`)?.style
  // Two distinct values: the ramp's ends, so they never look alike.
  expect(style('2026-09-12')?.fill).toBe('color-mix(in oklab, var(--brand) 20%, var(--card))')
  expect(style('2026-09-05')?.fill).toBe('color-mix(in oklab, var(--brand) 100%, var(--card))')
  expect(style('2026-09-06')?.fill).toBe('var(--muted)')
  expect(style('2026-09-06')?.stroke).toBe('var(--border)')
})
