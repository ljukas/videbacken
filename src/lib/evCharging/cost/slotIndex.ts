import type { PriceSlot } from '~/lib/spotPrice/slots'

/**
 * Spot price slots sorted by start, for overlap lookups. Assumes slots don't
 * overlap each other (the sync stores whole validated days), so ends are
 * sorted too and the first overlapping slot is a binary search away.
 */
export class SlotIndex {
  private readonly slots: readonly PriceSlot[]

  constructor(slots: readonly PriceSlot[]) {
    this.slots = [...slots].sort((a, b) => a.startMs - b.startMs)
  }

  /** Slots overlapping `[startMs, endMs)`, in order. */
  between(startMs: number, endMs: number): PriceSlot[] {
    let lo = 0
    let hi = this.slots.length
    // First slot whose end is after `startMs`.
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.slots[mid].endMs <= startMs) lo = mid + 1
      else hi = mid
    }
    const out: PriceSlot[] = []
    for (let i = lo; i < this.slots.length && this.slots[i].startMs < endMs; i++) {
      out.push(this.slots[i])
    }
    return out
  }
}
