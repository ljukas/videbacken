import type { UnavailableCode } from '../../keyedAdapter'
import type { EmaldoClient } from '../emaldo'
import { EmaldoError } from '../errors'

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured:
    'Emaldo client is not configured (set it under Inställningar or as EMALDO_USER / EMALDO_PASSWORD / EMALDO_APP_ID / EMALDO_APP_SECRET)',
  credentials_unreadable:
    'Stored Emaldo credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Inställningar',
}

// `not_configured` when any of the four fields is missing (and under VITEST),
// `credentials_unreadable` when the stored row can't be decrypted: fails
// closed so health shows the reason, never a fake healthy sync.
export function unavailable(code: UnavailableCode): EmaldoClient {
  return {
    async fetchDay() {
      throw new EmaldoError(code, 'stats', undefined, { message: MESSAGES[code] })
    },
  }
}

export const notConfigured: EmaldoClient = unavailable('not_configured')
