import 'maplibre-gl/dist/maplibre-gl.css'
import { Map as MapGL, type MapRef, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { ImageIcon, ImageOffIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useRef } from 'react'
import { BlurhashImage } from '~/components/ui/blurhash-image'
import type { RouterOutputs } from '~/lib/orpc/client'
import { LEFKADA, mapStyleUrl } from './mapConfig'

type Place = RouterOutputs['recommendation']['list'][number]

// Memoized so panning/zooming (which re-renders the parent) doesn't re-render every orb.
const Orb = memo(function Orb({
  place,
  onSelect,
}: {
  place: Place
  onSelect: (id: string) => void
}) {
  return (
    <Marker longitude={place.lng} latitude={place.lat} anchor="bottom">
      <button
        type="button"
        aria-label={place.title}
        onClick={() => onSelect(place.id)}
        // ≥44px touch target; circular cover thumbnail with a ring.
        className="size-11 cursor-pointer overflow-hidden rounded-full border-2 border-background bg-muted shadow-md transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {place.coverUrl ? (
          <BlurhashImage
            src={place.coverUrl}
            blurhash={place.photos[0]?.blurhash ?? null}
            alt={place.title}
            width={64}
            height={64}
            className="size-full"
          />
        ) : (
          // No cover URL yet: the cover transcode is pending or failed. Too small for
          // text, so a single muted icon — ImageOff for failed, a pulsing Image for
          // pending. The realtime refetch swaps in the thumbnail once the worker is done.
          <span className="flex size-full items-center justify-center text-muted-foreground">
            {place.photos[0]?.failed ? (
              <ImageOffIcon className="size-5" />
            ) : (
              <ImageIcon className="size-5 animate-pulse" />
            )}
          </span>
        )}
      </button>
    </Marker>
  )
})

export default function RecommendationMap({
  places,
  onSelect,
}: {
  places: Place[]
  onSelect: (id: string) => void
}) {
  const mapRef = useRef<MapRef>(null)

  // Frame all places once the map is ready and whenever the set changes. A single
  // place yields a degenerate bbox, so cap zoom; empty stays on Lefkada.
  const fitToPlaces = useCallback(() => {
    const map = mapRef.current
    if (!map || places.length === 0) return
    let minLng = Number.POSITIVE_INFINITY
    let minLat = Number.POSITIVE_INFINITY
    let maxLng = Number.NEGATIVE_INFINITY
    let maxLat = Number.NEGATIVE_INFINITY
    for (const p of places) {
      minLng = Math.min(minLng, p.lng)
      maxLng = Math.max(maxLng, p.lng)
      minLat = Math.min(minLat, p.lat)
      maxLat = Math.max(maxLat, p.lat)
    }
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 64, maxZoom: 13, duration: 0 },
    )
  }, [places])

  useEffect(() => {
    fitToPlaces()
  }, [fitToPlaces])

  return (
    <MapGL
      ref={mapRef}
      initialViewState={LEFKADA}
      mapStyle={mapStyleUrl()}
      onLoad={fitToPlaces}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" />
      {places.map((place) => (
        <Orb key={place.id} place={place} onSelect={onSelect} />
      ))}
    </MapGL>
  )
}
