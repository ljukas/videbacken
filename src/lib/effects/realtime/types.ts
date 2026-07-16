import { z } from 'zod'

// One variant per entity that opts into real-time fan-out. The `kind` names a
// top-level oRPC query namespace; the client invalidates that namespace.
// Optional `ids` is metadata for future fine-grained patching — coarse
// invalidation ignores it.
export const realtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user.changed'), ids: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('presence.changed') }),
  // Add per-entity variants here as they adopt.
])

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>
