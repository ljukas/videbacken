import { expect, test } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { PeriodSums } from '~/lib/houseEnergy/figures'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { EnergyTiles } from './EnergyTiles'

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

test('shows this month by default with all five readouts', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{ thisMonth: sums(), thisYear: sums({ solarKwh: 5000 }), allTime: sums() }}
    />,
  )
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

test('switching to I år shows the year', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{ thisMonth: sums(), thisYear: sums({ solarKwh: 5000 }), allTime: sums() }}
    />,
  )
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
})

test('a period without data says so', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles tiles={{ thisMonth: null, thisYear: sums(), allTime: sums() }} />,
  )
  // Opens on the first period with data; the empty month says so when picked.
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_month() }))
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
})

test('a gap of 9 h is named; a complete period has no note', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{ thisMonth: sums({ buckets: 8640 - 113 }), thisYear: sums(), allTime: sums() }}
    />,
  )
  await expect.element(screen.getByText(m.energy_missing_hours({ hours: '9' }))).toBeVisible()
  await userEvent.click(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
  expect(screen.getByText(m.energy_missing_hours({ hours: '9' })).elements()).toHaveLength(0)
})

test('no solar means no split line; no grid charging means no "varav" line', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{
        thisMonth: sums({
          solarKwh: 0,
          batteryChargeSolarKwh: 0,
          gridExportKwh: 0,
          batteryChargeGridKwh: 0,
        }),
        thisYear: null,
        allTime: null,
      }}
    />,
  )
  await expect.element(screen.getByText('561,0 kWh')).toBeVisible()
  expect(screen.getByText(/^Direkt /).elements()).toHaveLength(0)
  expect(screen.getByText(/till batteriet/).elements()).toHaveLength(0)
})

test('an overshooting battery-from-solar never shows above 100 %', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{
        thisMonth: sums({ solarKwh: 100, batteryChargeSolarKwh: 130, gridExportKwh: 0 }),
        thisYear: null,
        allTime: null,
      }}
    />,
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
    <EnergyTiles
      tiles={{ thisMonth: sums({ loadKwh: 0, carKwh: 0 }), thisYear: null, allTime: null }}
    />,
  )
  await expect.element(screen.getByText('—')).toBeVisible()
  expect(screen.getByText(m.energy_tile_self_sufficiency_detail()).elements()).toHaveLength(0)
})

test('opens on the first period with data', async () => {
  const { screen } = await renderWithProviders(
    <EnergyTiles
      tiles={{ thisMonth: null, thisYear: sums({ solarKwh: 5000 }), allTime: sums() }}
    />,
  )
  await expect
    .element(screen.getByRole('tab', { name: m.charging_tile_this_year() }))
    .toHaveAttribute('aria-selected', 'true')
  await expect.element(screen.getByText(/^5\s000,0 kWh$/)).toBeVisible()
})
