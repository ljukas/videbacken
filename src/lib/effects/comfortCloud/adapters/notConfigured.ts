import type { UnavailableCode } from '../../keyedAdapter'
import type { ComfortCloudClient } from '../comfortCloud'
import { ComfortCloudError } from '../errors'

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured:
    'Comfort Cloud client is not configured (set it under Charging → Settings or as PANASONIC_USER / PANASONIC_PASSWORD)',
  credentials_unreadable:
    'Stored Comfort Cloud credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Charging → Settings',
}

// `not_configured` when either field is missing (and under VITEST),
// `credentials_unreadable` when the stored row can't be decrypted: fails closed
// so health shows the reason, never a fake healthy sync (ADR-0019). `op` is
// `login`: nothing got as far as a call.
export function unavailable(code: UnavailableCode): ComfortCloudClient {
  const fail = async (): Promise<never> => {
    throw new ComfortCloudError(code, 'login', undefined, { message: MESSAGES[code] })
  }
  return { units: fail, dayHours: fail, monthDays: fail }
}

export const notConfigured: ComfortCloudClient = unavailable('not_configured')
