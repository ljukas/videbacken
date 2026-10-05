import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergySourceBar } from './EnergySourceBar'

const supply = { kwh: 56, solarKwh: 20, batteryKwh: 8, noHouseDataKwh: 0 }

test('a captioned figure: the legend carries every figure, the bar is hidden from assistive tech', async () => {
  const { screen } = await renderWithProviders(<EnergySourceBar supply={supply} />)
  const figure = screen.getByRole('figure', { name: m.charging_session_sources_title() })
  await expect.element(figure).toBeInTheDocument()
  const items = figure
    .getByRole('listitem')
    .elements()
    .map((li) => li.textContent)
  expect(items).toEqual([
    `${m.charging_supply_grid()}28,0 kWh`,
    `${m.charging_supply_solar()}20,0 kWh`,
    `${m.charging_supply_battery()}8,0 kWh`,
  ])
  const bar = figure.element().querySelector<HTMLElement>('[aria-hidden="true"]:has([data-source])')
  expect(bar).not.toBeNull()
  const segments = [...(bar?.querySelectorAll<HTMLElement>('[data-source]') ?? [])]
  expect(segments.map((el) => el.dataset.source)).toEqual(['grid', 'solar', 'battery'])
  const widths = segments.map((el) => Number.parseFloat(el.style.width))
  expect(widths[0]).toBeCloseTo(50, 3)
  expect(widths[1]).toBeCloseTo((20 / 56) * 100, 3)
  expect(widths[2]).toBeCloseTo((8 / 56) * 100, 3)
})

test('a source that would read 0,0 kWh is left out of the bar and the legend', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ ...supply, batteryKwh: 0.04 }} />,
  )
  expect(screen.getByText(m.charging_supply_battery()).elements()).toHaveLength(0)
  expect(screen.container.querySelectorAll('[data-source]')).toHaveLength(2)
})

test('no house data at all: a sentence instead of a 100 % grid bar', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ kwh: 56, solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 56 }} />,
  )
  await expect.element(screen.getByText(m.charging_session_no_house_data_all())).toBeVisible()
  expect(screen.getByRole('figure').elements()).toHaveLength(0)
})

test('partly without house data says how much', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ ...supply, noHouseDataKwh: 6 }} />,
  )
  await expect
    .element(screen.getByText(m.charging_session_no_house_data({ kwh: '6,0' })))
    .toBeVisible()
})

test('no energy renders nothing', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ kwh: 0, solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 0 }} />,
  )
  expect(screen.container.textContent).toBe('')
})
