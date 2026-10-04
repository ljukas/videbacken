import type { HouseReading } from '~/lib/services/houseEnergy'
import { stockholmDayBounds } from '~/lib/time/stockholm'

// SYNTHETIC house readings for tests. Never put real readings in the repo
// (it's public); the probe's real data stays in data/private/.

const BUCKET_MS = 5 * 60_000

export type Flows = Partial<Omit<HouseReading, 'bucketStart'>>

/** One reading; every flow not given is 0, the SoC null (so the pool isn't capped). */
export function reading(bucketStart: Date | number, flows: Flows = {}): HouseReading {
  return {
    bucketStart: new Date(bucketStart),
    gridImportKwh: 0,
    gridExportKwh: 0,
    solarKwh: 0,
    loadKwh: 0,
    batteryDischargeKwh: 0,
    batteryChargeSolarKwh: 0,
    batteryChargeGridKwh: 0,
    batteryChargeAcKwh: 0,
    batterySocPct: null,
    ...flows,
  }
}

/** Every 5-min bucket of Stockholm `day` (276, 288 or 300 of them); `flows` per bucket. */
export function syntheticDay(
  day: string,
  flows: (bucketStartMs: number, i: number) => Flows = () => ({}),
): HouseReading[] {
  const { startMs, endMs } = stockholmDayBounds(day)
  const out: HouseReading[] = []
  for (let t = startMs, i = 0; t < endMs; t += BUCKET_MS, i++) out.push(reading(t, flows(t, i)))
  return out
}
