import type { EmaldoClient } from '../emaldo'
import { EmaldoError } from '../errors'

// Selected when any EMALDO_* variable is unset (and under VITEST): fails
// closed so health shows "not configured", never a fake healthy sync.
export const notConfigured: EmaldoClient = {
  async fetchDay() {
    throw new EmaldoError('not_configured', 'stats', undefined, {
      message:
        'Emaldo client is not configured (EMALDO_USER / EMALDO_PASSWORD / EMALDO_APP_ID / EMALDO_APP_SECRET unset)',
    })
  },
}
