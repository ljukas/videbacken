import 'maplibre-gl/dist/maplibre-gl.css'
import {
  Map as MapGL,
  type MapLayerMouseEvent,
  type MapRef,
  Marker,
  type MarkerDragEvent,
  NavigationControl,
} from '@vis.gl/react-maplibre'
import { MapPinIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { LEFKADA, mapStyleUrl } from './mapConfig'

export default function LocationPicker({
  value,
  onChange,
}: {
  value: { lat: number; lng: number } | null
  onChange: (loc: { lat: number; lng: number }) => void
}) {
  const mapRef = useRef<MapRef>(null)
  const initialViewState = value ? { longitude: value.lng, latitude: value.lat, zoom: 11 } : LEFKADA

  // Recenter when the location is set programmatically (e.g. prefilled from a
  // photo's EXIF) and lands outside the current view — otherwise the pin renders
  // off-screen and looks like nothing happened. `initialViewState` is consumed
  // once at mount, so it can't do this. The getBounds().contains guard means
  // placing/dragging the pin within view never triggers a jarring camera move.
  const lat = value?.lat
  const lng = value?.lng
  useEffect(() => {
    const map = mapRef.current
    if (!map || lat == null || lng == null) return
    if (!map.getBounds().contains([lng, lat])) {
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 11), duration: 600 })
    }
  }, [lat, lng])

  return (
    <MapGL
      ref={mapRef}
      initialViewState={initialViewState}
      mapStyle={mapStyleUrl()}
      onClick={(e: MapLayerMouseEvent) => onChange({ lat: e.lngLat.lat, lng: e.lngLat.lng })}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" />
      {value ? (
        <Marker
          longitude={value.lng}
          latitude={value.lat}
          anchor="bottom"
          draggable
          onDragEnd={(e: MarkerDragEvent) => onChange({ lat: e.lngLat.lat, lng: e.lngLat.lng })}
        >
          <MapPinIcon className="size-8 fill-brand text-brand drop-shadow" />
        </Marker>
      ) : null}
    </MapGL>
  )
}
