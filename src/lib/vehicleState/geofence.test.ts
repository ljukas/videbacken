import { expect, test } from 'vitest'
import { atHome, distanceMeters, formatHomePoint, HOME_RADIUS_M, parseHomePoint } from './geofence'

const HOME = { latitude: 59.3293, longitude: 18.0686 } // central Stockholm, not a real home

test('parseHomePoint reads "lat,lon" with optional spaces', () => {
  expect(parseHomePoint('59.3293,18.0686')).toEqual(HOME)
  expect(parseHomePoint(' 59.3293 , 18.0686 ')).toEqual(HOME)
})

test('parseHomePoint rejects blank, malformed and out-of-range values', () => {
  for (const raw of [
    undefined,
    '',
    'abc',
    '59.3',
    '59.3,18.0,1',
    '91,18',
    '59,181',
    'NaN,18',
    ',18',
    '0x10,18', // hex
    '0b11,18', // binary
    '59,0o7', // octal
    '59e0,18', // exponent
    '1e2,18', // exponent
    'Infinity,18',
    '59,abc', // non-finite longitude
    '-91,18', // latitude out of range
    '59,-181', // longitude out of range
  ]) {
    expect(parseHomePoint(raw)).toBeNull()
  }
})

test('parseHomePoint accepts leading +/- and leading decimal point', () => {
  expect(parseHomePoint('+59,18')).toEqual({ latitude: 59, longitude: 18 })
  expect(parseHomePoint('-33.9,151.2')).toEqual({ latitude: -33.9, longitude: 151.2 })
  expect(parseHomePoint('.5,.5')).toEqual({ latitude: 0.5, longitude: 0.5 })
})

test('parseHomePoint accepts inclusive latitude and longitude limits', () => {
  expect(parseHomePoint('90,180')).toEqual({ latitude: 90, longitude: 180 })
  expect(parseHomePoint('-90,-180')).toEqual({ latitude: -90, longitude: -180 })
})

test('distanceMeters is ~111 km per degree of latitude and 0 for the same point', () => {
  expect(distanceMeters(HOME, HOME)).toBe(0)
  const north = { latitude: HOME.latitude + 1, longitude: HOME.longitude }
  expect(distanceMeters(HOME, north)).toBeGreaterThan(110_000)
  expect(distanceMeters(HOME, north)).toBeLessThan(112_000)
})

test('distanceMeters scales correctly by longitude and respects cos(lat)', () => {
  // 0.001 degree longitude change at ~59°N ≈ 56–57.5 m (cos scaling factor)
  const east = { latitude: HOME.latitude, longitude: HOME.longitude + 0.001 }
  expect(distanceMeters(HOME, east)).toBeGreaterThan(56)
  expect(distanceMeters(HOME, east)).toBeLessThan(58)
})

test('distanceMeters is symmetric', () => {
  const other = { latitude: HOME.latitude + 0.001, longitude: HOME.longitude + 0.001 }
  expect(distanceMeters(HOME, other)).toBe(distanceMeters(other, HOME))
})

test('distanceMeters handles negative deltas (west/south)', () => {
  const southwest = { latitude: HOME.latitude - 0.001, longitude: HOME.longitude - 0.001 }
  expect(distanceMeters(HOME, southwest)).toBeGreaterThan(100) // ≈156 m (diagonal)
  expect(distanceMeters(HOME, southwest)).toBeLessThan(200)
})

test('HOME_RADIUS_M is pinned to 150 m', () => {
  expect(HOME_RADIUS_M).toBe(150)
  // ≈149 m north (latitude offset 149/111195 ≈ 0.00134°) → inside
  const inside = { latitude: HOME.latitude + 149 / 111195, longitude: HOME.longitude }
  expect(atHome({ state: 'PARKED', position: inside }, HOME)).toBe(true)
  // ≈151 m north → outside
  const outside = { latitude: HOME.latitude + 151 / 111195, longitude: HOME.longitude }
  expect(atHome({ state: 'PARKED', position: outside }, HOME)).toBe(false)
})

test('atHome with longitude delta (≈113 m → true, ≈227 m → false)', () => {
  const insideLon = { latitude: HOME.latitude, longitude: HOME.longitude + 0.002 } // ≈113 m
  expect(atHome({ state: 'PARKED', position: insideLon }, HOME)).toBe(true)
  const outsideLon = { latitude: HOME.latitude, longitude: HOME.longitude + 0.004 } // ≈227 m
  expect(atHome({ state: 'PARKED', position: outsideLon }, HOME)).toBe(false)
})

test('parked inside the radius is home; outside is not', () => {
  const near = { latitude: HOME.latitude + 0.001, longitude: HOME.longitude } // ≈ 111 m
  const far = { latitude: HOME.latitude + 0.002, longitude: HOME.longitude } // ≈ 222 m
  expect(distanceMeters(HOME, near)).toBeLessThan(HOME_RADIUS_M)
  expect(atHome({ state: 'PARKED', position: near }, HOME)).toBe(true)
  expect(atHome({ state: 'PARKED', position: far }, HOME)).toBe(false)
})

test('moving is never home, wherever it is', () => {
  expect(atHome({ state: 'IN_MOTION', position: null }, HOME)).toBe(false)
  expect(atHome({ state: 'IN_MOTION', position: HOME }, HOME)).toBe(false)
})

test('unknown when there is no position, no home point, or an unknown parking state', () => {
  expect(atHome(null, HOME)).toBeNull()
  expect(atHome({ state: 'PARKED', position: null }, HOME)).toBeNull()
  expect(atHome({ state: 'PARKED', position: HOME }, null)).toBeNull()
  expect(atHome({ state: 'SOMETHING_NEW', position: HOME }, HOME)).toBeNull()
  expect(atHome({ state: null, position: HOME }, HOME)).toBeNull()
})

test('formatHomePoint rounds to five decimals and round-trips through parseHomePoint', () => {
  expect(formatHomePoint({ latitude: 57.123456789, longitude: 11.987654321 })).toBe(
    '57.12346,11.98765',
  )
  expect(formatHomePoint({ latitude: -0.000001, longitude: 180 })).toBe('-0.00000,180.00000')
  expect(parseHomePoint(formatHomePoint(HOME))).toEqual(HOME)
})
