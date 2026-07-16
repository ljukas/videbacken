import { z } from 'zod'

// One variant per entity that opts into real-time fan-out. The `kind` names a
// top-level oRPC query namespace; the client invalidates that namespace.
// Optional `ids` is metadata for future fine-grained patching — coarse
// invalidation ignores it.
export const realtimeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user.changed'), ids: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('presence.changed') }),
  z.object({ kind: z.literal('document.changed'), ids: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('folder.changed'), ids: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('share.changed'), ids: z.array(z.string()).optional() }),
  // Bin (admin deleted-items view) contents changed — published only by
  // soft-delete / restore / hard-delete, never by upload / rename / move.
  z.object({ kind: z.literal('bin.changed') }),
  z.object({ kind: z.literal('recommendation.changed'), ids: z.array(z.string()).optional() }),
  // Booking round changed: wishes, draft slots, or lock state (ADR-0020).
  // No ids — the round is one aggregate; coarse invalidation is right-sized.
  z.object({ kind: z.literal('booking.changed') }),
  // Add per-entity variants here as they adopt.
])

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>
