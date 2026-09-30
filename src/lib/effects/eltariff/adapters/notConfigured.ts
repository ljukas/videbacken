import type { EltariffClient } from '../eltariff'
import { EltariffError } from '../errors'

// Test-only default (VITEST): fails closed so nothing reaches the network.
export const notConfigured: EltariffClient = {
  async catalogue() {
    throw new EltariffError('not_configured', 'catalogue', undefined, {
      message: 'eltariff client is not configured in this environment',
    })
  },
}
