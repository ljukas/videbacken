import type { ElprisClient } from '../elpris'
import { ElprisError } from '../errors'

// Test-only default (VITEST): fails closed so nothing reaches the network.
export const notConfigured: ElprisClient = {
  async dayPrices() {
    throw new ElprisError('not_configured', 'prices', undefined, {
      message: 'elpris client is not configured in this environment',
    })
  },
}
