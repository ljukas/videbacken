import { beforeEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { energyFigures, gapHours, type PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { BatteryFlow } from './BatteryFlow'
import { SHOW_FLOW_VALUES_KEY } from './EnergyFlow'

// September 2026 on prod: in 172,9 + 67,9, out 225,4, SoC 15 → 20 (Δ +0,379), loss 15,0, efficiency 94 %.
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
const node = (key: string) => document.querySelector(`[data-flow-node="${key}"]`)?.textContent ?? ''
const edges = () =>
  [...document.querySelectorAll('[data-flow-edge]')].map((e) => e.getAttribute('data-flow-edge'))

beforeEach(async () => {
  localStorage.removeItem(SHOW_FLOW_VALUES_KEY)
  await page.viewport(1440, 900)
})

test('the five nodes, the efficiency and the four arrows', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums()} />
    </div>,
  )
  await vi.waitFor(() => expect(edges()).toHaveLength(4))
  expect(node('sol')).toContain('172,9')
  expect(node('imp')).toContain('67,9')
  expect(node('bat')).toMatch(/Lager\s*\+0,4/)
  expect(node('out')).toContain('225,4')
  expect(node('loss')).toContain('15,0')
  expect(node('loss')).toMatch(/6\s% av det som laddades in/)
  // The table (collapsed) repeats the figure: scope to the ring.
  await expect.element(screen.getByText(/^94\s%$/).first()).toBeVisible()
  expect(edges().sort()).toEqual(['bat>loss', 'bat>out', 'imp>bat', 'sol>bat'])
})

test('a small or negative loss reads ≈ 0 kWh, with no loss arrow and no share', async () => {
  await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow
        sums={sums({
          batteryChargeSolarKwh: 10,
          batteryChargeGridKwh: 0,
          batteryDischargeKwh: 10.2,
          firstSocPct: 50,
          lastSocPct: 50,
        })}
      />
    </div>,
  )
  await vi.waitFor(() => expect(edges()).toContain('bat>out'))
  expect(node('loss')).toContain('≈ 0')
  expect(node('loss')).not.toContain('av det som laddades in')
  expect(edges()).not.toContain('bat>loss')
})

test('a battery that barely ran: "—", an empty ring, no shares', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow
        sums={sums({
          batteryChargeSolarKwh: 0.4,
          batteryChargeGridKwh: 0.2,
          batteryDischargeKwh: 0.1,
          firstSocPct: 50,
          lastSocPct: 50,
        })}
      />
    </div>,
  )
  await expect.element(screen.getByText(m.energy_battery_efficiency()).first()).toBeVisible()
  expect(screen.container.querySelector('[data-slot="ring-figure"]')?.textContent).toContain('—')
  expect(screen.container.querySelector('[data-slot="ring-arc"]')).toBeNull()
  // The ring's own detail line says "av det som laddades in kom ut igen": look at the diagram only.
  for (const n of document.querySelectorAll('[data-flow-node]'))
    expect(n.textContent).not.toContain('av det som laddades in')
})

test('a battery sale adds "varav såld" to Ut and to the table', async () => {
  // Export beyond the solar surplus: 509 − 172,9 = 336,1 < 400 → 63,9 kWh from the battery.
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums({ gridExportKwh: 400 })} />
    </div>,
  )
  await vi.waitFor(() => expect(node('out')).toContain('varav såld 63,9 kWh'))
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  await expect
    .element(screen.getByRole('rowheader', { name: m.energy_battery_row_sold() }))
    .toBeVisible()
})

test('no sale: no "varav såld", the table has the battery rows with units', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums()} />
    </div>,
  )
  await vi.waitFor(() => expect(edges()).toHaveLength(4))
  expect(node('out')).not.toContain('varav såld')
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  for (const name of [
    m.energy_battery_row_in_solar(),
    m.energy_battery_row_in_grid(),
    m.energy_battery_row_in_total(),
    m.energy_flow_row_stored(),
    m.energy_battery_node_out(),
    m.energy_flow_loss_title(),
    m.energy_battery_efficiency(),
  ]) {
    await expect.element(screen.getByRole('rowheader', { name, exact: true })).toBeVisible()
  }
  await expect.element(screen.getByRole('cell', { name: '+0,4 kWh' })).toBeVisible()
  // The loss row carries its share; the charge level follows the rows.
  await expect.element(screen.getByRole('cell', { name: /^15,0\skWh \(6\s%\)$/ })).toBeVisible()
  await expect
    .element(screen.getByText(m.energy_flow_charge_level({ from: '15', to: '20' })))
    .toBeVisible()
  expect(
    [...screen.container.querySelectorAll('th[scope="row"]')].map((t) => t.textContent),
  ).not.toContain(m.energy_battery_row_sold())
})

test('a negative loss: the table keeps the real value', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow
        sums={sums({
          batteryChargeSolarKwh: 10,
          batteryChargeGridKwh: 0,
          batteryDischargeKwh: 10.2,
          firstSocPct: 50,
          lastSocPct: 50,
        })}
      />
    </div>,
  )
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  const row = [...screen.container.querySelectorAll('th[scope="row"]')].find(
    (t) => t.textContent === m.energy_flow_loss_title(),
  )
  expect(row?.nextElementSibling?.textContent).toMatch(/^[-−]0,2\skWh/)
})

test('an unknown charge level: "Lager —" and "—" in the table', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums({ firstSocPct: null, lastSocPct: null })} />
    </div>,
  )
  await vi.waitFor(() => expect(edges()).toHaveLength(4))
  expect(node('bat')).toMatch(/Lager\s*—/)
  expect(node('bat')).not.toContain('kWh')
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  const row = [...screen.container.querySelectorAll('th[scope="row"]')].find(
    (t) => t.textContent === m.energy_flow_row_stored(),
  )
  expect(row?.nextElementSibling?.textContent).toBe('—')
})

test('the gap note names the missing hours', async () => {
  const s = sums({ buckets: 8000 })
  const hours = gapHours(energyFigures(s))
  expect(hours).toBeGreaterThan(0)
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={s} />
    </div>,
  )
  await expect
    .element(screen.getByText(m.energy_missing_hours({ hours: String(hours) })))
    .toBeVisible()
})

test('the values switch hides the pills and is the same preference as Översikt', async () => {
  const { screen } = await renderWithProviders(
    <div style={{ width: 1100 }}>
      <BatteryFlow sums={sums()} />
    </div>,
  )
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(4),
  )
  await userEvent.click(screen.getByRole('switch', { name: m.energy_flow_show_values() }))
  expect(document.querySelectorAll('[data-slot="flow-value"]')).toHaveLength(0)
  // useLocalStorageFlag stores '0' / '1'.
  expect(localStorage.getItem(SHOW_FLOW_VALUES_KEY)).toBe('0')
})

test('no data and unavailable', async () => {
  const none = await renderWithProviders(<BatteryFlow sums={null} />)
  await expect.element(none.screen.getByText(m.energy_period_no_data())).toBeVisible()
  none.screen.unmount()
  const unavailable = await renderWithProviders(<BatteryFlow sums="unavailable" />)
  expect(unavailable.screen.container.querySelector('[data-flow-node]')).toBeNull()
  expect(unavailable.screen.container.textContent).not.toContain(m.energy_period_no_data())
})
