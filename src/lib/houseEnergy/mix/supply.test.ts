import { expect, test } from 'vitest'
import { reading } from '~test/fixtures/houseEnergy'
import { houseSupply, type SupplyFractions } from './supply'

const T = Date.UTC(2026, 5, 10, 10)

function expectFractions(actual: SupplyFractions | null, expected: SupplyFractions) {
  expect(actual).not.toBeNull()
  expect(actual?.grid).toBeCloseTo(expected.grid, 12)
  expect(actual?.solar).toBeCloseTo(expected.solar, 12)
  expect(actual?.battery).toBeCloseTo(expected.battery, 12)
}

test('a bucket on grid alone is all grid', () => {
  expectFractions(houseSupply(reading(T, { gridImportKwh: 0.4, loadKwh: 0.4 })), {
    grid: 1,
    solar: 0,
    battery: 0,
  })
})

test('solar that is exported or stored is not house supply', () => {
  // 1.2 produced: 0.5 exported, 0.3 into the battery → 0.4 reaches the house.
  const r = reading(T, {
    solarKwh: 1.2,
    gridExportKwh: 0.5,
    batteryChargeSolarKwh: 0.3,
    gridImportKwh: 0.4,
    loadKwh: 0.8,
  })
  expectFractions(houseSupply(r), { grid: 0.5, solar: 0.5, battery: 0 })
})

test('grid energy charging the battery is not house supply (charge_grid and charge_ac alike)', () => {
  // 1.5 imported: 0.6 + 0.3 into the battery → 0.6 reaches the house.
  const r = reading(T, {
    gridImportKwh: 1.5,
    batteryChargeGridKwh: 0.6,
    batteryChargeAcKwh: 0.3,
    loadKwh: 0.6,
  })
  expectFractions(houseSupply(r), { grid: 1, solar: 0, battery: 0 })
})

test('battery discharge feeding the house is battery supply', () => {
  const r = reading(T, { gridImportKwh: 0.2, batteryDischargeKwh: 0.6, loadKwh: 0.8 })
  expectFractions(houseSupply(r), { grid: 0.25, solar: 0, battery: 0.75 })
})

test('battery energy that was exported is not house supply', () => {
  // 0.5 exported with only 0.1 solar → 0.4 of the 1.0 discharged left via the grid.
  const r = reading(T, {
    solarKwh: 0.1,
    gridExportKwh: 0.5,
    batteryDischargeKwh: 1.0,
    loadKwh: 0.6,
  })
  expectFractions(houseSupply(r), { grid: 0, solar: 0, battery: 1 })
})

test('grid, solar and battery together split in proportion', () => {
  const r = reading(T, {
    gridImportKwh: 0.3,
    solarKwh: 0.5,
    batteryDischargeKwh: 0.2,
    loadKwh: 1,
  })
  expectFractions(houseSupply(r), { grid: 0.3, solar: 0.5, battery: 0.2 })
})

test('a flow inconsistency never makes a part negative', () => {
  // More battery charging than import: grid → house clamps to 0.
  const r = reading(T, {
    gridImportKwh: 0.1,
    batteryChargeGridKwh: 0.3,
    solarKwh: 0.5,
    loadKwh: 0.5,
  })
  expectFractions(houseSupply(r), { grid: 0, solar: 1, battery: 0 })
})

test('zero load, or nothing supplying the house, is no house data', () => {
  expect(houseSupply(reading(T, { gridImportKwh: 0.1 }))).toBeNull()
  expect(houseSupply(reading(T, { loadKwh: 0.5 }))).toBeNull()
})

test('export beyond solar larger than the discharge leaves no battery supply', () => {
  const r = reading(T, {
    gridExportKwh: 0.5,
    batteryDischargeKwh: 0.2,
    gridImportKwh: 0.4,
    loadKwh: 0.4,
  })
  expectFractions(houseSupply(r), { grid: 1, solar: 0, battery: 0 })
})

test('more solar charging than solar production never makes solar supply negative', () => {
  const r = reading(T, {
    solarKwh: 0.3,
    batteryChargeSolarKwh: 0.5,
    gridImportKwh: 0.4,
    loadKwh: 0.4,
  })
  expectFractions(houseSupply(r), { grid: 1, solar: 0, battery: 0 })
})
