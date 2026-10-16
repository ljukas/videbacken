import { describe, expect, test } from 'vitest'
import { addDays } from '~/lib/time/stockholm'
import type { HeatPumpEventDto } from './events'
import { HEAT_PUMP_DAYS_MAX } from './period'
import {
  defaultEventId,
  energySignature,
  eventsForUnit,
  qualifyingDays,
  type SignatureDay,
  selectedEventId,
  signatureChunks,
  signatureRange,
} from './signature'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'

// A complete, heating-only day: 24 of 24 hours, all heat, no cooling, ΔT = 21 − 5 = 16.
const day = (d: string, over: Partial<SignatureDay> = {}): SignatureDay => ({
  day: d,
  kwh: 10,
  heatKwh: 10,
  coolKwh: 0,
  insideC: 21,
  outsideC: 5,
  hours: 24,
  expectedHours: 24,
  ...over,
})
const event = (
  over: Partial<HeatPumpEventDto> & { id: string; occurredOn: string },
): HeatPumpEventDto => ({
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})
const none = new Set<string>()
const daysOf = (list: { day: string }[]) => list.map((d) => d.day)

describe('qualifyingDays', () => {
  test('a complete heating day qualifies, with ΔT = mean indoor − mean outdoor', () => {
    const [d] = qualifyingDays([day('2026-01-10', { insideC: 21.5, outsideC: -3.25 })], none)
    expect(d.deltaT).toBe(24.75)
    expect(d.kwh).toBe(10)
  })

  test('a missing hour fails the day', () => {
    expect(qualifyingDays([day('2026-01-10', { hours: 23 })], none)).toEqual([])
  })

  test('every hour of the Stockholm day, not just the expected ones: today and the DST days', () => {
    const days = [
      // Today at 10:00: 10 stored hours, and step 3 clips expectedHours to the newest stored hour.
      day('2026-10-08', { hours: 10, expectedHours: 10 }),
      // 2026-10-25 has 25 hours (DST ends).
      day('2026-10-25', { hours: 24, expectedHours: 24 }),
      day('2026-10-26', { hours: 24, expectedHours: 24 }),
      // 2026-03-29 has 23 hours (DST starts).
      day('2026-03-29', { hours: 23, expectedHours: 23 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-10-26', '2026-03-29'])
    expect(
      daysOf(qualifyingDays([day('2026-10-25', { hours: 25, expectedHours: 25 })], none)),
    ).toEqual(['2026-10-25'])
  })

  test('cooling up to 2 % of the day is allowed, more is not', () => {
    const days = [
      day('2026-04-01', { kwh: 10, heatKwh: 9.8, coolKwh: 0.2 }),
      day('2026-04-02', { kwh: 10, heatKwh: 9.79, coolKwh: 0.21 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-04-01'])
  })

  test('a unit switched off is not a heating day; one idling in heat mode is', () => {
    const days = [
      // Off all day: standby only, heat share 0, though it is 8 °C colder outside.
      day('2026-01-10', { kwh: 0.65, heatKwh: 0, insideC: 21, outsideC: 13 }),
      // On in heat mode, barely working: heat share 1.
      day('2026-01-11', { kwh: 0.7, heatKwh: 0.7, insideC: 21, outsideC: 13 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-01-11'])
  })

  test('heating must be at least half of the day; a day with no kWh has no share', () => {
    const days = [
      day('2026-01-10', { kwh: 10, heatKwh: 5 }),
      day('2026-01-11', { kwh: 10, heatKwh: 4.9 }),
      day('2026-01-12', { kwh: 0, heatKwh: 0 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-01-10'])
  })

  test('a day without an indoor or outdoor mean does not qualify', () => {
    const days = [day('2026-01-10', { insideC: null }), day('2026-01-11', { outsideC: null })]
    expect(qualifyingDays(days, none)).toEqual([])
  })

  test('ΔT must be at least 3 °C', () => {
    const days = [
      day('2026-05-01', { insideC: 21, outsideC: 18 }),
      day('2026-05-02', { insideC: 21, outsideC: 18.25 }),
    ]
    expect(daysOf(qualifyingDays(days, none))).toEqual(['2026-05-01'])
  })

  test('an event day does not qualify; the input order is kept', () => {
    const days = [day('2026-01-12'), day('2026-01-10'), day('2026-01-11')]
    expect(daysOf(qualifyingDays(days, new Set(['2026-01-11'])))).toEqual([
      '2026-01-12',
      '2026-01-10',
    ])
  })
})

describe('events for a unit', () => {
  const events = [
    event({ id: 'b', occurredOn: '2026-10-08' }), // Båda
    event({ id: 'o', occurredOn: '2026-09-01', heatPumpId: OVER, kind: 'filter' }),
    event({ id: 'm', occurredOn: '2026-03-15', heatPumpId: MATSAL, kind: 'filter' }),
  ]

  test('its own and Båda, oldest first; the other unit’s are left out', () => {
    expect(eventsForUnit(events, MATSAL).map((e) => e.id)).toEqual(['m', 'b'])
    expect(eventsForUnit(events, OVER).map((e) => e.id)).toEqual(['o', 'b'])
  })

  test('the default is the latest service, even with a later event of another kind', () => {
    const later = [
      ...events,
      event({ id: 'f', occurredOn: '2026-10-20', heatPumpId: MATSAL, kind: 'filter' }),
    ]
    expect(defaultEventId(later, MATSAL)).toBe('b')
  })

  test('without a service, the latest event; without events, null', () => {
    const noService = events.filter((e) => e.kind !== 'service')
    expect(defaultEventId(noService, MATSAL)).toBe('m')
    expect(defaultEventId(noService, 'hp-third')).toBeNull()
  })

  test('the other unit’s service is not a default', () => {
    const own = [event({ id: 's-o', occurredOn: '2026-10-01', heatPumpId: OVER })]
    expect(defaultEventId(own, MATSAL)).toBeNull()
  })

  test('the chosen event when it applies to the unit, else the unit’s default', () => {
    expect(selectedEventId(events, MATSAL, 'm')).toBe('m')
    expect(selectedEventId(events, OVER, 'm')).toBe('b') // Matsal's filter, Övervåning shown
    expect(selectedEventId(events, MATSAL, null)).toBe('b')
    expect(selectedEventId(events, MATSAL, 'gone')).toBe('b')
    expect(selectedEventId([], MATSAL, null)).toBeNull()
  })
})

describe('the fetch range', () => {
  const service = event({ id: 'svc', occurredOn: '2026-01-20' })
  const range = (events: HeatPumpEventDto[], firstReadingDay: string | null, heatPumpId = MATSAL) =>
    signatureRange({ events, heatPumpId, eventId: 'svc', firstReadingDay, today: '2026-02-10' })

  test('400 days before the event to today', () => {
    // 2026-01-20 − 400 days = 2024-12-16.
    expect(range([service], '2024-10-31')).toEqual({ from: '2024-12-16', to: '2026-02-10' })
    expect(range([service], null)).toEqual({ from: '2024-12-16', to: '2026-02-10' })
  })

  test('not before the first reading', () => {
    expect(range([service], '2025-06-01')).toEqual({ from: '2025-06-01', to: '2026-02-10' })
  })

  test('up to the unit’s next event; the other unit’s next event is ignored', () => {
    const next = event({ id: 'set', occurredOn: '2026-01-28', kind: 'setting' })
    const theirs = event({ id: 'ov', occurredOn: '2026-01-25', heatPumpId: OVER, kind: 'filter' })
    expect(range([service, theirs, next], null).to).toBe('2026-01-28')
    expect(range([service, theirs], null).to).toBe('2026-02-10')
  })

  test('chunks of at most HEAT_PUMP_DAYS_MAX days, consecutive, covering the range', () => {
    expect(HEAT_PUMP_DAYS_MAX).toBe(800)
    expect(signatureChunks('2024-12-16', '2026-02-10')).toEqual([
      { from: '2024-12-16', to: '2026-02-10' },
    ])
    // 1 700 days: 800 + 800 + 100.
    expect(signatureChunks('2022-01-01', '2026-08-27')).toEqual([
      { from: '2022-01-01', to: '2024-03-10' },
      { from: '2024-03-11', to: '2026-05-19' },
      { from: '2026-05-20', to: '2026-08-27' },
    ])
    expect(signatureChunks('2026-01-01', '2026-01-01')).toEqual([
      { from: '2026-01-01', to: '2026-01-01' },
    ])
    expect(signatureChunks('2026-01-02', '2026-01-01')).toEqual([])
  })
})

// A complete heating day (all heat) with ΔT exactly `deltaT` (21 − (21 − ΔT), exact for integers and halves).
const at = (d: string, deltaT: number, kwh: number): SignatureDay =>
  day(d, { insideC: 21, outsideC: 21 - deltaT, kwh, heatKwh: kwh })
const run = (start: string, values: [number, number][]) =>
  values.map(([deltaT, kwh], i) => at(addDays(start, i), deltaT, kwh))

// The before set: 16 days (2026-01-04 … 01-19), ΔT 4 … 19, kWh = 2 + 0,5·ΔT + e with
// e = +0,1, −0,1, −0,1, +0,1 repeating. Each block of four has Σe = 0 and Σ ΔT·e = 0,
// so the OLS line is exactly a = 2, b = 0,5 and every residual is ±0,1:
// Σ residual² = 16 × 0,01 = 0,16, s = √(0,16 ÷ (16 − 2)).
const NOISE = [0.1, -0.1, -0.1, 0.1]
const BEFORE = run(
  '2026-01-04',
  Array.from({ length: 16 }, (_, i): [number, number] => [4 + i, 2 + 0.5 * (4 + i) + NOISE[i % 4]]),
)
// The after set: 14 days (2026-01-21 … 02-03), ΔT 5 … 18, each exactly 90 % of the
// prediction. Σ predicted = 14 × 2 + 0,5 × Σ(5…18) = 28 + 0,5 × 161 = 108,5; Σ actual = 97,65.
const AFTER = run(
  '2026-01-21',
  Array.from({ length: 14 }, (_, i): [number, number] => [5 + i, 0.9 * (2 + 0.5 * (5 + i))]),
)
const SERVICE = event({ id: 'svc', occurredOn: '2026-01-20' }) // Båda
const sig = (days: SignatureDay[], events: HeatPumpEventDto[] = [SERVICE], eventId = 'svc') =>
  energySignature({ days, events, heatPumpId: MATSAL, eventId })
const pointDays = (r: { points: { day: string; set: string }[] }, set: 'before' | 'after') =>
  r.points.filter((p) => p.set === set).map((p) => p.day)

describe('energySignature', () => {
  test('the fit, the change and the margin on known data', () => {
    const r = sig([...BEFORE, ...AFTER])
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.fit.a).toBeCloseTo(2, 10)
    expect(r.fit.b).toBeCloseTo(0.5, 10)
    expect(r.change).toBeCloseTo(-0.1, 10)
    // s·√n = √(0,16 ÷ 14) × √14 = √0,16 = 0,4.
    expect(r.margin).toBeCloseTo((1.96 * 0.4) / 108.5, 10)
    // n − 2, not n − 1: the n − 1 margin would be 1,96 × √(0,16 ÷ 15) × √14 ÷ 108,5.
    expect(r.margin).not.toBeCloseTo((1.96 * Math.sqrt(0.16 / 15) * Math.sqrt(14)) / 108.5, 6)
    expect(r.beforeDays).toBe(16)
    expect(r.afterDays).toBe(14)
    // The after-days are 1,8 + 0,45·ΔT exactly.
    expect(r.afterFit?.a).toBeCloseTo(1.8, 10)
    expect(r.afterFit?.b).toBeCloseTo(0.45, 10)
    expect(pointDays(r, 'before')).toEqual(BEFORE.map((d) => d.day))
    expect(pointDays(r, 'after')).toEqual(AFTER.map((d) => d.day))
    expect(r.points.every((p) => !p.extrapolated)).toBe(true)
  })

  test('after-days outside the before ΔT range are flagged and left out; its edges count', () => {
    const extra = [
      at('2026-02-04', 20, 9), // above 19
      at('2026-02-05', 3.5, 3), // below 4
      at('2026-02-06', 19, 0.9 * (2 + 0.5 * 19)), // on the edge: counted
    ]
    const r = sig([...BEFORE, ...AFTER, ...extra])
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.afterDays).toBe(15)
    expect(r.change).toBeCloseTo(-0.1, 10) // every counted day is still 90 % of its prediction
    const flagged = r.points.filter((p) => p.extrapolated).map((p) => p.day)
    expect(flagged).toEqual(['2026-02-04', '2026-02-05'])
  })

  test('an off day after the event is no point at all', () => {
    const off = day('2026-02-04', { kwh: 0.65, heatKwh: 0, insideC: 21, outsideC: 13 })
    const r = sig([...BEFORE, ...AFTER, off])
    expect(r).toMatchObject({ state: 'ok', afterDays: 14 })
    expect(r.points.some((p) => p.day === '2026-02-04')).toBe(false)
  })

  test('fewer than 14 counted after-days: not_enough_after with the count', () => {
    const r = sig([...BEFORE, ...AFTER.slice(0, 13), at('2026-02-04', 25, 9)])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 13, needed: 14 })
    if (r.state !== 'not_enough_after') return
    expect(r.fit.a).toBeCloseTo(2, 10)
    expect(r.points.filter((p) => p.extrapolated)).toHaveLength(1)
  })

  test('a summer after a winter event: every after-day outside the range counts 0', () => {
    const summer = run(
      '2026-01-21',
      Array.from({ length: 14 }, (): [number, number] => [25, 12]),
    )
    const r = sig([...BEFORE, ...summer])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 0 })
    expect(r.points.filter((p) => p.set === 'after' && p.extrapolated)).toHaveLength(14)
  })

  test('fewer than 14 before-days: not_enough_before with the count, points still drawn', () => {
    const r = sig([...BEFORE.slice(-13), ...AFTER])
    expect(r).toMatchObject({ state: 'not_enough_before', before: 13 })
    expect(r.points).toHaveLength(27)
    // The 13 before-days span ΔT 7 … 19: the after-days at ΔT 5 and 6 lie outside.
    expect(r.points.filter((p) => p.extrapolated).map((p) => p.deltaT)).toEqual([5, 6])
  })

  test('before-days spanning less than 4 °C: not_enough_before', () => {
    // 19 days (2026-01-01 … 01-19), ΔT 10 … 13,5.
    const narrow = run(
      '2026-01-01',
      Array.from({ length: 19 }, (_, i): [number, number] => [10 + (i % 8) * 0.5, 7]),
    )
    expect(sig([...narrow, ...AFTER])).toMatchObject({ state: 'not_enough_before', before: 19 })
  })

  test('the before set starts after the previous event for the unit', () => {
    const filter = event({
      id: 'flt',
      occurredOn: '2026-01-10',
      heatPumpId: MATSAL,
      kind: 'filter',
    })
    const r = sig([...BEFORE, ...AFTER], [filter, SERVICE])
    // 01-11 … 01-19: the filter day itself is an event day.
    expect(r).toMatchObject({ state: 'not_enough_before', before: 9 })
    expect(pointDays(r, 'before')).toEqual(BEFORE.slice(7).map((d) => d.day))
  })

  test('the other unit’s event neither cuts the window nor drops its day; a Båda event does both', () => {
    const theirs = event({ id: 'ov', occurredOn: '2026-01-10', heatPumpId: OVER, kind: 'filter' })
    const r = sig([...BEFORE, ...AFTER], [theirs, SERVICE])
    expect(r.state).toBe('ok')
    if (r.state === 'ok') expect(r.beforeDays).toBe(16)
    const both = event({ id: 'both', occurredOn: '2026-01-10', kind: 'setting' })
    expect(sig([...BEFORE, ...AFTER], [both, SERVICE])).toMatchObject({
      state: 'not_enough_before',
      before: 9,
    })
  })

  test('the after set ends before the next event; the next event’s day is out', () => {
    const next = event({ id: 'set', occurredOn: '2026-01-28', kind: 'setting' })
    const r = sig([...BEFORE, ...AFTER], [SERVICE, next])
    expect(r).toMatchObject({ state: 'not_enough_after', after: 7 })
    expect(pointDays(r, 'after')).toEqual(AFTER.slice(0, 7).map((d) => d.day))
  })

  test('two events on the same day: neither cuts the other’s window', () => {
    const sameDay = event({
      id: 'flt-same',
      occurredOn: '2026-01-20',
      heatPumpId: MATSAL,
      kind: 'filter',
    })
    for (const id of ['svc', 'flt-same']) {
      const r = sig([...BEFORE, ...AFTER], [SERVICE, sameDay], id)
      expect(r).toMatchObject({ state: 'ok', beforeDays: 16, afterDays: 14 })
    }
  })

  test('only the latest 90 qualifying before-days', () => {
    // 100 days, 2025-11-21 … 2026-02-28, before an event on 2026-03-01.
    const long = run(
      '2025-11-21',
      Array.from({ length: 100 }, (_, i): [number, number] => [
        4 + (i % 16),
        2 + 0.5 * (4 + (i % 16)),
      ]),
    )
    const march = event({ id: 'mar', occurredOn: '2026-03-01' })
    const r = sig(long, [march], 'mar')
    expect(r.state).toBe('not_enough_after')
    const before = pointDays(r, 'before')
    expect(before).toHaveLength(90)
    expect(before[0]).toBe('2025-12-01')
    expect(before.at(-1)).toBe('2026-02-28')
  })

  test('a before line that predicts no consumption over the after-days gives no ratio', () => {
    // 14 days, ΔT 4 … 17, 0,1 kWh each but 50 at ΔT 17: a ≈ −11,31, b ≈ 1,43; at ΔT 4 the line is ≈ −5,6.
    const skewed = run(
      '2026-01-06',
      Array.from({ length: 14 }, (_, i): [number, number] => [4 + i, i === 13 ? 50 : 0.1]),
    )
    const low = run(
      '2026-01-21',
      Array.from({ length: 14 }, (): [number, number] => [4, 1]),
    )
    expect(sig([...skewed, ...low])).toMatchObject({ state: 'not_enough_before', before: 14 })
  })

  test('an event that does not exist or belongs to the other unit throws', () => {
    const theirs = event({ id: 'ov', occurredOn: '2026-01-20', heatPumpId: OVER })
    expect(() => sig(BEFORE, [SERVICE], 'nope')).toThrow(RangeError)
    expect(() => sig(BEFORE, [theirs], 'ov')).toThrow(RangeError)
  })
})
