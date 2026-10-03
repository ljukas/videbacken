import { describe, expect, test } from 'vitest'
import { stockholmDayBounds } from '~/lib/time/stockholm'
import type { HouseBucket } from './emaldo'
import { EmaldoError, type EmaldoOp } from './errors'
import { dayMinutes, seriesDay, syntheticRow } from './fixtures'
import {
  buildDay,
  parseDevices,
  parseEnvelope,
  parseHomeIds,
  parseLogin,
  parseSeries,
  SERIES_NAMES,
  type SeriesName,
} from './parse'

/** The four parsed series of `day`, each with rows at `minutes[name]` (default: the whole day). */
function day(
  date: string,
  minutes: Partial<Record<SeriesName, number[]>> = {},
  row?: (name: SeriesName, m: number) => unknown[],
) {
  return Object.fromEntries(
    SERIES_NAMES.map((n) => [n, parseSeries(n, seriesDay(n, date, minutes[n], row))]),
  ) as Record<SeriesName, ReturnType<typeof parseSeries>>
}

/** What `syntheticRow` at minute `m` must decode to — written out, not derived from the code under test. */
function expected(date: string, m: number): HouseBucket {
  const k = m / 5 + 1
  return {
    bucketStart: new Date(stockholmDayBounds(date).startMs + m * 60_000),
    gridImportKwh: (12 * k + 6) / 12_000,
    gridExportKwh: (24 * k) / 12_000,
    solarKwh: (120 + 240 + 36 * k + 48) / 12_000,
    loadKwh: (60 * k) / 12_000,
    batteryDischargeKwh: 72 / 12_000,
    batteryChargeSolarKwh: 84 / 12_000,
    batteryChargeGridKwh: 96 / 12_000,
    batteryChargeAcKwh: 108 / 12_000,
  }
}

const unexpected = (fn: () => unknown, op: EmaldoOp, at?: string, absent: string[] = []) => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(EmaldoError)
    expect(err).toMatchObject({ code: 'unexpected_response', op })
    if (at) expect((err as Error).message).toContain(at)
    for (const value of absent) expect((err as Error).message).not.toContain(value)
    return
  }
  throw new Error('expected an EmaldoError')
}

describe('buildDay', () => {
  test('a normal day: 288 buckets, columns mapped, kWh = W / 12 000, bounds exact', () => {
    const out = buildDay(-1, day('2026-06-10'))
    const { startMs, endMs } = stockholmDayBounds('2026-06-10')
    expect(out.dayStart).toEqual(new Date(startMs))
    expect(out.dayEnd).toEqual(new Date(endMs))
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(0)
    expect(out.buckets[0]).toEqual(expected('2026-06-10', 0))
    expect(out.buckets[287]).toEqual(expected('2026-06-10', 1435))
  })

  test('spring-forward day: 276 buckets over 23 h, bucket starts continuous in UTC', () => {
    const out = buildDay(-1, day('2026-03-29'))
    expect(out.buckets).toHaveLength(276)
    expect(out.dayEnd.getTime() - out.dayStart.getTime()).toBe(23 * 3_600_000)
    expect(out.buckets.at(-1)).toEqual(expected('2026-03-29', 1375))
    const steps = new Set(
      out.buckets.slice(1).map((b, i) => +b.bucketStart - +out.buckets[i].bucketStart),
    )
    expect([...steps]).toEqual([300_000])
  })

  test('fall-back day: 300 buckets over 25 h', () => {
    const out = buildDay(-1, day('2025-10-26'))
    expect(out.buckets).toHaveLength(300)
    expect(out.dayEnd.getTime() - out.dayStart.getTime()).toBe(25 * 3_600_000)
    expect(out.buckets.at(-1)).toEqual(expected('2025-10-26', 1495))
  })

  test('a row at or past the next midnight is dropped and counted', () => {
    const extra = [...dayMinutes('2026-06-10'), 1440, 1445]
    const out = buildDay(
      -1,
      day('2026-06-10', { grid: extra, mppt: extra, usage: extra, battery: extra }),
    )
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(2)
  })

  test('rows past the next midnight on DST days are dropped (not a fixed 1440)', () => {
    const run = (date: string, extra: number[]) => {
      const mins = [...dayMinutes(date), ...extra]
      return buildDay(-1, day(date, { grid: mins, mppt: mins, usage: mins, battery: mins }))
    }
    const spring = run('2026-03-29', [1380, 1385])
    expect(spring.buckets).toHaveLength(276)
    expect(spring.droppedBuckets).toBe(2)
    const fall = run('2025-10-26', [1500])
    expect(fall.buckets).toHaveLength(300)
    expect(fall.droppedBuckets).toBe(1)
  })

  test('a bucket whose used columns are all 0 W is kept with 0 kWh', () => {
    const row = (name: SeriesName, m: number) =>
      m < 60 ? syntheticRow(name, m).map((v, i) => (i === 0 ? v : 0)) : syntheticRow(name, m)
    const out = buildDay(-1, day('2026-06-10', {}, row))
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(0)
    expect(out.buckets[0]).toEqual({
      bucketStart: out.dayStart,
      gridImportKwh: 0,
      gridExportKwh: 0,
      solarKwh: 0,
      loadKwh: 0,
      batteryDischargeKwh: 0,
      batteryChargeSolarKwh: 0,
      batteryChargeGridKwh: 0,
      batteryChargeAcKwh: 0,
    })
  })

  test('a negative value in an unused column keeps the bucket', () => {
    const row = (name: SeriesName, m: number) => {
      const r: unknown[] = syntheticRow(name, m)
      if (name === 'usage') r[1] = -1
      if (name === 'grid') r[4] = -5
      return r
    }
    const out = buildDay(-1, day('2026-06-10', {}, row))
    expect(out.buckets).toHaveLength(288)
    expect(out.droppedBuckets).toBe(0)
    expect(out.buckets[3]).toEqual(expected('2026-06-10', 15))
  })

  test('a gap in all four series is just absent; a bucket missing from one series is dropped', () => {
    const all = dayMinutes('2026-03-18')
    const gap = all.filter((m) => m < 180 || m >= 275) // the 95-min hole shape
    const out = buildDay(-1, day('2026-03-18', { grid: gap, mppt: gap, usage: gap, battery: gap }))
    expect(out.buckets).toHaveLength(gap.length)
    expect(out.droppedBuckets).toBe(0)

    const noUsageAt10 = all.filter((m) => m !== 10)
    const partial = buildDay(-1, day('2026-03-18', { usage: noUsageAt10 }))
    expect(partial.buckets).toHaveLength(287)
    expect(partial.buckets.map((b) => b.bucketStart)).not.toContainEqual(
      expected('2026-03-18', 10).bucketStart,
    )
    expect(partial.droppedBuckets).toBe(1)
  })

  test('today drops the still-filling newest bucket, from the earliest series newest on', () => {
    const upTo = (last: number) => dayMinutes('2026-10-03').filter((m) => m <= last)
    const same = buildDay(
      0,
      day('2026-10-03', { grid: upTo(430), mppt: upTo(430), usage: upTo(430), battery: upTo(430) }),
    )
    expect(same.buckets).toHaveLength(86)
    expect(same.buckets.at(-1)?.bucketStart).toEqual(expected('2026-10-03', 425).bucketStart)
    expect(same.droppedBuckets).toBe(1)

    // grid already has 435, usage only up to 425: 425 and everything after go.
    const ragged = buildDay(
      0,
      day('2026-10-03', { grid: upTo(435), mppt: upTo(430), usage: upTo(425), battery: upTo(430) }),
    )
    expect(ragged.buckets.at(-1)?.bucketStart).toEqual(expected('2026-10-03', 420).bucketStart)
    expect(ragged.droppedBuckets).toBe(3) // 425, 430, 435

    // Yesterday keeps its last bucket.
    expect(buildDay(-1, day('2026-10-02')).buckets).toHaveLength(288)
  })

  test('an empty day (far past, or today just after midnight) is no buckets', () => {
    const none = { grid: [], mppt: [], usage: [], battery: [] }
    expect(buildDay(-1100, day('2023-09-29', none))).toMatchObject({
      buckets: [],
      droppedBuckets: 0,
    })
    expect(buildDay(0, day('2026-10-03', none))).toMatchObject({ buckets: [], droppedBuckets: 0 })
  })

  test('a negative reading in a used column drops that bucket; unused columns may be anything', () => {
    const row = (name: SeriesName, m: number) => {
      const r: unknown[] = syntheticRow(name, m)
      if (name === 'battery' && m === 60) r[3] = -1
      // A negative emergency import must not hide inside the import sum.
      if (name === 'grid' && m === 65) r[2] = -1
      if (name === 'grid') r[4] = null // an unused column
      return r
    }
    const out = buildDay(-1, day('2026-06-10', {}, row))
    expect(out.buckets).toHaveLength(286)
    expect(out.droppedBuckets).toBe(2)
  })

  test('series that disagree on the day, or a day not starting at Stockholm midnight, are refused', () => {
    const mixed = { ...day('2026-06-10'), usage: day('2026-06-11').usage }
    unexpected(() => buildDay(-1, mixed), 'stats', 'disagree')
    const shifted = Object.fromEntries(
      Object.entries(day('2026-06-10')).map(([n, s]) => [
        n,
        { ...s, startTime: s.startTime + 3600 },
      ]),
    ) as ReturnType<typeof day>
    unexpected(() => buildDay(-1, shifted), 'stats', 'Stockholm midnight')
  })
})

describe('parseSeries', () => {
  const base = () => seriesDay('grid', '2026-06-10', [0, 5])

  test.each([
    ['timezone', { timezone: 'UTC' }, ['UTC']],
    ['interval', { interval: 15 }, ['15']],
    ['start_time', { start_time: '1781042400' }, ['1781042400']],
    ['start_time', { start_time: 33e9 }, ['33000000000']],
    ['data', { data: null }, []],
    [
      'data.1.0',
      {
        data: [
          [0, 1, 2, 3],
          [7, 1, 2, 3],
        ],
      },
      ['7'],
    ], // minute not on the 5-min grid
    ['data.0.3', { data: [[0, 1, 2]] }, []], // row too short
    ['data.0.1', { data: [[0, 'x', 2, 3]] }, ["'x'", '"x"']],
  ])('a wrong %s is unexpected_response naming the path, never the value', (at, patch, absent) => {
    unexpected(() => parseSeries('grid', { ...base(), ...patch }), 'stats', at, absent)
  })

  test.each([
    ['mppt', 'data.0.4', [0, 1, 2, 3]],
    ['usage', 'data.0.2', [0, 1]],
    ['battery', 'data.0.4', [0, 1, 2, 3]],
  ] as const)('a short %s row is unexpected_response at %s', (name, at, row) => {
    unexpected(
      () => parseSeries(name, { ...seriesDay(name, '2026-06-10', []), data: [row] }),
      'stats',
      at,
    )
  })

  test('a repeated minute is unexpected_response', () => {
    unexpected(
      () => parseSeries('usage', { ...seriesDay('usage', '2026-06-10', [0, 0]) }),
      'stats',
      'repeats',
    )
  })

  test('more than 400 rows is refused', () => {
    const rows = Array.from({ length: 401 }, (_, i) => i * 5)
    unexpected(() => parseSeries('mppt', seriesDay('mppt', '2026-06-10', rows)), 'stats', 'data')
  })
})

describe('envelope, login and discovery', () => {
  test('envelope needs an integer Status', () => {
    expect(parseEnvelope('stats', { Status: -12 })).toEqual({ Status: -12 })
    unexpected(() => parseEnvelope('stats', { Status: '1' }), 'stats', 'Status')
    unexpected(() => parseEnvelope('stats', []), 'stats', '(root)')
  })

  test('login needs a non-empty token', () => {
    expect(parseLogin({ token: 'abc', user_id: 'u' })).toBe('abc')
    unexpected(() => parseLogin({ token: '' }), 'login', 'token')
    unexpected(() => parseLogin({}), 'login', 'token')
  })

  test('homes and devices: lists may be null or missing; entries must carry ids', () => {
    expect(parseHomeIds({ list_homes: [{ home_id: 'a', name: 'x' }, { home_id: 'b' }] })).toEqual([
      'a',
      'b',
    ])
    expect(parseHomeIds({ list_homes: null })).toEqual([])
    expect(parseHomeIds({})).toEqual([])
    expect(parseDevices({ bmts: [{ id: 'd', model: 'm', name: 'n' }] })).toEqual([
      { deviceId: 'd', model: 'm' },
    ])
    expect(parseDevices({ bmts: null })).toEqual([])
    unexpected(
      () => parseHomeIds({ list_homes: [{ home_id: 7 }] }),
      'discover',
      'list_homes.0.home_id',
    )
    unexpected(() => parseDevices({ bmts: [{ id: 'd' }] }), 'discover', 'bmts.0.model')
  })
})
