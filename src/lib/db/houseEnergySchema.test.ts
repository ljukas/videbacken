import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import {
  HOUSE_BUCKET_KWH_MAX,
  houseEnergyReading,
  integrationSync,
  integrationSyncRun,
} from '~/lib/db/schema'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/): drizzle-kit scans schema/ and would try to
// require() this file.
setupDatabase()

type Insert = typeof houseEnergyReading.$inferInsert

// Synthetic values only — never real household readings (the repo is public).
const row = (overrides: Partial<Insert> = {}): Insert => ({
  bucketStart: new Date('2026-04-01T10:00:00Z'),
  gridImportKwh: 0.1,
  gridExportKwh: 0,
  solarKwh: 0.05,
  loadKwh: 0.15,
  batteryDischargeKwh: 0,
  batteryChargeSolarKwh: 0,
  batteryChargeGridKwh: 0,
  batteryChargeAcKwh: 0,
  ...overrides,
})

test('a reading is keyed by its bucket start', async () => {
  await db.insert(houseEnergyReading).values(row())
  await expectConstraintViolation(
    db.insert(houseEnergyReading).values(row()),
    'house_energy_reading_pkey',
  )
})

test.each([
  ['gridImportKwh', 'house_energy_reading_grid_import_kwh_check'],
  ['gridExportKwh', 'house_energy_reading_grid_export_kwh_check'],
  ['solarKwh', 'house_energy_reading_solar_kwh_check'],
  ['loadKwh', 'house_energy_reading_load_kwh_check'],
  ['batteryDischargeKwh', 'house_energy_reading_battery_discharge_kwh_check'],
  ['batteryChargeSolarKwh', 'house_energy_reading_battery_charge_solar_kwh_check'],
  ['batteryChargeGridKwh', 'house_energy_reading_battery_charge_grid_kwh_check'],
  ['batteryChargeAcKwh', 'house_energy_reading_battery_charge_ac_kwh_check'],
] as const)('a negative or absurd %s is rejected', async (field, constraint) => {
  const negative = { [field]: -0.001 } as Partial<Insert>
  const absurd = { [field]: HOUSE_BUCKET_KWH_MAX } as Partial<Insert>
  await expectConstraintViolation(db.insert(houseEnergyReading).values(row(negative)), constraint)
  await expectConstraintViolation(db.insert(houseEnergyReading).values(row(absurd)), constraint)
})

test('a bucket must start on a 5-minute boundary', async () => {
  for (const bucketStart of [
    new Date('2026-04-01T10:02:00Z'),
    new Date('2026-04-01T10:00:01Z'),
    new Date('2026-04-01T10:00:00.001Z'),
  ]) {
    await expectConstraintViolation(
      db.insert(houseEnergyReading).values(row({ bucketStart })),
      'house_energy_reading_bucket_aligned_check',
    )
  }
  await db.insert(houseEnergyReading).values(row({ bucketStart: new Date('2026-04-01T10:55:00Z') }))
})

test('zero is a valid reading', async () => {
  await db.insert(houseEnergyReading).values(row({ gridImportKwh: 0, solarKwh: 0, loadKwh: 0 }))
})

test('every integration source, emaldo included, passes both source CHECKs', async () => {
  expect(INTEGRATION_SOURCES).toContain('emaldo')
  for (const source of INTEGRATION_SOURCES) {
    await db.insert(integrationSync).values({ source })
    await db.insert(integrationSyncRun).values({
      source,
      trigger: 'cron',
      startedAt: new Date('2026-04-01T10:00:00Z'),
      finishedAt: new Date('2026-04-01T10:00:01Z'),
      durationMs: 1000,
      outcome: 'ok',
    })
  }
})
