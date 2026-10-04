import { expect, test } from 'vitest'
import { reading } from '~test/fixtures/houseEnergy'
import { deriveSessionMix } from './carMix'
import { runHouseTimeline } from './houseTimeline'
import { BATTERY_CAPACITY_KWH, emptyPool } from './pool'
import { shapeSession } from './shape'

// The pure chain end to end (shape → timeline → car mix), on synthetic data:
// the battery charges from the grid at 0.2 SEK just after midnight, then half
// feeds a 19:00Z session; the session's last bucket has no reading.
const at = (iso: string) => Date.parse(iso)
const NIGHT = at('2026-02-14T23:00:00Z') // 00:00 local, 2026-02-15

test('a grid-charged battery reaches the car at its purchase spot; a gap is no-house-data', () => {
  const readings = [
    ...[0, 1, 2].map((i) =>
      reading(NIGHT + i * 300_000, { batteryChargeGridKwh: 1, gridImportKwh: 1 }),
    ),
    ...['19:00', '19:05'].map((hm) =>
      reading(at(`2026-02-15T${hm}:00Z`), {
        loadKwh: 1,
        gridImportKwh: 0.5,
        batteryDischargeKwh: 0.5,
      }),
    ),
  ]
  const { house } = runHouseTimeline({
    readings,
    fromDay: '2026-02-15',
    throughDay: '2026-02-15',
    start: emptyPool(),
    spotAt: (ms) => (ms < NIGHT + 900_000 ? 0.2 : 1),
    capacityKwh: BATTERY_CAPACITY_KWH,
  })
  const startMs = at('2026-02-15T19:00:00Z')
  const car = shapeSession({
    startMs,
    stretches: [{ startMs, endMs: at('2026-02-15T19:15:00Z'), kwh: 1.5 }],
    readings,
  })
  const [slot] = deriveSessionMix(car, house)
  expect(slot.slotStart).toEqual(new Date(startMs))
  expect(slot.kwh).toBeCloseTo(1.5, 12)
  expect(slot.gridKwh).toBeCloseTo(0.5, 12)
  expect(slot.batteryGridKwh).toBeCloseTo(0.5, 12)
  expect(slot.batteryGridSpotSek).toBeCloseTo(0.2, 12)
  expect(slot.noHouseDataKwh).toBeCloseTo(0.5, 12)
})
