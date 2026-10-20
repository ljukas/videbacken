import { expect, test } from 'vitest'
import type { SensorAlertEventDto, SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import {
  alertCountHint,
  alertEventPeriod,
  alertRuleDescription,
  formatAlertSince,
} from './alertRuleCopy'

// A no-break space keeps a value on one line with its unit (and "≈" with its number).
const NB = ' '

test.each([
  // Both ends in minutes while the longer end is under two hours…
  [30, 2, `≈${NB}30–60${NB}min för Förråd`],
  [40, 2, `≈${NB}40–80${NB}min för Förråd`],
  // …else both in whole hours.
  [60, 2, `≈${NB}1–2${NB}timmar för Förråd`],
  [120, 2, `≈${NB}2–4${NB}timmar för Förråd`],
  [120, 3, `≈${NB}4–6${NB}timmar för Förråd`],
  // Ends that round alike collapse to one number.
  [12, 10, `≈${NB}2${NB}timmar för Förråd`],
])('a %i-minute gap, %i in a row: "%s"', (gap, count, hint) => {
  expect(alertCountHint(count, gap, 'Förråd')).toBe(hint)
})

test('no typical gap: no hint', () => {
  expect(alertCountHint(2, null, 'Förråd')).toBeNull()
  expect(alertCountHint(2, 0, 'Förråd')).toBeNull()
})

const rule = (over: Partial<SensorAlertRuleDto>): SensorAlertRuleDto => ({
  id: 'r',
  deviceId: 'd',
  kind: 'temperature',
  enabled: true,
  direction: 'below',
  threshold: 4.5,
  count: 2,
  silenceHours: null,
  ...over,
})

test('a description keeps each value with its unit', () => {
  expect(alertRuleDescription(rule({}))).toBe(`Temperatur under 4,5${NB}°C · 2 mätningar`)
  expect(alertRuleDescription(rule({ direction: 'above', threshold: -3 }))).toBe(
    `Temperatur över −3${NB}°C · 2 mätningar`,
  )
  expect(alertRuleDescription(rule({ kind: 'humidity', direction: 'above', threshold: 80 }))).toBe(
    `Luftfuktighet över 80${NB}% · 2 mätningar`,
  )
  expect(alertRuleDescription(rule({ kind: 'battery', direction: null, threshold: 20 }))).toBe(
    `Batteri under 20${NB}% · 2 mätningar`,
  )
  expect(
    alertRuleDescription(
      rule({ kind: 'silence', direction: null, threshold: null, count: null, silenceHours: 6 }),
    ),
  ).toBe(`Tyst i 6${NB}h`)
})

test('the bell label counts its rules in the singular and the plural', () => {
  expect(m.sensors_alerts_open_named_count({ name: 'Förråd', count: 1 })).toBe(
    'Larm för Förråd, 1 aktivt',
  )
  expect(m.sensors_alerts_open_named_count({ name: 'Förråd', count: 2 })).toBe(
    'Larm för Förråd, 2 aktiva',
  )
  expect(m.sensors_alerts_open_named_count({ name: 'Garage', count: 1 }, { locale: 'en' })).toBe(
    'Alerts for Garage, 1 active',
  )
})

test('the bell label says how many rules fire now', () => {
  expect(m.sensors_alerts_open_named_firing({ name: 'Förråd', count: 1 })).toBe(
    'Larm för Förråd, 1 larmar nu',
  )
  expect(m.sensors_alerts_open_named_firing({ name: 'Garage', count: 2 }, { locale: 'en' })).toBe(
    'Alerts for Garage, 2 firing now',
  )
})

// 12:00 in Stockholm (CEST): the machine's own zone (Stockholm locally, UTC in CI) plays no part.
const NOW = new Date('2026-10-20T10:00:00Z')

test('"since" is the time today and the day and time before today, in Stockholm', () => {
  expect(formatAlertSince(new Date('2026-10-20T01:10:00Z'), NOW)).toBe('03:10')
  // 00:30 on the 20th in Stockholm is still today, though it is the 19th in UTC.
  expect(formatAlertSince(new Date('2026-10-19T22:30:00Z'), NOW)).toBe('00:30')
  expect(formatAlertSince(new Date('2026-10-19T20:00:00Z'), NOW)).toBe('19 okt. 22:00')
  expect(formatAlertSince(new Date('2025-10-19T20:00:00Z'), NOW)).toBe('19 okt. 2025 22:00')
})

const event = (over: Partial<SensorAlertEventDto>): SensorAlertEventDto => ({
  id: 'e',
  kind: 'temperature',
  direction: 'below',
  threshold: 5,
  count: 2,
  silenceHours: null,
  startedAt: new Date('2026-10-19T20:00:00Z'),
  endedAt: new Date('2026-10-19T21:30:00Z'),
  endReason: 'recovered',
  ...over,
})

test('a period: the end time alone on the same Stockholm day, then the duration', () => {
  expect(alertEventPeriod(event({}), NOW)).toBe('19 okt. 22:00 – 23:30 · 1 h 30 min')
  expect(alertEventPeriod(event({ endedAt: new Date('2026-10-20T01:10:00Z') }), NOW)).toBe(
    '19 okt. 22:00 – 20 okt. 03:10 · 5 h 10 min',
  )
})

test('a period outside the current Stockholm year shows its year on each date', () => {
  expect(
    alertEventPeriod(
      event({
        startedAt: new Date('2025-12-31T20:00:00Z'),
        endedAt: new Date('2026-01-01T01:00:00Z'),
      }),
      NOW,
    ),
  ).toBe('31 dec. 2025 21:00 – 1 jan. 02:00 · 5 h')
})

test('an open alert is ongoing; a quiet end says why', () => {
  expect(alertEventPeriod(event({ endedAt: null, endReason: null }), NOW)).toBe(
    '19 okt. 22:00 – pågår',
  )
  expect(alertEventPeriod(event({ endReason: 'paused' }), NOW)).toBe(
    '19 okt. 22:00 – 23:30 · 1 h 30 min · avslutad (pausad)',
  )
  expect(alertEventPeriod(event({ endReason: 'edited' }), NOW)).toBe(
    '19 okt. 22:00 – 23:30 · 1 h 30 min · avslutad (ändrad)',
  )
  expect(alertEventPeriod(event({ endReason: 'deleted' }), NOW)).toBe(
    '19 okt. 22:00 – 23:30 · 1 h 30 min · avslutad (borttaget)',
  )
})

test('a history entry describes the rule as it was', () => {
  expect(alertRuleDescription(event({}))).toBe(`Temperatur under 5${NB}°C · 2 mätningar`)
})
