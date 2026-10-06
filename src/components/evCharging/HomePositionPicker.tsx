import { useQuery } from '@tanstack/react-query'
import { ClientOnly } from '@tanstack/react-router'
import { LocateFixedIcon, MapPinIcon, SearchIcon } from 'lucide-react'
import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { LatLon } from '~/lib/effects/skoda'
import { orpc } from '~/lib/orpc/client'
import { formatHomePoint, parseHomePoint } from '~/lib/vehicleState/geofence'
import { m } from '~/paraglide/messages'
import { type MapView, PICK_ZOOM, PIN_ZOOM, SWEDEN_VIEW, supportsWebGL2 } from './mapSupport'

// The map chunk (maplibre, ~250 kB gz) loads only when a picker shows a map.
const HomePositionMap = lazy(() =>
  import('./HomePositionMap').then((mod) => ({ default: mod.HomePositionMap })),
)

export const homeSearchId = (idBase: string) => `${idBase}-search`

export type HomePositionPickerProps = {
  /** The form value ("lat,lon" or ""). */
  value: string
  /** Sets the form value (field.handleChange). */
  onChange: (value: string) => void
  /** Disabled (encryption key missing): only `children` render, nothing is fetched. */
  disabled: boolean
  /** Field hints shown first, described by `headerId`. */
  header: ReactNode
  headerId: string
  /** Prefix for the picker's own ids (`${idBase}-search` is the search input, focused on reveal). */
  idBase: string
  /** The bound "lat,lon" input (field.TextField). */
  children: ReactNode
}

type LocationError = 'denied' | 'unavailable'

// The Škoda home position (ADR-0026, step 3c-2): address search through our
// server, a map with a draggable pin, "Använd min position", and the bound
// "lat,lon" input (`children`) as the keyboard and screen-reader path. The form
// value stays that string; every point set here is rounded to 5 decimals.
export function HomePositionPicker({
  value,
  onChange,
  disabled,
  header,
  headerId,
  idBase,
  children,
}: HomePositionPickerProps) {
  if (disabled) {
    return (
      <div className="flex flex-col gap-3">
        <div id={headerId} className="flex flex-col gap-1 text-muted-foreground text-sm">
          {header}
        </div>
        {children}
      </div>
    )
  }
  return (
    <EnabledPicker
      value={value}
      onChange={onChange}
      header={header}
      headerId={headerId}
      idBase={idBase}
    >
      {children}
    </EnabledPicker>
  )
}

function EnabledPicker({
  value,
  onChange,
  header,
  headerId,
  idBase,
  children,
}: Omit<HomePositionPickerProps, 'disabled'>) {
  // The saved pin: read only while the picker shows, dropped once it closes (gcTime 0),
  // never in a loader or the dehydrated cache (ADR-0026).
  const saved = useQuery(
    orpc.credentials.homePosition.queryOptions({
      gcTime: 0,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  )
  const [camera, setCamera] = useState<MapView | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<LocationError | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The form value at mount decides the first view; later moves go through `camera`.
  const [initialView] = useState<MapView>(() => {
    const p = parseHomePoint(value)
    return p ? { center: p, zoom: PIN_ZOOM } : SWEDEN_VIEW
  })

  // Seed once with the saved pin, unless the admin has already chosen a point.
  const seeded = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => {
    if (seeded.current || !saved.data) return
    seeded.current = true
    if (valueRef.current.trim() !== '') return
    onChange(formatHomePoint(saved.data))
    setCamera({ center: saved.data, zoom: PIN_ZOOM })
  }, [saved.data, onChange])

  const pick = (point: LatLon, zoom?: number) => {
    const text = formatHomePoint(point)
    onChange(text)
    const [lat, lon] = text.split(',')
    setAnnouncement(m.charging_home_chosen({ lat, lon }))
    if (zoom !== undefined) setCamera({ center: point, zoom })
  }

  // Search runs on submit only (Nominatim's policy forbids autocomplete).
  const hits = useQuery({
    ...orpc.credentials.searchAddress.queryOptions({ input: { query: query ?? '' } }),
    enabled: query !== null,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const runSearch = () => {
    const q = searchRef.current?.value.trim() ?? ''
    if (q.length < 2 || hits.isFetching) return
    // The same text again is a retry: an equal query string would not re-run the query.
    if (q === query) void hits.refetch()
    else setQuery(q)
  }
  const pickHit = (hit: { latitude: number; longitude: number }) => {
    pick({ latitude: hit.latitude, longitude: hit.longitude }, PICK_ZOOM)
    setQuery(null)
    searchRef.current?.focus()
  }

  const locate = () => {
    if (locating) return
    setLocationError(null)
    if (!('geolocation' in navigator)) {
      setLocationError('unavailable')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        pick({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, PICK_ZOOM)
      },
      (err) => {
        setLocating(false)
        setLocationError(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable')
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  const point = parseHomePoint(value)
  const searchId = homeSearchId(idBase)
  const noMap = <p className="text-muted-foreground text-sm">{m.charging_home_no_map()}</p>

  return (
    <div className="flex flex-col gap-3">
      <div id={headerId} className="flex flex-col gap-1 text-muted-foreground text-sm">
        {header}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchId}>{m.charging_home_search_label()}</Label>
        <div className="flex gap-2">
          <Input
            id={searchId}
            ref={searchRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            className="pointer-coarse:h-11"
            onKeyDown={(e) => {
              // Enter searches; it must never submit the credentials form.
              if (e.key === 'Enter') {
                e.preventDefault()
                runSearch()
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="pointer-coarse:h-11 shrink-0"
            onClick={runSearch}
            aria-busy={hits.isFetching}
          >
            <SearchIcon aria-hidden />
            {hits.isFetching ? m.charging_home_searching() : m.charging_home_search()}
          </Button>
        </div>
        {/* Always mounted, so a screen reader announces what appears inside. */}
        <div role="alert" className="text-muted-foreground text-sm empty:hidden">
          {query !== null && hits.isError ? m.charging_home_search_unavailable() : null}
        </div>
        <div role="status" className="text-muted-foreground text-sm empty:hidden">
          {query !== null && !hits.isError && hits.data
            ? hits.data.length === 0
              ? m.charging_home_search_empty()
              : m.charging_home_search_hit_count({ count: hits.data.length })
            : null}
        </div>
        {query !== null && !hits.isError && hits.data && hits.data.length > 0 ? (
          <div className="flex flex-col gap-1">
            <ul aria-label={m.charging_home_search_hits()} className="flex flex-col">
              {hits.data.map((hit) => (
                <li key={`${hit.latitude},${hit.longitude},${hit.label}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-9 pointer-coarse:min-h-11 w-full justify-start whitespace-normal py-1.5 text-left"
                    onClick={() => pickHit(hit)}
                  >
                    <MapPinIcon aria-hidden className="shrink-0" />
                    {hit.label}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">{m.charging_home_search_attribution()}</p>
          </div>
        ) : null}
      </div>
      {supportsWebGL2() ? (
        <ClientOnly fallback={<MapPlaceholder />}>
          <MapBoundary fallback={noMap}>
            <Suspense fallback={<MapPlaceholder />}>
              <HomePositionMap
                point={point}
                initialView={initialView}
                camera={camera}
                onPick={(p) => pick(p)}
              />
            </Suspense>
          </MapBoundary>
        </ClientOnly>
      ) : (
        noMap
      )}
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={locate}
          aria-busy={locating}
        >
          <LocateFixedIcon aria-hidden />
          {locating ? m.charging_home_locating() : m.charging_home_use_location()}
        </Button>
        <div role="status" className="text-muted-foreground text-sm empty:hidden">
          {locationError === 'denied'
            ? m.charging_home_location_denied()
            : locationError === 'unavailable'
              ? m.charging_home_location_unavailable()
              : null}
        </div>
      </div>
      {children}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function MapPlaceholder() {
  return <div aria-hidden className="h-[260px] w-full animate-pulse rounded-md border bg-muted" />
}

// A chunk that fails to load, or a map that can't start (MapLibre throws
// GPUInitializationError without WebGL2), falls back to the note: search and
// the coordinates input still work.
class MapBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
