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

test('a period without data says so over an invisible grid of the same shape', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={null} />)
  await expect.element(screen.getByText(m.energy_period_no_data())).toBeVisible()
  const hidden = screen.container.querySelector('[aria-hidden="true"].invisible')
  expect(hidden).not.toBeNull()
  expect(hidden?.querySelectorAll('[data-slot="readout-detail"]')).toHaveLength(5)
  expect(hidden?.querySelector('[data-slot="energy-gap"]')).not.toBeNull()
})

test('pins the layout classes that keep the height steady', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={sums()} />)
  expect(screen.container.querySelector('.\\@container')).not.toBeNull()
  const grid = screen.container.querySelector('.grid')
  expect(grid?.className).toContain('grid-cols-2')
  expect(grid?.className).toContain('@[35rem]:grid-cols-3')
  expect(grid?.className).toContain('@[61.25rem]:grid-cols-5')
  const detail = screen.container.querySelector('[data-slot="readout-detail"]')
  expect(detail?.className).toContain('min-h-[4.5em]')
  expect(detail?.className).toContain('@[35rem]:min-h-[3em]')
  expect(screen.container.querySelector('.flex-nowrap.whitespace-nowrap')).not.toBeNull()
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

test('unavailable figures: the same invisible grid, blank, with no "no data" claim', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums="unavailable" />)
  const hidden = screen.container.querySelector('[aria-hidden="true"].invisible')
  expect(hidden).not.toBeNull()
  expect(hidden?.querySelectorAll('[data-slot="readout-detail"]')).toHaveLength(5)
  expect(screen.getByText(m.energy_period_no_data()).elements()).toHaveLength(0)
  // Nothing readable outside the invisible grid.
  expect(screen.container.querySelector('p:not([aria-hidden] p)')).toBeNull()
})

test('pins the readout figure’s container-relative font sizes', async () => {
  const { screen } = await renderWithProviders(<EnergyReadouts sums={sums()} />)
  const value = screen.getByText('509,0', { exact: true }).element()
  expect(value.className).toContain('text-[length:min(28px,calc(10.4cqi_-_8.5px))]')
  expect(value.className).toContain('@[35rem]:text-[length:min(36px,calc(6.94cqi_-_9.06px))]')
  expect(value.className).toContain('@[61.25rem]:text-[length:min(36px,calc(4.17cqi_-_9.5px))]')
})
