import type { PresenceEffects } from '../presence'

export function createInMemoryPresence(): PresenceEffects {
  const refCounts = new Map<string, number>()
  return {
    async acquire(userId) {
      const prev = refCounts.get(userId) ?? 0
      refCounts.set(userId, prev + 1)
      return prev === 0
    },
    async release(userId) {
      const prev = refCounts.get(userId) ?? 0
      if (prev <= 1) {
        refCounts.delete(userId)
        return prev === 1
      }
      refCounts.set(userId, prev - 1)
      return false
    },
    async listOnline() {
      return Array.from(refCounts.keys())
    },
  }
}

export const inMemoryPresence = createInMemoryPresence()
