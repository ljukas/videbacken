import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { energyFigures, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { BatteryFlowDiagram } from './BatteryFlowDiagram'

// September 2026 on prod (see BatteryFlow.browser.test.tsx).
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 947,
  batteryDischargeKwh: 225.4,
  batteryChargeSolarKwh: 172.9,
  batteryChargeGridKwh: 67.9,
  carKwh: 211,
  firstSocPct: 15,
  lastSocPct: 20,
  buckets: 8640,
  expectedBuckets: 8640,
  ...over,
})
// February: in 274,45, out 156,97, Δstored −0,83 → loss ≈ 118,3 (43 % of what stayed).
const february = sums({
  batteryChargeSolarKwh: 25.57,
  batteryChargeGridKwh: 248.88,
  batteryDischargeKwh: 156.97,
  firstSocPct: 34,
  lastSocPct: 23,
})
const barelyRan = sums({
  batteryChargeSolarKwh: 0.4,
  batteryChargeGridKwh: 0.2,
  batteryDischargeKwh: 0.1,
  firstSocPct: 50,
  lastSocPct: 50,
})
const draw = (s: PeriodSums, width = 1006) =>
  renderWithProviders(
    <BatteryFlowDiagram sums={s} figures={energyFigures(s)} width={width} showValues />,
  )
const hitOf = (c: Element, id: string) => c.querySelector(`[data-flow-hit="${id}"]`) as Element
const arrowName = (from: string, to: string) => m.energy_flow_arrow({ from, to })

test('a battery that barely ran: no share on the in arrows', async () => {
  const { screen } = await draw(barelyRan)
  for (const [id, from] of [
    ['sol>bat', m.energy_tile_solar()],
    ['imp>bat', m.energy_tile_import()],
  ] as const) {
    const hit = hitOf(screen.container, id)
    expect(hit).not.toBeNull()
    await userEvent.hover(hit)
    await expect.element(screen.getByText(arrowName(from, m.energy_flow_battery()))).toBeVisible()
    expect(document.body.textContent).not.toMatch(/\d\s%/)
    await userEvent.hover(document.body)
  }
})

test('an in arrow shows its share of what went in', async () => {
  const { screen } = await draw(sums())
  await userEvent.hover(hitOf(screen.container, 'sol>bat'))
  await expect
    .element(screen.getByText(arrowName(m.energy_tile_solar(), m.energy_flow_battery())))
    .toBeVisible()
  // 172,9 of 240,8 → 72 %
  await expect.element(screen.getByText(m.energy_battery_in_share({ share: '72 %' }))).toBeVisible()
  await userEvent.hover(document.body)
})

test('Ut: "till huset" without a sale', async () => {
  const { screen } = await draw(sums())
  await userEvent.hover(hitOf(screen.container, 'bat>out'))
  await expect.element(screen.getByText(m.energy_battery_out_house())).toBeVisible()
  await userEvent.hover(document.body)
})

test('Ut: the house/sold split with a sale', async () => {
  const { screen } = await draw(sums({ gridExportKwh: 400 }))
  await userEvent.hover(hitOf(screen.container, 'bat>out'))
  await expect
    .element(screen.getByText(m.energy_battery_out_split({ house: '161,5', sold: '63,9' })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('Förlust: the share, the charge level and the winter hint', async () => {
  const { screen } = await draw(february)
  await userEvent.hover(hitOf(screen.container, 'bat>loss'))
  await expect
    .element(screen.getByText(m.energy_flow_charge_level({ from: '34', to: '23' })))
    .toBeVisible()
  await expect.element(screen.getByText(m.energy_flow_winter_hint())).toBeVisible()
  await expect.element(screen.getByText(/av det som laddades in/).first()).toBeVisible()
  await userEvent.hover(document.body)
})

test('hovering an arrow dims the others; leaving clears it', async () => {
  const { screen } = await draw(sums())
  const c = screen.container
  await userEvent.hover(hitOf(c, 'sol>bat'))
  await expect
    .element(screen.getByText(arrowName(m.energy_tile_solar(), m.energy_flow_battery())))
    .toBeVisible()
  expect(c.querySelector('[data-flow-edge="bat>out"]')?.getAttribute('class')).toContain(
    'opacity-25',
  )
  expect(c.querySelector('[data-flow-edge="sol>bat"]')?.getAttribute('class') ?? '').not.toContain(
    'opacity-25',
  )
  await userEvent.hover(c.querySelector('[data-flow-node="out"]') as Element)
  await expect
    .element(screen.getByText(arrowName(m.energy_tile_solar(), m.energy_flow_battery())))
    .not.toBeInTheDocument()
  expect(c.querySelectorAll('.opacity-25')).toHaveLength(0)
})

test('a large sale stays inside the narrow Ut node (phone content ~270 px)', async () => {
  // gridExportKwh 600 − (509 − 172,9) → 263,9 kWh sold from the battery.
  const { screen } = await draw(sums({ gridExportKwh: 600 }), 270)
  const out = screen.container.querySelector('[data-flow-node="out"]') as Element
  const rect = out.querySelector('rect') as SVGRectElement
  const text = [...out.querySelectorAll('text')].find((t) => t.textContent?.includes('varav såld'))
  expect(text).toBeDefined()
  const right = (el: Element) => el.getBoundingClientRect().right
  expect(right(text as Element)).toBeLessThanOrEqual(right(rect) + 0.5)
})
