import { describe, expect, test } from 'vitest'
import {
  dayEventMarkers,
  HEAT_PUMP_EVENT_KINDS,
  HEAT_PUMP_EVENT_NOTE_MAX,
  type HeatPumpEventDto,
  isHeatPumpEventKind,
  normalizeNote,
  noteLength,
} from './events'

const MATSAL = '11111111-1111-4111-8111-111111111111'
const UPSTAIRS = '22222222-2222-4222-8222-222222222222'
const ev = (over: Partial<HeatPumpEventDto>): HeatPumpEventDto => ({
  id: crypto.randomUUID(),
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})

test('the kinds are the four the spec names, and the guard knows them', () => {
  expect(HEAT_PUMP_EVENT_KINDS).toEqual(['service', 'filter', 'setting', 'other'])
  expect(isHeatPumpEventKind('filter')).toBe(true)
  expect(isHeatPumpEventKind('repair')).toBe(false)
})

describe('notes', () => {
  test('length counts characters (code points), not UTF-16 units', () => {
    expect(noteLength('å')).toBe(1)
    expect(noteLength('🙂')).toBe(1)
    expect(noteLength(`${'å'.repeat(HEAT_PUMP_EVENT_NOTE_MAX - 1)}🙂`)).toBe(500)
  })
  test('a note is trimmed, and a blank one is no note', () => {
    expect(normalizeNote('  Årlig service \n')).toBe('Årlig service')
    expect(normalizeNote('   ')).toBeNull()
    expect(normalizeNote('')).toBeNull()
    expect(normalizeNote(null)).toBeNull()
    expect(normalizeNote(undefined)).toBeNull()
  })
})

describe('dayEventMarkers', () => {
  test('one marker per day and unit; both units first, then units in the given order', () => {
    const markers = dayEventMarkers(
      [
        ev({ heatPumpId: UPSTAIRS, kind: 'filter' }),
        ev({ heatPumpId: MATSAL, kind: 'setting' }),
        ev({ heatPumpId: null, kind: 'service' }),
        ev({ heatPumpId: MATSAL, kind: 'other' }),
      ],
      [MATSAL, UPSTAIRS],
    )
    expect(markers.get('2026-10-08')).toEqual([
      { day: '2026-10-08', heatPumpId: null, kinds: ['service'], notes: [] },
      { day: '2026-10-08', heatPumpId: MATSAL, kinds: ['setting', 'other'], notes: [] },
      { day: '2026-10-08', heatPumpId: UPSTAIRS, kinds: ['filter'], notes: [] },
    ])
  })
  test('a kind logged twice on the same day and unit is listed once', () => {
    const markers = dayEventMarkers([ev({ kind: 'service' }), ev({ kind: 'service' })], [MATSAL])
    expect(markers.get('2026-10-08')).toEqual([
      { day: '2026-10-08', heatPumpId: null, kinds: ['service'], notes: [] },
    ])
  })
  test("a marker carries its events' notes, in the events' order, each one (no blanks)", () => {
    const markers = dayEventMarkers(
      [
        ev({ kind: 'service', note: 'Årlig service' }),
        ev({ kind: 'filter', note: null }),
        ev({ kind: 'service', note: 'Bytte filter' }),
        ev({ heatPumpId: MATSAL, kind: 'setting', note: '21 °C' }),
      ],
      [MATSAL],
    )
    expect(markers.get('2026-10-08')?.map((mk) => mk.notes)).toEqual([
      ['Årlig service', 'Bytte filter'],
      ['21 °C'],
    ])
  })
  test('an event for a unit the chart does not show draws nothing', () => {
    const markers = dayEventMarkers([ev({ heatPumpId: UPSTAIRS })], [MATSAL])
    expect(markers.size).toBe(0)
  })
  // Review Focus 5: keyed by calendar-day strings, never Dates, so the DST day and a UTC test
  // runner give the same key.
  test('markers are keyed by calendar day strings', () => {
    const markers = dayEventMarkers(
      [ev({ occurredOn: '2026-10-25' }), ev({ occurredOn: '2026-03-29' })],
      [MATSAL],
    )
    expect([...markers.keys()].sort()).toEqual(['2026-03-29', '2026-10-25'])
  })
})
