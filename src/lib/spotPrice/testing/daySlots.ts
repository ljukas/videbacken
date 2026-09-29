import { stockholmDayBounds } from '../../time/stockholm'
import type { PriceSlot } from '../slots'

/**
 * Synthetic slots covering Stockholm `day` — test fixtures only. `price(i)`
 * gives slot i's SEK/kWh (default 1).
 */
export function daySlots(
  day: string,
  lengthMin: 15 | 60,
  price: (i: number) => number = () => 1,
): PriceSlot[] {
  const { startMs, endMs } = stockholmDayBounds(day)
  const step = lengthMin * 60 * 1000
  const slots: PriceSlot[] = []
  for (let t = startMs, i = 0; t < endMs; t += step, i++) {
    slots.push({ startMs: t, endMs: t + step, sekPerKwh: price(i) })
  }
  return slots
}
