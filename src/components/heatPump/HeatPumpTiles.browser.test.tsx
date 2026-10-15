import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { MATSAL, monthsPayload, OVERVANING } from '~test/fixtures/heatPumpView'
import { HeatPumpTiles } from './HeatPumpTiles'
import { heatPumpView } from './heatPumpView'

const tilesFor = (months = monthsPayload()) => {
  const v = heatPumpView({
    months,
    days: null,
    period: { kind: 'year', year: 2026 },
    now: { year: 2026, month: 9 },
    today: '2026-09-15',
  })
  if (!v) throw new Error('no view')
  return v.tiles
}
const NBSP = '\u00a0'
const tile = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-heat-pump-tile="${id}"]`)

test('a tile per unit with its kWh and "hittills", the change against last year, and the outdoor tile', async () => {
  const p = monthsPayload()
  p.lastYear = p.lastYear.map((c) =>
    c.heatPumpId === MATSAL.id && c.month <= 8 ? { ...c, kwh: 125 } : c,
  )
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  const matsal = tile(screen.container, MATSAL.id)
  expect(matsal?.textContent).toContain('Matsal')
  expect(matsal?.textContent).toMatch(/850 kWh/)
  expect(matsal?.textContent).toContain(m.energy_chart_so_far())
  expect(matsal?.textContent).toMatch(/−19\s%\smot 2025/)
  expect(tile(screen.container, 'outdoor')?.textContent).toMatch(/2,0\s°C/)
})

test('no change line without 99 % of the hours, but its line keeps its height', async () => {
  const p = monthsPayload()
  p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) =>
    c.heatPumpId === OVERVANING.id ? { ...c, hours: 100 } : c,
  )
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  const over = tile(screen.container, OVERVANING.id)
  expect(over?.textContent).not.toMatch(/mot 2025/)
  expect(over?.querySelectorAll('dd')).toHaveLength(2) // the empty change line is still there
})

// Browser tests have no app CSS, so the heights themselves can't be measured here: pin what holds them. A
// whitespace-only line collapses to zero height, a no-break space doesn't.
test('empty lines hold a no-break space, and "hittills" is always there, hidden when the period is not running', async () => {
  const p = monthsPayload()
  p.lastYearSoFar = (p.lastYearSoFar ?? []).map((c) =>
    c.heatPumpId === OVERVANING.id ? { ...c, hours: 100 } : c,
  )
  const running = tilesFor(p)
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={running} />)
  const over = tile(screen.container, OVERVANING.id)
  expect(over?.querySelectorAll('dd')[1]?.textContent).toBe(NBSP)
  expect(screen.container.querySelector('[data-slot="heat-pump-missing"]')?.textContent).toBe(NBSP)
  const soFar = (root: ParentNode) =>
    tile(root, MATSAL.id)?.querySelector<HTMLElement>('[data-slot="so-far"]')
  expect(soFar(screen.container)?.textContent).toBe(m.energy_chart_so_far())
  expect(soFar(screen.container)?.classList.contains('invisible')).toBe(false)
  const past = await renderWithProviders(<HeatPumpTiles tiles={{ ...running, running: false }} />)
  expect(soFar(past.screen.container)?.textContent).toBe(m.energy_chart_so_far())
  expect(soFar(past.screen.container)?.classList.contains('invisible')).toBe(true)
})

test('a unit without a figure reads "—"; the missing-hours note shows only with a gap', async () => {
  const p = monthsPayload({
    months: monthsPayload().months.filter((c) => c.heatPumpId === MATSAL.id),
  })
  p.months = p.months.map((c) => (c.month === 3 ? { ...c, hours: 700, expectedHours: 744 } : c))
  const { screen } = await renderWithProviders(<HeatPumpTiles tiles={tilesFor(p)} />)
  expect(tile(screen.container, OVERVANING.id)?.textContent).toContain('—')
  expect(screen.container.querySelector('[data-slot="heat-pump-missing"]')?.textContent).toBe(
    m.energy_missing_hours({ hours: '44' }),
  )
})
