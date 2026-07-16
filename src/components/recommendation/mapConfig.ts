// Shared MapLibre config for the read map (RecommendationMap) and the editor's
// LocationPicker. The MapTiler key is client-exposed by nature (the browser fetches
// the style JSON) — not a secret; restricted by HTTP-referrer in the dashboard.
export const LEFKADA = { longitude: 20.65, latitude: 38.7, zoom: 9 } as const

export function mapStyleUrl(): string {
  return `https://api.maptiler.com/maps/satellite/style.json?key=${import.meta.env.VITE_MAPTILER_API_KEY}`
}
