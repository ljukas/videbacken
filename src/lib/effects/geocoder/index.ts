export { createNominatimClient } from './client'
export { GeocoderError, type GeocoderErrorCode } from './errors'
export {
  type GeocoderCallOpts,
  type GeocoderCallStats,
  type GeocoderClient,
  type GeocoderHit,
  geocoder,
  newGeocoderStats,
  selectGeocoderAdapter,
} from './geocoder'
