// Client-safe, pure (ADR-0023). Runs the battery pool forward over the house
// readings from `fromDay`, one Stockholm day at a time (23, 24 or 25 h), and
// records what the car mix needs per bucket. Each bucket is capped at its
// end-of-bucket SoC × `capacityKwh` (the next reading's SoC is needed for it,
// so the readings are stepped as one ascending list across days). A
// checkpoint is written for every day through `throughDay` (normally today)
// even without readings: the state carries over, so a later derive from any
// day up to today finds D−1's row.
import type { HouseReading } from '~/lib/services/houseEnergy'
import { addDays, stockholmDayBounds, stockholmDayOf } from '~/lib/time/stockholm'
import type { BucketHouse } from './carMix'
import { endOfBucketSocPct, type PoolState, stepPool } from './pool'
import { houseSupply } from './supply'

export type PoolDay = { day: string; state: PoolState }

export function runHouseTimeline(input: {
  readings: readonly HouseReading[]
  fromDay: string
  throughDay: string
  start: PoolState
  /** The spot (SEK/kWh ex VAT) of the slot containing the bucket, or null. */
  spotAt: (bucketStartMs: number) => number | null
  /** C: kWh the battery delivers per 100 % SoC. */
  capacityKwh: number
}): { days: PoolDay[]; house: Map<number, BucketHouse> } {
  const fromMs = stockholmDayBounds(input.fromDay).startMs
  const stepped = input.readings
    .filter((r) => r.bucketStart.getTime() >= fromMs)
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
  const house = new Map<number, BucketHouse>()
  const days: PoolDay[] = []
  const last = stepped.at(-1)
  const lastReadingDay = last ? stockholmDayOf(last.bucketStart.getTime()) : null
  const lastDay =
    lastReadingDay !== null && lastReadingDay > input.throughDay ? lastReadingDay : input.throughDay

  let state = input.start
  let i = 0
  for (let day = input.fromDay; day <= lastDay; day = addDays(day, 1)) {
    const endMs = stockholmDayBounds(day).endMs
    for (; i < stepped.length && stepped[i].bucketStart.getTime() < endMs; i++) {
      const r = stepped[i]
      const t = r.bucketStart.getTime()
      const soc = endOfBucketSocPct(r, stepped[i + 1])
      const capKwh = soc === null ? null : (soc / 100) * input.capacityKwh
      const { next, out } = stepPool(state, r, input.spotAt(t), capKwh)
      state = next
      house.set(t, { supply: houseSupply(r), batteryOut: out })
    }
    days.push({ day, state })
  }
  return { days, house }
}
