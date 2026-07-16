import type { Logger } from '~/lib/logger'
import { inMemory } from './adapters/inMemory'
import type { RealtimeEvent } from './types'

// A delivered event plus the id of the actor that caused it. `source` is
// server-internal transport metadata (never serialized to the browser — that's
// why it rides an envelope and not `realtimeEventSchema`). The SSE handler uses
// it for echo suppression: an event is not delivered back to its own actor's
// subscription (the actor's tab already updated itself locally). `source` is
// `undefined` for broadcast-to-all publishes (presence, background jobs).
export type RealtimeEnvelope = { event: RealtimeEvent; source?: string }

export interface RealtimeEffects {
  publish(event: RealtimeEvent, opts?: { source?: string }): Promise<void>
  subscribe(args: { signal?: AbortSignal; log: Logger }): AsyncIterable<RealtimeEnvelope>
}

// Echo-suppression policy applied by the SSE handler: a subscriber should not
// receive an event it caused itself (the actor's own tab already updated
// locally via its mutation's invalidation — see ADR-0004). Sourceless events
// (presence transitions, background jobs) are broadcast to everyone, including
// the actor, and are always delivered.
export function shouldDeliver(source: string | undefined, self: string): boolean {
  return source === undefined || source !== self
}

// In-process pub/sub: the mutation procedure publishes; the SSE handler in
// the same process reads it out. Single-instance Vercel deployment, so no
// cross-process fan-out is needed.
export const realtime = inMemory
export type { RealtimeEvent }
