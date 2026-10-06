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

test('the switch hides the values and is remembered', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums()} />)
  await expect
    .poll(() => screen.container.querySelectorAll('[data-slot="flow-value"]').length)
    .toBe(6)
  await screen.getByRole('switch', { name: m.energy_flow_show_values() }).click()
  await expect
    .poll(() => screen.container.querySelectorAll('[data-slot="flow-value"]').length)
    .toBe(0)
  expect(localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
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
  await expect.element(table.getByRole('cell', { name: '0,7' })).toBeVisible()
})

test('no car: the car lines are blank, the box keeps its height', async () => {
  const { screen } = await renderWithProviders(<EnergyFlow sums={sums({ carKwh: 0 })} />)
  // The table keeps its "varav laddning" row (0,0); the diagram has no car lines.
  await expect.poll(() => screen.container.querySelector('svg[role="img"]')).not.toBeNull()
  expect(screen.container.querySelector('svg[role="img"]')?.textContent).not.toContain(
    m.energy_flow_car(),
  )
  const box = screen.container.querySelector('[data-slot="energy-flow-box"]') as HTMLElement
  const withCar = await renderWithProviders(<EnergyFlow sums={sums()} />)
  const box2 = withCar.screen.container.querySelector(
    '[data-slot="energy-flow-box"]',
  ) as HTMLElement
  await expect.poll(() => box2.querySelector('svg[role="img"]')).not.toBeNull()
  expect(box.getBoundingClientRect().height).toBe(box2.getBoundingClientRect().height)
})

test('a period without data says so in a box of the same height; unavailable stays blank', async () => {
  const empty = await renderWithProviders(<EnergyFlow sums={null} />)
  await expect.element(empty.screen.getByText(m.energy_period_no_data())).toBeVisible()
  const full = await renderWithProviders(<EnergyFlow sums={sums()} />)
  // No app.css here, so pin the reservation (classes) instead of the computed height.
  const reserved = (c: HTMLElement) =>
    (c.querySelector('[data-slot="energy-flow-box"]') as HTMLElement).className
  expect(reserved(empty.screen.container)).toBe(reserved(full.screen.container))
  expect(reserved(empty.screen.container)).toContain('h-[490px]')
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
