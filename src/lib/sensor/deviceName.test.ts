import { expect, test } from 'vitest'
import { fallbackSensorName, formatMac, sensorDisplayName } from './deviceName'

test('the fallback is the Shelly name, else "Sensor" and the last four of the MAC', () => {
  expect(fallbackSensorName('Källare NV', 'aabbccddeeff')).toBe('Källare NV')
  expect(fallbackSensorName(null, 'aabbccddeeff')).toBe('Sensor eeff')
})

test('the display name is the own name first, then the fallback', () => {
  expect(sensorDisplayName('Under köket', 'Källare NV', 'aabbccddeeff')).toBe('Under köket')
  expect(sensorDisplayName(null, 'Källare NV', 'aabbccddeeff')).toBe('Källare NV')
  expect(sensorDisplayName(null, null, 'aabbccddeeff')).toBe('Sensor eeff')
})

test('a MAC reads as upper-case pairs joined by colons', () => {
  expect(formatMac('aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF')
  expect(formatMac('a4cf12ab34cd')).toBe('A4:CF:12:AB:34:CD')
})

test('a MAC that is not 12 hex digits is shown as it is, upper-cased', () => {
  expect(formatMac('abc')).toBe('ABC')
})
