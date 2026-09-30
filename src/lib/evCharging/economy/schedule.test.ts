import { sum } from 'd3-array'
import { describe, expect, test } from 'vitest'
import { SlotIndex, type TariffPeriod } from '~/lib/evCharging/cost'
import { daySlots } from '~/lib/spotPrice/testing/daySlots'
import { economyWindow, rateCapKw, schedule, sessionKwh, windowPieces } from './schedule'
import type { EconomySession } from './types'

const utc = (iso: string) => new Date(iso).getTime()
const TARIFF: TariffPeriod = {
  validFrom: '2025-01-01',
  retailMarkupOre: 5.331,
  gridTransferOre: 35.6,
  energyTaxOre: 36,
  vatPercent: 25,
}
// 2026-09-28 is CEST: local 10:00 = 08:00Z; slot i starts at local i×15 min.
// Window local 10:00–12:00 = slots 40..47 with these spot prices, 9 SEK elsewhere.
const WINDOW_PRICES = [5, 1, 4, 2, 8, -0.5, 7, 6]
const day = new SlotIndex(daySlots('2026-09-28', 15, (i) => WINDOW_PRICES[i - 40] ?? 9))
const WINDOW = { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T10:00Z') }
const span = (iv: { startMs: number; endMs: number }) => [
  new Date(iv.startMs).toISOString().slice(11, 16),
  new Date(iv.endMs).toISOString().slice(11, 16),
]

describe('windowPieces', () => {
  test('covers the window slot by slot with each slot’s full price', () => {
    const pieces = windowPieces(WINDOW, day, [TARIFF])
    expect(pieces).toHaveLength(8)
    // (spot + 76,931 öre fees) × 1,25
    expect(pieces?.[1].sekPerKwh).toBeCloseTo((1 + 0.76931) * 1.25)
    expect(pieces?.[0].startMs).toBe(WINDOW.startMs)
    expect(pieces?.[7].endMs).toBe(WINDOW.endMs)
  })

  test('clips the edge slots to the window', () => {
    const pieces = windowPieces(
      { startMs: utc('2026-09-28T08:05Z'), endMs: utc('2026-09-28T08:40Z') },
      day,
      [TARIFF],
    )
    expect(pieces?.map(span)).toEqual([
      ['08:05', '08:15'],
      ['08:15', '08:30'],
      ['08:30', '08:40'],
    ])
  })

  test('is null when any part of the window has no price slot', () => {
    const holey = new SlotIndex(daySlots('2026-09-28', 15).filter((_, i) => i !== 43))
    expect(windowPieces(WINDOW, holey, [TARIFF])).toBeNull()
  })

  test('is null when the window runs past the last stored slot', () => {
    const partial = new SlotIndex(daySlots('2026-09-28', 15).slice(0, 44)) // ends 09:00Z
    expect(windowPieces(WINDOW, partial, [TARIFF])).toBeNull()
  })

  test('is null when the window starts before the first stored slot', () => {
    const late = new SlotIndex(
      daySlots('2026-09-28', 15).filter((s) => s.startMs >= utc('2026-09-28T08:30Z')),
    )
    expect(windowPieces(WINDOW, late, [TARIFF])).toBeNull()
  })

  test('is null when a whole price day is missing in the middle of an overnight window', () => {
    const slots = new SlotIndex([...daySlots('2026-09-28', 15), ...daySlots('2026-09-30', 15)])
    // local 2026-09-28 20:00 → 2026-09-30 02:00 (CEST)
    const window = { startMs: utc('2026-09-28T18:00Z'), endMs: utc('2026-09-30T00:00Z') }
    expect(windowPieces(window, slots, [TARIFF])).toBeNull()
  })

  test('is null for a zero-length window', () => {
    const at = utc('2026-09-28T08:10Z')
    expect(windowPieces({ startMs: at, endMs: at }, day, [TARIFF])).toBeNull()
    expect(windowPieces({ startMs: at, endMs: at - 1 }, day, [TARIFF])).toBeNull()
  })

  test('is null when a slot has no tariff in force', () => {
    expect(windowPieces(WINDOW, day, [{ ...TARIFF, validFrom: '2026-10-01' }])).toBeNull()
  })
})

describe('schedule', () => {
  const pieces = windowPieces(WINDOW, day, [TARIFF]) ?? []

  test('immediate fills from plug-in in time order and stops at the energy', () => {
    // 10 kW → 2,5 kWh per quarter.
    const s = schedule('immediate', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:00', '08:15'],
      ['08:15', '08:30'],
    ])
    expect(sum(s, (iv) => iv.kwh)).toBeCloseTo(5)
    expect(s.every((iv) => iv.gridShare === 1)).toBe(true)
  })

  test('optimal takes the cheapest quarters first — a negative price first of all — in time order', () => {
    const s = schedule('optimal', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:15', '08:30'], // 1 SEK
      ['09:15', '09:30'], // −0,5 SEK
    ])
  })

  test('the last quarter is filled partly, from its start, at the rate cap', () => {
    // 2,5 kWh at −0,5, then 1 kWh of the 1-SEK quarter = 6 min at 10 kW.
    const s = schedule('optimal', 3.5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['08:15', '08:21'],
      ['09:15', '09:30'],
    ])
    expect(s[0].kwh).toBeCloseTo(1)
  })

  test('dearest takes the most expensive quarters first', () => {
    const s = schedule('dearest', 5, 10, pieces)
    expect(s.map(span)).toEqual([
      ['09:00', '09:15'], // 8
      ['09:30', '09:45'], // 7
    ])
  })

  test('a partial edge piece holds only rate × its own length', () => {
    const edge =
      windowPieces({ startMs: utc('2026-09-28T08:05Z'), endMs: utc('2026-09-28T09:00Z') }, day, [
        TARIFF,
      ]) ?? []
    // 10 min at 10 kW = 1,667 kWh, the rest (0,333 kWh = 2 min) in the next quarter.
    const s = schedule('immediate', 2, 10, edge)
    expect(s.map(span)).toEqual([
      ['08:05', '08:15'],
      ['08:15', '08:17'],
    ])
  })

  test('a tariff change at local midnight re-ranks flat spot prices', () => {
    // Local 23:00 Sep 30 → 01:00 Oct 1 (21:00Z–23:00Z); grid fee drops at midnight.
    const slots = new SlotIndex([
      ...daySlots('2026-09-30', 15, () => 1),
      ...daySlots('2026-10-01', 15, () => 1),
    ])
    const tariffs = [TARIFF, { ...TARIFF, validFrom: '2026-10-01', gridTransferOre: 10 }]
    const window = { startMs: utc('2026-09-30T21:00Z'), endMs: utc('2026-09-30T23:00Z') }
    const s = schedule('optimal', 5, 10, windowPieces(window, slots, tariffs) ?? [])
    expect(s.map(span)).toEqual([
      ['22:00', '22:15'],
      ['22:15', '22:30'],
    ])
  })

  test('hourly slots (before 2025-10-01) hold rate × one hour each', () => {
    // 2025-09-15 CEST: local 10:00 = 08:00Z; hourly slot h at local h:00.
    const slots = new SlotIndex(daySlots('2025-09-15', 60, (h) => (h === 11 ? 0.5 : 2)))
    const window = { startMs: utc('2025-09-15T08:00Z'), endMs: utc('2025-09-15T10:00Z') }
    const s = schedule('optimal', 5, 10, windowPieces(window, slots, [TARIFF]) ?? [])
    expect(s.map(span)).toEqual([['09:00', '09:30']])
  })

  test('a window across the autumn DST change keeps every one of its four real hours', () => {
    // Local 01:00 CEST → 04:00 CET on 2026-10-25 = 23:00Z–03:00Z, 4 h (16 quarters).
    const slots = new SlotIndex([
      ...daySlots('2026-10-24', 15, () => 1),
      ...daySlots('2026-10-25', 15, () => 1),
    ])
    const window = { startMs: utc('2026-10-24T23:00Z'), endMs: utc('2026-10-25T03:00Z') }
    const pieces4h = windowPieces(window, slots, [TARIFF]) ?? []
    expect(pieces4h).toHaveLength(16)
    const s = schedule('immediate', 4, 1, pieces4h)
    expect(sum(s, (iv) => iv.kwh)).toBeCloseTo(4)
    expect(s.at(-1)?.endMs).toBe(window.endMs)
  })

  test('no energy → no schedule', () => {
    expect(schedule('optimal', 0, 10, pieces)).toEqual([])
  })

  test.each([
    ['rate 0', 5, 0],
    ['rate -1', 5, -1],
    ['rate NaN', 5, Number.NaN],
    ['rate Infinity', 5, Number.POSITIVE_INFINITY],
    ['kwh NaN', Number.NaN, 10],
    ['kwh -1', -1, 10],
  ])('invalid input throws: %s', (_name, kwh, rate) => {
    expect(() => schedule('optimal', kwh, rate, pieces)).toThrow(RangeError)
  })

  test('zero energy needs no rate', () => {
    expect(schedule('optimal', 0, 0, pieces)).toEqual([])
  })

  test('a session whose rate cap is energy ÷ window fills an off-grid window exactly', () => {
    const session: EconomySession = {
      startMs: utc('2026-09-28T08:07Z'),
      endMs: utc('2026-09-28T12:07Z'),
      stretches: [{ startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 20 }],
      estimated: false,
    }
    const window = economyWindow(session)
    const wp = windowPieces(window, day, [TARIFF]) ?? []
    expect(wp.length).toBeGreaterThan(0)
    const rate = rateCapKw(session, window)
    for (const kind of ['immediate', 'optimal', 'dearest'] as const) {
      const s = schedule(kind, sessionKwh(session), rate, wp)
      expect(sum(s, (iv) => iv.kwh)).toBeCloseTo(sessionKwh(session))
    }
  })

  test('more energy than the window can take at the rate is a caller bug', () => {
    expect(() => schedule('optimal', 50, 10, pieces)).toThrow(RangeError)
  })
})

describe('rate cap and window', () => {
  const session = (stretches: EconomySession['stretches']): EconomySession => ({
    startMs: utc('2026-09-28T08:00Z'),
    endMs: utc('2026-09-28T12:00Z'),
    stretches,
    estimated: false,
  })

  test('the rate cap is the highest observed kW', () => {
    const s = session([
      { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 10.8 },
      { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:20Z'), kwh: 2 }, // 6 kW
    ])
    expect(rateCapKw(s, economyWindow(s))).toBeCloseTo(10.8)
  })

  test('the rate cap is at least the energy spread over the window', () => {
    // 20 kWh reported in a zero-length stretch (a clock quirk) over a 4 h window.
    const s = session([
      { startMs: utc('2026-09-28T09:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 20 },
    ])
    expect(rateCapKw(s, economyWindow(s))).toBeCloseTo(5)
  })

  test('the window widens to stretches just outside plug-in → plug-out', () => {
    const s = session([
      { startMs: utc('2026-09-28T07:58Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 5 },
      { startMs: utc('2026-09-28T11:00Z'), endMs: utc('2026-09-28T12:03Z'), kwh: 5 },
    ])
    expect(economyWindow(s)).toEqual({
      startMs: utc('2026-09-28T07:58Z'),
      endMs: utc('2026-09-28T12:03Z'),
    })
    expect(sessionKwh(s)).toBe(10)
  })

  test('no energy → a zero rate cap', () => {
    const s = session([
      { startMs: utc('2026-09-28T08:00Z'), endMs: utc('2026-09-28T09:00Z'), kwh: 0 },
    ])
    expect(rateCapKw(s, economyWindow(s))).toBe(0)
  })
})
