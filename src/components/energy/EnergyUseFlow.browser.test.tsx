import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { formatOneDecimal, formatShare } from '~/components/evCharging/format'
import type { HeatPumpPeriod, PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'
import { EnergyUseFlow } from './EnergyUseFlow'

const unit = (id: string, name: string, kwh: number, hours = 720): HeatPumpPeriod => ({
  id,
  name,
  kwh,
  hours,
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
const box = (c: Element) => c.querySelector('[data-slot="energy-use-box"]') as HTMLElement
const note = (c: Element) => c.querySelector('[data-slot="energy-use-gap"]') as HTMLElement

test('the box reserves its height by container query and keeps it whatever the node count', async () => {
  // No query client needed: vitest-browser-react's own render, for its rerender.
  const screen = await render(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums()} units={units} />
    </div>,
  )
  // Browser tests carry no Tailwind: pin the reservation classes (what holds the height in the app)...
  expect(box(screen.container).className).toContain('h-[436px]')
  expect(box(screen.container).className).toContain('@[860px]:h-[312px]')
  await expect.poll(() => screen.container.querySelectorAll('[data-flow-node]').length).toBe(5)
  const before = box(screen.container).getBoundingClientRect()
  // ...and that two nodes instead of five change nothing.
  await screen.rerender(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums({ heatPumps: [] })} units={units} />
    </div>,
  )
  await expect.poll(() => screen.container.querySelectorAll('[data-flow-node]').length).toBe(3)
  const after = box(screen.container).getBoundingClientRect()
  expect(after.height).toBe(before.height)
  expect(after.top).toBe(before.top)
})

test('missing heat pump hours: the note names the most any unit misses; a complete period keeps the line', async () => {
  const gap = await renderWithProviders(
    <EnergyUseFlow
      sums={sums({ heatPumps: [unit('hp-a', 'Matsal', 150, 714), unit('hp-b', 'Övervåning', 60)] })}
      units={units}
    />,
  )
  expect(note(gap.screen.container).textContent).toBe(m.energy_use_missing_hours({ hours: '6' }))
  const full = await renderWithProviders(<EnergyUseFlow sums={sums()} units={units} />)
  expect(note(full.screen.container).textContent).toBe('')
  expect(note(full.screen.container).className).toContain('min-h-[1.5em]')
})

test('the table: consumer, energy and share, with the total', async () => {
  const { screen } = await renderWithProviders(<EnergyUseFlow sums={sums()} units={units} />)
  await screen.getByText(m.energy_flow_table_toggle()).click()
  const table = screen.getByRole('table')
  await expect
    .element(table.getByRole('columnheader', { name: m.energy_use_table_share() }))
    .toBeVisible()
  const row = (name: string) =>
    table.getByRole('row', { name: new RegExp(`^${name}`) }).element().textContent ?? ''
  expect(row(m.energy_heat_pump_name({ name: 'Matsal' }))).toContain(formatShare(150 / 900))
  expect(row(m.energy_use_house())).toContain(formatOneDecimal(390))
  expect(row(m.energy_tile_load())).toContain(formatOneDecimal(900))
})

test('a failed read or a period without data draws no diagram; only the latter says so', async () => {
  const failed = await renderWithProviders(<EnergyUseFlow sums="unavailable" units={units} />)
  expect(failed.screen.container.querySelector('[data-flow-node]')).toBeNull()
  expect(failed.screen.container.textContent).not.toContain(m.energy_period_no_data())
  const none = await renderWithProviders(<EnergyUseFlow sums={null} units={units} />)
  await expect.element(none.screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('"Visa värden" is Summering’s remembered preference; its switch hides on the narrow layout', async () => {
  window.localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
  const { screen } = await renderWithProviders(
    <div style={{ width: 1060 }}>
      <EnergyUseFlow sums={sums()} units={units} />
    </div>,
  )
  const toggle = screen.getByRole('switch', { name: m.energy_flow_show_values() })
  await toggle.click()
  expect(window.localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
  const label = toggle.element().closest('label') as HTMLElement
  expect(label.className).toContain('hidden')
  expect(label.className).toContain('@[860px]:flex')
  window.localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
})
