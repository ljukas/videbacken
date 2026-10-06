import { AttributionControl, Map as MapLibre, type MapRef, Marker } from '@vis.gl/react-maplibre'
import { MapPinIcon } from 'lucide-react'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import type { LatLon } from '~/lib/effects/skoda'
import { logger } from '~/lib/logger/browser'
import { m } from '~/paraglide/messages'
import type { MapView } from './mapSupport'

// The only module that imports maplibre (ADR-0026, step 3c-2). The picker loads
// it with React.lazy inside <ClientOnly>, so the settings page never ships it.
// `?worker&url` (not `?url`): the dist worker imports a sibling chunk that only
// Vite's worker pipeline bundles in.
setWorkerUrl(workerUrl)

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
/** Pixels per arrow press; Shift moves five times as far. */
const KEY_STEP_PX = 10

export type HomePositionMapProps = {
  /** The pin; none until a point is chosen. */
  point: LatLon | null
  /** The first view (not reactive). */
  initialView: MapView
  /** A camera request: each new object moves the view there. */
  camera: MapView | null
  onPick: (point: LatLon) => void
}

let warned = false

/** MapLibre reports unwrapped longitudes after panning past the antimeridian; wrap to ±180. */
function toPoint(lngLat: { wrap(): { lat: number; lng: number } }): LatLon {
  const p = lngLat.wrap()
  return { latitude: p.lat, longitude: p.lng }
}

export function HomePositionMap({ point, initialView, camera, onPick }: HomePositionMapProps) {
  const mapRef = useRef<MapRef>(null)
  // Read once at mount: one finger scrolls the bottom sheet, two move the map.
  const coarse = useRef(window.matchMedia('(pointer: coarse)').matches).current

  useEffect(() => {
    if (!camera) return
    // Not `essential`: with prefers-reduced-motion MapLibre jumps instead of flying.
    mapRef.current?.flyTo({
      center: [camera.center.longitude, camera.center.latitude],
      zoom: camera.zoom,
    })
  }, [camera])

  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = (event.shiftKey ? 5 : 1) * KEY_STEP_PX
    const delta = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    }[event.key]
    const map = mapRef.current
    if (!delta || !map || !point) return
    event.preventDefault()
    event.stopPropagation() // the map's own keyboard handler would pan instead
    const at = map.project([point.longitude, point.latitude])
    onPick(toPoint(map.unproject([at.x + delta[0], at.y + delta[1]])))
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings legend/min-width quirks the map frame doesn't want
    <div
      className="h-[260px] w-full overflow-hidden rounded-md border bg-muted"
      role="group"
      aria-label={m.charging_home_map_label()}
    >
      <MapLibre
        ref={mapRef}
        initialViewState={{
          longitude: initialView.center.longitude,
          latitude: initialView.center.latitude,
          zoom: initialView.zoom,
        }}
        mapStyle={STYLE_URL}
        cooperativeGestures={coarse}
        attributionControl={false}
        onClick={(e) => onPick(toPoint(e.lngLat))}
        // Tiles or style failing leaves the pin on a blank map (the text input still works).
        // One warning per page, never the coordinates.
        onError={(e) => {
          if (warned) return
          warned = true
          logger.warn('home-position map error', { error: e.error })
        }}
      >
        <AttributionControl compact position="bottom-right" />
        {point ? (
          <Marker
            longitude={point.longitude}
            latitude={point.latitude}
            anchor="bottom"
            draggable
            onDragEnd={(e) => onPick(toPoint(e.lngLat))}
          >
            <button
              type="button"
              aria-label={m.charging_home_pin_label()}
              onKeyDown={nudge}
              className="grid size-11 place-items-center rounded-full text-brand focus-visible:outline-2 focus-visible:outline-ring"
            >
              <MapPinIcon aria-hidden className="size-9 fill-background drop-shadow" />
            </button>
          </Marker>
        ) : null}
      </MapLibre>
    </div>
  )
}
