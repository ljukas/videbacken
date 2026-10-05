import type { UnavailableCode } from '../../keyedAdapter'
import { ZaptecError } from '../errors'
import type { ZaptecClient } from '../zaptec'

const MESSAGES: Record<UnavailableCode, string> = {
  not_configured:
    'Zaptec client is not configured (set it under Inställningar or as ZAPTEC_USERNAME / ZAPTEC_PASSWORD)',
  credentials_unreadable:
    'Stored Zaptec credentials are unreadable (CREDENTIALS_ENCRYPTION_KEY missing or changed); enter them again under Inställningar',
}

/**
 * A client whose every method throws `ZaptecError(code)`: `not_configured` when
 * credentials are missing (and under Vitest), `credentials_unreadable` when the
 * stored row can't be decrypted. Fails closed so health never shows a fake
 * healthy sync.
 */
export function unavailable(code: UnavailableCode): ZaptecClient {
  const message = MESSAGES[code]
  return {
    async chargers() {
      throw new ZaptecError(code, 'chargers', undefined, { message })
    },
    // biome-ignore lint/correctness/useYield: throws before the first page by design
    async *sessionsEndedSince() {
      throw new ZaptecError(code, 'sessions', undefined, { message })
    },
    async liveState() {
      throw new ZaptecError(code, 'state', undefined, { message })
    },
  }
}

export const notConfigured: ZaptecClient = unavailable('not_configured')
