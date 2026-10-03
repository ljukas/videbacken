import { SkodaError } from '../errors'
import type { SkodaClient } from '../skoda'

// Selected when SKODA_API_KEY or SKODA_VIN is unset (and under VITEST): fails
// closed so health shows "not configured", never a fake healthy sync.
export const notConfigured: SkodaClient = {
  async vehicleState() {
    throw new SkodaError('not_configured', 'vehicle', undefined, {
      message: 'Škoda client is not configured (SKODA_API_KEY / SKODA_VIN unset)',
    })
  },
}
