import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '~/lib/db'
import {
  HEAT_PUMP_HOUR_KWH_MAX,
  HEAT_PUMP_TEMP_MAX_C,
  HEAT_PUMP_TEMP_MIN_C,
  heatPump,
  heatPumpReading,
} from '~/lib/db/schema'
import { expectConstraintViolation } from '~test/expectConstraintViolation'
import { setupDatabase } from '~test/setup'

// Lives in src/lib/db/ (not schema/), like houseEnergySchema.test.ts.
setupDatabase()

type Reading = typeof heatPumpReading.$inferInsert
const NOW = new Date('2026-10-08T10:00:00Z')

async function unit(guid = 'CS-HZ25ZKE+0000000001') {
  const [row] = await db
    .insert(heatPump)
    .values({ guid, name: 'Matsal', model: 'CS-HZ25ZKE', firstSeenAt: NOW, lastSeenAt: NOW })
    .returning()
  return row
}

// Synthetic values only (public repo).
const reading = (heatPumpId: string, overrides: Partial<Reading> = {}): Reading => ({
  heatPumpId,
  hourStart: new Date('2026-10-07T10:00:00Z'),
  energyKwh: 0.12,
  heatShare: 1,
  coolShare: 0,
  setpointC: 21,
  insideC: 20.5,
  outsideC: 3.25,
  ...overrides,
})

test('a unit is unique by guid; its dates start empty', async () => {
  const u = await unit()
  expect(u).toMatchObject({
    registeredOn: null,
    historyCompleteAt: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
  await expectConstraintViolation(unit(), 'heat_pump_guid_unique')
})

test('a reading is keyed by unit and hour; two units share an hour', async () => {
  const a = await unit()
  const b = await unit('CS-HZ25ZKE+0000000002')
  await db.insert(heatPumpReading).values([reading(a.id), reading(b.id)])
  await expectConstraintViolation(
    db.insert(heatPumpReading).values(reading(a.id)),
    'heat_pump_reading_pkey',
  )
})

test('a reading must start on a whole UTC hour', async () => {
  const u = await unit()
  for (const hourStart of [
    new Date('2026-10-07T10:30:00Z'),
    new Date('2026-10-07T10:00:01Z'),
    new Date('2026-10-07T10:00:00.001Z'),
  ]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { hourStart })),
      'heat_pump_reading_hour_aligned_check',
    )
  }
  await db
    .insert(heatPumpReading)
    .values(reading(u.id, { hourStart: new Date('2026-10-07T23:00:00Z') }))
})

test('energy is 0 or more and under 5 kWh', async () => {
  const u = await unit()
  for (const energyKwh of [-0.001, HEAT_PUMP_HOUR_KWH_MAX]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { energyKwh })),
      'heat_pump_reading_energy_kwh_check',
    )
  }
  await db.insert(heatPumpReading).values(reading(u.id, { energyKwh: 0 }))
  await db
    .insert(heatPumpReading)
    .values(reading(u.id, { energyKwh: 4.999, hourStart: new Date('2026-10-07T11:00:00Z') }))
})

test.each([
  ['heatShare', 'heat_pump_reading_heat_share_check', -0.01, 1.01],
  ['coolShare', 'heat_pump_reading_cool_share_check', -0.01, 1.01],
  [
    'setpointC',
    'heat_pump_reading_setpoint_c_check',
    HEAT_PUMP_TEMP_MIN_C - 0.25,
    HEAT_PUMP_TEMP_MAX_C + 0.25,
  ],
  [
    'insideC',
    'heat_pump_reading_inside_c_check',
    HEAT_PUMP_TEMP_MIN_C - 0.25,
    HEAT_PUMP_TEMP_MAX_C + 0.25,
  ],
  [
    'outsideC',
    'heat_pump_reading_outside_c_check',
    HEAT_PUMP_TEMP_MIN_C - 0.25,
    HEAT_PUMP_TEMP_MAX_C + 0.25,
  ],
] as const)('%s outside its range is rejected; its bounds and null are not', async (field, constraint, low, high) => {
  const u = await unit()
  for (const value of [low, high]) {
    await expectConstraintViolation(
      db.insert(heatPumpReading).values(reading(u.id, { [field]: value } as Partial<Reading>)),
      constraint,
    )
  }
  const bounds = field.endsWith('Share') ? [0, 1] : [HEAT_PUMP_TEMP_MIN_C, HEAT_PUMP_TEMP_MAX_C]
  for (const [i, value] of [...bounds, null].entries()) {
    await db.insert(heatPumpReading).values(
      reading(u.id, {
        [field]: value,
        hourStart: new Date(Date.UTC(2026, 9, 7, i)),
      } as Partial<Reading>),
    )
  }
})

test('a reading needs an existing unit, and goes with it', async () => {
  await expectConstraintViolation(
    db.insert(heatPumpReading).values(reading('00000000-0000-4000-8000-000000000000')),
    'heat_pump_reading_heat_pump_id_heat_pump_id_fk',
  )
  const u = await unit()
  await db.insert(heatPumpReading).values(reading(u.id))
  await db.delete(heatPump).where(eq(heatPump.id, u.id))
  expect(await db.select().from(heatPumpReading)).toEqual([])
})
