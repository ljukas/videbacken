import { describe, expect, test } from 'vitest'
import { unitEndRule } from './unitEnd'

const HOUR_MS = 3_600_000
const at = (iso: string) => Date.parse(iso)
// The coverage end every case measures against: 2026-03-10 00:00 Z.
const END = at('2026-03-10T00:00:00Z')
const SEEN = at('2026-03-09T18:00:00Z') // the newest listing (the last sync run)

describe('unitEndRule', () => {
  test('a unit trailing the coverage end by less than 13 h ends at its own newest hour', () => {
    // Newest stored hour 03-09 11:00 Z → own end 12:00 Z, 12 h before the coverage end: the sync's normal lag.
    const unit = { lastMs: at('2026-03-09T11:00:00Z'), lastSeenMs: SEEN }
    const rule = unitEndRule([unit], END)
    expect(rule.removed(unit)).toBe(false)
    expect(rule.endMs(unit)).toBe(at('2026-03-09T12:00:00Z'))
  })

  test('from 13 h behind, a listed unit ends at the coverage end (its silence is missing)', () => {
    // Own end 03-09 11:00 Z, exactly 13 h before the coverage end.
    const unit = { lastMs: at('2026-03-09T10:00:00Z'), lastSeenMs: SEEN }
    expect(unitEndRule([unit], END).endMs(unit)).toBe(END)
  })

  test('a unit no longer listed ends at the later of its own end and its last listing', () => {
    const listed = { lastMs: END - HOUR_MS, lastSeenMs: SEEN }
    // Own end 03-08 00:00 Z, last listed 03-08 06:00 Z: missing up to the listing.
    const listedLater = {
      lastMs: at('2026-03-07T23:00:00Z'),
      lastSeenMs: at('2026-03-08T06:00:00Z'),
    }
    // Own end 03-08 00:00 Z, last listed before it (03-07 12:00 Z): nothing missing after its own end.
    const listedEarlier = {
      lastMs: at('2026-03-07T23:00:00Z'),
      lastSeenMs: at('2026-03-07T12:00:00Z'),
    }
    const rule = unitEndRule([listed, listedLater, listedEarlier], END)
    expect(rule.removed(listed)).toBe(false)
    expect(rule.removed(listedLater)).toBe(true)
    expect(rule.removed(listedEarlier)).toBe(true)
    expect(rule.endMs(listed)).toBe(END)
    expect(rule.endMs(listedLater)).toBe(at('2026-03-08T06:00:00Z'))
    expect(rule.endMs(listedEarlier)).toBe(at('2026-03-08T00:00:00Z'))
  })

  test("a removed unit's end never passes the coverage end", () => {
    // The coverage end can precede the last listing (Översikt's ends at the newest house bucket).
    const newest = { lastMs: END - HOUR_MS, lastSeenMs: at('2026-03-11T00:00:00Z') }
    const removed = { lastMs: at('2026-03-08T23:00:00Z'), lastSeenMs: at('2026-03-10T06:00:00Z') }
    const rule = unitEndRule([newest, removed], END)
    expect(rule.removed(removed)).toBe(true)
    expect(rule.endMs(removed)).toBe(END)
  })

  test('a removed unit lagging less than 13 h still ends at its own newest hour', () => {
    const newest = { lastMs: END - HOUR_MS, lastSeenMs: SEEN }
    const removed = { lastMs: at('2026-03-09T20:00:00Z'), lastSeenMs: at('2026-03-09T12:00:00Z') }
    expect(unitEndRule([newest, removed], END).endMs(removed)).toBe(at('2026-03-09T21:00:00Z'))
  })

  test("every unit's last listing frozen together (the source failing): none is removed", () => {
    const a = { lastMs: at('2026-03-07T23:00:00Z'), lastSeenMs: at('2026-03-08T00:20:00Z') }
    const b = { lastMs: at('2026-03-07T22:00:00Z'), lastSeenMs: at('2026-03-08T00:20:00Z') }
    const rule = unitEndRule([a, b], END)
    expect([rule.removed(a), rule.removed(b)]).toEqual([false, false])
    expect([rule.endMs(a), rule.endMs(b)]).toEqual([END, END])
  })
})
