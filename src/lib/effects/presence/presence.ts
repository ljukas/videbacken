import { inMemoryPresence } from './adapters/inMemory'

export interface PresenceEffects {
  // Returns true iff the user transitioned offline → online (refcount 0 → 1).
  // Callers use that signal to publish a `presence.changed` realtime event
  // without flooding the bus on every per-tab connect from the same user.
  acquire(userId: string): Promise<boolean>
  // Returns true iff the user transitioned online → offline (refcount 1 → 0).
  release(userId: string): Promise<boolean>
  listOnline(): Promise<string[]>
}

// Tracks open SSE subscriptions per user, refcounted across tabs. Same
// single-instance assumption as the realtime bus — works because every
// SSE handler in this process shares one in-memory map.
export const presence: PresenceEffects = inMemoryPresence
