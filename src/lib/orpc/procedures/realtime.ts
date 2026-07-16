import { eventIterator } from '@orpc/server'
import { presence, realtime } from '~/lib/effects'
import { shouldDeliver } from '~/lib/effects/realtime/realtime'
import { realtimeEventSchema } from '~/lib/effects/realtime/types'
import { protectedProcedure } from '~/lib/orpc/context'

export const realtimeRouter = {
  // One SSE stream per authenticated tab. GET + eventIterator output schema
  // tells oRPC's RPCHandler to enable the SSE encoder (matches the oRPC
  // TanStack Start playground pattern). AbortSignal is wired by oRPC for
  // client disconnects and function shutdown; we forward it to the adapter.
  //
  // Doubles as the presence ingress: connect → acquire, disconnect → release.
  // This is the one publish site for `presence.changed` and the only
  // intentional exception to ADR-0004's "publish from mutation procedures"
  // rule, because presence state *is* the SSE subscription state — there's
  // no DB mutation to attach it to.
  events: protectedProcedure
    .route({ method: 'GET' })
    .output(eventIterator(realtimeEventSchema))
    .handler(async function* ({ context, signal }) {
      context.log.info('realtime subscriber connected')
      const self = context.user.id
      const becameOnline = await presence.acquire(self)
      try {
        // Inside the try: if this publish ever throws (a future distributed
        // adapter), the finally still releases — the invariant is "release
        // runs iff acquire ran", or the refcount leaks the user as online.
        if (becameOnline) await realtime.publish({ kind: 'presence.changed' })
        for await (const { event, source } of realtime.subscribe({ signal, log: context.log })) {
          if (shouldDeliver(source, self)) yield event
        }
      } finally {
        const becameOffline = await presence.release(self)
        if (becameOffline) await realtime.publish({ kind: 'presence.changed' })
        context.log.info('realtime subscriber disconnected')
      }
    }),
}
