import { Profiler } from 'react'
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { overflowX, SR_ONLY_CSS, tablesClipped } from '~test/browser/chartDom'
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
      {/* No Tailwind in the browser project: stand in for the tooltip's whitespace-nowrap. */}
      <style>{'.whitespace-nowrap{white-space:nowrap}'}</style>
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

test('a tooltip for a mark at the window edge is kept inside the window', async () => {
  // A narrow chart pinned to the right edge: the tooltip (portalled to <body>) must not spill out.
  const { screen } = await renderWithProviders(
    <div style={{ position: 'absolute', top: 0, left: window.innerWidth - 120, width: 120 }}>
      <style>{'.whitespace-nowrap{white-space:nowrap}'}</style>
      <ChargingCalendar
        year={2026}
        daily={daily}
        months={months}
        today="2026-09-30"
        onPickMonth={() => {}}
      />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-09-12"]')
  if (!cell) throw new Error('missing cell')
  await userEvent.hover(cell)
  const tip = screen.getByText(/12 sep.*10,5 kWh · 2 sessioner$/)
  await expect.element(tip).toBeInTheDocument()
  const t = tip.element().getBoundingClientRect()
  expect(t.left).toBeGreaterThanOrEqual(0)
  expect(t.right).toBeLessThanOrEqual(window.innerWidth)
})

test('a mark left of the window edge gets a tooltip inside the window', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ position: 'absolute', top: 0, left: -250, width: 400 }}>
      <style>{'.whitespace-nowrap{white-space:nowrap}'}</style>
      <ChargingCalendar
        year={2026}
        daily={[{ day: '2026-01-05', kwh: 4.2, sessions: 1 }]}
        months={months}
        today="2026-09-30"
        onPickMonth={() => {}}
      />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-01-01"]')
  if (!cell) throw new Error('missing cell')
  expect(cell.getBoundingClientRect().left).toBeLessThan(0)
  cell.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  const tip = screen.getByText(/1 jan/)
  await expect.element(tip).toBeInTheDocument()
  const t = tip.element().getBoundingClientRect()
  expect(t.left).toBeGreaterThanOrEqual(0)
  expect(t.right).toBeLessThanOrEqual(window.innerWidth)
})

test('on a scrolled page the tooltip sits inside the window next to the cell', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 400 }}>
      <style>{'.whitespace-nowrap{white-space:nowrap}'}</style>
      <div style={{ height: 3000 }} />
      <ChargingCalendar
        year={2026}
        daily={daily}
        months={months}
        today="2026-09-30"
        onPickMonth={() => {}}
      />
      <div style={{ height: 3000 }} />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  const cell = screen.container.querySelector('rect[data-day="2026-09-12"]')
  if (!cell) throw new Error('missing cell')
  window.scrollTo(0, window.scrollY + cell.getBoundingClientRect().top - window.innerHeight / 2)
  await expect
    .poll(() => Math.abs(cell.getBoundingClientRect().top - window.innerHeight / 2))
    .toBeLessThan(2)
  await userEvent.hover(cell)
  const tip = screen.getByText(/12 sep.*10,5 kWh · 2 sessioner$/)
  await expect.element(tip).toBeInTheDocument()
  const t = tip.element().getBoundingClientRect()
  const c = cell.getBoundingClientRect()
  expect(t.top).toBeGreaterThanOrEqual(0)
  expect(t.bottom).toBeLessThanOrEqual(window.innerHeight)
  expect(t.left).toBeGreaterThanOrEqual(0)
  expect(t.right).toBeLessThanOrEqual(window.innerWidth)
  // Vertically adjacent to the cell: the tooltip overlaps it or sits just above/below.
  expect(t.bottom).toBeGreaterThan(c.top - 60)
  expect(t.top).toBeLessThan(c.bottom + 60)
})

test('scrolling does not re-render the chart while no tooltip is open', async () => {
  let renders = 0
  const { screen } = await renderWithProviders(
    // pointer-events: none so a pointer resting from an earlier test can't open a tooltip as cells scroll under it.
    <div style={{ width: 400, pointerEvents: 'none' }}>
      <Profiler id="cal" onRender={() => renders++}>
        <ChargingCalendar
          year={2026}
          daily={daily}
          months={months}
          today="2026-09-30"
          onPickMonth={() => {}}
        />
      </Profiler>
      <div style={{ height: 3000 }} />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('rect[data-day]').length).toBe(365)
  await new Promise((r) => setTimeout(r, 400))
  const before = renders
  for (const y of [100, 300, 600, 900]) {
    window.scrollTo(0, y)
    await new Promise((r) => requestAnimationFrame(r))
  }
  await new Promise((r) => setTimeout(r, 100))
  expect(renders).toBe(before)
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

test("its sr-only tables don't widen a 320 px page", async () => {
  const { screen } = await renderWithProviders(
    <div data-testid="page" style={{ width: 320, overflow: 'auto', position: 'relative' }}>
      <style>{SR_ONLY_CSS}</style>
      <ChargingCalendar
        year={2026}
        daily={daily}
        months={months}
        today="2026-09-30"
        onPickMonth={() => {}}
      />
    </div>,
  )
  await expect.element(screen.getByRole('table', { name: /september 2026/i })).toBeInTheDocument()
  expect(overflowX(screen.getByTestId('page').element())).toBe(0)
  tablesClipped(screen.container)
})
