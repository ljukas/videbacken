import type { UnavailableCode } from '../../keyedAdapter'
import { SkodaError } from '../errors'
import type { SkodaClient } from '../skoda'

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured:
    'Škoda client is not configured (set it under Charging → Settings or as SKODA_API_KEY / SKODA_VIN)',
  credentials_unreadable:
    'Stored Škoda credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Charging → Settings',
}

// `not_configured` when the API key or VIN is missing (and under VITEST),
// `credentials_unreadable` when the stored row can't be decrypted: fails
// closed so health shows the reason, never a fake healthy sync.
export function unavailable(code: UnavailableCode): SkodaClient {
  return {
    async vehicleState() {
      throw new SkodaError(code, 'vehicle', undefined, { message: MESSAGES[code] })
    },
  }
}

export const notConfigured: SkodaClient = unavailable('not_configured')
