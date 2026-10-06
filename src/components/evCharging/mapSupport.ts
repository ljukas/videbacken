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
