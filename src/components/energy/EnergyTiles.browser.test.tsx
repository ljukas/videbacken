import { expect, test } from 'vitest'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyReadouts } from './EnergyTiles'

const sums = (over: Partial<PeriodSums> = {}): PeriodSums => ({
  gridImportKwh: 561,
  gridExportKwh: 114,
  solarKwh: 509,
  loadKwh: 947,
  batteryDischargeKwh: 225,
  batteryChargeSolarKwh: 173,
  batteryChargeGridKwh: 68,
  carKwh: 312,
  firstSocPct: 30,
  lastSocPct: 40,
  buckets: 8640,
  expectedBuckets: 8640,
  ...over,
})

test('shows all five readouts', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={sums()} />)
  await expect.element(screen.getByText('509,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('561,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('114,0 kWh')).toBeVisible()
  await expect.element(screen.getByText('947,0 kWh')).toBeVisible()
  await expect
    .element(screen.getByText(m.energy_tile_import_to_battery({ kwh: '68,0' })))
    .toBeVisible()
  await expect.element(screen.getByText(m.energy_tile_load_car({ kwh: '312,0' }))).toBeVisible()
  await expect
    .element(
      screen.getByText(
        m.energy_tile_solar_split({
          direct: '44\u00a0%',
          battery: '34\u00a0%',
          exported: '22\u00a0%',
        }),
      ),
    )
    .toBeVisible()
  // 1 − 561 / 947 ≈ 41 %
  await expect.element(screen.getByText(/^41\s%$/)).toBeVisible()
})

test('a period without data says so, in the same reserved space', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={null} />)
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('the gap line is always rendered, empty when the period is complete', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={sums()} />)
  const gap = screen.container.querySelector('[data-slot="energy-gap"]')
  expect(gap).not.toBeNull()
  expect(gap?.textContent).toBe('')
})

test('every detail slot is rendered, even without a detail', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts sums={sums({ solarKwh: 0, batteryChargeGridKwh: 0, carKwh: 0 })} />,
  )
  expect(screen.container.querySelectorAll('[data-slot="readout-detail"]')).toHaveLength(5)
})

test('a gap of 9 h is named', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts sums={sums({ buckets: 8640 - 113 })} />,
  )
  await expect.element(screen.getByText(m.energy_missing_hours({ hours: '9' }))).toBeVisible()
})

test('no solar means no split line; no grid charging means no "varav" line', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts
      sums={sums({
        solarKwh: 0,
        batteryChargeSolarKwh: 0,
        gridExportKwh: 0,
        batteryChargeGridKwh: 0,
      })}
    />,
  )
  await expect.element(screen.getByText('561,0 kWh')).toBeVisible()
  expect(screen.getByText(/^Direkt /).elements()).toHaveLength(0)
  expect(screen.getByText(/till batteriet/).elements()).toHaveLength(0)
})

test('an overshooting battery-from-solar never shows above 100 %', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts sums={sums({ solarKwh: 100, batteryChargeSolarKwh: 130, gridExportKwh: 0 })} />,
  )
  await expect
    .element(
      screen.getByText(
        m.energy_tile_solar_split({
          direct: '0\u00a0%',
          battery: '100\u00a0%',
          exported: '0\u00a0%',
        }),
      ),
    )
    .toBeVisible()
})

test('no consumption shows a dash and no self-sufficiency detail', async () => {
  const { screen } = await renderWithProviders(
    <EnergyReadouts sums={sums({ loadKwh: 0, carKwh: 0 })} />,
  )
  await expect.element(screen.getByText('—')).toBeVisible()
  expect(screen.getByText(m.energy_tile_self_sufficiency_detail()).elements()).toHaveLength(0)
})
