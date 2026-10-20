import { expect, test } from 'vitest'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { alertCountHint, alertRuleDescription } from './alertRuleCopy'

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
