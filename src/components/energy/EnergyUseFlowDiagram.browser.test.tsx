import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import { energyFigures, type HeatPumpPeriod, type PeriodSums } from '~/lib/houseEnergy/figures'
import { NODE_PADDING } from '~/lib/houseEnergy/flowLayout'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyUseFlowDiagram } from './EnergyUseFlowDiagram'

const unit = (id: string, name: string, kwh: number): HeatPumpPeriod => ({
  id,
  name,
  kwh,
  hours: 720,
  expectedHours: 720,
})
const units = [
  { id: 'hp-a', name: 'Matsal' },
  { id: 'hp-b', name: 'Övervåning' },
]
const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 900,
  batteryDischargeKwh: 225,
  batteryChargeSolarKwh: 173,
  batteryChargeGridKwh: 68,
  carKwh: 300,
  firstSocPct: 30,
  lastSocPct: 40,
  buckets: 8640,
  expectedBuckets: 8640,
  heatPumps: [unit('hp-a', 'Matsal', 150), unit('hp-b', 'Övervåning', 60)],
  ...over,
})
const draw = (s: PeriodSums, width = 1006, showValues = true, u = units) =>
  renderWithProviders(
    <EnergyUseFlowDiagram
      sums={s}
      figures={energyFigures(s)}
      units={u}
      width={width}
      showValues={showValues}
    />,
  )
const nodeKeys = (c: Element) =>
  [...c.querySelectorAll('[data-flow-node]')].map((n) => n.getAttribute('data-flow-node'))
/**
 * A point halfway along `path`, relative to its svg's top left: a hover `position` on the svg. (Relative to the path
 * itself it would miss: Playwright measures a path's box with its stroke, inflated by the miter limit.)
 */
const onStroke = (path: SVGPathElement) => {
  const p = path
    .getPointAtLength(path.getTotalLength() / 2)
    .matrixTransform(path.getScreenCTM() as DOMMatrix)
  const b = (path.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
  return { x: p.x - b.left, y: p.y - b.top }
}
const stroke = (c: Element, to: string) =>
  c.querySelector(`[data-flow-edge="load>${to}"] path`)?.getAttribute('stroke')

test('one node per consumer: laddning, each heat pump by name, övrigt hus', async () => {
  const { screen } = await draw(sums())
  expect(nodeKeys(screen.container)).toEqual(['load', 'car', 'hp:hp-a', 'hp:hp-b', 'house'])
  await expect.element(screen.getByText(m.energy_heat_pump_name({ name: 'Matsal' }))).toBeVisible()
  await expect.element(screen.getByText(m.energy_series_house())).toBeVisible()
  await expect.element(screen.getByText(m.energy_tile_load())).toBeVisible()
})

test('each consumer node shows its kWh and its share of the load', async () => {
  const { screen } = await draw(sums())
  const node = screen.container.querySelector('[data-flow-node="hp:hp-a"]') as Element
  expect(node.textContent).toContain(formatOneDecimal(150))
  expect(node.textContent).toContain(formatShare(150 / 900))
  const house = screen.container.querySelector('[data-flow-node="house"]') as Element
  expect(house.textContent).toContain(formatOneDecimal(390))
})

test('each arrow takes its consumer’s colour; a unit’s colour is its all-time place, not the period’s', async () => {
  const { screen } = await draw(sums())
  expect(stroke(screen.container, 'car')).toBe('var(--energy-car)')
  expect(stroke(screen.container, 'hp:hp-a')).toBe('var(--energy-heat-pump-1)')
  expect(stroke(screen.container, 'hp:hp-b')).toBe('var(--energy-heat-pump-2)')
  expect(stroke(screen.container, 'house')).toBe('var(--energy-house)')
  // A period where only Övervåning ran: it keeps colour 2.
  const only = await draw(sums({ heatPumps: [unit('hp-b', 'Övervåning', 60)] }))
  expect(stroke(only.screen.container, 'hp:hp-b')).toBe('var(--energy-heat-pump-2)')
})

test('no heat pumps: laddning and övrigt hus only', async () => {
  const { screen } = await draw(sums({ heatPumps: [] }))
  expect(nodeKeys(screen.container)).toEqual(['load', 'car', 'house'])
})

test('a consumer under 0,05 kWh keeps its node but draws no arrow', async () => {
  const { screen } = await draw(sums({ carKwh: 0.01 }))
  expect(nodeKeys(screen.container)).toContain('car')
  expect(screen.container.querySelector('[data-flow-edge="load>car"]')).toBeNull()
})

test('value pills follow showValues on the wide layout; the narrow layout draws none', async () => {
  const on = await draw(sums(), 1006, true)
  expect(on.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(4)
  const off = await draw(sums(), 1006, false)
  expect(off.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  const narrow = await draw(sums(), 311, true)
  expect(narrow.screen.container.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
})

test('hovering an arrow names it and gives its kWh and share of the load', async () => {
  const { screen } = await draw(sums())
  await userEvent.hover(screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as Element)
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({
          from: m.energy_tile_load(),
          to: m.energy_heat_pump_name({ name: 'Matsal' }),
        }),
      ),
    )
    .toBeVisible()
  await expect
    .element(screen.getByText(m.energy_flow_share_load({ share: formatShare(150 / 900) })))
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('a long unit name is cut with … inside its node on a phone; the tooltip names it in full', async () => {
  const long = 'Vardagsrummets stora värmepump vid trappan'
  const u = [{ id: 'hp-a', name: long }]
  const { screen } = await draw(sums({ heatPumps: [unit('hp-a', long, 150)] }), 311, true, u)
  const node = screen.container.querySelector('[data-flow-node="hp:hp-a"]') as SVGGElement
  const label = node.querySelector('text') as SVGTextElement
  await expect.poll(() => label.textContent?.endsWith('…')).toBe(true)
  const box = node.querySelector('rect') as SVGRectElement
  const right = box.getBoundingClientRect().right
  expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(right - NODE_PADDING + 1)
  // On the narrow layout the arrow is an L: the centre of its box is the inside corner, where the arrow above it
  // runs. Hover a point on its own stroke.
  const hit = screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as SVGPathElement
  const svg = hit.ownerSVGElement as SVGSVGElement
  await userEvent.hover(svg, { position: onStroke(hit) })
  await expect
    .element(
      screen.getByText(
        m.energy_flow_arrow({
          from: m.energy_tile_load(),
          to: m.energy_heat_pump_name({ name: long }),
        }),
      ),
    )
    .toBeVisible()
  await userEvent.hover(document.body)
})

test('a 150-character unit name renders in one fitting pass, cut with … on phone and wide nodes', async () => {
  // Comfort Cloud allows names up to 200 characters; cutting one character per render threw React's update-depth
  // error past ~55 characters.
  const long = `Värmepump ${'vid trappan i vardagsrummet '.repeat(6)}`.slice(0, 150)
  expect(long).toHaveLength(150)
  const u = [{ id: 'hp-a', name: long }]
  for (const width of [311, 1006]) {
    const { screen } = await draw(sums({ heatPumps: [unit('hp-a', long, 150)] }), width, true, u)
    const node = screen.container.querySelector('[data-flow-node="hp:hp-a"]') as SVGGElement
    const label = node.querySelector('text') as SVGTextElement
    await expect.poll(() => label.textContent?.endsWith('…')).toBe(true)
    expect(label.textContent?.length).toBeLessThan(long.length)
    const right = (node.querySelector('rect') as SVGRectElement).getBoundingClientRect().right
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(right - NODE_PADDING + 1)
    const hit = screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as SVGPathElement
    await userEvent.hover(hit.ownerSVGElement as SVGSVGElement, { position: onStroke(hit) })
    await expect
      .element(
        screen.getByText(
          m.energy_flow_arrow({
            from: m.energy_tile_load(),
            to: m.energy_heat_pump_name({ name: long }),
          }),
        ),
      )
      .toBeVisible()
    await userEvent.hover(document.body)
  }
})

test('a figure too wide for its node steps down to its 13 px floor, never below', async () => {
  const { screen } = await draw(
    sums({ carKwh: 999_999_999_999, loadKwh: 1_000_000_000_000, heatPumps: [] }),
    311,
  )
  const figure = () =>
    screen.container.querySelector('[data-flow-node="car"] tspan')?.getAttribute('font-size')
  await expect.poll(figure).toBe('13')
  // Once more after the body font has loaded (the hook measures again then).
  await document.fonts.ready
  await expect.poll(figure).toBe('13')
})

test('a new period closes an open popover, so a vanished arrow leaves nothing dimmed', async () => {
  // A tap keeps its popover open (a mouse closes it on leaving the arrow), so a touch press opens it here. The mouse
  // waits above the diagram: resting on the svg, the redrawn layout can put another arrow under it, and Chromium then
  // enters that arrow and opens its popover.
  const diagram = (s: PeriodSums) => (
    <div>
      <div data-testid="away" style={{ height: 40 }} />
      <EnergyUseFlowDiagram
        sums={s}
        figures={energyFigures(s)}
        units={units}
        width={1006}
        showValues
      />
    </div>
  )
  // No query client needed: vitest-browser-react's own render, for its rerender.
  const screen = await render(diagram(sums()))
  await userEvent.hover(screen.getByTestId('away'))
  const name = m.energy_flow_arrow({
    from: m.energy_tile_load(),
    to: m.energy_heat_pump_name({ name: 'Matsal' }),
  })
  const hit = screen.container.querySelector('[data-flow-hit="load>hp:hp-a"]') as Element
  hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
  await expect.element(screen.getByText(name)).toBeVisible()
  expect(screen.container.querySelectorAll('.opacity-25').length).toBeGreaterThan(0)
  // The next period has no Matsal: its arrow is gone.
  await screen.rerender(diagram(sums({ heatPumps: [unit('hp-b', 'Övervåning', 60)] })))
  await expect.element(screen.getByText(name)).not.toBeInTheDocument()
  expect(screen.container.querySelectorAll('.opacity-25')).toHaveLength(0)
  await userEvent.hover(document.body)
})

test('the svg is one image named by its description', async () => {
  const { screen } = await draw(sums())
  await expect.element(screen.getByRole('img', { name: m.energy_use_description() })).toBeVisible()
})
