// Client-safe range enum for the climate feature. Kept OUT of the service
// module (`~/lib/services/sensor`, which imports the db layer) so the client
// `/sensors` route can import the enum for its search schema WITHOUT dragging
// `postgres` — and its `Buffer` usage — into the browser bundle. Importing a
// runtime value from the service would evaluate `sensor.ts` → `~/lib/db` in the
// browser and crash with "Buffer is not defined". Keep this file dependency-free.
export const SERIES_RANGES = ['24h', '1m', '3m', '6m', '1y', 'all'] as const
export type SeriesRange = (typeof SERIES_RANGES)[number]

// Chart gap-break tuning (client-safe; imported by chartData + the /sensors route).
// A device is drawn as one continuous line across silence up to MAX_GAP_BUCKETS
// bucket-widths; a longer silence renders as a visible break. On ranges whose
// bucket is finer than CADENCE_SEC (only 24h), empty buckets are normal
// sparseness, so the line connects across the whole window (never breaks).
export const MAX_GAP_BUCKETS = 4
export const CADENCE_SEC = 2 * 3600 // sensors emit at most ~1 reading / 2h
