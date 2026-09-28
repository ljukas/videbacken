import { ZaptecError } from '../errors'
import type { ZaptecClient } from '../zaptec'

/** Selected when Zaptec credentials are missing (and under Vitest). */
export const notConfigured: ZaptecClient = {
  async chargers() {
    throw new ZaptecError('not_configured', 'chargers')
  },
  // biome-ignore lint/correctness/useYield: throws before the first page by design
  async *sessionsEndedSince() {
    throw new ZaptecError('not_configured', 'sessions')
  },
  async liveState() {
    throw new ZaptecError('not_configured', 'state')
  },
}
