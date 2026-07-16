import { presence } from '~/lib/effects'
import { protectedProcedure } from '~/lib/orpc/context'

export const presenceRouter = {
  // Snapshot of user IDs currently holding an open SSE subscription.
  // Clients refetch on every `presence.changed` realtime event.
  listOnline: protectedProcedure.handler(() => presence.listOnline()),
}
