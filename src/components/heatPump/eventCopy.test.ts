import { expect, test } from 'vitest'
import { HEAT_PUMP_EVENT_KINDS } from '~/lib/heatPump/events'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { eventKindLabel, eventUnitLabel } from './eventCopy'

const TWO = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]

test('every kind has its Swedish label', () => {
  expect(HEAT_PUMP_EVENT_KINDS.map(eventKindLabel)).toEqual([
    'Service',
    'Filterrengöring',
    'Inställning',
    'Annat',
  ])
})

test('a unit event names the unit; every unit is "Båda" with two, "Alla" otherwise', () => {
  expect(eventUnitLabel('b', TWO)).toBe('Övervåning')
  expect(eventUnitLabel(null, TWO)).toBe(m.heat_pump_event_unit_both())
  expect(eventUnitLabel(null, [...TWO, { id: 'c', name: 'Vind' }])).toBe(
    m.heat_pump_event_unit_all(),
  )
  expect(eventUnitLabel(null, [])).toBe(m.heat_pump_event_unit_all())
  expect(eventUnitLabel('zzz', TWO)).toBe(m.heat_pump_event_unit_unknown())
})

test('every event error code has its own message', () => {
  const codes = ['UNKNOWN_HEAT_PUMP', 'FUTURE_DATE', 'EVENT_NOT_FOUND', 'NOTE_TOO_LONG'] as const
  const messages = codes.map(heatPumpEventErrorMessage)
  expect(new Set(messages).size).toBe(codes.length)
  expect(heatPumpEventErrorMessage('FUTURE_DATE')).toBe(m.heat_pump_event_error_future())
})
