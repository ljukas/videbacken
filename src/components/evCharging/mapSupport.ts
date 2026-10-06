import type { LatLon } from '~/lib/effects/skoda'

// Kept out of HomePositionMap (the lazy chunk) so the picker can decide without
// loading it, and so browser tests can mock the check.

export type MapView = { center: LatLon; zoom: number }

/** No saved pin: Sweden at country zoom. */
export const SWEDEN_VIEW: MapView = { center: { latitude: 62.0, longitude: 15.0 }, zoom: 3.6 }
/** Opening on a saved pin. */
export const PIN_ZOOM = 16
/** After a search hit or "Använd min position". */
export const PICK_ZOOM = 17

let webgl2: boolean | undefined

/** MapLibre 6 needs WebGL2; without it its constructor throws. Checked once per page. */
export function supportsWebGL2(): boolean {
  if (webgl2 === undefined) {
    try {
      webgl2 = document.createElement('canvas').getContext('webgl2') !== null
    } catch {
      webgl2 = false
    }
  }
  return webgl2
}

/**
 * The only parts of a MapLibre error that may be logged. Its message carries the
 * failing tile's URL (a z/x/y cell about 1 km around the saved home), and the
 * browser logger forwards warnings to the server logs: never log the Error itself.
 */
export function mapErrorLogFields(error: unknown): { name: string; status?: number } {
  const e = (error ?? {}) as { name?: unknown; status?: unknown }
  const name = typeof e.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error'
  return typeof e.status === 'number' && Number.isFinite(e.status)
    ? { name, status: e.status }
    : { name }
}
