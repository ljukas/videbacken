import { expect, test } from 'vitest'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergySourceBar } from './EnergySourceBar'

const supply = { kwh: 56, solarKwh: 20, batteryKwh: 8, noHouseDataKwh: 0 }

test('one image summarised in its label, with every figure in the legend', async () => {
  const { screen } = await renderWithProviders(<EnergySourceBar supply={supply} />)
  const bar = screen.getByRole('img', {
    name: m.charging_session_sources_label({ grid: '28,0', solar: '20,0', battery: '8,0' }),
  })
  // No app.css in browser tests: the bar has no height, so it's present, not "visible".
  await expect.element(bar).toBeInTheDocument()
  const segments = [...bar.element().querySelectorAll<HTMLElement>('[data-source]')]
  expect(segments.map((el) => el.dataset.source)).toEqual(['grid', 'solar', 'battery'])
  const widths = segments.map((el) => Number.parseFloat(el.style.width))
  expect(widths[0]).toBeCloseTo(50, 3)
  expect(widths[1]).toBeCloseTo((20 / 56) * 100, 3)
  expect(widths[2]).toBeCloseTo((8 / 56) * 100, 3)
  await expect.element(screen.getByText(m.charging_supply_solar())).toBeVisible()
  await expect.element(screen.getByText('20,0 kWh')).toBeVisible()
})

test('a source without energy is left out', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ ...supply, batteryKwh: 0 }} />,
  )
  expect(screen.getByText(m.charging_supply_battery()).elements()).toHaveLength(0)
})

test('no house data at all: a sentence instead of a 100 % grid bar', async () => {
  const { screen } = await renderWithProviders(
    <EnergySourceBar supply={{ kwh: 56, solarKwh: 0, batteryKwh: 0, noHouseDataKwh: 56 }} />,
  )
  await expect.element(screen.getByText(m.charging_session_no_house_data_all())).toBeVisible()
  expect(screen.getByRole('img').elements()).toHaveLength(0)
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
