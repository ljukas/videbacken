import { describe, expect, test } from 'vitest'
import type { HeatPumpEventDto } from './events'
import { HEAT_PUMP_DAYS_MAX } from './period'
import {
  defaultEventId,
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
