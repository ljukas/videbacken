import { AttributionControl, Map as MapLibre, type MapRef, Marker } from '@vis.gl/react-maplibre'
import { MapPinIcon } from 'lucide-react'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useRef } from 'react'
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
  /**
   * A camera request: each new object moves the view there. The latest one is also
   * applied once the map has loaded, so a request made before the (async) map exists
   * is not lost.
   */
  camera: MapView | null
  onPick: (point: LatLon) => void
}

let warned = false

/** MapLibre's own UI strings (Swedish-default app); read once at mount. */
function mapLocale() {
  return {
    'Map.Title': m.charging_home_map_ui_title(),
    'Marker.Title': m.charging_home_map_ui_marker(),
    'AttributionControl.ToggleAttribution': m.charging_home_map_ui_toggle_attribution(),
    'AttributionControl.MapFeedback': m.charging_home_map_ui_feedback(),
    'CooperativeGesturesHandler.MobileHelpText': m.charging_home_map_ui_gesture_mobile(),
    'CooperativeGesturesHandler.WindowsHelpText': m.charging_home_map_ui_gesture_windows(),
    'CooperativeGesturesHandler.MacHelpText': m.charging_home_map_ui_gesture_mac(),
  }
}

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
}

/** MapLibre reports unwrapped longitudes after panning past the antimeridian; wrap to ±180. */
function toPoint(lngLat: { wrap(): { lat: number; lng: number } }): LatLon {
  const p = lngLat.wrap()
  return { latitude: p.lat, longitude: p.lng }
}

export function HomePositionMap({ point, initialView, camera, onPick }: HomePositionMapProps) {
  const mapRef = useRef<MapRef>(null)
  // Read once at mount: one finger scrolls the bottom sheet, two move the map.
  const coarse = useRef(window.matchMedia('(pointer: coarse)').matches).current

  const locale = useRef(mapLocale()).current
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const pinRef = useRef<HTMLButtonElement>(null)
  const pointRef = useRef(point)
  pointRef.current = point
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const hasPoint = point !== null

  useEffect(() => {
    if (!camera) return
    // Not `essential`: with prefers-reduced-motion MapLibre jumps instead of flying.
    // Before the map exists this is a no-op; `onLoad` applies the latest camera then.
    mapRef.current?.flyTo({
      center: [camera.center.longitude, camera.center.latitude],
      zoom: camera.zoom,
    })
  }, [camera])

  // A native listener on the pin: MapLibre's keyboard handler listens on the canvas
  // container, which a keydown reaches before React's root-level handlers run, so a
  // React `onKeyDown` + `stopPropagation` cannot keep the map from panning.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasPoint mounts/unmounts the pin button
  useEffect(() => {
    const pin = pinRef.current
    if (!pin) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const unit = ARROW_DELTAS[event.key]
      const map = mapRef.current
      const at = pointRef.current
      if (!unit || !map || !at) return
      event.preventDefault()
      event.stopPropagation()
      const step = (event.shiftKey ? 5 : 1) * KEY_STEP_PX
      const px = map.project([at.longitude, at.latitude])
      onPickRef.current(toPoint(map.unproject([px.x + unit[0] * step, px.y + unit[1] * step])))
    }
    pin.addEventListener('keydown', onKeyDown)
    return () => pin.removeEventListener('keydown', onKeyDown)
  }, [hasPoint])

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
        locale={locale}
        onLoad={() => {
          const c = cameraRef.current
          if (c) {
            mapRef.current?.jumpTo({
              center: [c.center.longitude, c.center.latitude],
              zoom: c.zoom,
            })
          }
        }}
        onClick={(e) => {
          // A tap or Enter/Space on the pin bubbles to the map's click listener: not a pick.
          if ((e.originalEvent.target as Element | null)?.closest('.maplibregl-marker')) return
          onPick(toPoint(e.lngLat))
        }}
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
              ref={pinRef}
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
