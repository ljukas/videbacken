import { describe, expect, test } from 'vitest'
import {
  addDays,
  daysBetween,
  isStockholmDay,
  stockholmDayBounds,
  stockholmDayOf,
  stockholmFirstOfMonth,
  stockholmMonthBounds,
  stockholmNightsOfDay,
  stockholmYearBounds,
  stockholmYearMonth,
} from './stockholm'

const HOUR = 60 * 60 * 1000
const utc = (iso: string) => new Date(iso).getTime()

describe('stockholmMonthBounds', () => {
  const h = (b: { startMs: number; endMs: number }) => (b.endMs - b.startMs) / HOUR
  test('spans local midnight to local midnight', () => {
    expect(stockholmMonthBounds(2026, 3)).toEqual({
      startMs: Date.parse('2026-02-28T23:00:00Z'), // 1 Mar 00:00 CET
      endMs: Date.parse('2026-03-31T22:00:00Z'), // 1 Apr 00:00 CEST
    })
    expect(stockholmMonthBounds(2026, 12).endMs).toBe(Date.parse('2026-12-31T23:00:00Z'))
    expect(stockholmMonthBounds(2026, 12).startMs).toBe(Date.parse('2026-11-30T23:00:00Z'))
  })

  test('January spans 31 CET days', () => {
    expect(stockholmMonthBounds(2026, 1)).toEqual({
      startMs: Date.parse('2025-12-31T23:00:00Z'),
      endMs: Date.parse('2026-01-31T23:00:00Z'),
    })
  })

  test('October 2026 (fall-back month) is 745 hours', () => {
    const october = stockholmMonthBounds(2026, 10)
    expect(october).toEqual({
      startMs: Date.parse('2026-09-30T22:00:00Z'),
      endMs: Date.parse('2026-10-31T23:00:00Z'),
    })
    expect(h(october)).toBe(745)
  })
})

describe('stockholmDayOf', () => {
  test('switches day at local midnight, not UTC midnight', () => {
    // CEST (UTC+2)
    expect(stockholmDayOf(utc('2026-09-27T21:59:59.999Z'))).toBe('2026-09-27')
    expect(stockholmDayOf(utc('2026-09-27T22:00:00Z'))).toBe('2026-09-28')
    // CET (UTC+1), across New Year
    expect(stockholmDayOf(utc('2025-12-31T22:59:59.999Z'))).toBe('2025-12-31')
    expect(stockholmDayOf(utc('2025-12-31T23:00:00Z'))).toBe('2026-01-01')
  })

  test('tracks the offset change on DST switch days', () => {
    // Spring forward 2025-03-30 02:00 CET → 03:00 CEST (01:00Z).
    expect(stockholmDayOf(utc('2025-03-29T22:59:59.999Z'))).toBe('2025-03-29')
    expect(stockholmDayOf(utc('2025-03-29T23:00:00Z'))).toBe('2025-03-30')
    expect(stockholmDayOf(utc('2025-03-30T21:59:59.999Z'))).toBe('2025-03-30')
    expect(stockholmDayOf(utc('2025-03-30T22:00:00Z'))).toBe('2025-03-31')
    // Fall back 2025-10-26 03:00 CEST → 02:00 CET (01:00Z).
    expect(stockholmDayOf(utc('2025-10-25T21:59:59.999Z'))).toBe('2025-10-25')
    expect(stockholmDayOf(utc('2025-10-25T22:00:00Z'))).toBe('2025-10-26')
    expect(stockholmDayOf(utc('2025-10-26T22:59:59.999Z'))).toBe('2025-10-26')
    expect(stockholmDayOf(utc('2025-10-26T23:00:00Z'))).toBe('2025-10-27')
  })
})

describe('stockholmYearMonth', () => {
  test('uses the local calendar month', () => {
    expect(stockholmYearMonth(utc('2026-08-31T22:30:00Z'))).toEqual({ year: 2026, month: 9 })
    expect(stockholmYearMonth(utc('2025-12-31T23:30:00Z'))).toEqual({ year: 2026, month: 1 })
    // CET again after the October switch.
    expect(stockholmYearMonth(utc('2025-10-31T22:59:59.999Z'))).toEqual({ year: 2025, month: 10 })
    expect(stockholmYearMonth(utc('2025-10-31T23:00:00Z'))).toEqual({ year: 2025, month: 11 })
  })
})

// stockholmDayOf and stockholmYearMonth run once or more per priced 15-min
// piece, so they are the ones worth speeding up. These pin them against Intl,
// which shares no code with them (only the runtime's zone data: the
// hand-written cases below catch wrong zone data). The instants are spread
// so that each test meets hours no earlier test has asked for.
describe('stockholmDayOf and stockholmYearMonth match Intl', () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
  const reference = (ms: number) => {
    const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, x.value]))
    const [year, month, day] = [Number(p.year), Number(p.month), Number(p.day)]
    const pad = (n: number) => String(n).padStart(2, '0')
    return { day: `${year}-${pad(month)}-${pad(day)}`, year, month }
  }
  const mismatches = (instants: number[], want = instants.map(reference)) =>
    instants.flatMap((ms, i) => {
      const day = stockholmDayOf(ms)
      const ym = stockholmYearMonth(ms)
      return day === want[i].day && ym.year === want[i].year && ym.month === want[i].month
        ? []
        : [{ at: new Date(ms).toISOString(), day, ym, want: want[i] }]
    })
  // A fixed-seed shuffle (mulberry32 + Fisher–Yates), so a failure reproduces.
  const shuffled = (xs: number[]) => {
    let seed = 0x5eed
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const out = [...xs]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  test('every 15 minutes from 2023 through 2027, in shuffled and then in time order', () => {
    const instants: number[] = []
    for (let ms = utc('2023-01-01T00:00:00Z'); ms < utc('2028-01-01T00:00:00Z'); ms += HOUR / 4) {
      instants.push(ms)
    }
    const mixed = shuffled(instants)
    expect(mismatches(mixed).slice(0, 5)).toEqual([])
    expect(mismatches(instants).slice(0, 5)).toEqual([])
  })

  test('every hour from 1970 through 1975, then the first hours again', () => {
    // ~52 600 distinct hours: more than the per-hour cache's cap (50 000 in
    // stockholm.ts), so it clears once and the first hours are asked again.
    const instants: number[] = []
    for (let ms = utc('1970-01-01T00:00:00Z'); ms < utc('1976-01-01T00:00:00Z'); ms += HOUR) {
      instants.push(ms + 1_234_567)
    }
    const want = instants.map(reference)
    expect(mismatches(instants, want).slice(0, 5)).toEqual([])
    expect(mismatches(instants.slice(0, 48), want.slice(0, 48))).toEqual([])
  })

  test('each hour asked for at its last ms before its first', () => {
    // The 2030 switches (31 Mar and 27 Oct, 01:00Z) and the local midnights
    // around them, outside every other test's range.
    const hours = [
      '2030-03-30T22:00:00Z',
      '2030-03-30T23:00:00Z',
      '2030-03-31T00:00:00Z',
      '2030-03-31T01:00:00Z',
      '2030-03-31T21:00:00Z',
      '2030-03-31T22:00:00Z',
      '2030-10-26T21:00:00Z',
      '2030-10-26T22:00:00Z',
      '2030-10-27T00:00:00Z',
      '2030-10-27T01:00:00Z',
      '2030-10-27T22:00:00Z',
      '2030-10-27T23:00:00Z',
      '2030-12-31T22:00:00Z',
      '2030-12-31T23:00:00Z',
    ].map(utc)
    expect(mismatches(hours.flatMap((h) => [h + HOUR - 1, h]))).toEqual([])
  })

  test('hand-written days, independent of the zone data the code reads', () => {
    expect(stockholmDayOf(utc('2026-03-29T01:00:00Z'))).toBe('2026-03-29')
    expect(stockholmDayOf(utc('2026-12-31T23:00:00Z'))).toBe('2027-01-01')
    expect(stockholmYearMonth(utc('2026-12-31T23:00:00Z'))).toEqual({ year: 2027, month: 1 })
    // 22:30Z is 23:30 in CET (same day) and 00:30 in CEST (next day). No DST
    // before 1980; it began 6 Apr 1980, ended in September until 1995 and in
    // October from 1996.
    expect(stockholmDayOf(Date.UTC(1979, 6, 1, 22, 30))).toBe('1979-07-01')
    expect(stockholmDayOf(Date.UTC(1980, 3, 6, 22, 30))).toBe('1980-04-07')
    expect(stockholmDayOf(Date.UTC(1995, 8, 24, 22, 30))).toBe('1995-09-24')
    expect(stockholmDayOf(Date.UTC(1996, 9, 26, 22, 30))).toBe('1996-10-27')
  })

  test('around the 2026 DST switches, New Year and month ends', () => {
    const instants = [
      // Spring forward 2026-03-29 01:00Z, fall back 2026-10-25 01:00Z.
      '2026-03-28T22:59:59.999Z',
      '2026-03-28T23:00:00Z',
      '2026-03-29T00:59:59.999Z',
      '2026-03-29T01:00:00Z',
      '2026-03-29T01:59:59.999Z',
      '2026-03-29T21:59:59.999Z',
      '2026-03-29T22:00:00Z',
      '2026-10-24T21:59:59.999Z',
      '2026-10-24T22:00:00Z',
      '2026-10-25T00:59:59.999Z',
      '2026-10-25T01:00:00Z',
      '2026-10-25T01:59:59.999Z',
      '2026-10-25T22:59:59.999Z',
      '2026-10-25T23:00:00Z',
      // New Year (CET) and month ends on both offsets.
      '2026-12-31T22:59:59.999Z',
      '2026-12-31T23:00:00Z',
      '2026-02-28T22:59:59.999Z',
      '2026-02-28T23:00:00Z',
      '2026-06-30T21:59:59.999Z',
      '2026-06-30T22:00:00Z',
      '2028-02-29T22:59:59.999Z',
      '2028-02-29T23:00:00Z',
    ].map(utc)
    expect(mismatches(instants)).toEqual([])
  })

  test('the first and last ms of an hour', () => {
    const instants: number[] = []
    for (let h = utc('2026-10-24T20:00:00Z'); h < utc('2026-10-26T02:00:00Z'); h += HOUR) {
      instants.push(h, h + HOUR - 1)
    }
    expect(mismatches(instants)).toEqual([])
  })

  test('before 1900, when one UTC hour can span two Stockholm days', () => {
    // Local mean time: +00:53:28 in the zone data since tzdata 2022b (which
    // merged Europe/Stockholm into Europe/Berlin), so 23:00Z and 23:30Z on
    // 31 Dec 1878 fall on different Stockholm days.
    expect(stockholmDayOf(utc('1878-12-31T23:00:00Z'))).toBe('1878-12-31')
    expect(stockholmDayOf(utc('1878-12-31T23:30:00Z'))).toBe('1879-01-01')
    expect(stockholmYearMonth(utc('1878-12-31T23:00:00Z'))).toEqual({ year: 1878, month: 12 })
    expect(stockholmYearMonth(utc('1878-12-31T23:30:00Z'))).toEqual({ year: 1879, month: 1 })
    expect(mismatches([utc('1878-12-31T23:00:00Z'), utc('1878-12-31T23:30:00Z')])).toEqual([])
  })

  test('just before 1970, in time order', () => {
    // Different Stockholm days; a key that rounds negative hours toward zero
    // would give both the same one.
    expect(stockholmDayOf(utc('1969-12-31T22:30:00Z'))).toBe('1969-12-31')
    expect(stockholmDayOf(utc('1969-12-31T23:00:00Z'))).toBe('1970-01-01')
    expect(mismatches([utc('1969-12-31T21:30:00Z'), utc('1969-12-31T22:00:00Z'), -1, 0])).toEqual(
      [],
    )
  })

  test('fractional instants on either side of a local midnight, and -0', () => {
    const midnights = ['2029-12-31T23:00:00Z', '2029-06-30T22:00:00Z'].map(utc)
    const below = (x: number) => x - 2 ** -12 // the nearest step below at this magnitude
    expect(
      mismatches(midnights.flatMap((m) => [below(m), m - 0.5, m, m + 0.5, m + HOUR - 0.5])),
    ).toEqual([])
    expect(stockholmDayOf(below(midnights[0]))).toBe('2029-12-31')
    expect(stockholmDayOf(midnights[0])).toBe('2030-01-01')
    expect(stockholmDayOf(-0)).toBe('1970-01-01')
  })

  test('the year 3000, where the hours stop being remembered', () => {
    const bound = utc('3000-01-01T00:00:00Z')
    expect(mismatches([bound - HOUR, bound - 1, bound, bound + 1, bound + HOUR])).toEqual([])
    expect(stockholmDayOf(bound - HOUR)).toBe('3000-01-01') // 00:00 CET
    expect(stockholmYearMonth(bound - 1)).toEqual({ year: 3000, month: 1 })
  })

  test('an invalid instant, asked for twice: no day, and a NaN year and month', () => {
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1]
    for (const ms of [...invalid, ...invalid]) {
      expect(() => stockholmDayOf(ms)).toThrow(RangeError)
      expect(stockholmYearMonth(ms)).toEqual({ year: Number.NaN, month: Number.NaN })
    }
  })

  test('the top of the Date range, where one UTC hour gives a day and then none', () => {
    // 2 h before the last valid instant, the local time still fits a Date at
    // the hour's first ms but not 1 ms later. Ask in both orders.
    const lastHour = 8.64e15 - 2 * HOUR
    const later = stockholmDayOf(lastHour + 1)
    expect(stockholmDayOf(lastHour)).toBe('275760-09-13')
    expect(stockholmDayOf(lastHour + 1)).toBe(later)
    expect(later).not.toBe('275760-09-13')
    // The last valid instant gives no real day, and 1 ms past it throws.
    expect(stockholmDayOf(8.64e15)).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(() => stockholmDayOf(8.64e15 + 1)).toThrow(RangeError)
  })

  test('a result changed by the caller does not leak into the next call', () => {
    // Outside every other test's range, so the first call is the first ask.
    const ms = utc('2031-05-10T12:00:00Z')
    const mutate = (ym: { year: number; month: number }) => {
      try {
        ym.month = 1
      } catch {
        // A frozen result throws in strict mode; either way the next call is right.
      }
    }
    mutate(stockholmYearMonth(ms))
    expect(stockholmYearMonth(ms)).toEqual({ year: 2031, month: 5 })
    mutate(stockholmYearMonth(ms + HOUR / 2))
    expect(stockholmYearMonth(ms)).toEqual({ year: 2031, month: 5 })
  })
})

describe('addDays', () => {
  test('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01')
    expect(addDays('2026-09-28', 0)).toBe('2026-09-28')
  })

  test('is pure calendar arithmetic across DST switch days', () => {
    expect(addDays('2025-03-29', 1)).toBe('2025-03-30')
    expect(addDays('2025-03-30', 1)).toBe('2025-03-31')
    expect(addDays('2025-10-26', 1)).toBe('2025-10-27')
    expect(addDays('2025-10-27', -1)).toBe('2025-10-26')
  })

  test('accepts years 1970–2999 and does not validate the shifted result', () => {
    expect(addDays('1970-01-01', 0)).toBe('1970-01-01')
    expect(addDays('2999-12-31', 0)).toBe('2999-12-31')
    expect(addDays('2999-12-31', 1)).toBe('3000-01-01')
    expect(addDays('1970-01-01', -1)).toBe('1969-12-31')
    expect(() => addDays('1969-12-31', 0)).toThrow(RangeError)
    expect(() => addDays('3000-01-01', 0)).toThrow(RangeError)
  })

  test('rejects a malformed or impossible day', () => {
    expect(() => addDays('2026-9-1', 1)).toThrow(RangeError)
    expect(() => addDays('2025-02-30', 0)).toThrow(RangeError)
    expect(() => addDays('0050-01-01', 0)).toThrow(RangeError)
    expect(() => addDays('0000-01-01', 0)).toThrow(RangeError)
    expect(() => addDays('2026-02-29', 0)).toThrow(RangeError)
    expect(addDays('2028-02-29', 0)).toBe('2028-02-29')
    for (const bad of [
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
      '2026-04-31',
      ' 2026-01-01',
      '2026-01-01T00:00',
      '20260101',
      '',
    ]) {
      expect(() => addDays(bad, 0), bad).toThrow(RangeError)
    }
  })
})

describe('stockholmDayBounds', () => {
  test('a normal day is 24 h from local midnight', () => {
    const { startMs, endMs } = stockholmDayBounds('2026-09-28')
    expect(new Date(startMs).toISOString()).toBe('2026-09-27T22:00:00.000Z')
    expect(endMs - startMs).toBe(24 * HOUR)
  })

  test('spring-forward day is 23 h, fall-back day is 25 h', () => {
    const spring = stockholmDayBounds('2025-03-30')
    expect(new Date(spring.startMs).toISOString()).toBe('2025-03-29T23:00:00.000Z')
    expect(spring.endMs - spring.startMs).toBe(23 * HOUR)

    const fall = stockholmDayBounds('2025-10-26')
    expect(new Date(fall.startMs).toISOString()).toBe('2025-10-25T22:00:00.000Z')
    expect(fall.endMs - fall.startMs).toBe(25 * HOUR)
  })

  test('rejects a malformed or out-of-range day', () => {
    expect(() => stockholmDayBounds('2025-02-30')).toThrow(RangeError)
    expect(() => stockholmDayBounds('2026-9-1')).toThrow(RangeError)
    expect(() => stockholmDayBounds('1969-12-31')).toThrow(RangeError)
    // Its end is the next day's midnight, which is itself out of range.
    expect(() => stockholmDayBounds('2999-12-31')).toThrow(RangeError)
  })

  test('the first supported day is a plain CET day', () => {
    const { startMs, endMs } = stockholmDayBounds('1970-01-01')
    expect(new Date(startMs).toISOString()).toBe('1969-12-31T23:00:00.000Z')
    expect(endMs - startMs).toBe(24 * HOUR)
  })

  test('the 2026 switch days (last Sunday of March / October)', () => {
    const spring = stockholmDayBounds('2026-03-29')
    expect(new Date(spring.startMs).toISOString()).toBe('2026-03-28T23:00:00.000Z')
    expect(new Date(spring.endMs).toISOString()).toBe('2026-03-29T22:00:00.000Z')
    const fall = stockholmDayBounds('2026-10-25')
    expect(new Date(fall.startMs).toISOString()).toBe('2026-10-24T22:00:00.000Z')
    expect(new Date(fall.endMs).toISOString()).toBe('2026-10-25T23:00:00.000Z')
  })

  test('consecutive days tile without gaps', () => {
    let day = '2025-03-28'
    for (let i = 0; i < 220; i++) {
      const next = addDays(day, 1)
      expect(stockholmDayBounds(day).endMs).toBe(stockholmDayBounds(next).startMs)
      day = next
    }
  })
})

describe('isStockholmDay', () => {
  test('accepts exactly the days addDays accepts', () => {
    expect(isStockholmDay('2026-09-28')).toBe(true)
    expect(isStockholmDay('2028-02-29')).toBe(true)
    expect(isStockholmDay('1970-01-01')).toBe(true)
    expect(isStockholmDay('2999-12-31')).toBe(true)
    for (const bad of ['2025-02-30', '2026-9-1', '1969-12-31', '3000-01-01', '', '2026-01-01Z']) {
      expect(isStockholmDay(bad), bad).toBe(false)
    }
  })
})

describe('stockholmFirstOfMonth', () => {
  test('the 1st of the local month, not the UTC one', () => {
    expect(stockholmFirstOfMonth(utc('2026-09-28T12:00:00Z'))).toBe('2026-09-01')
    // 2026-08-31T22:30Z is already 1 September in Stockholm (CEST).
    expect(stockholmFirstOfMonth(utc('2026-08-31T22:30:00Z'))).toBe('2026-09-01')
    expect(stockholmFirstOfMonth(utc('2026-08-31T21:59:59.999Z'))).toBe('2026-08-01')
    expect(stockholmFirstOfMonth(utc('2025-12-31T23:00:00Z'))).toBe('2026-01-01')
  })
})

describe('stockholmYearBounds', () => {
  test('runs from local 1 January midnight (always CET, UTC+1) to the next', () => {
    const { startMs, endMs } = stockholmYearBounds(2026)
    expect(new Date(startMs).toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(new Date(endMs).toISOString()).toBe('2026-12-31T23:00:00.000Z')
    for (let year = 1970; year <= 2100; year++) {
      expect(stockholmYearBounds(year).startMs).toBe(Date.UTC(year - 1, 11, 31, 23))
      expect(stockholmYearBounds(year).endMs).toBe(stockholmYearBounds(year + 1).startMs)
    }
  })
})

describe('stockholmNightsOfDay', () => {
  const nights = (day: string) =>
    stockholmNightsOfDay(day).map(({ startMs, endMs }) => [
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    ])

  test('a normal summer day: 00:00-06:00 and 22:00-24:00 CEST', () => {
    expect(nights('2026-09-05')).toEqual([
      ['2026-09-04T22:00:00.000Z', '2026-09-05T04:00:00.000Z'],
      ['2026-09-05T20:00:00.000Z', '2026-09-05T22:00:00.000Z'],
    ])
  })

  test('spring-forward day (29 Mar 2026): the early night is 5 h long', () => {
    expect(nights('2026-03-29')).toEqual([
      ['2026-03-28T23:00:00.000Z', '2026-03-29T04:00:00.000Z'],
      ['2026-03-29T20:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ])
  })

  test('fall-back day (25 Oct 2026): the early night is 7 h long', () => {
    expect(nights('2026-10-25')).toEqual([
      ['2026-10-24T22:00:00.000Z', '2026-10-25T05:00:00.000Z'],
      ['2026-10-25T21:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ])
  })

  test('starts and ends exactly on the day bounds', () => {
    for (const day of ['2026-01-31', '2026-03-29', '2026-10-25', '2026-12-31']) {
      const [early, late] = stockholmNightsOfDay(day)
      expect(early?.startMs).toBe(stockholmDayBounds(day).startMs)
      expect(late?.endMs).toBe(stockholmDayBounds(day).endMs)
    }
  })
})

describe('daysBetween', () => {
  test('counts calendar days, negative backwards, unaffected by DST', () => {
    expect(daysBetween('2026-04-01', '2026-04-01')).toBe(0)
    expect(daysBetween('2026-04-01', '2026-03-31')).toBe(-1)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // spans the 23 h day
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2) // spans the 25 h day
    expect(daysBetween('2026-01-03', '2026-03-31')).toBe(87)
  })

  test('rejects a malformed day', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(RangeError)
  })
})
