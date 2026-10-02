import type { LatLon } from '~/lib/effects/skoda'

// Home geofence for live attribution (ADR-0022). The car's parked position is
// compared here, in memory, and only the boolean leaves this module — never the
// coordinates. Haversine is hand-rolled: a few lines, no geo library installed.

/** Generous for GPS while parked; the probe saw the car 5 m from the home point. */
export const HOME_RADIUS_M = 150
const EARTH_RADIUS_M = 6_371_000

/** `SKODA_HOME_COORDINATES` ("lat,lon", decimal degrees) → a point, or null when unset/invalid. */
export function parseHomePoint(raw: string | undefined): LatLon | null {
  const parts = raw?.split(',').map((p) => p.trim())
  if (parts?.length !== 2 || parts.some((p) => p === '')) return null
  // Accept only plain decimals (+ sign, digits, optional decimal point): reject hex/octal/exponential.
  const decimalRegex = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
  if (!parts.every((p) => decimalRegex.test(p))) return null
  const [latitude, longitude] = parts.map(Number)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  const rad = (deg: number) => (deg * Math.PI) / 180
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/**
 * Parked inside the radius → true; parked outside, or moving → false (a moving
 * car is not at our charger); no position, no home point or an unknown parking
 * state → null (the rule then falls back to plug state alone).
 */
export function atHome(
  parking: { state: string | null; position: LatLon | null } | null,
  home: LatLon | null,
): boolean | null {
  if (parking?.state === 'IN_MOTION') return false
  if (parking?.state !== 'PARKED' || !parking.position || !home) return null
  return distanceMeters(parking.position, home) <= HOME_RADIUS_M
}
