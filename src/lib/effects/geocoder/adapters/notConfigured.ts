import { GeocoderError } from '../errors'
import type { GeocoderClient } from '../geocoder'

// Test-only default (VITEST): fails closed so nothing reaches the network.
export const notConfigured: GeocoderClient = {
  async search() {
    throw new GeocoderError('not_configured')
  },
}
