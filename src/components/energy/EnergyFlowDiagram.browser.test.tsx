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
  const hit = screen.container.querySelector('[data-flow-hit="imp>load"]') as Element
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

const batteryText = (c: HTMLElement) => c.querySelector('[data-flow-node="bat"]')?.textContent ?? ''

test('the wide battery node shows the change in stored energy, not the charge level', async () => {
  // 19 → 100 % of 7,58 kWh: 6,1 kWh more is stored at the end.
  const { screen } = await draw(sums())
  expect(batteryText(screen.container)).toContain(m.energy_flow_stored({ kwh: '+6,1' }))
  expect(batteryText(screen.container)).not.toContain(
    m.energy_flow_charge_level({ from: '19', to: '100' }),
  )
})

test('less stored reads with a minus, no change without a sign', async () => {
  const less = await draw(sums({ firstSocPct: 34, lastSocPct: 23 }))
  expect(batteryText(less.screen.container)).toContain(m.energy_flow_stored({ kwh: '−0,8' }))
  const same = await draw(sums({ firstSocPct: 50, lastSocPct: 50.2 }))
  expect(batteryText(same.screen.container)).toContain(m.energy_flow_stored({ kwh: '0,0' }))
})

test('the narrow layout drops the stored line from the battery node', async () => {
  const { screen } = await draw(sums(), 324)
  expect(screen.container.querySelector('svg')?.getAttribute('height')).toBe('490')
  expect(batteryText(screen.container)).not.toContain(m.energy_flow_stored({ kwh: '+6,1' }))
  expect(batteryText(screen.container)).not.toContain(
    m.energy_flow_charge_level({ from: '19', to: '100' }),
  )
})

const hitOf = (c: Element, id: string) => c.querySelector(`[data-flow-hit="${id}"]`) as Element

test('the diagram has an accessible name and no native title tooltip', async () => {
  const { screen } = await draw(sums())
  await expect
    .element(screen.getByRole('img', { name: m.energy_flow_description() }))
    .toBeInTheDocument()
  expect(screen.container.querySelector('svg title')).toBeNull()
})

test('leaving an arrow closes the tooltip and clears the dimming', async () => {
  const { screen } = await draw(sums())
  const c = screen.container
  await userEvent.hover(hitOf(c, 'imp>load'))
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({ from: m.energy_tile_import(), to: m.energy_tile_load() }),
      ),
    )
    .toBeVisible()
  // The other arrows and their pills dim; the hovered one does not.
  expect(c.querySelector('[data-flow-edge="sol>load"]')?.getAttribute('class')).toContain(
    'opacity-25',
  )
  expect(c.querySelector('[data-flow-edge="imp>load"]')?.getAttribute('class') ?? '').not.toContain(
    'opacity-25',
  )
  expect(
    [...c.querySelectorAll('[data-slot="flow-value"]')].filter((p) =>
      p.getAttribute('class')?.includes('opacity-25'),
    ),
  ).toHaveLength(5)
  await userEvent.hover(c.querySelector('[data-flow-node="load"]') as Element)
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({ from: m.energy_tile_import(), to: m.energy_tile_load() }),
      ),
    )
    .not.toBeInTheDocument()
  expect(c.querySelectorAll('.opacity-25')).toHaveLength(0)
})

test('battery to sold names itself and has no share line', async () => {
  const { screen } = await draw(sums({ gridExportKwh: 70 }))
  await userEvent.hover(hitOf(screen.container, 'bat>exp'))
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({ from: m.energy_flow_battery(), to: m.energy_tile_export() }),
      ),
    )
    .toBeVisible()
  await expect.element(screen.getByText('14,9 kWh')).toBeVisible()
  const suffix = m.energy_flow_share_load({ share: '~' }).split('~')[1].trim()
  expect(document.body.textContent).not.toContain(suffix)
  await userEvent.hover(document.body)
})

test('the loss tooltip shows the share, the charge level and the winter hint', async () => {
  const { screen } = await draw(
    sums({
      batteryChargeSolarKwh: 25.57,
      batteryChargeGridKwh: 248.88,
      batteryDischargeKwh: 156.97,
      firstSocPct: 34,
      lastSocPct: 23,
    }),
  )
  const rects = [...screen.container.querySelectorAll('rect[fill="transparent"]')]
  await userEvent.hover(rects[rects.length - 1])
  await expect.element(screen.getByText(m.energy_flow_loss_title())).toBeVisible()
  await expect.element(screen.getByText(m.energy_flow_winter_hint())).toBeVisible()
  await expect.element(screen.getByText(m.energy_flow_loss_share({ share: '43 %' }))).toBeVisible()
  expect(
    screen.getByText(m.energy_flow_charge_level({ from: '34', to: '23' })).elements().length,
  ).toBeGreaterThan(0)
  await userEvent.hover(document.body)
})

test('the loss tooltip rounds the charge level', async () => {
  const { screen } = await draw(sums({ firstSocPct: 19.4999, lastSocPct: 99.6 }))
  const rects = [...screen.container.querySelectorAll('rect[fill="transparent"]')]
  await userEvent.hover(rects[rects.length - 1])
  await expect
    .element(screen.getByText(m.energy_flow_charge_level({ from: '19', to: '100' })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('without a charge level the wide battery text moves down to stay centred on its tile', async () => {
  const labelY = (c: HTMLElement) =>
    Number(c.querySelector('[data-flow-node="bat"] text')?.getAttribute('y'))
  const withSoc = await draw(sums())
  const without = await draw(sums({ firstSocPct: null }))
  expect(labelY(without.screen.container) - labelY(withSoc.screen.container)).toBe(9.5)
})

test('a period under 1 kWh still scales its largest arrow to full width', async () => {
  const tiny = sums({
    gridImportKwh: 0.6,
    gridExportKwh: 0,
    solarKwh: 0.2,
    loadKwh: 0.8,
    batteryDischargeKwh: 0,
    batteryChargeSolarKwh: 0,
    batteryChargeGridKwh: 0,
    carKwh: 0,
    firstSocPct: null,
    lastSocPct: null,
  })
  const { screen } = await draw(tiny)
  const stroke = (id: string) =>
    Number(
      screen.container.querySelector(`[data-flow-edge="${id}"] path`)?.getAttribute('stroke-width'),
    )
  // Köpt el → Förbrukning (0,6 kWh) is the largest arrow: the full 20 px; Solel → Förbrukning (0,2) a third of it.
  expect(stroke('imp>load')).toBe(20)
  expect(stroke('sol>load')).toBeCloseTo(20 / 3)
})

test('a car part that would read "0,0" leaves the car lines blank', async () => {
  const { screen } = await draw(sums({ carKwh: 0.04 }))
  expect(screen.getByText(m.energy_flow_car()).elements()).toHaveLength(0)
  expect(screen.getByText('0,0 kWh').elements()).toHaveLength(0)
  const atMin = await draw(sums({ carKwh: 0.05 }))
  await expect.element(atMin.screen.getByText(m.energy_flow_car())).toBeInTheDocument()
})

test('an arrow tooltip leaves its own value pill uncovered', async () => {
  const { screen } = await draw(sums())
  const c = screen.container
  await userEvent.hover(hitOf(c, 'imp>load'))
  const title = screen.getByText(
    m.energy_flow_arrow({ from: m.energy_tile_import(), to: m.energy_tile_load() }),
  )
  await expect.element(title).toBeVisible()
  const card = (title.element() as HTMLElement).parentElement as HTMLElement
  const pill = [...c.querySelectorAll('[data-slot="flow-value"]')].find(
    (p) => p.textContent === '111,8',
  ) as SVGGElement
  const a = card.getBoundingClientRect()
  const b = pill.getBoundingClientRect()
  const apart = a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left
  expect(apart, `tooltip ${JSON.stringify(a)} covers pill ${JSON.stringify(b)}`).toBe(true)
  await userEvent.hover(document.body)
})

test('on a 360 px phone, five-digit figures and a long loss shrink to fit their nodes', async () => {
  // The app's body font (browser tests have no app.css), so the widths are the real ones.
  const face = new FontFace('Switzer', 'url(/fonts/switzer/Switzer-Variable.woff2)', {
    weight: '100 900',
  })
  document.fonts.add(await face.load())
  const style = document.createElement('style')
  style.textContent = 'svg text { font-family: Switzer; font-variant-numeric: tabular-nums }'
  document.head.append(style)
  try {
    // Totalt a few years on: every node figure "12 345,6", the loss 934,5 (in 1 700, out 765,5, no SoC).
    const big = sums({
      gridImportKwh: 12345.6,
      gridExportKwh: 12345.6,
      solarKwh: 12345.6,
      loadKwh: 12345.6,
      carKwh: 2345.6,
      batteryChargeSolarKwh: 0,
      batteryChargeGridKwh: 1700,
      batteryDischargeKwh: 765.5,
      firstSocPct: null,
      lastSocPct: null,
    })
    // A 360 px viewport leaves a 296 px card content width.
    const { screen } = await draw(big, 296)
    const c = screen.container
    await expect.element(screen.getByText('934,5')).toBeInTheDocument()
    for (const node of c.querySelectorAll<SVGGElement>('[data-flow-node]')) {
      const box = (node.querySelector('rect') as SVGRectElement).getBBox()
      for (const text of node.querySelectorAll('text')) {
        const t = text.getBBox()
        const key = `${node.dataset.flowNode}: ${text.textContent}`
        expect(t.x, key).toBeGreaterThanOrEqual(box.x)
        expect(t.x + t.width, key).toBeLessThanOrEqual(box.x + box.width)
      }
    }
    // The figures stepped down from 24 px, the loss from 18 px.
    const size = (sel: string) => Number(c.querySelector(sel)?.getAttribute('font-size'))
    expect(size('[data-flow-node="load"] text[font-weight="600"]')).toBeLessThan(24)
    expect(size('[data-flow-node="bat"] tspan')).toBeLessThan(18)
  } finally {
    style.remove()
    document.fonts.delete(face)
  }
})
