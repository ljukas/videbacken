import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyFlowDiagram } from './EnergyFlowDiagram'

// October 2026 on prod, rounded (synthetic copy).
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 145.8,
  gridExportKwh: 15.5,
  solarKwh: 76.9,
  loadKwh: 200.6,
  batteryDischargeKwh: 49,
  batteryChargeSolarKwh: 21.8,
  batteryChargeGridKwh: 34,
  carKwh: 28.4,
  firstSocPct: 19,
  lastSocPct: 100,
  buckets: 1568,
  expectedBuckets: 1568,
  ...over,
})
const draw = (s: PeriodSums, width = 1006, showValues = true) =>
  renderWithProviders(
    <EnergyFlowDiagram sums={s} figures={energyFigures(s)} width={width} showValues={showValues} />,
  )

test('every node shows its figure', async () => {
  const { screen } = await draw(sums())
  for (const text of ['76,9 kWh', '145,8 kWh', '15,5 kWh', '200,6 kWh']) {
    await expect.element(screen.getByText(text)).toBeInTheDocument()
  }
  await expect.element(screen.getByText(m.energy_flow_car())).toBeInTheDocument()
  await expect.element(screen.getByText('28,4 kWh')).toBeInTheDocument()
})

test('arrows carry their values; the switch off removes only the pills', async () => {
  const { screen } = await draw(sums())
  const pills = screen.container.querySelectorAll('[data-slot="flow-value"]')
  // sol>exp, sol>load, sol>bat, imp>bat, imp>load, bat>load (bat>exp is 0 in October).
  expect(pills).toHaveLength(6)
  expect([...pills].map((p) => p.textContent)).toContain('111,8')
  const off = await draw(sums(), 1006, false)
  expect(off.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  // The arrows stay (one hit area each).
  expect(off.screen.container.querySelectorAll('[data-slot="flow-hit"]')).toHaveLength(6)
})

test('the loss: a value and a stub from 0.5 kWh, "≈ 0" and no stub below or negative', async () => {
  // February: in 274,45, out 156,97, Δstored −0,83 → loss ≈ 118,3.
  const feb = await draw(
    sums({
      batteryChargeSolarKwh: 25.57,
      batteryChargeGridKwh: 248.88,
      batteryDischargeKwh: 156.97,
      firstSocPct: 34,
      lastSocPct: 23,
    }),
  )
  await expect.element(feb.screen.getByText('118,3')).toBeInTheDocument()
  expect(feb.screen.container.querySelector('[data-slot="flow-loss"]')).not.toBeNull()
  // Charging 10 kWh, discharging 9, SoC up by 20 % (1,5 kWh): loss −0,5 → "≈ 0".
  const neg = await draw(
    sums({
      batteryChargeSolarKwh: 10,
      batteryChargeGridKwh: 0,
      batteryDischargeKwh: 9,
      firstSocPct: 50,
      lastSocPct: 70,
    }),
  )
  await expect.element(neg.screen.getByText(m.energy_flow_about_zero())).toBeInTheDocument()
  expect(neg.screen.container.querySelector('[data-slot="flow-loss"]')).toBeNull()
})

test('battery to sold is drawn when export exceeds the solar surplus', async () => {
  const { screen } = await draw(sums({ gridExportKwh: 70 }))
  expect(screen.container.querySelector('[data-flow-edge="bat>exp"]')).not.toBeNull()
})

test('hovering an arrow names it with its share', async () => {
  const { screen } = await draw(sums())
  // Köpt el → Förbrukning is a point-symmetric cubic: its box centre (where hover points) lies on the stroke.
  const hit = screen.container.querySelector(
    '[data-flow-edge="imp>load"] [data-slot="flow-hit"]',
  ) as Element
  await userEvent.hover(hit)
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({ from: m.energy_tile_import(), to: m.energy_tile_load() }),
      ),
    )
    .toBeVisible()
  // importDirect 111,8 of 145,8 → 77 %
  await expect
    .element(screen.getByText(m.energy_flow_share_import({ share: '77 %' })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('the narrow layout drops the charge level from the battery node', async () => {
  const { screen } = await draw(sums(), 324)
  expect(screen.container.querySelector('svg')?.getAttribute('height')).toBe('490')
  expect(
    screen.getByText(m.energy_flow_charge_level({ from: '19', to: '100' })).elements(),
  ).toHaveLength(0)
})
