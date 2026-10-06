import { afterEach, expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyFlow, SHOW_FLOW_VALUES_KEY } from './EnergyFlow'

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

afterEach(() => localStorage.removeItem(SHOW_FLOW_VALUES_KEY))

test('opens with Självförsörjning, then the diagram', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  // .first(): the (closed) table repeats both.
  await expect.element(screen.getByText(m.energy_tile_self_sufficiency()).first()).toBeVisible()
  // 1 − 145,8 / 200,6 ≈ 27 %
  await expect.element(screen.getByText(/^27\s%$/).first()).toBeVisible()
  await expect.element(screen.getByRole('img')).toBeVisible()
})

test('the switch starts on, hides the values and is remembered across a remount', async () => {
  const first = await renderWithProviders(<EnergyFlow sums={sums()} />)
  const values = (c: HTMLElement) => c.querySelectorAll('[data-slot="flow-value"]').length
  const sw = first.screen.getByRole('switch', { name: m.energy_flow_show_values() })
  await expect.element(sw).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => values(first.screen.container)).toBe(6)
  await sw.click()
  await expect.poll(() => values(first.screen.container)).toBe(0)
  expect(localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
  await first.screen.unmount()
  const again = await renderWithProviders(<EnergyFlow sums={sums()} />)
  await expect
    .element(again.screen.getByRole('switch', { name: m.energy_flow_show_values() }))
    .toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => again.screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  expect(values(again.screen.container)).toBe(0)
})

test('the table lists every value, the battery included', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  await screen.getByText(m.energy_flow_table_toggle()).click()
  const table = screen.getByRole('table')
  await expect
    .element(table.getByRole('rowheader', { name: m.energy_flow_row_battery_in() }))
    .toBeVisible()
  await expect
    .element(table.getByRole('rowheader', { name: m.energy_flow_loss_title() }))
    .toBeVisible()
  // The loss row keeps the real value: 55,8 − 49 − 6,14 ≈ 0,7.
  await expect.element(table.getByRole('cell', { name: /^0,7\skWh$/ })).toBeVisible()
  // The charge level is in the table too (the diagram's tooltip is pointer-only on a narrow card).
  await expect
    .element(
      table.getByRole('rowheader', { name: m.energy_flow_charge_level({ from: '19', to: '100' }) }),
    )
    .toBeVisible()
  // The unit sits in the cells, so the Självförsörjning row reads "27 %", not "27 % kWh".
  await expect.element(table.getByRole('cell', { name: /^27\s%$/ })).toBeVisible()
})

test('a small or negative battery loss reads "about 0" in the diagram, the real value in the table', async () => {
  // 55,8 − 49,4 − 6,14 ≈ 0,3 kWh
  const small = await renderWithProviders(<EnergyFlow sums={sums({ batteryDischargeKwh: 49.4 })} />)
  await expect.poll(() => small.screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  expect(small.screen.container.querySelector('svg[role="img"]')?.textContent).toContain(
    m.energy_flow_about_zero(),
  )
  expect(small.screen.container.textContent).toMatch(/0,3\skWh/)
  // 55,8 − 57 − 6,14 < 0: the table shows the negative number.
  const neg = await renderWithProviders(<EnergyFlow sums={sums({ batteryDischargeKwh: 57 })} />)
  await expect.poll(() => neg.screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  expect(neg.screen.container.querySelector('svg[role="img"]')?.textContent).toContain(
    m.energy_flow_about_zero(),
  )
  expect(neg.screen.container.textContent).toMatch(/[-−]\d+,\d\skWh/)
})

const BOX_RESERVATION = ['h-[490px]', '@[860px]:h-[360px]']
const boxOf = (c: HTMLElement) => c.querySelector('[data-slot="energy-flow-box"]') as HTMLElement

// No app.css in browser tests: computed heights can't be asserted here (Task 7 measures the live no-shift).
test('the box carries its height reservation in every state; no car leaves the car lines out', async () => {
  const noCar = await renderWithProviders(<EnergyFlow sums={sums({ carKwh: 0 })} />)
  await expect.poll(() => noCar.screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  // The table keeps its "varav laddning" row (0,0); the diagram has no car lines.
  expect(noCar.screen.container.querySelector('svg[role="img"]')?.textContent).not.toContain(
    m.energy_flow_car(),
  )
  const states = [
    noCar,
    await renderWithProviders(<EnergyFlow sums={sums()} />),
    await renderWithProviders(<EnergyFlow sums={null} />),
    await renderWithProviders(<EnergyFlow sums="unavailable" />),
  ]
  for (const r of states) {
    for (const cls of BOX_RESERVATION) expect(boxOf(r.screen.container).className).toContain(cls)
  }
})

test('no data says so; unavailable stays blank', async () => {
  const empty = await renderWithProviders(<EnergyFlow sums={null} />)
  expect(empty.screen.container.textContent).toContain(m.energy_period_no_data())
  const blank = await renderWithProviders(<EnergyFlow sums="unavailable" />)
  // The screen is page-wide (earlier renders stay mounted), so look inside this render's container.
  expect(blank.screen.container.textContent).not.toContain(m.energy_period_no_data())
  expect(blank.screen.container.querySelector('svg[role="img"]')).toBeNull()
})

test('a gap in the readings is named under the diagram', async () => {
  const { screen } = await renderWithProviders(
    <EnergyFlow sums={sums({ buckets: 8760, expectedBuckets: 8928 })} />,
  )
  await expect.element(screen.getByText(m.energy_missing_hours({ hours: '14' }))).toBeVisible()
})
